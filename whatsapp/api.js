const twilio = require('twilio');

let _client = null;
function getClient() {
  if (!_client) {
    _client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return _client;
}

function fromNumber() {
  return `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER || '+14155238886'}`;
}

/**
 * Send a plain text message.
 */
async function sendText(to, text) {
  try {
    await getClient().messages.create({
      from: fromNumber(),
      to:   `whatsapp:+${to}`,
      body: text,
    });
  } catch (err) {
    console.error('[Twilio] sendText error:', err.message);
  }
}

/**
 * Send buttons as a numbered text menu (Twilio has no native button support).
 * buttons: [{ id: 'btn_1', title: 'Option 1' }, ...]
 */
async function sendButtons(to, bodyText, buttons) {
  const menu = buttons.map((b, i) => `${i + 1}. ${b.title}`).join('\n');
  return sendText(to, `${bodyText}\n\n${menu}\n\nReply with a number to choose`);
}

/**
 * Send a list as a numbered text menu (Twilio has no native list support).
 * sections: [{ title: 'Section', rows: [{ id, title, description? }] }]
 */
async function sendList(to, headerText, bodyText, _buttonText, sections) {
  const allRows = sections.flatMap((s) => s.rows);
  const menu = allRows
    .map((r, i) => `${i + 1}. ${r.title}${r.description ? ' \u2014 ' + r.description : ''}`)
    .join('\n');
  return sendText(to, `${headerText}\n\n${bodyText}\n\n${menu}\n\nReply with a number to choose`);
}

/**
 * No-op — Twilio handles read receipts automatically.
 */
function markAsRead(_messageId) {}

module.exports = { sendText, sendButtons, sendList, markAsRead };
