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
  saveSession:  dbSaveSession,
  clearSession,
  insertLead,
  saveMessage:  dbSaveMessage,
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

const API = { sendText, sendButtons, sendList, insertLead };

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

// ── Main entry point ──────────────────────────────────────────────────────────

async function handleMessage(message) {
  const { from, text, buttonId, listId } = message;

  const rawText = (text || '').trim();
  const inputId = buttonId || listId || null;

  // "menu" / "restart" → reset to START
  if (['menu', 'restart', 'start'].includes(rawText.toLowerCase())) {
    const flow = getDefaultFlow();
    const existingRow = await getSession(from);
    const lang = existingRow?.language || 'en';
    await clearSession(from);
    await flow.STEPS.START.send(from, {}, API, lang);
    await saveOutbound(from, 'text', 'START prompt sent');
    await persistSession(from, 'START', { _flowName: flow.FLOW_NAME }, lang, false, []);
    return;
  }

  // Load or bootstrap session
  const sessionRow = await getSession(from);
  let session = parseSession(sessionRow);

  if (!session) {
    const lang = (message._fromVoice && message._detectedLanguage)
      ? message._detectedLanguage
      : detectLanguage(rawText);
    const flow = selectFlow(rawText);

    // Out-of-hours auto-reply (only for genuinely new conversations)
    if (!isBusinessHours()) {
      const agency = process.env.CLIENT_NAME || 'Our Agency';
      const startH = process.env.BUSINESS_HOURS_START || '9';
      const endH   = process.env.BUSINESS_HOURS_END   || '18';
      await sendText(
        from,
        `Thank you for reaching out to ${agency}! 🌙 ` +
        `Our team is available ${startH}am–${endH === '18' ? '6' : endH}pm UAE time (Mon–Sat). ` +
        `We have noted your enquiry and will contact you first thing tomorrow morning. ` +
        `Feel free to leave your name and what you are looking for — we will get back to you!`
      );
    }

    await flow.STEPS.START.send(from, {}, API, lang);
    await saveOutbound(from, 'text', 'START prompt sent');
    await persistSession(from, 'START', { _flowName: flow.FLOW_NAME }, lang, false, []);
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
        await sendText(from, aiReply);
        await saveOutbound(from, 'text', aiReply);
        updatedHistory.push({ role: 'assistant', content: aiReply });
        await persistSession(from, currentStep, collectedData, language, true, updatedHistory.slice(-20));
        return;
      }
    } catch (err) {
      console.error('[AI Mode] Error:', err.message);
    }
    await sendText(from, language === 'ar'
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
    await flow.STEPS.START.send(from, {}, API, lang);
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
    await stepDef.send(from, collectedData, API, language);
    if (language !== savedLang) {
      await persistSession(from, currentStep, collectedData, language, aiMode, aiHistory);
    }
    return;
  }

  // ── Collect data ────────────────────────────────────────────────────────────
  const collected = stepDef.collect({ id: resolvedId, text: rawText });
  const newData   = { ...collectedData, ...collected };

  const nextStep = stepDef.next;

  // ── Advance ─────────────────────────────────────────────────────────────────
  if (nextStep === 'COMPLETE' || flow.STEPS[nextStep]?.terminal) {
    if (message._fromVoice) {
      newData.source             = 'voice';
      newData.originalTranscript = rawText;
    }
    const score = calculateScore(newData);
    await flow.onComplete(from, newData, API, { language, score });

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
        await sendText(from, msg);
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
  await nextDef.send(from, newData, API, language);
  await saveOutbound(from, 'text', `Step: ${nextStep}`);
  await persistSession(from, nextStep, newData, language, false, []);
}

module.exports = { handleMessage };
