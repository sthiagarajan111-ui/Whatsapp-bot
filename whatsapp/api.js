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

/**
 * Send an image or video via Twilio media URL.
 */
async function sendImage(to, imageUrl, caption) {
  try {
    const message = await getClient().messages.create({
      from: fromNumber(),
      to:   `whatsapp:+${to}`,
      mediaUrl: [imageUrl],
      body: caption || ''
    });
    return message.sid;
  } catch(e) {
    console.error('[Twilio] sendImage error:', e.message);
    throw e;
  }
}

/**
 * Send a formatted property card as a text message.
 */
async function sendPropertyCard(to, listing, language) {
  const isAr = language === 'ar';
  const msg = isAr
    ? `🏠 *${listing.title}*\n\n💰 السعر: AED ${listing.price?.toLocaleString()}\n📍 الموقع: ${listing.area}\n🛏 غرف النوم: ${listing.beds}\n🚿 الحمامات: ${listing.baths}\n📐 المساحة: ${listing.size_sqft} قدم مربع\n\n${listing.description||''}\n${listing.listing_url?'\n🔗 '+listing.listing_url:''}`
    : `🏠 *${listing.title}*\n\n💰 Price: AED ${listing.price?.toLocaleString()}\n📍 Location: ${listing.area}\n🛏 Bedrooms: ${listing.beds}\n🚿 Bathrooms: ${listing.baths}\n📐 Size: ${listing.size_sqft} sqft\n\n${listing.description||''}\n${listing.listing_url?'\n🔗 View listing: '+listing.listing_url:''}`;
  return await sendText(to, msg);
}

module.exports = { sendText, sendButtons, sendList, markAsRead, sendImage, sendPropertyCard };
