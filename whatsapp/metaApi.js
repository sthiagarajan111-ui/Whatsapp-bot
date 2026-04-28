'use strict';

const fetch = require('node-fetch');

const META_API_BASE = 'https://graph.facebook.com/v18.0';

function getToken() {
  return process.env.META_PAGE_ACCESS_TOKEN || '';
}

// Send plain text message
async function sendText(recipientId, text) {
  const token = getToken();
  if (!token) {
    console.log(`[MetaAPI SIMULATION] Would send to ${recipientId}: "${String(text).substring(0, 80)}"`);
    return { simulated: true };
  }
  try {
    const res = await fetch(`${META_API_BASE}/me/messages?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text: String(text).substring(0, 2000) },
        messaging_type: 'RESPONSE'
      })
    });
    const data = await res.json();
    if (data.error) console.error('[MetaAPI] sendText error:', data.error.message);
    return data;
  } catch(e) {
    console.error('[MetaAPI] sendText exception:', e.message);
  }
}

// Send quick reply buttons (up to 13 on FB/IG)
async function sendButtons(recipientId, bodyText, buttons) {
  const token = getToken();
  if (!token) {
    const numbered = (buttons || []).map((b, i) => `${i+1}. ${b.title || b.body || b}`).join('\n');
    console.log(`[MetaAPI SIMULATION] Would send buttons to ${recipientId}: "${String(bodyText).substring(0,60)}" [${buttons.length} options]`);
    return { simulated: true };
  }
  try {
    const quickReplies = (buttons || []).slice(0, 13).map((b, i) => ({
      content_type: 'text',
      title: String(b.title || b.body || b).substring(0, 20),
      payload: b.id || b.title || String(i + 1)
    }));
    const res = await fetch(`${META_API_BASE}/me/messages?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text: String(bodyText).substring(0, 2000), quick_replies: quickReplies },
        messaging_type: 'RESPONSE'
      })
    });
    const data = await res.json();
    if (data.error) {
      console.error('[MetaAPI] sendButtons error:', data.error.message);
      // Fallback to numbered text
      const numbered = (buttons || []).map((b, i) => `${i+1}. ${b.title || b.body || b}`).join('\n');
      return sendText(recipientId, bodyText + '\n\n' + numbered);
    }
    return data;
  } catch(e) {
    console.error('[MetaAPI] sendButtons exception:', e.message);
    const numbered = (buttons || []).map((b, i) => `${i+1}. ${b.title || b.body || b}`).join('\n');
    return sendText(recipientId, bodyText + '\n\n' + numbered);
  }
}

// Send list — flatten sections to quick replies
async function sendList(recipientId, headerText, bodyText, buttonText, sections) {
  const allItems = (sections || []).flatMap(s => s.rows || s.items || []);
  if (!getToken() || allItems.length === 0) {
    const numbered = allItems.map((item, i) => `${i+1}. ${item.title || item}`).join('\n');
    const full = [headerText, bodyText, numbered].filter(Boolean).join('\n\n');
    console.log(`[MetaAPI SIMULATION] Would send list to ${recipientId}: "${String(full).substring(0,80)}"`);
    return { simulated: true };
  }
  return sendButtons(recipientId, bodyText || headerText, allItems);
}

// Mark message as seen
async function markSeen(recipientId) {
  const token = getToken();
  if (!token) return;
  try {
    await fetch(`${META_API_BASE}/me/messages?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: recipientId }, sender_action: 'mark_seen' })
    });
  } catch(e) {}
}

// Show typing indicator
async function sendTyping(recipientId) {
  const token = getToken();
  if (!token) return;
  try {
    await fetch(`${META_API_BASE}/me/messages?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: recipientId }, sender_action: 'typing_on' })
    });
  } catch(e) {}
}

// markAsRead no-op (compatibility with Twilio api.js interface)
function markAsRead() {}

module.exports = { sendText, sendButtons, sendList, markSeen, sendTyping, markAsRead };
