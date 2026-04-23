require('dotenv').config();

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const { handleMessage } = require('./flows/flowEngine');
const { markAsRead, sendText }    = require('./whatsapp/api');
const db = require('./db/database');
const { startScheduler }     = require('./utils/scheduler');
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

  try {
    const from   = (req.body.From || '').replace('whatsapp:+', '');
    const msgSid = req.body.MessageSid;
    const bodyText = req.body.Body || '';
    const numMedia = parseInt(req.body.NumMedia || '0', 10);

    if (!from || !msgSid) return;
    if (dedup(msgSid)) return;

    markAsRead(msgSid); // no-op for Twilio

    const isAudio = numMedia > 0 && (req.body.MediaContentType0 || '').startsWith('audio');

    if (isAudio) {
      // ── Voice note handling ──────────────────────────────────────────────
      (async () => {
        try {
          if (!process.env.OPENAI_API_KEY || process.env.VOICE_ENABLED === 'false') {
            await sendText(from, 'Sorry, voice messages are not supported yet. Please type your message.').catch(() => {});
            return;
          }

          const voiceSession = db.getSession.get(from);
          if (voiceSession && voiceSession.human_mode === 1) {
            const agentNum = voiceSession.agent_number || process.env.OWNER_WHATSAPP;
            if (agentNum) {
              const vName = (() => {
                try { return JSON.parse(voiceSession.collected_data || '{}').name || from; }
                catch (_) { return from; }
              })();
              sendText(agentNum, `[${vName}]: [sent a voice note]`).catch(() => {});
            }
            return;
          }

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
          try { db.saveMessage.run({ wa_number: from, direction: 'inbound', message_type: 'audio', content: transcript, raw_data: JSON.stringify({ MessageSid: msgSid, MediaUrl: req.body.MediaUrl0 }) }); } catch (_) {}

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
      })();
      return;
    }

    // ── Text message ─────────────────────────────────────────────────────────
    const parsed = {
      from,
      id:       msgSid,
      type:     'text',
      text:     bodyText,
      buttonId: null,
      listId:   null,
    };

    try { db.saveMessage.run({ wa_number: from, direction: 'inbound', message_type: 'text', content: bodyText, raw_data: JSON.stringify(req.body) }); } catch (_) {}

    // ── Human handoff logic ──────────────────────────────────────────────────
    const owner       = process.env.OWNER_WHATSAPP;
    const rawText     = bodyText.trim();
    const isFromOwner = owner && from === owner;

    if (isFromOwner) {
      // TAKE <number>
      if (rawText.toUpperCase().startsWith('TAKE ')) {
        const targetNum = rawText.slice(5).trim();
        const session   = db.getSession.get(targetNum);
        if (!session) {
          sendText(owner, `❌ No active session found for ${targetNum}.`).catch(() => {});
        } else {
          db.setHumanMode.run({ wa_number: targetNum, human_mode: 1, agent_number: owner });
          const leadName = (() => {
            try { return JSON.parse(session.collected_data || '{}').name || targetNum; }
            catch (_) { return targetNum; }
          })();
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
        db.setHumanMode.run({ wa_number: targetNum, human_mode: 0, agent_number: null });
        const leads = db.getAllLeads.all();
        const lead  = leads.find((l) => l.wa_number === targetNum);
        if (lead) db.updateLeadStatus.run({ id: lead.id, status: 'contacted' });
        sendText(targetNum, 'Thank you for chatting with us! Have a great day. 😊').catch(() => {});
        sendText(owner, `✅ Conversation with ${targetNum} ended. Status set to contacted.`).catch(() => {});
        return;
      }

      // Owner typing normally — forward if they have an active human-mode session
      const humanSession = db.getSessionByAgent.get(owner);
      if (humanSession) {
        sendText(humanSession.wa_number, rawText).catch(() => {});
        return;
      }
    }

    // ── Customer in human mode → forward to owner ────────────────────────────
    if (!isFromOwner) {
      const session = db.getSession.get(from);
      if (session && session.human_mode === 1) {
        const name = (() => {
          try { return JSON.parse(session.collected_data || '{}').name || from; }
          catch (_) { return from; }
        })();
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

  } catch (err) {
    console.error('[Webhook Parse Error]', err.message);
  }
});

// ── Dashboard ─────────────────────────────────────────────────────────────────
app.get('/dashboard', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
});

// ── API: all leads ────────────────────────────────────────────────────────────
app.get('/api/leads', (_req, res) => {
  const leads = db.getAllLeads.all().map((l) => ({
    ...l,
    data: (() => { try { return JSON.parse(l.data || '{}'); } catch (_) { return {}; } })(),
  }));

  // Attach human_mode from sessions
  const sessions = {};
  try {
    db.db.prepare('SELECT wa_number, human_mode FROM sessions').all()
      .forEach((s) => { sessions[s.wa_number] = s.human_mode; });
  } catch (_) {}

  leads.forEach((l) => {
    l.human_mode = sessions[l.wa_number] || 0;
  });

  res.json(leads);
});

// ── API: stats ────────────────────────────────────────────────────────────────
app.get('/api/stats', (_req, res) => {
  res.json(db.getStats.get());
});

// ── API: update lead status ───────────────────────────────────────────────────
app.post('/api/leads/:id/status', (req, res) => {
  const { id }     = req.params;
  const { status } = req.body;
  const allowed    = ['new', 'contacted', 'converted', 'lost'];

  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  db.updateLeadStatus.run({ id, status });
  res.json({ ok: true });
});

// ── API: export leads as CSV ──────────────────────────────────────────────────
app.get('/api/leads/export', (req, res) => {
  const statusFilter = req.query.status;
  let leads = db.getAllLeads.all();

  if (statusFilter && statusFilter !== 'all') {
    leads = leads.filter((l) => l.status === statusFilter);
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="leads-${dateStr}.csv"`);

  const header = 'Date,Name,WhatsApp,Interest,Property Type,Budget,Area,Status,Score,Language\n';
  const rows = leads.map((l) => {
    let d = {};
    try { d = JSON.parse(l.data || '{}'); } catch (_) {}
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

  let leads = db.getAllLeads.all().map((l) => {
    let d = {};
    try { d = JSON.parse(l.data || '{}'); } catch (_) {}
    return { ...l, parsedData: d };
  });

  // Apply filters
  if (filter.status)    leads = leads.filter((l) => l.status    === filter.status);
  if (filter.score_min) leads = leads.filter((l) => (l.score || 0) >= filter.score_min);
  if (filter.area)      leads = leads.filter((l) => (l.parsedData.area || '').toLowerCase().includes(filter.area.toLowerCase()));
  if (filter.interest)  leads = leads.filter((l) => (l.parsedData.intent || '').toLowerCase() === filter.interest.toLowerCase());

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
app.get('/api/conversations', (_req, res) => {
  try {
    const convs = db.getRecentConversations.all(50);
    res.json(convs);
  } catch (e) { res.json([]); }
});

app.get('/api/conversations/:waNumber', (req, res) => {
  const msgs = db.getMessages.all(decodeURIComponent(req.params.waNumber));
  res.json(msgs);
});

app.get('/api/conversations/:waNumber/lead', (req, res) => {
  const wa = decodeURIComponent(req.params.waNumber);
  const leads = db.getAllLeads.all().filter(l => l.wa_number === wa);
  if (!leads.length) return res.status(404).json({ error: 'Not found' });
  res.json(leads[0]);
});

// ── API: pipeline ─────────────────────────────────────────────────────────────
app.get('/api/pipeline', (_req, res) => {
  const leads = db.getAllLeads.all().map(l => {
    // Derive pipeline_stage from status if not set
    if (!l.pipeline_stage || l.pipeline_stage === 'null') {
      const map = { new: 'new_lead', contacted: 'ai_contacted', converted: 'won', lost: 'lost' };
      l.pipeline_stage = map[l.status] || 'new_lead';
    }
    return l;
  });
  const grouped = {};
  for (const l of leads) {
    const s = l.pipeline_stage;
    if (!grouped[s]) grouped[s] = [];
    grouped[s].push(l);
  }
  res.json(grouped);
});

app.post('/api/leads/:id/stage', (req, res) => {
  const { stage } = req.body;
  db.updateLeadPipelineStage.run({ id: req.params.id, stage });
  res.json({ ok: true });
});

// ── API: analytics ────────────────────────────────────────────────────────────
app.get('/api/analytics', (req, res) => {
  const { from, to } = req.query;
  let leads = db.getAllLeads.all();
  if (from) leads = leads.filter(l => l.created_at >= from);
  if (to)   leads = leads.filter(l => l.created_at <= to + ' 23:59:59');

  const total     = leads.length;
  const converted = leads.filter(l => l.status === 'converted').length;
  const avgScore  = total ? Math.round(leads.reduce((s, l) => s + (l.score || 0), 0) / total * 10) / 10 : 0;

  const byArea = {}, byBudget = {}, byInterest = {}, scoreDistribution = {}, hourly = {};
  let arabic = 0, english = 0, voice = 0, text = 0;

  for (const l of leads) {
    let d = {}; try { d = JSON.parse(l.data || '{}'); } catch (_) {}
    if (d.area)     byArea[d.area]     = (byArea[d.area] || 0) + 1;
    if (d.budget)   byBudget[d.budget] = (byBudget[d.budget] || 0) + 1;
    if (d.intent)   byInterest[d.intent] = (byInterest[d.intent] || 0) + 1;
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
app.get('/api/settings', (_req, res) => {
  const rows = db.getAllSettings.all();
  const obj  = {};
  rows.forEach(r => { obj[r.key] = r.value; });
  res.json(obj);
});

app.post('/api/settings', (req, res) => {
  const data = req.body;
  if (typeof data !== 'object') return res.status(400).json({ error: 'Expected JSON object' });
  for (const [key, value] of Object.entries(data)) {
    db.upsertSetting.run({ key, value: String(value) });
  }
  res.json({ ok: true });
});

// ── API: lead detail ──────────────────────────────────────────────────────────
app.get('/api/leads/:id/detail', (req, res) => {
  const { id } = req.params;
  const lead = db.getAllLeads.all().find(l => l.id == id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  const messages    = db.getMessages.all(lead.wa_number);
  const notes       = db.getNotes.all(id);
  const lastMessage = messages[messages.length - 1] || null;
  res.json({ lead, messages, notes, lastMessage });
});

app.post('/api/leads/:id/notes', (req, res) => {
  const { note } = req.body;
  if (!note) return res.status(400).json({ error: 'note required' });
  const result = db.insertNote.run({ lead_id: req.params.id, note });
  res.json({ ok: true, id: result.lastInsertRowid });
});

app.delete('/api/leads/:id/notes/:noteId', (req, res) => {
  db.deleteNote.run(req.params.noteId, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/leads/:id', (req, res) => {
  db.db.prepare('DELETE FROM leads WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── API: listings ─────────────────────────────────────────────────────────────
app.get('/api/listings', (_req, res) => {
  res.json(db.getAllListings.all());
});

app.post('/api/listings', (req, res) => {
  const b = req.body;
  const result = db.insertListing.run({
    title: b.title || '', type: b.type || 'apartment', area: b.area || '',
    price: b.price || 0, beds: b.beds || 0, baths: b.baths || 0,
    size_sqft: b.size_sqft || 0, description: b.description || '',
    image_url: b.image_url || '', listing_url: b.listing_url || '',
    status: b.status || 'available',
  });
  res.json({ ok: true, id: result.lastInsertRowid });
});

app.put('/api/listings/:id', (req, res) => {
  const b = req.body;
  db.updateListing.run({ ...b, id: req.params.id });
  res.json({ ok: true });
});

app.delete('/api/listings/:id', (req, res) => {
  db.deleteListing.run(req.params.id);
  res.json({ ok: true });
});

// ── API: appointments ─────────────────────────────────────────────────────────
app.get('/api/appointments', (_req, res) => {
  res.json(db.getAllAppointments.all());
});

app.post('/api/appointments', (req, res) => {
  const b = req.body;
  const result = db.insertAppointment.run({
    lead_id: b.lead_id || null, wa_number: b.wa_number,
    slot_date: b.slot_date, slot_time: b.slot_time, notes: b.notes || '',
  });
  res.json({ ok: true, id: result.lastInsertRowid });
});

app.put('/api/appointments/:id/status', (req, res) => {
  db.updateAppointmentStatus.run({ id: req.params.id, status: req.body.status });
  res.json({ ok: true });
});

app.get('/api/availability', (_req, res) => {
  const { getAvailableSlots } = require('./utils/appointmentHandler');
  res.json(getAvailableSlots(7));
});

// ── API: agents ───────────────────────────────────────────────────────────────
app.get('/api/agents', (_req, res) => {
  res.json(db.getAllAgents.all());
});

app.post('/api/agents', (req, res) => {
  const b = req.body;
  const result = db.insertAgent.run({ name: b.name, wa_number: b.wa_number, email: b.email || '', role: b.role || 'agent' });
  res.json({ ok: true, id: result.lastInsertRowid });
});

app.put('/api/agents/:id', (req, res) => {
  const b = req.body;
  db.updateAgent.run({ id: req.params.id, name: b.name, email: b.email || '', role: b.role, status: b.status || 'active' });
  res.json({ ok: true });
});

app.delete('/api/agents/:id', (req, res) => {
  db.deleteAgent.run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/leads/:id/assign', (req, res) => {
  db.updateLeadAgent.run({ id: req.params.id, agent_wa_number: req.body.agent_wa_number });
  res.json({ ok: true });
});

// ── API: reports ──────────────────────────────────────────────────────────────
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

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Server] ${process.env.CLIENT_NAME || 'WhatsApp Bot'} running on port ${PORT}`);
  console.log(`[Server] Dashboard → http://localhost:${PORT}/dashboard`);
  startScheduler();
});
