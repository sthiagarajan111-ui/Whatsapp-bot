require('dotenv').config();

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const mongoose = require('mongoose');
const { handleMessage } = require('./flows/flowEngine');
const { markAsRead, sendText, sendImage, sendPropertyCard } = require('./whatsapp/api');
const db = require('./db/database');
const { startScheduler, sendDailyReport } = require('./utils/scheduler');
const { processVoiceMessage } = require('./utils/voiceHandler');
const { generateReport, listReports, REPORTS_DIR } = require('./utils/reportGenerator');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Twilio sends form-encoded webhooks

// ── Deduplication: keep last 100 message IDs ──────────────────────────────────
const seenIds = new Set();
const SEEN_MAX = 100;

function dedup(id) {
  if (seenIds.has(id)) return true;
  seenIds.add(id);
  if (seenIds.size > SEEN_MAX) {
    seenIds.delete(seenIds.values().next().value);
  }
  return false;
}

// ── Webhook verification (GET) — Twilio does not use challenge verification ───
app.get('/webhook', (_req, res) => {
  res.sendStatus(200);
});

// ── Webhook incoming messages (POST) — Twilio format ─────────────────────────
app.post('/webhook', (req, res) => {
  // Respond immediately with empty TwiML
  res.set('Content-Type', 'text/xml').send('<Response></Response>');
  processWebhook(req).catch((err) => console.error('[Webhook Error]', err.message));
});

async function processWebhook(req) {
  const from     = (req.body.From || '').replace('whatsapp:+', '');
  const msgSid   = req.body.MessageSid;
  const bodyText = req.body.Body || '';
  const numMedia = parseInt(req.body.NumMedia || '0', 10);

  if (!from || !msgSid) return;
  if (dedup(msgSid)) return;

  markAsRead(msgSid); // no-op for Twilio

  const isAudio = numMedia > 0 && (req.body.MediaContentType0 || '').startsWith('audio');

  if (isAudio) {
    // ── Voice note handling ──────────────────────────────────────────────
    if (!process.env.OPENAI_API_KEY || process.env.VOICE_ENABLED === 'false') {
      await sendText(from, 'Sorry, voice messages are not supported yet. Please type your message.').catch(() => {});
      return;
    }

    const voiceSession = await db.getSession(from);
    if (voiceSession && voiceSession.human_mode) {
      const agentNum = voiceSession.agent_number || process.env.OWNER_WHATSAPP;
      if (agentNum) {
        const vName = (voiceSession.data || {}).name || from;
        sendText(agentNum, `[${vName}]: [sent a voice note]`).catch(() => {});
      }
      return;
    }

    try {
      await sendText(from, '🎙️ Processing your voice message...');

      const audioObj = { url: req.body.MediaUrl0, mime_type: req.body.MediaContentType0 };
      const { transcript, language } = await processVoiceMessage(audioObj);

      if (!transcript || transcript.length < 2) {
        const emptyMsg = language === 'ar'
          ? 'لم أتمكن من فهم الرسالة الصوتية. يرجى المحاولة مرة أخرى أو كتابة رسالتك.'
          : 'Could not understand the voice message. Please try again or type your message.';
        await sendText(from, emptyMsg).catch(() => {});
        return;
      }

      console.log(`[Voice] ${from} said: "${transcript}" (${language})`);
      try { await db.saveMessage(from, 'inbound', 'audio', transcript, { MessageSid: msgSid, MediaUrl: req.body.MediaUrl0 }); } catch (_) {}

      const syntheticParsed = {
        from,
        id:                msgSid,
        type:              'text',
        text:              transcript,
        buttonId:          null,
        listId:            null,
        _fromVoice:        true,
        _detectedLanguage: language,
      };
      await handleMessage(syntheticParsed);
    } catch (err) {
      console.error('[Voice] Error processing voice note:', err.message);
      await sendText(from, 'Voice processing failed, please type your message').catch(() => {});
    }
    return;
  }

  // ── Text message ─────────────────────────────────────────────────────────────
  const parsed = {
    from,
    id:       msgSid,
    type:     'text',
    text:     bodyText,
    buttonId: null,
    listId:   null,
  };

  try { await db.saveMessage(from, 'inbound', 'text', bodyText, req.body); } catch (_) {}

  // ── Human handoff logic ──────────────────────────────────────────────────────
  const owner       = process.env.OWNER_WHATSAPP;
  const rawText     = bodyText.trim();
  const isFromOwner = owner && from === owner;

  if (isFromOwner) {
    // TAKE <number>
    if (rawText.toUpperCase().startsWith('TAKE ')) {
      const targetNum = rawText.slice(5).trim();
      const session   = await db.getSession(targetNum);
      if (!session) {
        sendText(owner, `❌ No active session found for ${targetNum}.`).catch(() => {});
      } else {
        await db.setHumanMode(targetNum, true, owner);
        const leadName = (session.data || {}).name || targetNum;
        sendText(owner,
          `✅ You are now live with *${leadName}* (${targetNum}).\n` +
          `Type your message to reply. Send *DONE ${targetNum}* to end.`
        ).catch(() => {});
      }
      return;
    }

    // DONE <number>
    if (rawText.toUpperCase().startsWith('DONE ')) {
      const targetNum = rawText.slice(5).trim();
      await db.setHumanMode(targetNum, false, null);
      const leads = await db.getAllLeads();
      const lead  = leads.find((l) => l.wa_number === targetNum);
      if (lead) await db.updateLeadStatus(lead.id, 'contacted');
      sendText(targetNum, 'Thank you for chatting with us! Have a great day. 😊').catch(() => {});
      sendText(owner, `✅ Conversation with ${targetNum} ended. Status set to contacted.`).catch(() => {});
      return;
    }

    // Owner typing normally — forward if they have an active human-mode session
    const humanSession = await db.getSessionByAgent(owner);
    if (humanSession) {
      sendText(humanSession.wa_number, rawText).catch(() => {});
      return;
    }
  }

  // ── Customer in human mode → forward to owner ────────────────────────────
  if (!isFromOwner) {
    const session = await db.getSession(from);
    if (session && session.human_mode) {
      const name = (session.data || {}).name || from;
      const agentNum = session.agent_number || owner;
      if (agentNum) {
        sendText(agentNum, `[${name}]: ${rawText}`).catch(() => {});
      }
      return;
    }
  }

  // ── Normal flow processing ───────────────────────────────────────────────
  handleMessage(parsed).catch((err) => {
    console.error('[Flow Error]', from, err.message);
  });
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
app.get('/dashboard', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
});

