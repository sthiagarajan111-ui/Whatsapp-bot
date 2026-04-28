/**
 * Flow Engine — generic conversation state machine
 *
 * Supports:
 *   - Multi-flow loading with triggerKeywords
 *   - Arabic language detection
 *   - Lead scoring at COMPLETE
 *   - Business hours out-of-hours message
 */

const fs   = require('fs');
const path = require('path');

const {
  getSession,
  saveSession:   dbSaveSession,
  clearSession,
  insertLead:    _insertLead,
  saveMessage:   dbSaveMessage,
  getLead,
  generateLeadId,
} = require('../db/database');
const { sendText, sendButtons, sendList } = require('../whatsapp/api');
const { detectLanguage }  = require('../utils/langDetect');
const { isBusinessHours } = require('../utils/timeUtils');
const { calculateScore }  = require('../utils/scorer');
const { getAIResponse }   = require('../utils/aiHandler');
const { matchListings, formatListingMessage } = require('../utils/listingsMatcher');
const { createZohoLead }  = require('../utils/integrations/zohoSync');
const { sendLeadEmail }   = require('../utils/integrations/emailNotifier');
const { triggerZapier }      = require('../utils/integrations/zapierWebhook');
const { triggerHotLeadAlert } = require('../utils/hotLeadAlert');
const { handleOptOut } = require('../utils/reengagementEngine');
const { notifyAgentNewAppointment } = require('../utils/appointmentNotifier');

