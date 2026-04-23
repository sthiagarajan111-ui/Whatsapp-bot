/**
 * Zapier webhook integration — fires on lead COMPLETE.
 * Only activates if ZAPIER_WEBHOOK_URL is set.
 */

const fetch = require('node-fetch');

async function triggerZapier(leadData) {
  if (!process.env.ZAPIER_WEBHOOK_URL) return;

  try {
    await fetch(process.env.ZAPIER_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...leadData,
        timestamp: new Date().toISOString(),
        source: 'WhatsApp Bot',
        agency: process.env.CLIENT_NAME || 'Agency',
      }),
    });
    console.log('[Zapier] Webhook triggered successfully');
  } catch (err) {
    console.error('[Zapier] Webhook failed:', err.message);
  }
}

module.exports = { triggerZapier };
