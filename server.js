require('dotenv').config();

const express      = require('express');
const path         = require('path');
const fs           = require('fs');
const crypto       = require('crypto');
const cookieParser = require('cookie-parser');
const mongoose     = require('mongoose');
const { handleMessage } = require('./flows/flowEngine');
const { markAsRead, sendText, sendImage, sendPropertyCard } = require('./whatsapp/api');
const db = require('./db/database');
const { startScheduler, sendDailyReport } = require('./utils/scheduler');
const { processVoiceMessage } = require('./utils/voiceHandler');
const { generateReport, listReports, REPORTS_DIR } = require('./utils/reportGenerator');
const { getClientByWhatsAppNumber, getClientById, clearClientCache } = require('./middleware/clientResolver');
const Client = require('./db/models/Client');
const multer = require('multer');
const { getLeadCounterModel } = require('./db/models/LeadCounter');
const { getRecordingModel } = require('./db/models/Recording');
const uploadMiddleware = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Admin API key validation ──────────────────────────────────────────────────
if (process.env.ADMIN_API_KEY && process.env.ADMIN_API_KEY.length < 32) {
  console.warn('[Admin] WARNING: ADMIN_API_KEY should be at least 32 characters long');
}

// ── Helper: generate client_id slug ──────────────────────────────────────────
function generateClientId(companyName) {
  return companyName.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50) + '-' + Date.now().toString(36);
}

// ── Helper: generate API key ──────────────────────────────────────────────────
function generateApiKey() {
  return 'ax_' + crypto.randomBytes(24).toString('hex');
}

// ── Admin auth middleware ─────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const validKey = process.env.ADMIN_PASSWORD || process.env.ADMIN_API_KEY;
  const apiKey   = req.headers['x-api-key'] || req.query.admin_key;
  const sessionKey = req.cookies?.admin_session;

  if (apiKey === validKey || sessionKey === validKey) return next();

  // Return JSON for API calls, redirect for page requests
  if (req.path.startsWith('/admin/clients') || req.path.startsWith('/admin/stats') || req.path.startsWith('/admin/onboard')) {
    return res.status(401).json({ error: 'Unauthorized — invalid admin key' });
  }
  res.redirect('/admin/login');
}