// ── Load all flow files from this directory ───────────────────────────────────
const flows = {};
const flowsDir = __dirname;
fs.readdirSync(flowsDir).forEach((file) => {
  if (file === 'flowEngine.js' || !file.endsWith('.js')) return;
  try {
    const flow = require(path.join(flowsDir, file));
    if (flow.FLOW_NAME && flow.STEPS && flow.onComplete) {
      flows[flow.FLOW_NAME] = flow;
    }
  } catch (err) {
    console.error(`[FlowEngine] Failed to load flow ${file}:`, err.message);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

// Wrapped insertLead that auto-assigns a lead_id on first creation
async function insertLeadWithId(params, clientId = 'default') {
  try {
    const existing = await getLead(params.wa_number, clientId);
    if (!existing || !existing.lead_id) {
      const activeFlow = process.env.ACTIVE_FLOW || 'realEstate';
      const channel  = (params.data && (params.data.channel || params.data._channel)) || params.channel || 'whatsapp';
      const vertical = params.flow_name || activeFlow;
      try {
        const leadId = await generateLeadId(clientId, channel, vertical);
        params = { ...params, lead_id: leadId, channel, vertical };
      } catch (e) {
        console.error('[LeadID] generateLeadId failed:', e.message);
      }
    }
    return await _insertLead(params, clientId);
  } catch (e) {
    console.error('[InsertLead] Failed for', params.wa_number, ':', e.message);
    throw e;
  }
}

const API = { sendText, sendButtons, sendList, insertLead: insertLeadWithId };

function getDefaultFlow() {
  const name = process.env.ACTIVE_FLOW || 'realEstate';
  return flows[name] || Object.values(flows)[0];
}

function selectFlow(messageText) {
  const lower = (messageText || '').toLowerCase();
  for (const flow of Object.values(flows)) {
    if (!flow.triggerKeywords) continue;
    for (const kw of flow.triggerKeywords) {
      if (lower.includes(kw.toLowerCase())) return flow;
    }
  }
  return getDefaultFlow();
}

function parseSession(row) {
  if (!row) return null;
  const data = row.data || {};
  return {
    currentStep:   row.step,
    collectedData: data,
    language:      row.language || 'en',
    flowName:      data._flowName || null,
    aiMode:        !!row.ai_mode,
    aiHistory:     row.ai_history || [],
  };
}

async function persistSession(waNumber, currentStep, collectedData, language, aiMode, aiHistory) {
  await dbSaveSession(waNumber, {
    step:       currentStep,
    data:       collectedData,
    language:   language || 'en',
    ai_mode:    !!aiMode,
    ai_history: aiHistory || [],
  });
}

// Save outbound message to messages table
async function saveOutbound(waNumber, type, content) {
  try { await dbSaveMessage(waNumber, 'outbound', type, content, null); } catch (_) {}
}

// Wrap the real API to capture the text that gets sent, for accurate message logging
function makeCaptureAPI(baseApi) {
  const base = baseApi || API;
  let captured = '';
  const api = {
    sendText: async (to, text, ...rest) => {
      captured = text;
      return base.sendText(to, text, ...rest);
    },
    sendButtons: async (to, text, buttons, ...rest) => {
      const opts = (buttons || []).map((b, i) => `${i + 1}. ${b.title || b.body || b}`).join('\n');
      captured = `${text}\n\n${opts}`;
      return base.sendButtons(to, text, buttons, ...rest);
    },
    // sendList real signature: (to, headerText, bodyText, buttonText, sections)
    sendList: async (to, headerText, bodyText, buttonText, sections, ...rest) => {
      const allRows = (sections || []).flatMap(s => s.rows || []);
      const opts = allRows.map((r, i) => `${i + 1}. ${r.title}`).join('\n');
      captured = `${headerText}\n\n${bodyText}\n\n${opts}`;
      return base.sendList(to, headerText, bodyText, buttonText, sections, ...rest);
    },
  };
  return { api, getText: () => captured };
}

// ── Main entry point ──────────────────────────────────────────────────────────

async function handleMessage(message) {
  const { from, text, buttonId, listId } = message;
  const incomingChannel = message.channel || 'whatsapp';

  // Use channel-specific API adapter if provided (e.g. metaApi for FB/IG),
  // otherwise fall back to the global Twilio API.
  // Always include insertLead from the global API — it's DB logic, not transport.
  const effectiveApi = message.api
    ? { ...message.api, insertLead: API.insertLead }
    : API;

  const rawText = (text || '').trim();
  const inputId = buttonId || listId || null;

  // Re-engagement: STOP → opt-out
  if (rawText.toLowerCase() === 'stop') {
    await handleOptOut(from);
    return;
  }

  // Re-engagement: YES/SHOW ME → clear session and restart flow
  if (['yes','show me','نعم','أرني'].includes(rawText.toLowerCase())) {
    try {
      const lead = await require('../db/database').getLead(from);
      if (lead && lead.status !== 'converted') {
        await clearSession(from);
        // Fall through to normal flow start (session will be null)
      }
    } catch(_) {}
  }

  // "hi" / "hello" / "menu" / "restart" / "start" → reset to START (fresh session)
  const RESTART_KEYWORDS = ['hi', 'hello', 'menu', 'restart', 'start'];
  if (RESTART_KEYWORDS.includes(rawText.toLowerCase())) {
    const flow = getDefaultFlow();
    const existingRow = await getSession(from);
    const lang = existingRow?.language || 'en';
    await clearSession(from);
    const capMenu = makeCaptureAPI(effectiveApi);
    await flow.STEPS.START.send(from, {}, capMenu.api, lang);
    await saveOutbound(from, 'text', capMenu.getText() || 'Welcome message');
    await persistSession(from, 'START', { _flowName: flow.FLOW_NAME, _channel: incomingChannel }, lang, false, []);
    return;
  }

  // Load or bootstrap session
  const sessionRow = await getSession(from);
  let session = parseSession(sessionRow);

  if (!session) {
    // Referral link: REF-{agentId} — tag lead with referral agent
    if (rawText.startsWith('REF-')) {
      const agentId = rawText.replace('REF-', '').trim();
      const lang = detectLanguage('') || 'en';
      const flow = getDefaultFlow();
      const welcomeMsg = lang === 'ar'
        ? `مرحباً! 👋 شكراً لتواصلك معنا. كيف يمكنني مساعدتك اليوم؟`
        : `Hello! 👋 Welcome! I'm your AI property assistant. How can I help you today?`;
      await effectiveApi.sendText(from, welcomeMsg);
      await persistSession(from, 'START', { _flowName: flow.FLOW_NAME, _channel: incomingChannel, referral_agent: agentId, source: 'Referral Link' }, lang, false, []);
      await flow.STEPS.START.send(from, { referral_agent: agentId }, effectiveApi, lang);
      return;
    }

    const lang = (message._fromVoice && message._detectedLanguage)
      ? message._detectedLanguage
      : detectLanguage(rawText);
    const flow = selectFlow(rawText);

    // Out-of-hours auto-reply (only for genuinely new conversations)
    if (!isBusinessHours()) {
      const agency = process.env.CLIENT_NAME || 'Our Agency';
      const startH = process.env.BUSINESS_HOURS_START || '9';
      const endH   = process.env.BUSINESS_HOURS_END   || '18';
      await effectiveApi.sendText(
        from,
        `Thank you for reaching out to ${agency}! 🌙 ` +
        `Our team is available ${startH}am–${endH === '18' ? '6' : endH}pm UAE time (Mon–Sat). ` +
        `We have noted your enquiry and will contact you first thing tomorrow morning. ` +
        `Feel free to leave your name and what you are looking for — we will get back to you!`
      );
    }

    const capStart = makeCaptureAPI(effectiveApi);
    await flow.STEPS.START.send(from, {}, capStart.api, lang);
    await saveOutbound(from, 'text', capStart.getText() || 'Welcome message');
    await persistSession(from, 'START', { _flowName: flow.FLOW_NAME, _channel: incomingChannel }, lang, false, []);
    return;
  }

  const { currentStep, collectedData, language: savedLang, aiMode, aiHistory } = session;

  // Re-detect language on every message
  const detectedLang = rawText ? detectLanguage(rawText) : savedLang;
  const language = detectedLang === 'ar' ? 'ar' : savedLang;

  // ── AI mode: bypass flow engine ─────────────────────────────────────────────
  if (aiMode && rawText) {
    const updatedHistory = [...aiHistory, { role: 'user', content: rawText }];
    try {
      const aiReply = await getAIResponse(from, rawText, collectedData, updatedHistory, language);
      if (aiReply) {
        await effectiveApi.sendText(from, aiReply);
        await saveOutbound(from, 'text', aiReply);
        updatedHistory.push({ role: 'assistant', content: aiReply });
        await persistSession(from, currentStep, collectedData, language, true, updatedHistory.slice(-20));
        return;
      }
    } catch (err) {
      console.error('[AI Mode] Error:', err.message);
    }
    await effectiveApi.sendText(from, language === 'ar'
      ? 'عذراً، حدث خطأ. يرجى المحاولة مرة أخرى أو كتابة "menu".'
      : 'Sorry, something went wrong. Please try again or type "menu".');
    return;
  }

  // Determine which flow this session uses
  const flowName = collectedData._flowName || (process.env.ACTIVE_FLOW || 'realEstate');
  const flow     = flows[flowName] || getDefaultFlow();

  const stepDef = flow.STEPS[currentStep];

  if (!stepDef && currentStep !== 'AI_MODE') {
    // Corrupted session — reset
    await clearSession(from);
    const lang = language || 'en';
    await flow.STEPS.START.send(from, {}, effectiveApi, lang);
    await persistSession(from, 'START', { _flowName: flow.FLOW_NAME }, lang, false, []);
    return;
  }

  // ── Validate input ──────────────────────────────────────────────────────────
  let inputValid = false;
  let resolvedId = inputId;

  if (stepDef.freeText) {
    inputValid = rawText.length > 0;
  } else if (stepDef.acceptIds) {
    if (inputId && stepDef.acceptIds.includes(inputId)) {
      inputValid = true;
    } else if (rawText) {
      const num = parseInt(rawText, 10);
      if (!isNaN(num) && num >= 1 && num <= stepDef.acceptIds.length) {
        resolvedId = stepDef.acceptIds[num - 1];
        inputValid = true;
      } else {
        const matched = stepDef.acceptIds.find(
          (id) => id.toLowerCase() === rawText.toLowerCase()
        );
        if (matched) {
          resolvedId = matched;
          inputValid = true;
        }
      }
    }
  }

  if (!inputValid) {
    await stepDef.send(from, collectedData, effectiveApi, language);
    if (language !== savedLang) {
      await persistSession(from, currentStep, collectedData, language, aiMode, aiHistory);
    }
    return;
  }

  // ── Collect data ────────────────────────────────────────────────────────────
  console.log('[Flow] Input:', rawText, 'Step:', currentStep, 'Resolved ID:', resolvedId);

  const collected = stepDef.collect({ id: resolvedId, text: rawText });
  const newData   = { ...collectedData, ...collected };

  // Support conditional routing via _nextStep (set by collect functions).
  // Use collected._nextStep (current step only) — NOT newData._nextStep, which
  // could carry a stale _nextStep value persisted from an older session in MongoDB.
  const nextStep = collected._nextStep || stepDef.next;
  delete newData._nextStep; // ensure _nextStep is never persisted to MongoDB

  console.log('[Flow] Next step:', nextStep);

  // ── Advance ─────────────────────────────────────────────────────────────────

  // Special handling: CONFIRM_APPOINTMENT — create appointment then go to COMPLETE
  if (nextStep === 'CONFIRM_APPOINTMENT') {
    function getNextWeekend() {
      const d = new Date();
      const daysUntilSat = (6 - d.getDay() + 7) % 7 || 7;
      return new Date(d.getTime() + daysUntilSat * 86400000);
    }
    const dateMap = {
      today:        new Date(),
      tomorrow:     new Date(Date.now() + 86400000),
      day_after:    new Date(Date.now() + 172800000),
      this_weekend: getNextWeekend(),
      next_week:    new Date(Date.now() + 7 * 86400000),
    };
    const appointmentDate = dateMap[newData.appointment_date_pref] || new Date(Date.now() + 86400000);
    const dateDisplay     = appointmentDate.toLocaleDateString('en-AE', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Dubai',
    });
    const timeMap = {
      morning:     'Morning (9am – 12pm)',
      afternoon:   'Afternoon (12pm – 3pm)',
      evening:     'Evening (3pm – 6pm)',
      late_evening: 'Late Evening (6pm – 8pm)',
    };
    const timeSlot = timeMap[newData.appointment_time_pref] || 'Morning (9am – 12pm)';

    // Send confirmation to lead FIRST (graceful — don't block on DB)
    const confirmMsg = language === 'ar'
      ? `✅ *تم تأكيد الموعد!*\n\n📅 التاريخ: ${dateDisplay}\n⏰ الوقت: ${timeSlot}\n👤 سيتصل بك خبيرنا على: +${from}\n\nسنرسل لك تذكيراً قبل ساعة من الموعد.`
      : `✅ *Appointment Confirmed!*\n\n📅 Date: ${dateDisplay}\n⏰ Time: ${timeSlot}\n👤 Our expert will call you at: +${from}\n\nWe'll send you a reminder 1 hour before.\n\nIs there anything specific you'd like to discuss?\nReply with your message or type 'menu' anytime.`;
    await effectiveApi.sendText(from, confirmMsg);
    await saveOutbound(from, 'text', confirmMsg);

    // Save appointment and notify agent (non-blocking on failures)
    let savedAppt = null;
    try {
      const db = require('../db/database');
      savedAppt = await db.saveAppointment({
        wa_number:                from,
        lead_name:                newData.name || 'Unknown',
        appointment_date:         appointmentDate,
        appointment_date_display: dateDisplay,
        time_slot:                timeSlot,
        status:                   'confirmed',
        industry:                 flow.FLOW_NAME || 'realEstate',
        agent_wa:                 process.env.OWNER_WHATSAPP || '',
      });
      // Update lead score — appointments signal high intent
      const score = calculateScore(newData);
      await db.updateLeadScore(from, Math.max(score, 8));
      // Notify agent
      notifyAgentNewAppointment(savedAppt, newData).catch(e =>
        console.error('[Appointment] Agent notify failed:', e.message)
      );
      console.log(`[Appointment] Booked for ${from} — ${dateDisplay} ${timeSlot}`);
    } catch (e) {
      console.error('[Appointment] Save failed (confirmation already sent):', e.message);
    }

    // Proceed to COMPLETE flow
    const score = calculateScore(newData);
    await flow.onComplete(from, newData, effectiveApi, { language, score });
    const leadSnap = { ...newData, wa_number: from, score };
    createZohoLead(leadSnap).catch(() => {});
    sendLeadEmail({ wa_number: from, score, language }, newData).catch(() => {});
    triggerZapier(leadSnap).catch(() => {});
    if (process.env.AI_MODE_ENABLED !== 'false' && process.env.ANTHROPIC_API_KEY) {
      newData._score = score;
      await persistSession(from, 'AI_MODE', newData, language, true, []);
    } else {
      await clearSession(from);
    }
    return;
  }

  if (nextStep === 'COMPLETE' || flow.STEPS[nextStep]?.terminal) {
    if (message._fromVoice) {
      newData.source             = 'voice';
      newData.originalTranscript = rawText;
    }
    const score = calculateScore(newData);
    await flow.onComplete(from, newData, effectiveApi, { language, score });

    // Fire integrations (non-blocking)
    const leadSnap = { ...newData, wa_number: from, score };
    createZohoLead(leadSnap).catch(() => {});
    sendLeadEmail({ wa_number: from, score, language }, newData).catch(() => {});
    triggerZapier(leadSnap).catch(() => {});

    // HOT lead alert
    if (score >= 8) {
      const alertData = {
        name: newData.name,
        interest: newData.interest,
        budget: newData.budget,
        area: newData.area,
        language: language || 'en',
        source: newData.source || 'WhatsApp'
      };
      triggerHotLeadAlert(from, alertData, score).catch(e =>
        console.error('[HOT ALERT] Alert failed:', e.message)
      );
    }

    // Property listing matching
    try {
      const listings = await matchListings(newData);
      const msg = formatListingMessage(listings);
      if (msg) {
        await effectiveApi.sendText(from, msg);
        await saveOutbound(from, 'text', msg);
      }
    } catch (_) {}

    // Enter AI mode if enabled
    if (process.env.AI_MODE_ENABLED !== 'false' && process.env.ANTHROPIC_API_KEY) {
      newData._score = score;
      await persistSession(from, 'AI_MODE', newData, language, true, []);
    } else {
      await clearSession(from);
    }
    return;
  }

  // Send the next step prompt
  const nextDef = flow.STEPS[nextStep];
  if (!nextDef || !nextDef.send) {
    console.error(`[Flow] ERROR: step "${nextStep}" not found. Resetting to START.`);
    await flow.STEPS.START.send(from, {}, effectiveApi, language);
    await persistSession(from, 'START', { _flowName: flow.FLOW_NAME }, language, false, []);
    return;
  }
  const capNext = makeCaptureAPI(effectiveApi);
  await nextDef.send(from, newData, capNext.api, language);
  await saveOutbound(from, 'text', capNext.getText() || `Step: ${nextStep}`);
  try {
    await persistSession(from, nextStep, newData, language, false, []);
  } catch (err) {
    console.error('[Flow] persistSession failed — session may not advance:', err.message);
  }
}

module.exports = { handleMessage };