// ── API: all leads ────────────────────────────────────────────────────────────
app.get('/api/leads', async (_req, res) => {
  try {
    const leads = await db.getAllLeads();

    // Attach human_mode from sessions
    const sessions = await db.getSessionsHumanMode();
    leads.forEach((l) => { l.human_mode = sessions[l.wa_number] || 0; });

    res.json(leads);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: stats ────────────────────────────────────────────────────────────────
app.get('/api/stats', async (_req, res) => {
  try {
    res.json(await db.getLeadStats());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: update lead status ───────────────────────────────────────────────────
app.post('/api/leads/:id/status', async (req, res) => {
  const { id }     = req.params;
  const { status } = req.body;
  const allowed    = ['new', 'contacted', 'converted', 'lost'];

  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  await db.updateLeadStatus(id, status);
  res.json({ ok: true });
});

// ── API: export leads as CSV ──────────────────────────────────────────────────
app.get('/api/leads/export', async (req, res) => {
  const statusFilter = req.query.status;
  let leads = await db.getAllLeads();

  if (statusFilter && statusFilter !== 'all') {
    leads = leads.filter((l) => l.status === statusFilter);
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="leads-${dateStr}.csv"`);

  const header = 'Date,Name,WhatsApp,Interest,Property Type,Budget,Area,Status,Score,Language\n';
  const rows = leads.map((l) => {
    const d = l.data || {};
    const esc = (v) => `"${String(v || '').replace(/"/g, '""')}"`;
    return [
      esc(l.created_at),
      esc(l.name),
      esc(l.wa_number),
      esc(d.intent),
      esc(d.propertyType),
      esc(d.budget),
      esc(d.area),
      esc(l.status),
      esc(l.score || 0),
      esc(l.language || 'en'),
    ].join(',');
  }).join('\n');

  res.send(header + rows);
});

// ── API: broadcast ────────────────────────────────────────────────────────────
app.post('/api/broadcast', async (req, res) => {
  const { message, filter = {} } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  let leads = await db.getAllLeads();

  // Apply filters
  if (filter.status)    leads = leads.filter((l) => l.status === filter.status);
  if (filter.score_min) leads = leads.filter((l) => (l.score || 0) >= filter.score_min);
  if (filter.area)      leads = leads.filter((l) => (l.data?.area || '').toLowerCase().includes(filter.area.toLowerCase()));
  if (filter.interest)  leads = leads.filter((l) => (l.data?.intent || '').toLowerCase() === filter.interest.toLowerCase());

  if (req.query.preview === '1') {
    return res.json({ count: leads.length });
  }

  let sent = 0, failed = 0;
  for (const lead of leads) {
    try {
      await sendText(lead.wa_number, message);
      sent++;
    } catch (_) {
      failed++;
    }
    await new Promise((r) => setTimeout(r, 100)); // rate limit: 10/s
  }

  res.json({ sent, failed });
});

// ── API: token check (Twilio credentials) ────────────────────────────────────
app.get('/api/token-check', async (_req, res) => {
  try {
    const twilio  = require('twilio');
    const client  = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const account = await client.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
    res.json({ valid: true, status: account.status, friendlyName: account.friendlyName });
  } catch (err) {
    res.json({ valid: false, error: err.message });
  }
});

// ── Dashboard static asset routes ─────────────────────────────────────────────
app.get('/dashboard/pages/:page', (req, res) => {
  const file = path.join(__dirname, 'dashboard', 'pages', req.params.page);
  if (!file.startsWith(path.join(__dirname, 'dashboard'))) return res.sendStatus(403);
  res.sendFile(file);
});
app.get('/dashboard/js/:file', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard', 'js', req.params.file));
});
app.get('/dashboard/css/:file', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard', 'css', req.params.file));
});

// ── API: conversations ────────────────────────────────────────────────────────
app.get('/api/conversations', async (_req, res) => {
  try {
    const convs = await db.getRecentConversations(50);
    res.json(convs);
  } catch (e) { res.json([]); }
});

app.get('/api/conversations/:waNumber', async (req, res) => {
  const msgs = await db.getMessages(decodeURIComponent(req.params.waNumber));
  res.json(msgs);
});

app.get('/api/conversations/:waNumber/lead', async (req, res) => {
  const wa   = decodeURIComponent(req.params.waNumber);
  const lead = await db.getLead(wa);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  const sessions = await db.getSessionsHumanMode();
  lead.human_mode = sessions[wa] || 0;
  res.json(lead);
});

// ── API: pipeline ─────────────────────────────────────────────────────────────
app.get('/api/pipeline', async (_req, res) => {
  const leads = await db.getAllLeads();
  leads.forEach((l) => {
    if (!l.pipeline_stage || l.pipeline_stage === 'null') {
      const map = { new: 'new_lead', contacted: 'ai_contacted', converted: 'won', lost: 'lost' };
      l.pipeline_stage = map[l.status] || 'new_lead';
    }
  });
  const grouped = {};
  for (const l of leads) {
    const s = l.pipeline_stage;
    if (!grouped[s]) grouped[s] = [];
    grouped[s].push(l);
  }
  res.json(grouped);
});

app.post('/api/leads/:id/stage', async (req, res) => {
  const { stage } = req.body;
  await db.updateLeadPipelineStage(req.params.id, stage);
  res.json({ ok: true });
});

// ── API: analytics ────────────────────────────────────────────────────────────
app.get('/api/analytics', async (req, res) => {
  const { from, to } = req.query;
  let leads = await db.getAllLeads();
  if (from) leads = leads.filter(l => l.created_at >= from);
  if (to)   leads = leads.filter(l => l.created_at <= to + 'T23:59:59.999Z');

  const total     = leads.length;
  const converted = leads.filter(l => l.status === 'converted').length;
  const avgScore  = total ? Math.round(leads.reduce((s, l) => s + (l.score || 0), 0) / total * 10) / 10 : 0;

  const byArea = {}, byBudget = {}, byInterest = {}, scoreDistribution = {}, hourly = {};
  let arabic = 0, english = 0, voice = 0, text = 0;

  for (const l of leads) {
    const d = l.data || {};
    if (d.area)   byArea[d.area]     = (byArea[d.area] || 0) + 1;
    if (d.budget) byBudget[d.budget] = (byBudget[d.budget] || 0) + 1;
    if (d.intent) byInterest[d.intent] = (byInterest[d.intent] || 0) + 1;
    const sc = l.score || 0;
    scoreDistribution[sc] = (scoreDistribution[sc] || 0) + 1;
    if (l.language === 'ar') arabic++; else english++;
    if (d.source === 'voice') voice++; else text++;
    const h = parseInt((l.created_at || '').slice(11, 13)) || 0;
    hourly[h] = (hourly[h] || 0) + 1;
  }

  const bestArea = Object.entries(byArea).sort((a, b) => b[1] - a[1])[0]?.[0] || '—';
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const byDay = {};
  leads.forEach(l => { const d = DAYS[new Date(l.created_at).getDay()]; byDay[d] = (byDay[d] || 0) + 1; });
  const bestDay = Object.entries(byDay).sort((a, b) => b[1] - a[1])[0]?.[0] || '—';

  // 7-day trend
  const trendLabels = [], trendCounts = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const ds = d.toISOString().slice(0, 10);
    trendLabels.push(ds.slice(5));
    trendCounts.push(leads.filter(l => l.created_at?.startsWith(ds)).length);
  }

  res.json({
    total, conversionRate: total ? Math.round(converted / total * 100) : 0,
    avgScore, bestArea, bestDay, byArea, byBudget, byInterest,
    arabic, english, voice, text, hourly, scoreDistribution,
    trend: { labels: trendLabels, counts: trendCounts },
  });
});

