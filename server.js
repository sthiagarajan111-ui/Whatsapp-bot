require('dotenv').config();

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const mongoose = require('mongoose');
const { handleMessage } = require('./flows/flowEngine');
const { markAsRead, sendText }    = require('./whatsapp/api');
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
app.get('/api/listings', async (_req, res) => {
  res.json(await db.getAllListings());
});

app.post('/api/listings', async (req, res) => {
  const b = req.body;
  const result = await db.saveListing({
    title: b.title || '', type: b.type || 'apartment', area: b.area || '',
    price: b.price || 0, beds: b.beds || 0, baths: b.baths || 0,
    size_sqft: b.size_sqft || 0, description: b.description || '',
    image_url: b.image_url || '', listing_url: b.listing_url || '',
    status: b.status || 'available',
  });
  res.json({ ok: true, id: result.id });
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
    if (process.env.NOTIFICATION_EMAIL) {
      await sendDailyReport(process.env.NOTIFICATION_EMAIL, 'Team', leads, stats);
      recipients.push(process.env.NOTIFICATION_EMAIL);
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