app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Twilio sends form-encoded webhooks
app.use(cookieParser());

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

  // ── Resolve client (multi-tenant) ────────────────────────────────────────
  // The To field is the Twilio WhatsApp number that received the message
  let clientId = 'default';
  let clientConfig = null;

  if (process.env.MULTI_TENANT_MODE === 'true') {
    const toNumber = (req.body.To || '').replace('whatsapp:', '');
    if (toNumber) {
      clientConfig = await getClientByWhatsAppNumber(toNumber);
      if (clientConfig) {
        clientId = clientConfig.client_id;
        // If client is suspended, silently drop
        if (clientConfig.status !== 'active') return;
      }
    }
  }

  const isAudio = numMedia > 0 && (req.body.MediaContentType0 || '').startsWith('audio');

  if (isAudio) {
    // ── Voice note handling ──────────────────────────────────────────────
    if (!process.env.OPENAI_API_KEY || process.env.VOICE_ENABLED === 'false') {
      await sendText(from, 'Sorry, voice messages are not supported yet. Please type your message.').catch(() => {});
      return;
    }

    const voiceSession = await db.getSession(from, clientId);
    if (voiceSession && voiceSession.human_mode) {
      const agentNum = voiceSession.agent_number || (clientConfig?.owner_whatsapp || process.env.OWNER_WHATSAPP);
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
      try { await db.saveMessage(from, 'inbound', 'audio', transcript, { MessageSid: msgSid, MediaUrl: req.body.MediaUrl0 }, clientId); } catch (_) {}

      const syntheticParsed = {
        from,
        id:                msgSid,
        type:              'text',
        text:              transcript,
        buttonId:          null,
        listId:            null,
        clientId,
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
    clientId,
  };

  try { await db.saveMessage(from, 'inbound', 'text', bodyText, req.body, clientId); } catch (_) {}

  // ── Human handoff logic ──────────────────────────────────────────────────────
  const owner       = clientConfig?.owner_whatsapp || process.env.OWNER_WHATSAPP;
  const rawText     = bodyText.trim();
  const isFromOwner = owner && from === owner;

  if (isFromOwner) {
    // TAKE <number>
    if (rawText.toUpperCase().startsWith('TAKE ')) {
      const targetNum = rawText.slice(5).trim();
      const session   = await db.getSession(targetNum, clientId);
      if (!session) {
        sendText(owner, `❌ No active session found for ${targetNum}.`).catch(() => {});
      } else {
        await db.setHumanMode(targetNum, true, owner, clientId);
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
      await db.setHumanMode(targetNum, false, null, clientId);
      const leads = await db.getAllLeads(clientId);
      const lead  = leads.find((l) => l.wa_number === targetNum);
      if (lead) await db.updateLeadStatus(lead.id, 'contacted');
      sendText(targetNum, 'Thank you for chatting with us! Have a great day. 😊').catch(() => {});
      sendText(owner, `✅ Conversation with ${targetNum} ended. Status set to contacted.`).catch(() => {});
      return;
    }

    // Owner typing normally — forward if they have an active human-mode session
    const humanSession = await db.getSessionByAgent(owner, clientId);
    if (humanSession) {
      sendText(humanSession.wa_number, rawText).catch(() => {});
      return;
    }
  }

  // ── Customer in human mode → forward to owner ────────────────────────────
  if (!isFromOwner) {
    const session = await db.getSession(from, clientId);
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

// ── API: Lead ID search ───────────────────────────────────────────────────────
app.get('/api/leads/search', async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'] || 'default';
    const { q } = req.query;
    if (!q || q.trim().length < 2) return res.json({ leads: [] });
    const LeadModel = require('./db/models/Lead');
    const query = q.trim();
    const leads = await LeadModel.find({
      client_id: clientId,
      $or: [
        { lead_id:  new RegExp(query, 'i') },
        { name:     new RegExp(query, 'i') },
        { wa_number:new RegExp(query, 'i') },
      ]
    }).limit(10).lean();
    res.json({ leads });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── API: Lead profile by lead_id ──────────────────────────────────────────────
app.get('/api/leads/profile/:leadId', async (req, res) => {
  const routeTimeout = setTimeout(() => {
    if (!res.headersSent) {
      console.error('[Profile] Route timeout for leadId:', req.params.leadId);
      res.status(504).json({ error: 'Profile load timeout — please try again' });
    }
  }, 10000);

  try {
    const clientId = req.headers['x-client-id'] || 'default';
    const LeadModel        = require('./db/models/Lead');
    const MessageModel     = require('./db/models/Message');
    const AppointmentModel = require('./db/models/Appointment');

    const lead = await LeadModel.findOne({
      client_id: clientId,
      $or: [
        { lead_id: req.params.leadId },
        ...(mongoose.Types.ObjectId.isValid(req.params.leadId)
          ? [{ _id: req.params.leadId }] : [])
      ]
    }).lean();

    if (!lead) { clearTimeout(routeTimeout); return res.status(404).json({ error: 'Lead not found' }); }

    const [messages, appointments, recordings] = await Promise.all([
      MessageModel.find({ client_id: clientId, wa_number: lead.wa_number })
        .sort({ created_at: 1 }).lean()
        .catch(e => { console.error('[Profile] messages error:', e.message); return []; }),
      AppointmentModel.find({ client_id: clientId, wa_number: lead.wa_number })
        .sort({ appointment_date: 1 }).lean()
        .catch(e => { console.error('[Profile] appointments error:', e.message); return []; }),
      (async () => {
        try {
          const { getRecordingModel } = require('./db/models/Recording');
          const Rec = getRecordingModel(clientId);
          const waClean = lead.wa_number?.replace(/\D/g, '') || '';
          return await Rec.find({
            $or: [
              { wa_number: lead.wa_number },
              { wa_number: waClean },
              { wa_number: '+' + waClean },
              { lead_id: lead.lead_id }
            ]
          }).lean();
        } catch(e) {
          console.error('[Profile] recordings error:', e.message);
          return [];
        }
      })()
    ]);

    const timeline = [];

    messages.forEach(m => {
      const isManual = m.direction !== 'inbound' && (m.content || '').includes('Manual lead captured');
      timeline.push({
        type:      m.direction === 'inbound' ? 'message_in' : isManual ? 'manual' : 'message_out',
        tag:       m.direction === 'inbound' ? 'MSG' : isManual ? 'MANUAL' : 'AGENT',
        text:      m.content || '[media]',
        timestamp: m.created_at,
        meta:      { direction: m.direction, type: m.message_type }
      });
    });

    appointments.forEach(a => {
      timeline.push({
        type:      'appointment',
        tag:       'APPT',
        text:      `Appointment — ${a.time_slot || a.slot_time} · ${a.status}`,
        timestamp: a.created_at || a.appointment_date,
        meta:      { status: a.status, date: a.appointment_date_display, time_slot: a.time_slot }
      });
    });

    if ((lead.score || 0) >= 7) {
      timeline.push({
        type:      'score_change',
        tag:       'HOT',
        text:      `Score upgraded to HOT ${lead.score}/10`,
        timestamp: lead.updated_at || lead.created_at,
        meta:      { score: lead.score }
      });
    }

    timeline.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    const stats = {
      touchpoints:     messages.length,
      appointments:    appointments.length,
      recordingsCount: recordings.length,
      daysActive:      Math.ceil((new Date() - new Date(lead.created_at)) / (1000 * 60 * 60 * 24)),
      budget:          lead.budget || 0,
    };

    clearTimeout(routeTimeout);
    res.json({ lead, timeline, appointments, stats });
  } catch(e) {
    clearTimeout(routeTimeout);
    console.error('[Profile API]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Campaign Manager routes ───────────────────────────────────────────────────
app.get('/api/campaigns/leads-count', async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'] || 'default';
    const Lead = require('./db/models/Lead');
    const { score_min, score_max, stage, language, channel, days_inactive } = req.query;
    let filter = { client_id: clientId };
    if (score_min || score_max) {
      filter.score = {};
      if (score_min) filter.score.$gte = parseInt(score_min);
      if (score_max) filter.score.$lte = parseInt(score_max);
    }
    if (stage && stage !== 'all') filter.pipeline_stage = stage;
    if (language && language !== 'all') filter.language = new RegExp(language, 'i');
    if (channel && channel !== 'all') filter.channel = channel;
    if (days_inactive) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - parseInt(days_inactive));
      filter.updated_at = { $lte: cutoff };
    }
    const leads = await Lead.find(filter, 'wa_number name').lean();
    res.json({ count: leads.length, leads: leads.slice(0, 5) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/campaigns/send', async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'] || 'default';
    const Lead = require('./db/models/Lead');
    const { campaign_name, message, filters } = req.body;
    if (!campaign_name || !message) {
      return res.status(400).json({ error: 'Campaign name and message are required' });
    }
    let filter = { client_id: clientId };
    if (filters?.score_min) filter.score = { $gte: parseInt(filters.score_min) };
    if (filters?.stage && filters.stage !== 'all') filter.pipeline_stage = filters.stage;
    if (filters?.language && filters.language !== 'all') {
      filter.language = new RegExp(filters.language, 'i');
    }
    const leads = await Lead.find(filter, 'wa_number name area_interest budget').lean();
    const api = require('./whatsapp/api');
    let sent = 0, failed = 0;
    const results = [];
    for (const lead of leads) {
      try {
        const personalised = message
          .replace(/\{name\}/g, lead.name || 'there')
          .replace(/\{area\}/g, lead.area_interest || 'your area')
          .replace(/\{budget\}/g, lead.budget ? 'AED ' + (lead.budget / 1000000).toFixed(1) + 'M' : 'your budget');
        await api.sendText(`whatsapp:+${lead.wa_number}`, personalised);
        await db.saveMessage(lead.wa_number, 'outbound', 'campaign', personalised, null, clientId);
        sent++;
        results.push({ wa_number: lead.wa_number, status: 'sent' });
      } catch(e) {
        failed++;
        results.push({ wa_number: lead.wa_number, status: 'failed', error: e.message });
      }
    }
    res.json({ success: true, campaign_name, sent, failed, total: leads.length, results });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/campaigns/history', async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'] || 'default';
    const MessageModel = require('./db/models/Message');
    const campaigns = await MessageModel.aggregate([
      { $match: { client_id: clientId, message_type: 'campaign' } },
      { $group: {
        _id: '$content',
        count: { $sum: 1 },
        first_sent: { $min: '$created_at' },
        last_sent:  { $max: '$created_at' }
      }},
      { $sort: { first_sent: -1 } },
      { $limit: 20 }
    ]);
    res.json({ campaigns });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Add note to lead ─────────────────────────────────────────────────────
app.post('/api/leads/note', async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'] || 'default';
    const Lead = require('./db/models/Lead');
    const { wa_number, lead_id, note } = req.body;
    const agentName = req.headers['x-agent-name'] || 'Agent';
    const noteEntry = { text: note, agent: agentName, created_at: new Date() };
    await Lead.findOneAndUpdate(
      { wa_number },
      { $push: { agent_notes: noteEntry }, $set: { updated_at: new Date() } }
    );
    await db.saveMessage(wa_number, 'outbound', 'note', `📝 Agent note: ${note}`, null, clientId);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Flag lead as VIP ─────────────────────────────────────────────────────
app.post('/api/leads/flag-vip', async (req, res) => {
  try {
    const { wa_number } = req.body;
    const Lead = require('./db/models/Lead');
    await Lead.findOneAndUpdate(
      { wa_number },
      { $set: { is_vip: true, vip_flagged_at: new Date(), updated_at: new Date() } }
    );
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Re-engage lead ───────────────────────────────────────────────────────
app.post('/api/leads/reengage', async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'] || 'default';
    const { wa_number } = req.body;
    const msg = "Hi! We wanted to follow up and see if you're still interested. We have some great new options available. Would you like to know more?";
    const api = require('./whatsapp/api');
    await api.sendText(`whatsapp:+${wa_number}`, msg);
    await db.saveMessage(wa_number, 'outbound', 'text', msg, null, clientId);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Retroactive lead ID assignment (one-time migration) ──────────────────
app.post('/api/dev/assign-lead-ids', async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'] || 'default';
    const LeadModel = require('./db/models/Lead');
    const leads = await LeadModel.find({ client_id: clientId, lead_id: { $exists: false } }).lean();
    let assigned = 0;
    for (const lead of leads) {
      const channel  = lead.channel  || 'whatsapp';
      const vertical = lead.vertical || (process.env.ACTIVE_FLOW || 'realEstate');
      const leadId = await db.generateLeadId(clientId, channel, vertical);
      await LeadModel.findByIdAndUpdate(lead._id, { lead_id: leadId, channel, vertical });
      assigned++;
    }
    res.json({ success: true, assigned, total: leads.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── API: all leads ────────────────────────────────────────────────────────────
app.get('/api/leads', async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'] || req.client?.client_id || 'default';
    const leads = await db.getAllLeads(clientId);

    // Attach human_mode from sessions
    const sessions = await db.getSessionsHumanMode();
    leads.forEach((l) => { l.human_mode = sessions[l.wa_number] || 0; });

    res.json(leads);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: stats (unified — supports ?range=today|7d|30d|90d or ?from=&to=) ────
app.get('/api/stats', async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'] || req.client?.client_id || 'default';
    const { from, to, range } = req.query;
    const LeadModel        = require('./db/models/Lead');
    const AppointmentModel = require('./db/models/Appointment');

    // Build date filter for leads (created_at)
    let dateFilter = {};
    const now = new Date();
    if (from && to) {
      dateFilter = { created_at: { $gte: new Date(from), $lte: new Date(new Date(to).setHours(23,59,59,999)) } };
    } else if (range) {
      const days = range === 'today' ? 0 : range === '7d' ? 7 : range === '30d' ? 30 : range === '90d' ? 90 : null;
      if (days !== null) {
        const start = new Date(now);
        if (days === 0) start.setHours(0,0,0,0); else start.setDate(start.getDate() - days);
        dateFilter = { created_at: { $gte: start } };
      }
    }

    // Lead stats (date-filtered)
    const allLeads     = await LeadModel.find({ client_id: clientId, ...dateFilter }).lean();
    const totalLeads   = allLeads.length;
    const hotLeads     = allLeads.filter(l => (l.score || 0) >= 8).length;
    const newLeads     = allLeads.filter(l => l.status === 'new').length;
    const contactedLeads = allLeads.filter(l => l.status === 'contacted').length;
    const convertedLeads = allLeads.filter(l => l.status === 'converted').length;
    const lostLeads    = allLeads.filter(l => l.status === 'lost').length;
    const wonLeads     = allLeads.filter(l => l.pipeline_stage === 'won' || l.status === 'converted').length;
    const wonLeadsData = allLeads.filter(l => l.pipeline_stage === 'won' || l.status === 'converted');
    const wonRevenue   = wonLeadsData.reduce((sum, l) => sum + (l.budget || 0), 0);
    const pipelineLeads = allLeads.filter(l => l.pipeline_stage !== 'won' && l.pipeline_stage !== 'lost');
    const pipelineValue = pipelineLeads.reduce((sum, l) => sum + (l.budget || 0), 0);
    const avgScore     = totalLeads > 0
      ? Math.round(allLeads.reduce((s, l) => s + (l.score || 0), 0) / totalLeads * 10) / 10
      : 0;
    const stageGroups  = {};
    allLeads.forEach(l => {
      const stage = l.pipeline_stage || l.status || 'new';
      stageGroups[stage] = (stageGroups[stage] || 0) + 1;
    });

    // Appointment stats (always absolute counts, no date filter applied)
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const todayEnd   = new Date(); todayEnd.setHours(23,59,59,999);
    const weekStart  = new Date(); weekStart.setDate(weekStart.getDate() - 7);
    const [todayAppts, weekAppts, totalAppts, allApptDocs] = await Promise.all([
      AppointmentModel.countDocuments({ client_id: clientId, appointment_date: { $gte: todayStart, $lte: todayEnd } }),
      AppointmentModel.countDocuments({ client_id: clientId, appointment_date: { $gte: weekStart } }),
      AppointmentModel.countDocuments({ client_id: clientId }),
      AppointmentModel.find({ client_id: clientId }).select('status').lean(),
    ]);
    const completedAppts     = allApptDocs.filter(a => a.status === 'completed').length;
    const nonCancelledAppts  = allApptDocs.filter(a => a.status !== 'cancelled').length;
    const completionRate     = nonCancelledAppts > 0 ? Math.round(completedAppts / nonCancelledAppts * 100) : 0;

    // Resolve brand name
    let clientName = process.env.CLIENT_NAME || 'My Real Estate Agency';
    const brandSetting = await db.getSetting('brand_name', clientId);
    if (brandSetting?.value) {
      clientName = brandSetting.value;
    } else if (clientId !== 'default') {
      const clientDoc = await Client.findOne({ client_id: clientId });
      if (clientDoc?.brand_name)   clientName = clientDoc.brand_name;
      else if (clientDoc?.company_name) clientName = clientDoc.company_name;
    }

    res.json({
      // Lead counts (date-filtered)
      totalLeads, hotLeads, wonLeads, avgScore,
      conversionRate: totalLeads > 0 ? Math.round((wonLeads / totalLeads) * 100) : 0,
      stageGroups,
      wonRevenue,
      pipelineValue,
      // Legacy aliases (backwards compat with existing dashboard code)
      newLeads, contactedLeads, convertedLeads, lostLeads,
      total: totalLeads, new: newLeads, contacted: contactedLeads,
      converted: convertedLeads, lost: lostLeads, hot: hotLeads, avg_score: avgScore,
      // Appointment counts (always all-time)
      todayAppointments: todayAppts,
      weekAppointments:  weekAppts,
      totalAppointments: totalAppts,
      completionRate,
      // Meta
      clientName,
      dateRange: { from, to, range },
      generatedAt: new Date(),
    });
  } catch (e) { console.error('[Stats API]', e.message); res.status(500).json({ error: e.message }); }
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
app.use('/dashboard', express.static(path.join(__dirname, 'dashboard')));
app.use('/recordings', express.static(path.join(__dirname, 'public', 'recordings')));

// ── API: conversations ────────────────────────────────────────────────────────
app.get('/api/conversations', async (req, res) => {
  try {
    const clientId   = req.headers['x-client-id'] || req.client?.client_id || 'default';
    const LeadModel  = require('./db/models/Lead');
    const MessageModel = require('./db/models/Message');

    const leads = await LeadModel.find({ client_id: clientId })
      .sort({ updated_at: -1 })
      .limit(100)
      .lean();

    const conversations = await Promise.all(leads.map(async lead => {
      const lastMsg = await MessageModel.findOne({ wa_number: lead.wa_number, client_id: clientId })
        .sort({ created_at: -1 })
        .lean();
      return {
        wa_number:         lead.wa_number,
        name:              lead.name || null,
        score:             lead.score || 0,
        pipeline_stage:    lead.pipeline_stage || 'new_lead',
        status:            lead.status || 'new',
        last_message:      lastMsg?.content || '',
        last_body:         lastMsg?.content || '',
        last_direction:    lastMsg?.direction || '',
        last_message_time: lastMsg?.created_at || lead.updated_at || lead.created_at,
        last_at:           lastMsg?.created_at || lead.updated_at || lead.created_at,
      };
    }));

    conversations.sort((a, b) => new Date(b.last_message_time) - new Date(a.last_message_time));
    res.json(conversations);
  } catch (e) { console.error('[Conversations]', e.message); res.json([]); }
});

app.get('/api/conversations/:waNumber', async (req, res) => {
  const clientId = req.headers['x-client-id'] || req.client?.client_id || 'default';
  const wa = decodeURIComponent(req.params.waNumber);
  const msgs = await db.getMessages(wa, clientId);
  res.json(msgs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)));
});

app.get('/api/conversations/:waNumber/lead', async (req, res) => {
  const clientId = req.headers['x-client-id'] || req.client?.client_id || 'default';
  const wa   = decodeURIComponent(req.params.waNumber);
  const lead = await db.getLead(wa, clientId);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  const sessions = await db.getSessionsHumanMode();
  lead.human_mode = sessions[wa] || 0;
  res.json(lead);
});

// ── API: session management ────────────────────────────────────────────────────
app.post('/api/sessions/:waNumber/clear', async (req, res) => {
  try {
    const wa = decodeURIComponent(req.params.waNumber);
    await db.clearSession(wa);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// ── API: pipeline ─────────────────────────────────────────────────────────────
app.get('/api/pipeline', async (req, res) => {
  const clientId = req.headers['x-client-id'] || req.client?.client_id || 'default';
  const leads = await db.getAllLeads(clientId);
  // Normalise stage names: DB uses full names, Kanban board uses short names
  const stageNorm = {
    'qualified_hot':     'hot',
    'qualified_warm':    'warm',
    'viewing_requested': 'viewing_req',
    'viewing_confirmed': 'viewing_conf',
  };
  leads.forEach((l) => {
    if (!l.pipeline_stage || l.pipeline_stage === 'null') {
      const map = { new: 'new_lead', contacted: 'ai_contacted', converted: 'won', lost: 'lost' };
      l.pipeline_stage = map[l.status] || 'new_lead';
    }
    l.pipeline_stage = stageNorm[l.pipeline_stage] || l.pipeline_stage;
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
  const clientId = req.headers['x-client-id'] || req.client?.client_id || 'default';
  const { from, to } = req.query;
  let leads = await db.getAllLeads(clientId);
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
app.get('/api/settings', async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'] || req.client?.client_id || 'default';
    res.json(await db.getAllSettings(clientId));
  } catch (e) { res.json({}); }
});

app.post('/api/settings', async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'] || req.client?.client_id || 'default';
    const data = req.body;
    if (typeof data !== 'object') return res.status(400).json({ error: 'Expected JSON object' });
    for (const [key, value] of Object.entries(data)) {
      await db.saveSetting(key, String(value), clientId);
      if (key === 'brand_name') {
        console.log(`[Settings] brand_name saved: "${value}" for client: ${clientId}`);
        // Also sync to Client document for multi-tenant clients
        if (clientId !== 'default') {
          await Client.findOneAndUpdate(
            { client_id: clientId },
            { $set: { brand_name: value, updated_at: new Date() } }
          );
        }
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('[Settings] Save error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── API: settings/save (dedicated endpoint called by dashboard Save Changes) ──
app.post('/api/settings/save', async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'] || req.client?.client_id || 'default';
    const data = req.body;
    if (!data || typeof data !== 'object') return res.status(400).json({ error: 'Expected JSON object' });
    for (const [key, value] of Object.entries(data)) {
      if (value === '' || value === null || value === undefined) continue; // skip blanks
      await db.saveSetting(key, String(value), clientId);
      if (key === 'brand_name') {
        console.log(`[Settings/save] brand_name: "${value}" client: ${clientId}`);
        if (clientId !== 'default') {
          await Client.findOneAndUpdate(
            { client_id: clientId },
            { $set: { brand_name: value, updated_at: new Date() } }
          );
        }
      }
    }
    res.json({ success: true });
  } catch (e) {
    console.error('[Settings/save] Error:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// ── API: flow steps ───────────────────────────────────────────────────────────
const FLOW_DEFAULTS = {
  realEstate: [
    { stepId: 'greeting',  stepName: 'Greeting',        order: 1, message: "Hello! Welcome to our real estate service. I'm here to help you find your perfect property. 🏡" },
    { stepId: 'intent',    stepName: 'Intent Question',  order: 2, message: 'Are you looking to Buy or Rent?' },
    { stepId: 'budget',    stepName: 'Budget Question',  order: 3, message: 'What is your budget range?' },
    { stepId: 'area',      stepName: 'Area Preference',  order: 4, message: 'Which area are you interested in?' },
    { stepId: 'bedrooms',  stepName: 'Bedrooms',         order: 5, message: 'How many bedrooms do you need?' },
    { stepId: 'timeline',  stepName: 'Timeline',         order: 6, message: 'When are you looking to move?' },
    { stepId: 'complete',  stepName: 'Completion',       order: 7, message: 'Thank you! Our agent will contact you shortly.' },
  ],
  restaurant: [
    { stepId: 'greeting',    stepName: 'Greeting',         order: 1, message: "Welcome! I'd love to help you book a table. 🍽️" },
    { stepId: 'party_size',  stepName: 'Party Size',       order: 2, message: 'How many guests will be dining?' },
    { stepId: 'date',        stepName: 'Date',             order: 3, message: 'What date would you like to book?' },
    { stepId: 'time',        stepName: 'Time',             order: 4, message: 'What time would you prefer?' },
    { stepId: 'special',     stepName: 'Special Requests', order: 5, message: 'Any dietary requirements or special requests?' },
    { stepId: 'complete',    stepName: 'Completion',       order: 6, message: 'Your table is booked! See you soon.' },
  ],
  clinic: [
    { stepId: 'greeting',  stepName: 'Greeting',           order: 1, message: 'Hello! How can we help you today? 🏥' },
    { stepId: 'service',   stepName: 'Service Type',       order: 2, message: 'What type of appointment do you need?' },
    { stepId: 'doctor',    stepName: 'Doctor Preference',  order: 3, message: 'Do you have a preferred doctor?' },
    { stepId: 'date',      stepName: 'Preferred Date',     order: 4, message: 'What date works best for you?' },
    { stepId: 'time',      stepName: 'Preferred Time',     order: 5, message: 'What time do you prefer?' },
    { stepId: 'patient',   stepName: 'Patient Name',       order: 6, message: "Please provide the patient's full name." },
    { stepId: 'complete',  stepName: 'Completion',         order: 7, message: "Appointment request received. We'll confirm shortly." },
  ],
  retail: [
    { stepId: 'greeting',  stepName: 'Greeting',       order: 1, message: 'Hi! Welcome to our store. How can I help you? 🛍️' },
    { stepId: 'intent',    stepName: 'Shopping Intent', order: 2, message: 'Are you looking for something specific?' },
    { stepId: 'budget',    stepName: 'Budget',         order: 3, message: 'What is your budget?' },
    { stepId: 'product',   stepName: 'Product Type',   order: 4, message: 'What type of product are you looking for?' },
    { stepId: 'delivery',  stepName: 'Delivery',       order: 5, message: 'Do you need delivery or will you pick up in store?' },
    { stepId: 'complete',  stepName: 'Completion',     order: 6, message: 'Great! Our team will reach out to confirm your order.' },
  ],
  salon: [
    { stepId: 'greeting',  stepName: 'Greeting',            order: 1, message: 'Welcome to our salon! What can we do for you today? ✂️' },
    { stepId: 'service',   stepName: 'Service',             order: 2, message: 'What service are you interested in?' },
    { stepId: 'stylist',   stepName: 'Stylist Preference',  order: 3, message: 'Do you have a preferred stylist?' },
    { stepId: 'date',      stepName: 'Date',                order: 4, message: 'What date would you like to book?' },
    { stepId: 'time',      stepName: 'Time',                order: 5, message: 'What time works best for you?' },
    { stepId: 'complete',  stepName: 'Completion',          order: 6, message: 'Your appointment is booked! See you soon.' },
  ],
  carDealer: [
    { stepId: 'greeting',  stepName: 'Greeting',          order: 1, message: "Welcome! I'm here to help you find your perfect vehicle. 🚗" },
    { stepId: 'intent',    stepName: 'Intent',            order: 2, message: 'Are you looking to buy a new or used car?' },
    { stepId: 'budget',    stepName: 'Budget',            order: 3, message: 'What is your budget range?' },
    { stepId: 'car_type',  stepName: 'Car Type',          order: 4, message: 'What type of vehicle are you looking for? (Sedan, SUV, etc.)' },
    { stepId: 'brand',     stepName: 'Brand Preference',  order: 5, message: 'Do you have a preferred brand?' },
    { stepId: 'timeline',  stepName: 'Timeline',          order: 6, message: 'When are you looking to purchase?' },
    { stepId: 'complete',  stepName: 'Completion',        order: 7, message: 'Thank you! Our sales team will contact you shortly.' },
  ],
};

app.get('/api/flow/:vertical', async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'] || req.client?.client_id || 'default';
    const { vertical } = req.params;
    const defaults = FLOW_DEFAULTS[vertical] || [];
    const overrides = await db.getFlowSteps(clientId, vertical);
    const steps = defaults.map(step => {
      const override = overrides.find(o => o.stepId === step.stepId);
      return { ...step, message: override?.message ?? step.message };
    });
    res.json(steps);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/flow/save', async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'] || req.client?.client_id || 'default';
    const { vertical, stepId, message } = req.body;
    if (!vertical || !stepId) return res.status(400).json({ error: 'vertical and stepId required' });
    await db.saveFlowStep(clientId, vertical, stepId, message || '');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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

app.get('/api/listings', async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'] || 'default';
    const listings = await db.getListings(clientId, req.query);
    res.json({ listings });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/listings/:id', async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'] || 'default';
    const listing = await db.getListing(clientId, req.params.id);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    res.json({ listing });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upsert — create or update based on presence of _id
app.post('/api/listings/save', async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'] || 'default';
    const listing = await db.saveListing(req.body, clientId);
    res.json({ success: true, listing });
    if (!req.body._id) {
      notifyMatchingLeads({ ...req.body, ...listing }).catch(e => console.error('[Property Match]', e.message));
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/listings', async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'] || 'default';
    const b = req.body;
    const listing = {
      title: b.title || '', property_type: b.property_type || b.type || 'Apartment',
      type: b.type || b.property_type || 'Apartment', area: b.area || '',
      price: b.price || 0, bedrooms: b.bedrooms || b.beds || 0, beds: b.beds || b.bedrooms || 0,
      bathrooms: b.bathrooms || b.baths || 0, baths: b.baths || b.bathrooms || 0,
      size_sqft: b.size_sqft || 0, description: b.description || '',
      image_url: b.image_url || '', listing_url: b.listing_url || '',
      status: b.status || 'available', intent: b.intent || 'buy',
    };
    const result = await db.saveListing(listing, clientId);
    res.json({ ok: true, id: result.id, success: true, listing: result });
    notifyMatchingLeads({ ...listing, id: result.id }).catch(e => console.error('[Property Match]', e.message));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/listings/:id', async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'] || 'default';
    await db.updateListing(req.params.id, { ...req.body, client_id: clientId });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/listings/:id', async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'] || 'default';
    await db.deleteListing(req.params.id, clientId);
    res.json({ ok: true, success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/listings/:id/send', async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'] || 'default';
    const { wa_number } = req.body;
    if (!wa_number) return res.status(400).json({ error: 'wa_number required' });
    const listing = await db.getListing(clientId, req.params.id);
    if (!listing) return res.status(404).json({ error: 'Listing not found' });
    const formatPrice = (p) => p >= 1000000 ? `AED ${(p/1000000).toFixed(1)}M` : `AED ${(p/1000).toFixed(0)}K`;
    const beds = listing.bedrooms || listing.beds || 0;
    const baths = listing.bathrooms || listing.baths || 0;
    const msg =
      `🏠 *${listing.title}*\n\n` +
      `📍 ${listing.area || listing.location || 'Dubai'}\n` +
      `💰 ${formatPrice(listing.price || 0)}\n` +
      (beds  ? `🛏 ${beds} Bedroom${beds  > 1 ? 's' : ''}\n` : '') +
      (baths ? `🚿 ${baths} Bathroom${baths > 1 ? 's' : ''}\n` : '') +
      (listing.size_sqft ? `📐 ${listing.size_sqft.toLocaleString()} sqft\n` : '') +
      (listing.description ? `\n${listing.description}\n` : '') +
      (listing.listing_url ? `\n🔗 View Details: ${listing.listing_url}` : '') +
      `\n\nInterested? Reply *YES* to schedule a viewing or call us anytime.`;
    await sendText(`whatsapp:+${wa_number}`, msg);
    await db.saveMessage(wa_number, 'outbound', 'text', `[Listing: ${listing.title}]`, {}).catch(() => {});
    res.json({ success: true, message: 'Listing sent successfully' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: appointments (POST only — GET is handled below with enrichment) ───────
app.post('/api/appointments', async (req, res) => {
  const b = req.body;
  let lead_score = 0, lead_label = 'cold';
  if (b.wa_number) {
    try {
      const lead = await db.getLead(b.wa_number);
      if (lead) { lead_score = lead.score || 0; lead_label = lead.score_label || 'cold'; }
    } catch(_) {}
  }
  const result = await db.saveAppointment({
    lead_id: b.lead_id || null, wa_number: b.wa_number,
    slot_date: b.slot_date, slot_time: b.slot_time, notes: b.notes || '',
    lead_score, lead_label,
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

// ── API: Appointments ─────────────────────────────────────────────────────────
app.get('/api/appointments', async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'] || req.client?.client_id || 'default';
    const { status, agent, date_from, date_to, from, to } = req.query;
    // Accept both ?from=&to= and legacy ?date_from=&date_to=
    const appointments = await db.getAppointments({ status, agent, date_from: date_from || from, date_to: date_to || to }, clientId);
    // Enrich with lead score from leads table
    const leads = await db.getAllLeads(clientId);
    const leadMap = {};
    leads.forEach(l => { leadMap[l.wa_number] = l; });
    const enriched = appointments.map(a => ({
      ...a,
      lead_score: leadMap[a.wa_number]?.score || 0,
      lead_status: leadMap[a.wa_number]?.status || 'new',
    }));
    res.json(enriched);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/appointments/stats', async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'] || req.client?.client_id || 'default';
    const all = await db.getAppointments({}, clientId);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
    const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const todayCount   = all.filter(a => new Date(a.appointment_date) >= today && new Date(a.appointment_date) <= todayEnd).length;
    const weekCount    = all.filter(a => new Date(a.appointment_date) >= today && new Date(a.appointment_date) <= nextWeek).length;
    const completed    = all.filter(a => a.status === 'completed').length;
    const notCancelled = all.filter(a => a.status !== 'cancelled').length;
    const completionRate = notCancelled ? Math.round(completed / notCancelled * 100) : 0;
    res.json({ today: todayCount, this_week: weekCount, total: all.length, completion_rate: completionRate });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/appointments/today', async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'] || req.client?.client_id || 'default';
    const today = new Date();
    res.json(await db.getAppointmentsByDate(today, clientId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/appointments/upcoming', async (_req, res) => {
  try {
    res.json(await db.getUpcomingAppointments());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/appointments/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['confirmed', 'completed', 'cancelled', 'rescheduled'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    await db.updateAppointmentStatus(req.params.id, status);
    // If completed, send thank-you to lead
    if (status === 'completed') {
      const Appointment = require('./db/models/Appointment');
      const appt = await Appointment.findById(req.params.id).lean();
      if (appt && appt.wa_number) {
        sendText(appt.wa_number,
          `✅ Thank you for your time, ${appt.lead_name || 'there'}! We hope our consultation was helpful.\n\nFeel free to reach out anytime. Type 'menu' to start a new enquiry.`
        ).catch(() => {});
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/appointments/:id/reschedule', async (req, res) => {
  try {
    const { new_date, new_time_slot } = req.body;
    const Appointment = require('./db/models/Appointment');
    const appt = await Appointment.findByIdAndUpdate(
      req.params.id,
      { $set: { appointment_date: new Date(new_date), appointment_date_display: new_date, time_slot: new_time_slot, status: 'rescheduled' } },
      { new: true }
    ).lean();
    if (appt && appt.wa_number) {
      const msg = `📅 *Appointment Rescheduled*\n\nYour appointment has been updated:\n📅 New Date: ${new_date}\n⏰ Time: ${new_time_slot}\n\nWe'll confirm this with you shortly.`;
      sendText(appt.wa_number, msg).catch(() => {});
      if (process.env.OWNER_WHATSAPP) {
        sendText(process.env.OWNER_WHATSAPP, `📅 Appointment rescheduled:\nClient: ${appt.lead_name}\n📅 ${new_date} ${new_time_slot}`).catch(() => {});
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Re-engagement ────────────────────────────────────────────────────────
app.get('/api/reengagement/run', async (_req, res) => {
  try {
    const { runReengagement } = require('./utils/reengagementEngine');
    const sent = await runReengagement();
    res.json({ ok: true, sent: sent || 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── API: Dev audit — show raw counts for debugging ────────────────────────────
app.get('/api/dev/audit', async (req, res) => {
  try {
    const Lead        = require('./db/models/Lead');
    const Appointment = require('./db/models/Appointment');
    const clientId    = req.headers['x-client-id'] || 'default';

    const leads        = await Lead.find({ client_id: clientId }).lean();
    const appointments = await Appointment.find({ client_id: clientId }).lean();

    res.json({
      total_leads: leads.length,
      leads: leads.map(l => ({
        id: l._id, name: l.name, wa_number: l.wa_number,
        score: l.score, pipeline_stage: l.pipeline_stage,
        created_at: l.created_at
      })),
      total_appointments: appointments.length,
      appointments: appointments.map(a => ({
        id: a._id, name: a.lead_name, wa_number: a.wa_number,
        date: a.date, status: a.status, created_at: a.created_at
      }))
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── API: dev messages debug ───────────────────────────────────────────────────
app.get('/api/dev/messages-debug', async (req, res) => {
  try {
    const Message  = require('./db/models/Message');
    const clientId = req.headers['x-client-id'] || 'default';
    const msgs = await Message.find({ client_id: clientId })
      .sort({ created_at: -1 })
      .limit(20)
      .lean();
    res.json({ count: msgs.length, messages: msgs });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── API: dev fix-messages cleanup ─────────────────────────────────────────────
app.post('/api/dev/fix-messages', async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'] || 'default';
    const Message = require('./db/models/Message');
    const r1 = await Message.deleteMany({ client_id: clientId, content: { $in: ['START prompt sent', 'START_PROMPT_SENT'] } });
    const r2 = await Message.deleteMany({ client_id: clientId, content: { $in: ['1','2','3','4','5','6','7','8','9'] }, direction: 'inbound' });
    const r3 = await Message.deleteMany({ client_id: clientId, content: /^Step:/ });
    res.json({ deleted: r1.deletedCount + r2.deletedCount + r3.deletedCount });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
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

// ── Admin: login page ─────────────────────────────────────────────────────────
app.get('/admin/login', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Axyren Admin — Login</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0F172A;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{background:#1E293B;border:1px solid #334155;border-radius:16px;padding:40px;width:360px}
  .logo{font-size:24px;font-weight:800;color:#fff;margin-bottom:8px}
  .sub{font-size:13px;color:#94A3B8;margin-bottom:28px}
  label{font-size:12px;font-weight:600;color:#94A3B8;display:block;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px}
  input{width:100%;padding:10px 14px;border-radius:8px;border:1.5px solid #334155;background:#0F172A;color:#F1F5F9;font-size:14px;outline:none;margin-bottom:20px}
  input:focus{border-color:#3B82F6}
  button{width:100%;padding:11px;border-radius:8px;background:#3B82F6;color:#fff;font-weight:700;font-size:14px;border:none;cursor:pointer}
  button:hover{background:#2563EB}
  .err{color:#F87171;font-size:13px;margin-bottom:16px;display:none}
</style>
</head>
<body>
<div class="card">
  <div class="logo">Axyren Admin</div>
  <div class="sub">Internal platform management</div>
  <div class="err" id="err">Invalid password. Please try again.</div>
  <form method="POST" action="/admin/login">
    <label>Admin Password</label>
    <input type="password" name="password" placeholder="Enter admin password" required autofocus>
    <button type="submit">Sign In</button>
  </form>
</div>
<script>
  const params = new URLSearchParams(location.search);
  if (params.get('error')) document.getElementById('err').style.display = 'block';
</script>
</body>
</html>`);
});

app.post('/admin/login', express.urlencoded({ extended: false }), (req, res) => {
  const { password } = req.body;
  const adminPass = process.env.ADMIN_PASSWORD || process.env.ADMIN_API_KEY;
  console.log('[Admin] Login attempt. ADMIN_PASSWORD set:', !!process.env.ADMIN_PASSWORD, '| ADMIN_API_KEY set:', !!process.env.ADMIN_API_KEY);

  if (password && adminPass && password === adminPass) {
    // Set cookie for browser session persistence
    res.cookie('admin_session', adminPass, {
      httpOnly: true,
      maxAge:   24 * 60 * 60 * 1000,
      sameSite: 'lax',
    });
    // Also redirect with query param — works even if cookies are blocked
    return res.redirect(`/admin/dashboard?admin_key=${encodeURIComponent(adminPass)}`);
  }
  console.log('[Admin] Login failed — password mismatch or env var not set');
  res.redirect('/admin/login?error=1');
});

app.get('/admin/logout', (req, res) => {
  res.clearCookie('admin_session');
  res.redirect('/admin/login');
});

// ── Admin: dashboard (HTML) ───────────────────────────────────────────────────
app.get('/admin/dashboard', requireAdmin, (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard', 'admin', 'index.html'));
});

// ── Admin: static assets ──────────────────────────────────────────────────────
app.use('/admin/assets', requireAdmin, express.static(path.join(__dirname, 'dashboard', 'admin')));

// ── Admin API: list all clients ───────────────────────────────────────────────
app.get('/admin/clients', requireAdmin, async (_req, res) => {
  try {
    const Lead = require('./db/models/Lead');
    const clients = await Client.find().sort({ created_at: -1 }).lean();
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const enriched = await Promise.all(clients.map(async (c) => {
      const total_leads = await Lead.countDocuments({ client_id: c.client_id });
      const leads_this_month = await Lead.countDocuments({ client_id: c.client_id, created_at: { $gte: monthStart } });
      return {
        ...c,
        id:                c._id.toString(),
        total_leads,
        leads_this_month,
        twilio_auth_token: c.twilio_auth_token ? '••••••••' : '',
        smtp_pass:         c.smtp_pass         ? '••••••••' : '',
      };
    }));
    res.json(enriched);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin API: create client ──────────────────────────────────────────────────
app.post('/admin/clients', requireAdmin, async (req, res) => {
  try {
    const { company_name, industry, owner_name, owner_email, owner_whatsapp,
            whatsapp_number, twilio_account_sid, twilio_auth_token, plan, notes,
            notification_emails, brand_name } = req.body;

    if (!company_name) return res.status(400).json({ error: 'company_name is required' });

    const client_id = generateClientId(company_name);
    const api_key   = generateApiKey();

    const client = await Client.create({
      client_id, api_key, company_name,
      industry:           industry           || 'realEstate',
      owner_name:         owner_name         || '',
      owner_email:        owner_email        || '',
      owner_whatsapp:     owner_whatsapp     || '',
      whatsapp_number:    whatsapp_number    || '',
      twilio_account_sid: twilio_account_sid || '',
      twilio_auth_token:  twilio_auth_token  || '',
      plan:               plan               || 'professional',
      brand_name:         brand_name         || company_name,
      notification_emails:notification_emails|| owner_email || '',
      notes:              notes              || '',
      status: 'active',
    });

    const platformUrl = process.env.PLATFORM_URL || `http://localhost:${PORT}`;
    res.json({
      ok:           true,
      client_id:    client.client_id,
      api_key:      client.api_key,
      dashboard_url:`${platformUrl}/client-dashboard/${client.client_id}`,
      webhook_url:  `${platformUrl}/webhook`,
    });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'Client ID or API key already exists' });
    res.status(500).json({ error: e.message });
  }
});

// ── Admin API: get single client ──────────────────────────────────────────────
app.get('/admin/clients/:clientId', requireAdmin, async (req, res) => {
  try {
    const client = await Client.findOne({ client_id: req.params.clientId }).lean();
    if (!client) return res.status(404).json({ error: 'Not found' });
    res.json({
      ...client,
      id:               client._id.toString(),
      twilio_auth_token: client.twilio_auth_token ? '••••••••' + client.twilio_auth_token.slice(-4) : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin API: update client ──────────────────────────────────────────────────
app.put('/admin/clients/:clientId', requireAdmin, async (req, res) => {
  try {
    const updates = { ...req.body, updated_at: new Date() };
    // Never let callers overwrite client_id or api_key via this route
    delete updates.client_id;
    delete updates.api_key;
    delete updates._id;
    await Client.findOneAndUpdate({ client_id: req.params.clientId }, { $set: updates });
    clearClientCache(req.params.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin API: soft-delete client ─────────────────────────────────────────────
app.delete('/admin/clients/:clientId', requireAdmin, async (req, res) => {
  try {
    await Client.findOneAndUpdate({ client_id: req.params.clientId }, { $set: { status: 'cancelled', updated_at: new Date() } });
    clearClientCache(req.params.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin API: suspend client ─────────────────────────────────────────────────
app.post('/admin/clients/:clientId/suspend', requireAdmin, async (req, res) => {
  try {
    await Client.findOneAndUpdate({ client_id: req.params.clientId }, { $set: { status: 'suspended', updated_at: new Date() } });
    clearClientCache(req.params.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin API: activate client ────────────────────────────────────────────────
app.post('/admin/clients/:clientId/activate', requireAdmin, async (req, res) => {
  try {
    await Client.findOneAndUpdate({ client_id: req.params.clientId }, { $set: { status: 'active', updated_at: new Date() } });
    clearClientCache(req.params.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin API: reset API key ──────────────────────────────────────────────────
app.post('/admin/clients/:clientId/reset-api-key', requireAdmin, async (req, res) => {
  try {
    const newKey = generateApiKey();
    await Client.findOneAndUpdate({ client_id: req.params.clientId }, { $set: { api_key: newKey, updated_at: new Date() } });
    clearClientCache(req.params.clientId);
    res.json({ ok: true, api_key: newKey });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin API: platform stats ─────────────────────────────────────────────────
app.get('/admin/stats', requireAdmin, async (_req, res) => {
  try {
    const planPrices = { starter: 299, professional: 699, agency: 1499, enterprise: 2999 };
    const [clients, totalLeads, totalAppointments] = await Promise.all([
      Client.find().lean(),
      db.mongoose.connection.readyState === 1 ? db.mongoose.connection.db?.collection('leads').countDocuments() : 0,
      db.mongoose.connection.db?.collection('appointments').countDocuments(),
    ]);

    const total_clients  = clients.length;
    const active_clients = clients.filter(c => c.status === 'active').length;
    const revenue_estimate = clients
      .filter(c => c.status === 'active')
      .reduce((sum, c) => sum + (planPrices[c.plan] || 699), 0);

    // Leads added this month across all clients
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
    const leads_this_month = await db.mongoose.connection.db
      ?.collection('leads').countDocuments({ created_at: { $gte: monthStart } }) || 0;

    res.json({
      total_clients,
      active_clients,
      total_leads_all_time: totalLeads || 0,
      total_appointments:   totalAppointments || 0,
      leads_this_month,
      revenue_estimate,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin API: onboard new client (one-shot) ──────────────────────────────────
app.post('/admin/onboard', requireAdmin, async (req, res) => {
  try {
    const {
      company_name, industry, owner_name, owner_email, owner_whatsapp,
      whatsapp_number, twilio_account_sid, twilio_auth_token, plan,
      notification_emails, brand_name,
    } = req.body;

    if (!company_name) return res.status(400).json({ error: 'company_name is required' });

    const client_id = generateClientId(company_name);
    const api_key   = generateApiKey();

    await Client.create({
      client_id, api_key, company_name,
      industry:           industry           || 'realEstate',
      owner_name:         owner_name         || '',
      owner_email:        owner_email        || '',
      owner_whatsapp:     owner_whatsapp     || '',
      whatsapp_number:    whatsapp_number    || '',
      twilio_account_sid: twilio_account_sid || '',
      twilio_auth_token:  twilio_auth_token  || '',
      plan:               plan               || 'professional',
      brand_name:         brand_name         || company_name,
      notification_emails:notification_emails|| owner_email || '',
      status: 'active',
    });

    const platformUrl = process.env.PLATFORM_URL || `http://localhost:${PORT}`;
    res.json({
      success:      true,
      client_id,
      api_key,
      dashboard_url:`${platformUrl}/client-dashboard/${client_id}`,
      webhook_url:  `${platformUrl}/webhook`,
      setup_instructions: {
        step1: `Set Twilio webhook to: ${platformUrl}/webhook`,
        step2: 'Share your WhatsApp number with customers',
        step3: `Access your dashboard at: ${platformUrl}/client-dashboard/${client_id}`,
        step4: `Your API key for integrations: ${api_key}`,
      },
    });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'Client already exists' });
    res.status(500).json({ error: e.message });
  }
});

// ── Client dashboard route ────────────────────────────────────────────────────
app.get('/client-dashboard/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;

    // Demo client — bypass DB lookup and serve dashboard directly
    if (clientId === 'demo') {
      const activeFlow = process.env.ACTIVE_FLOW || 'realEstate';
      const html = fs.readFileSync(path.join(__dirname, 'dashboard', 'index.html'), 'utf8');
      return res.send(html.replace('</head>', `<script>window.__clientId=${JSON.stringify(clientId)};window.ACTIVE_FLOW=${JSON.stringify(activeFlow)};</script></head>`));
    }

    const ClientModel = require('./db/models/Client');
    const client = await ClientModel.findOne({ client_id: clientId });

    if (!client) {
      return res.status(404).send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#060912;color:white">
          <h2>Dashboard Not Found</h2>
          <p style="color:#6b7a99">This client account does not exist. Please contact Axyren support.</p>
        </body></html>
      `);
    }

    if (client.status === 'suspended') {
      return res.status(403).send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#060912;color:white">
          <h2 style="color:#F59E0B">Account Suspended</h2>
          <p style="color:#6b7a99">Your Axyren account has been temporarily suspended.</p>
          <p style="color:#6b7a99">Please contact <a href="mailto:hello@axyren.ai" style="color:#3B82F6">hello@axyren.ai</a> to resolve this.</p>
        </body></html>
      `);
    }

    if (client.status === 'cancelled') {
      return res.status(403).send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#060912;color:white">
          <h2 style="color:#EF4444">Account Cancelled</h2>
          <p style="color:#6b7a99">This Axyren account has been cancelled.</p>
          <p style="color:#6b7a99">Contact <a href="mailto:hello@axyren.ai" style="color:#3B82F6">hello@axyren.ai</a> to reactivate.</p>
        </body></html>
      `);
    }

    // Active client — inject clientId and ACTIVE_FLOW, then serve dashboard
    const activeFlow = process.env.ACTIVE_FLOW || 'realEstate';
    const html = fs.readFileSync(path.join(__dirname, 'dashboard', 'index.html'), 'utf8');
    res.send(html.replace('</head>', `<script>window.__clientId=${JSON.stringify(clientId)};window.ACTIVE_FLOW=${JSON.stringify(activeFlow)};</script></head>`));
  } catch (e) { res.status(500).send('Error loading dashboard'); }
});

// ── Client-scoped sub-page serving (injects window.__clientId) ───────────────
app.get('/client-dashboard/:clientId/pages/:page', (req, res) => {
  const { clientId, page } = req.params;
  const filePath = path.join(__dirname, 'dashboard', 'pages', page);
  if (!fs.existsSync(filePath)) return res.status(404).send('Page not found');
  const fragment = fs.readFileSync(filePath, 'utf8');
  // Sub-pages are HTML fragments (no <head>), so prepend the injection
  const html = `<script>window.__clientId=${JSON.stringify(clientId)};</script>\n` + fragment;
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// Static JS/CSS assets under the client path
app.use('/client-dashboard/:clientId/js',  express.static(path.join(__dirname, 'dashboard', 'js')));
app.use('/client-dashboard/:clientId/css', express.static(path.join(__dirname, 'dashboard', 'css')));

// ── Manual Lead Capture: preview ID ──────────────────────────────────────────
app.get('/api/leads/preview-id', async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'] || 'default';
    const channel = req.query.channel || 'phone';
    const activeFlow = process.env.ACTIVE_FLOW || 'realEstate';

    const prefixSetting = await db.getSetting('lead_id_prefix', clientId);
    const prefix = prefixSetting?.value || 'AXY';
    const year = new Date().getFullYear();

    const Counter = getLeadCounterModel(clientId);
    const counter = await Counter.findOne({ client_id: clientId }).lean();
    const nextSeq = String((counter?.current_count || 0) + 1).padStart(4, '0');

    const channelCodes = { phone:'PH', whatsapp:'WA', facebook:'FB', instagram:'IG', web:'WEB', walkin:'WI', referral:'RF' };
    const verticalCodes = { realEstate:'RE', restaurant:'RS', clinic:'CL', retail:'RT', salon:'SL', carDealer:'CD' };

    const preview = `${prefix}-${year}-${nextSeq}-${channelCodes[channel]||'PH'}-${verticalCodes[activeFlow]||'RE'}`;
    res.json({ preview });
  } catch(e) {
    res.json({ preview: 'AXY-2026-XXXX-PH-RE' });
  }
});

// ── Manual Lead Capture: save lead ───────────────────────────────────────────
app.post('/api/leads/manual', async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'] || 'default';
    const activeFlow = process.env.ACTIVE_FLOW || 'realEstate';
    const body = req.body;

    const leadId = await db.generateLeadId(clientId, body.channel || 'phone', activeFlow);

    const budgetMap = {
      'under-500k': 400000, '500k---1m': 750000, '1m---2m': 1500000,
      '2m---5m': 3000000, 'above-5m': 7500000,
      'under-aed-500': 300, 'aed-500-2000': 1250, 'aed-2000-5000': 3500, 'above-aed-5000': 7500,
      'under-50k': 40000, '50k-100k': 75000, '100k-200k': 150000, '200k-500k': 350000, 'above-500k': 750000
    };
    const budgetNum = budgetMap[body.budget] || 0;

    let score = 3;
    if (budgetNum > 1000000) score += 2;
    if (body.timeline && ['immediately','today'].includes(body.timeline)) score += 3;
    else if (body.timeline && ['this-month','within-1-month'].includes(body.timeline)) score += 1;
    if (body.intent && ['buy','invest'].includes(body.intent)) score += 1;
    score = Math.min(score, 10);
    const scoreLabel = score >= 7 ? 'HOT' : score >= 4 ? 'WARM' : 'COLD';
    const pipelineStage = score >= 7 ? 'qualified_hot' : score >= 4 ? 'qualified_warm' : 'new_lead';

    const waNumber = body.wa_number || (body.phone || '').replace(/\D/g, '');
    if (!waNumber) throw new Error('wa_number could not be derived from phone');

    const leadData = {
      client_id: clientId,
      wa_number: waNumber,
      name: body.name,
      channel: body.channel || 'phone',
      vertical: activeFlow,
      language: body.language || 'en',
      score,
      pipeline_stage: pipelineStage,
      status: 'active',
      data: {
        phone: body.phone || '', email: body.email || '',
        source: body.source || 'phone-inbound', intent: body.intent || '',
        property_type: body.property_type || '', budget: budgetNum,
        area_interest: body.area_interest || '', timeline: body.timeline || '',
        notes: body.notes || '', score_label: scoreLabel,
        entry_method: 'manual', recording_duration: body.recording_duration || 0,
        party_size: body.party_size || '', occasion: body.occasion || '',
      }
    };

    const Lead = require('./db/models/Lead');
    const filter = { wa_number: leadData.wa_number };
    const update = {
      $setOnInsert: { ...leadData, lead_id: leadId, created_at: new Date() },
      $set: { updated_at: new Date() }
    };
    const options = { upsert: true, returnDocument: 'after' };

    let savedLead;
    try {
      savedLead = await Lead.findOneAndUpdate(filter, update, options);
    } catch(dupErr) {
      if (dupErr.code === 11000) {
        // Lead exists — just update it with new manual entry data
        savedLead = await Lead.findOneAndUpdate(
          filter,
          { $set: { ...leadData, lead_id: leadId, updated_at: new Date() } },
          { returnDocument: 'after' }
        );
      } else {
        throw dupErr;
      }
    }

    // saveMessage(waNumber, direction, type, content, rawData, clientId)
    await db.saveMessage(
      leadData.wa_number,
      'outbound',
      'text',
      (body.notes && body.notes.trim()
        ? 'Manual lead captured via ' + (body.source || 'phone') + '. Notes: ' + body.notes
        : 'Manual lead captured via ' + (body.source || 'phone')),
      null,
      clientId
    );

    res.json({ success: true, lead_id: leadId, score, score_label: scoreLabel });
  } catch(e) {
    console.error('[Manual Lead]', e.message);
    if (e.code === 11000) {
      return res.status(400).json({ error: 'A lead with this phone number already exists.' });
    }
    res.status(500).json({ error: e.message });
  }
});

// ── Recording upload ──────────────────────────────────────────────────────────
app.post('/api/recordings/upload', uploadMiddleware.single('recording'), async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'] || 'default';
    const { lead_id, wa_number, duration, agent } = req.body;
    const file = req.file;

    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    const recordingsDir = path.join(__dirname, 'public', 'recordings');
    if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });

    const filename = `${lead_id}-${Date.now()}.webm`;
    const filePath = path.join(recordingsDir, filename);
    fs.writeFileSync(filePath, file.buffer);

    const fileUrl = `/recordings/${filename}`;

    const { source, notes, agent_name } = req.body;
    const Recording = getRecordingModel(clientId);
    await Recording.create({
      client_id: clientId, lead_id, wa_number,
      agent:     agent_name || agent || 'Agent',
      duration:  parseInt(duration) || 0,
      file_url:  fileUrl, file_size: file.size, mime_type: file.mimetype,
      source:    source || 'phone-inbound',
      notes:     notes  || '',
      created_at: new Date()
    });

    res.json({ success: true, file_url: fileUrl });
  } catch(e) {
    console.error('[Recording Upload]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Helper: format seconds to human duration ─────────────────────────────────
function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ── Recordings: list with filters ────────────────────────────────────────────
app.get('/api/recordings', async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'] || 'default';
    const { getRecordingModel } = require('./db/models/Recording');
    const Recording = getRecordingModel(clientId);

    const { lead_id, agent, from, to, q } = req.query;

    let filter = { client_id: clientId };
    if (lead_id) filter.lead_id = new RegExp(lead_id, 'i');
    if (agent)   filter.agent   = new RegExp(agent, 'i');
    if (from || to) {
      filter.created_at = {};
      if (from) filter.created_at.$gte = new Date(from);
      if (to)   filter.created_at.$lte = new Date(new Date(to).setHours(23, 59, 59, 999));
    }
    if (q) {
      filter.$or = [
        { lead_id: new RegExp(q, 'i') },
        { agent:   new RegExp(q, 'i') },
        { notes:   new RegExp(q, 'i') }
      ];
    }

    const recordings = await Recording.find(filter)
      .sort({ created_at: -1 })
      .limit(200)
      .lean();

    // Enrich with lead name + score
    const LeadModel = require('./db/models/Lead');
    const enriched = await Promise.all(recordings.map(async r => {
      let leadName  = r.wa_number || 'Unknown';
      let score     = 0;
      let scoreLabel = 'COLD';
      try {
        const lead = await LeadModel.findOne({ wa_number: r.wa_number }).lean();
        if (lead) {
          leadName   = lead.name || lead.wa_number;
          score      = lead.score || 0;
          scoreLabel = lead.data?.score_label || (score >= 7 ? 'HOT' : score >= 4 ? 'WARM' : 'COLD');
        }
      } catch(_) {}
      return { ...r, lead_name: leadName, score, score_label: scoreLabel };
    }));

    res.json({ recordings: enriched, total: enriched.length });
  } catch(e) {
    console.error('[Recordings API]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Recordings: stats for report header ──────────────────────────────────────
app.get('/api/recordings/stats', async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'] || 'default';
    const { getRecordingModel } = require('./db/models/Recording');
    const Recording = getRecordingModel(clientId);

    const all = await Recording.find({ client_id: clientId }).lean();
    const totalDuration = all.reduce((sum, r) => sum + (r.duration || 0), 0);
    const agents = [...new Set(all.map(r => r.agent).filter(Boolean))];

    res.json({
      total:                    all.length,
      total_duration_seconds:   totalDuration,
      total_duration_formatted: formatDuration(totalDuration),
      unique_agents:            agents.length,
      agents
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Recording: save post-call note ───────────────────────────────────────────
app.post('/api/recordings/:id/note', async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'] || 'default';
    const { getRecordingModel } = require('./db/models/Recording');
    const Recording = getRecordingModel(clientId);
    await Recording.findByIdAndUpdate(req.params.id, { notes: req.body.note || '' });
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Recording: toggle star ────────────────────────────────────────────────────
app.post('/api/recordings/:id/star', async (req, res) => {
  try {
    const clientId = req.headers['x-client-id'] || 'default';
    const { getRecordingModel } = require('./db/models/Recording');
    const Recording = getRecordingModel(clientId);
    await Recording.findByIdAndUpdate(req.params.id, { starred: req.body.starred });
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Dev: reseed demo data ─────────────────────────────────────────────────────
app.post('/api/dev/reseed', async (req, res) => {
  try {
    const { execSync } = require('child_process');
    execSync('node scripts/seedDemoData.js', { stdio: 'inherit', cwd: __dirname });
    res.json({ success: true, message: 'Demo data reseeded' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[Server] ${process.env.CLIENT_NAME || 'WhatsApp Bot'} running on port ${PORT}`);
  console.log(`[Server] Dashboard → http://localhost:${PORT}/dashboard`);
  if (process.env.MULTI_TENANT_MODE === 'true') {
    console.log(`[Server] Multi-tenant mode ENABLED — Admin → http://localhost:${PORT}/admin/dashboard`);
  }
  startScheduler();
});