// ── API: settings ─────────────────────────────────────────────────────────────
app.get('/api/settings', async (_req, res) => {
  try {
    res.json(await db.getAllSettings());
  } catch (e) { res.json({}); }
});

app.post('/api/settings', async (req, res) => {
  const data = req.body;
  if (typeof data !== 'object') return res.status(400).json({ error: 'Expected JSON object' });
  for (const [key, value] of Object.entries(data)) {
    await db.saveSetting(key, String(value));
  }
  res.json({ ok: true });
});

// ── API: lead detail ──────────────────────────────────────────────────────────
app.get('/api/leads/:id/detail', async (req, res) => {
  const { id } = req.params;
  const lead = await db.getLeadById(id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  const messages    = await db.getMessages(lead.wa_number);
  const notes       = await db.getNotes(id);
  const lastMessage = messages[messages.length - 1] || null;
  res.json({ lead, messages, notes, lastMessage });
});

app.post('/api/leads/:id/notes', async (req, res) => {
  const { note } = req.body;
  if (!note) return res.status(400).json({ error: 'note required' });
  const result = await db.saveNote(req.params.id, note);
  res.json({ ok: true, id: result.id });
});

app.delete('/api/leads/:id/notes/:noteId', async (req, res) => {
  await db.deleteNote(req.params.noteId);
  res.json({ ok: true });
});

app.delete('/api/leads/:id', async (req, res) => {
  await db.deleteLead(req.params.id);
  res.json({ ok: true });
});

// ── API: listings ─────────────────────────────────────────────────────────────
// ── Property Match Notifications ──────────────────────────────────────────────
async function notifyMatchingLeads(listing) {
  if (process.env.PROPERTY_MATCH_ALERTS !== 'true') return;
  const leads = await db.getAllLeads();
  const budgetRanges = {
    under_500k: {min:0, max:500000},
    '500k_1m': {min:500000, max:1000000},
    '1m_2m': {min:1000000, max:2000000},
    '2m_5m': {min:2000000, max:5000000},
    above_5m: {min:5000000, max:999999999}
  };
  let notified = 0;
  for (const lead of leads) {
    if (lead.status === 'converted' || lead.status === 'lost') continue;
    const data = typeof lead.data === 'string' ? JSON.parse(lead.data||'{}') : (lead.data||{});
    const range = budgetRanges[data.budget];
    if (!range) continue;
    const priceMatch = listing.price >= range.min && listing.price <= range.max;
    const areaMatch = !data.area || data.area === 'open' || data.area === listing.area;
    if (priceMatch && areaMatch) {
      const lang = lead.language || 'en';
      const msg = lang === 'ar'
        ? `مرحباً ${lead.name}! 🏠 عقار جديد يناسب معاييرك:\n\n*${listing.title}*\n💰 AED ${listing.price?.toLocaleString()}\n📍 ${listing.area}\n🛏 ${listing.beds} غرف\n\nهل تريد تحديد موعد للمعاينة؟`
        : `Hi ${lead.name}! 🏠 New listing matching your criteria:\n\n*${listing.title}*\n💰 AED ${listing.price?.toLocaleString()}\n📍 ${listing.area}\n🛏 ${listing.beds} beds | 📐 ${listing.size_sqft} sqft\n${listing.listing_url ? '\n🔗 ' + listing.listing_url : ''}\n\nWould you like to schedule a viewing? Reply YES`;
      try {
        await sendText(lead.wa_number, msg);
        notified++;
        await new Promise(r => setTimeout(r, 500));
      } catch(e) { console.error('[Property Match] Send failed:', e.message); }
    }
  }
  console.log(`[Property Match] Notified ${notified} matching leads for listing: ${listing.title}`);
  return notified;
}

app.get('/api/listings', async (_req, res) => {
  res.json(await db.getAllListings());
});

app.post('/api/listings', async (req, res) => {
  const b = req.body;
  const listing = {
    title: b.title || '', type: b.type || 'apartment', area: b.area || '',
    price: b.price || 0, beds: b.beds || 0, baths: b.baths || 0,
    size_sqft: b.size_sqft || 0, description: b.description || '',
    image_url: b.image_url || '', listing_url: b.listing_url || '',
    status: b.status || 'available',
  };
  const result = await db.saveListing(listing);
  res.json({ ok: true, id: result.id });
  notifyMatchingLeads({ ...listing, id: result.id }).catch(e => console.error('[Property Match]', e.message));
});

app.put('/api/listings/:id', async (req, res) => {
  await db.updateListing(req.params.id, req.body);
  res.json({ ok: true });
});

app.delete('/api/listings/:id', async (req, res) => {
  await db.deleteListing(req.params.id);
  res.json({ ok: true });
});

// ── API: appointments ─────────────────────────────────────────────────────────
app.get('/api/appointments', async (_req, res) => {
  res.json(await db.getAppointments());
});

app.post('/api/appointments', async (req, res) => {
  const b = req.body;
  const result = await db.saveAppointment({
    lead_id: b.lead_id || null, wa_number: b.wa_number,
    slot_date: b.slot_date, slot_time: b.slot_time, notes: b.notes || '',
  });
  res.json({ ok: true, id: result.id });
});

app.put('/api/appointments/:id/status', async (req, res) => {
  await db.updateAppointmentStatus(req.params.id, req.body.status);
  res.json({ ok: true });
});

app.get('/api/availability', async (_req, res) => {
  const { getAvailableSlots } = require('./utils/appointmentHandler');
  res.json(await getAvailableSlots(7));
});

// ── API: agents ───────────────────────────────────────────────────────────────
app.get('/api/agents', async (_req, res) => {
  res.json(await db.getAgents());
});

app.post('/api/agents', async (req, res) => {
  const b = req.body;
  const result = await db.saveAgent({ name: b.name, wa_number: b.wa_number, email: b.email || '', role: b.role || 'agent' });
  res.json({ ok: true, id: result.id });
});

app.put('/api/agents/:id', async (req, res) => {
  const b = req.body;
  await db.updateAgent(req.params.id, { name: b.name, email: b.email || '', role: b.role, status: b.status || 'active' });
  res.json({ ok: true });
});

app.delete('/api/agents/:id', async (req, res) => {
  await db.deleteAgent(req.params.id);
  res.json({ ok: true });
});

app.post('/api/leads/:id/assign', async (req, res) => {
  await db.updateLeadAgent(req.params.id, req.body.agent_wa_number);
  res.json({ ok: true });
});

// ── API: human takeover / release ─────────────────────────────────────────────
app.post('/api/leads/:waNumber/takeover', async (req, res) => {
  const waNumber = req.params.waNumber;
  try {
    const session = await db.getSession(waNumber);
    if (!session) return res.status(404).json({ success: false, message: 'No active session found for this number' });
    await db.setHumanMode(waNumber, true, process.env.OWNER_WHATSAPP);
    const leads = await db.getAllLeads();
    const lead  = leads.find(l => l.wa_number === waNumber);
    if (lead) await db.updateLeadStatus(lead.id, 'contacted');
    const leadName = (session.data || {}).name || waNumber;
    const owner    = process.env.OWNER_WHATSAPP;
    await sendText(waNumber, 'You are now connected with our agent who will assist you directly.').catch(() => {});
    if (owner) {
      await sendText(owner, `You have taken over chat with ${leadName} (${waNumber}). Reply DONE ${waNumber} when finished.`).catch(() => {});
    }
    res.json({ success: true, message: 'Takeover successful' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post('/api/leads/:waNumber/release', async (req, res) => {
  const waNumber = req.params.waNumber;
  try {
    await db.setHumanMode(waNumber, false, null);
    const owner = process.env.OWNER_WHATSAPP;
    await sendText(waNumber, "Thank you for chatting with us! Our assistant is back to help you. Type 'menu' to see options.").catch(() => {});
    if (owner) {
      await sendText(owner, `Chat with ${waNumber} returned to bot.`).catch(() => {});
    }
    res.json({ success: true, message: 'Released to bot' });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── API: Agent Media Sharing ──────────────────────────────────────────────────
app.post('/api/leads/:waNumber/send-media', async (req, res) => {
  const { waNumber } = req.params;
  const { mediaUrl, caption, mediaType } = req.body;
  if (!mediaUrl) return res.status(400).json({ error: 'mediaUrl required' });
  try {
    await sendImage(waNumber, mediaUrl, caption || '');
    await db.saveMessage(waNumber, 'outbound', mediaType || 'image', caption || '[media]', { mediaUrl }).catch(() => {});
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/leads/:waNumber/send-property', async (req, res) => {
  const { waNumber } = req.params;
  const { listingId } = req.body;
  if (!listingId) return res.status(400).json({ error: 'listingId required' });
  try {
    const listings = await db.getAllListings();
    const listing = listings.find(l => String(l.id) === String(listingId));
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    const lead = await db.getLead(waNumber);
    const lang = lead?.language || 'en';
    await sendPropertyCard(waNumber, listing, lang);
    await db.saveMessage(waNumber, 'outbound', 'text', `[Property Card: ${listing.title}]`, {}).catch(() => {});
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── API: reports ──────────────────────────────────────────────────────────────
app.get('/api/reports/send-daily', async (_req, res) => {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return res.status(400).json({ success: false, message: 'SMTP not configured — set SMTP_USER and SMTP_PASS in .env' });
  }
  try {
    const leads = await db.getAllLeads();
    const stats = await db.getLeadStats();
    const agents = await db.getAgents();
    const recipients = [];

    for (const agent of agents) {
      if (agent.email) {
        await sendDailyReport(agent.email, agent.name, leads, stats);
        recipients.push(agent.email);
      }
    }
    const notificationEmails = (process.env.NOTIFICATION_EMAIL || '')
      .split(',')
      .map(e => e.trim())
      .filter(e => e.length > 0);

    for (const email of notificationEmails) {
      await sendDailyReport(email, 'Team', leads, stats);
      recipients.push(email);
    }

    res.json({ success: true, sent: recipients.length, recipients });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get('/api/reports', (_req, res) => {
  res.json(listReports());
});

app.get('/api/reports/generate', async (_req, res) => {
  try {
    const result = await generateReport();
    res.json({ ok: true, filename: result.filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/:filename', (req, res) => {
  const file = path.join(REPORTS_DIR, req.params.filename);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(file);
});

// ── Facebook Lead Ads — shared processor ──────────────────────────────────────
async function processFacebookLead(payload) {
  try {
    const fields = payload.field_data || [];
    const phoneField = fields.find(f =>
      f.name === 'phone_number' ||
      f.name === 'whatsapp_number' ||
      f.name === 'phone'
    );
    const nameField  = fields.find(f => f.name === 'full_name' || f.name === 'first_name');
    const emailField = fields.find(f => f.name === 'email');

    if (!phoneField) {
      console.log('[FB Lead] No phone number in lead form — skipping WhatsApp');
    }

    let waNumber = phoneField ? phoneField.values[0].replace(/[^0-9]/g, '') : null;
    if (waNumber && waNumber.startsWith('0')) {
      waNumber = '971' + waNumber.slice(1);
    }

    const name     = nameField  ? nameField.values[0]  : 'Facebook Lead';
    const email    = emailField ? emailField.values[0] : null;
    const source   = payload.ad_name ? `Facebook Ad: ${payload.ad_name}` : 'Facebook Lead Ad';
    const campaign = payload.campaign_name || 'Unknown Campaign';

    console.log(`[FB Lead] New lead: ${name} (${waNumber}) from campaign: ${campaign}`);

    await db.saveLead(waNumber || `fb_${Date.now()}`, name, 'new', 0, {
      source, campaign, email,
      ad_id:    payload.ad_id,
      form_id:  payload.form_id,
      interest: 'buy',
      channel:  'facebook',
    }, 'en');

    if (waNumber) {
      const clientName = process.env.CLIENT_NAME || 'Our Agency';
      const greeting = `Hello ${name}! 👋\n\nThank you for your interest in ${clientName}. We received your enquiry from our Facebook ad.\n\nI'm your AI property assistant and I'm here to help you find your perfect property in Dubai.\n\nTo get started, what are you looking for?\n\n1. Buy a Property\n2. Rent a Property\n3. Sell My Property\n\nReply with a number to choose`;

      await sendText(waNumber, greeting);
      console.log(`[FB Lead] WhatsApp sent to ${waNumber}`);

      await db.saveSession(waNumber, {
        flow:       process.env.ACTIVE_FLOW || 'realEstate',
        step:       'ASK_PROPERTY_TYPE',
        data:       { name, source, campaign, email },
        language:   'en',
        human_mode: false,
      });
    }

    const baseScore = 6;
    await db.updateLeadScore(waNumber || `fb_${Date.now()}`, baseScore);
    console.log(`[FB Lead] Processed successfully — ${name}`);
  } catch (e) {
    console.error('[FB Lead] Processing error:', e.message);
  }
}

// ── GET /webhook/facebook — Meta webhook verification ─────────────────────────
app.get('/webhook/facebook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.FB_VERIFY_TOKEN) {
    console.log('[FB Webhook] Verified successfully');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ── Instagram DM processor ────────────────────────────────────────────────────
async function processInstagramDM(senderId, text) {
  try {
    console.log(`[Instagram] DM from ${senderId}: ${text}`);
    await db.saveLead(senderId, 'Instagram User', 'new', 5, {
      source: 'Instagram DM',
      channel: 'instagram',
      ig_sender_id: senderId,
      first_message: text
    }, 'en');
    console.log(`[Instagram] Lead saved — manual follow-up required for IG sender ${senderId}`);
  } catch(e) { console.error('[Instagram] processInstagramDM error:', e.message); }
}

// ── POST /webhook/facebook — receive Meta Lead Ads + Instagram DMs ────────────
app.post('/webhook/facebook', (req, res) => {
  res.sendStatus(200); // respond immediately — Meta requires fast response
  try {
    const entry  = req.body.entry?.[0];
    if (!entry) return;

    // Instagram DM handling
    if (entry.messaging) {
      for (const msg of entry.messaging) {
        if (msg.message && msg.message.text) {
          processInstagramDM(msg.sender.id, msg.message.text).catch(e => console.error('[Instagram] Error:', e.message));
        }
      }
      return;
    }

    const change = entry?.changes?.[0];
    if (!change) return;

    const value = change.value || {};
    if (!value.leadgen_id) return;

    const payload = {
      field_data:    value.field_data    || [],
      ad_id:         value.ad_id         || null,
      form_id:       value.form_id       || null,
      page_id:       value.page_id       || null,
      campaign_name: value.campaign_name || null,
      ad_name:       value.ad_name       || null,
    };

    processFacebookLead(payload).catch(e => console.error('[FB Webhook] Error:', e.message));
  } catch (e) {
    console.error('[FB Webhook] Parse error:', e.message);
  }
});

// ── POST /webhook/google-lead — Google Ads Lead Form webhook ──────────────────
app.post('/webhook/google-lead', (req, res) => {
  res.sendStatus(200); // respond immediately
  processGoogleLead(req.body).catch(e => console.error('[Google Lead] Error:', e.message));
});

async function processGoogleLead(body) {
  try {
    // Support both Google Ads Lead Form Extension format and simple format
    let name, phone, email;
    const columns = body.user_column_data;
    if (Array.isArray(columns)) {
      // Native Google Ads Lead Form Extension format
      const get = (colName) => columns.find(c => c.column_name === colName)?.string_value || '';
      name  = get('Full Name')     || get('full_name')     || 'Google Lead';
      phone = get('Phone number')  || get('phone_number')  || get('phone') || '';
      email = get('Email')         || get('email')         || '';
    } else {
      // Simple/legacy format
      name  = body.name  || 'Google Lead';
      phone = body.phone || '';
      email = body.email || '';
    }

    let waNumber = phone.replace(/[^0-9]/g, '');
    if (waNumber.startsWith('0')) waNumber = '971' + waNumber.slice(1);

    const campaignId = body.campaign_id || body.campaign_name || body.campaign || 'Google Ad';
    const source     = `Google Ad: ${campaignId}`;

    console.log(`[Google Lead] New lead: ${name} (${waNumber}) campaign: ${campaignId}`);

    await db.saveLead(waNumber || `google_${Date.now()}`, name, 'new', 6, {
      source, campaign: campaignId, email,
      ad_id:    body.creative_id || body.ad_id || null,
      form_id:  body.form_id     || null,
      lead_id:  body.lead_id     || null,
      interest: 'buy',
      channel:  'google_ads',
    }, 'en');

    if (waNumber) {
      const clientName = process.env.CLIENT_NAME || 'Our Agency';
      await sendText(waNumber,
        `Hello ${name}! 👋\n\nThank you for your interest in ${clientName} from our Google ad.\n\nI'm your AI property assistant. What are you looking for?\n\n1. Buy a Property\n2. Rent a Property\n3. Sell My Property\n\nReply with a number to choose`
      ).catch(() => {});
    }

    console.log(`[Google Lead] Processed: ${name}`);
  } catch(e) {
    console.error('[Google Lead] Processing error:', e.message);
  }
}

// ── POST /webhook/email-lead — Property Finder / Bayut email parser ──────────
app.post('/webhook/email-lead', async (req, res) => {
  res.json({ success: true });
  try {
    const { from: senderEmail, subject, body: emailBody, source: rawSource } = req.body;
    if (!emailBody) return;
    const source = rawSource ||
      (senderEmail?.includes('propertyfinder') ? 'Property Finder' :
       senderEmail?.includes('bayut') ? 'Bayut' : 'Email Lead');
    const phoneMatch = emailBody.match(/(\+?971[\s-]?\d{2}[\s-]?\d{3}[\s-]?\d{4}|\+?9\d{9,12})/);
    const nameMatch  = emailBody.match(/Name:\s*([^\n]+)/i) || emailBody.match(/From:\s*([^\n<]+)/i);
    const phone = phoneMatch ? phoneMatch[1] : null;
    const name  = nameMatch  ? nameMatch[1].trim() : 'Email Lead';
    let waNumber = phone ? phone.replace(/[^0-9]/g, '') : null;
    if (waNumber && waNumber.startsWith('0')) waNumber = '971' + waNumber.slice(1);
    if (!waNumber) { console.log(`[EmailLead] No phone in email from ${senderEmail}`); return; }
    await db.saveLead(waNumber, name, 'new', 6, {
      source, channel: 'email', email_subject: subject,
      raw_email: emailBody.slice(0, 500)
    }, 'en');
    const clientName = process.env.CLIENT_NAME || 'Our Agency';
    await sendText(waNumber,
      `Hello ${name}! 👋\n\nThank you for your property enquiry via ${source}. I'm the AI assistant for ${clientName}.\n\nTo help you find the perfect property, what are you looking for?\n\n1. Buy a Property\n2. Rent a Property\n3. Sell My Property\n\nReply with a number to choose`
    ).catch(() => {});
    console.log(`[EmailLead] Lead captured: ${name} (${waNumber}) from ${source}`);
  } catch(e) { console.error('[EmailLead] Error:', e.message); }
});

// ── GET /api/setup/email-forwarding — setup instructions ─────────────────────
app.get('/api/setup/email-forwarding', (_req, res) => {
  const baseUrl = process.env.RENDER_URL || `http://localhost:${process.env.PORT || 3000}`;
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html><html><head><title>Email Forwarding Setup</title>
<style>body{font-family:sans-serif;max-width:800px;margin:40px auto;padding:0 20px;color:#333}
h1{color:#3D7FFA}h2{margin-top:32px}code{background:#f4f4f4;padding:2px 6px;border-radius:4px;font-size:13px}
pre{background:#f4f4f4;padding:16px;border-radius:8px;overflow-x:auto}
.step{background:#fff;border:1px solid #e4e9f2;border-radius:8px;padding:16px;margin:12px 0}
</style></head><body>
<h1>📧 Email Lead Forwarding Setup</h1>
<p>When Property Finder or Bayut sends you a lead enquiry email, forward it to your bot via webhook.</p>
<h2>Webhook Endpoint</h2>
<pre>POST ${baseUrl}/webhook/email-lead</pre>
<h2>Method 1 — Zapier / Make (Recommended)</h2>
<div class="step"><b>Step 1:</b> Create a Zapier account at zapier.com</div>
<div class="step"><b>Step 2:</b> Trigger: Gmail → "New Email matching search" → from:propertyfinder.ae OR from:bayut.com</div>
<div class="step"><b>Step 3:</b> Action: Webhooks by Zapier → POST to <code>${baseUrl}/webhook/email-lead</code></div>
<div class="step"><b>Step 4:</b> Map fields: from=sender, subject=subject, body=body_plain, source=Property Finder</div>
<h2>Method 2 — Gmail Filter + Forward</h2>
<div class="step"><b>Step 1:</b> In Gmail, create a filter for emails from propertyfinder.ae or bayut.com</div>
<div class="step"><b>Step 2:</b> Set the filter to forward to a Zapier/Make email webhook address</div>
<div class="step"><b>Step 3:</b> The Zapier/Make webhook posts to <code>${baseUrl}/webhook/email-lead</code></div>
<h2>Test your webhook</h2>
<pre>curl -X POST ${baseUrl}/webhook/email-lead \\
  -H "Content-Type: application/json" \\
  -d '{"from":"enquiry@propertyfinder.ae","subject":"New Enquiry","body":"Name: Ahmed\\nPhone: +971501234567","source":"Property Finder"}'</pre>
</body></html>`);
});

// ── POST /webhook/web-form — website lead capture ────────────────────────────
app.post('/webhook/web-form', async (req, res) => {
  res.json({ success: true });
  try {
    const { name, phone, email, message, source, page_url } = req.body;
    let waNumber = (phone || '').replace(/[^0-9]/g, '');
    if (waNumber.startsWith('0')) waNumber = '971' + waNumber.slice(1);
    if (!waNumber) { console.log('[WebForm] No phone number'); return; }
    const leadName = name || 'Website Lead';
    await db.saveLead(waNumber, leadName, 'new', 5, {
      source: source || 'Website',
      email: email || null,
      message: message || null,
      page_url: page_url || null,
      channel: 'web_form'
    }, 'en');
    const clientName = process.env.CLIENT_NAME || 'Our Agency';
    await sendText(waNumber,
      `Hello ${leadName}! 👋\n\nThank you for your enquiry on ${clientName}'s website.\n\nI'm your AI property assistant. To help you find the perfect property, what are you looking for?\n\n1. Buy a Property\n2. Rent a Property\n3. Sell My Property\n\nReply with a number to choose`
    ).catch(() => {});
    console.log(`[WebForm] Lead captured: ${leadName} (${waNumber}) from ${page_url||'website'}`);
  } catch(e) { console.error('[WebForm] Error:', e.message); }
});

// ── GET /snippet/web-form.js — embed script for client websites ───────────────
app.get('/snippet/web-form.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  const baseUrl = process.env.RENDER_URL || `http://localhost:${process.env.PORT || 3000}`;
  res.send(`
(function() {
  var forms = document.querySelectorAll('form');
  forms.forEach(function(form) {
    form.addEventListener('submit', function(e) {
      var data = new FormData(form);
      var obj = {};
      data.forEach(function(v,k){ obj[k]=v; });
      obj.page_url = window.location.href;
      obj.source = 'Website';
      fetch('${baseUrl}/webhook/web-form', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(obj)
      });
    });
  });
})();
  `);
});

// ── POST /api/test/facebook-lead — simulate a Facebook lead for testing ───────
app.post('/api/test/facebook-lead', async (req, res) => {
  const { name = 'Test User', phone = '971501234567', campaign = 'Test Campaign' } = req.body;
  const waNumber = phone.replace(/[^0-9]/g, '');

  const payload = {
    field_data: [
      { name: 'full_name',    values: [name] },
      { name: 'phone_number', values: [phone] },
    ],
    ad_name:       'Test Ad',
    campaign_name: campaign,
    ad_id:         'test_ad_id',
    form_id:       'test_form_id',
  };

  await processFacebookLead(payload);
  res.json({ success: true, waNumber, name });
});

// ── API: Referral Links ───────────────────────────────────────────────────────
app.get('/api/agents/:agentId/referral-link', async (req, res) => {
  try {
    const { agentId } = req.params;
    const waNumber = (process.env.TWILIO_WHATSAPP_NUMBER || '+14155238886').replace('+','');
    const refCode = `REF-${agentId}`;
    const link = `https://wa.me/${waNumber}?text=${encodeURIComponent(refCode)}`;
    const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(link)}`;
    res.json({ link, qrCodeUrl, refCode });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/referral/:agentId', (req, res) => {
  const { agentId } = req.params;
  const waNumber = (process.env.TWILIO_WHATSAPP_NUMBER || '+14155238886').replace('+','');
  const refCode = `REF-${agentId}`;
  const link = `https://wa.me/${waNumber}?text=${encodeURIComponent(refCode)}`;
  res.redirect(302, link);
});

// ── API: Agent Performance Leaderboard ───────────────────────────────────────
app.get('/api/agents/performance', async (_req, res) => {
  try {
    const [agents, leads] = await Promise.all([db.getAgents(), db.getAllLeads()]);
    const perf = agents.map(agent => {
      const agentLeads = leads.filter(l => l.agent_wa_number === agent.wa_number);
      const totalLeads = agentLeads.length;
      const hotLeads = agentLeads.filter(l => (l.score||0) >= 8).length;
      const converted = agentLeads.filter(l => l.status === 'converted').length;
      const conversionRate = totalLeads > 0 ? Math.round(converted / totalLeads * 100) : 0;
      const avgScore = totalLeads > 0 ? Math.round(agentLeads.reduce((s,l) => s+(l.score||0),0) / totalLeads * 10) / 10 : 0;
      return { id: agent.id, name: agent.name, wa_number: agent.wa_number, email: agent.email,
               totalLeads, hotLeads, converted, conversionRate, avgScore };
    });
    perf.sort((a,b) => b.conversionRate - a.conversionRate);
    perf.forEach((p,i) => p.rank = i + 1);
    res.json(perf);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── API: Re-engagement ────────────────────────────────────────────────────────
app.get('/api/reengagement/run', async (_req, res) => {
  try {
    const { runReengagement } = require('./utils/reengagementEngine');
    const sent = await runReengagement();
    res.json({ ok: true, sent: sent || 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── API: DB status ────────────────────────────────────────────────────────────
app.get('/api/db-status', (_req, res) => {
  const states = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
  res.json({
    status:    states[mongoose.connection.readyState] || 'unknown',
    readyState: mongoose.connection.readyState,
    database:  mongoose.connection.name || null,
  });
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status:  'ok',
    uptime:  process.uptime(),
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Server] ${process.env.CLIENT_NAME || 'WhatsApp Bot'} running on port ${PORT}`);
  console.log(`[Server] Dashboard → http://localhost:${PORT}/dashboard`);
  startScheduler();
});
