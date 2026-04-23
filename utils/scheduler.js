/**
 * Follow-up reminder scheduler.
 * Runs every 5 minutes; sends WhatsApp follow-up to leads that are
 * still 'new' after FOLLOWUP_DELAY_HOURS (default 2).
 */
const { getLeadsForFollowup, markFollowupSent } = require('../db/database');
const { sendText } = require('../whatsapp/api');

function startScheduler() {
  const intervalMs = 5 * 60 * 1000; // 5 minutes
  setInterval(runFollowups, intervalMs);
  console.log('[Scheduler] Follow-up scheduler started (every 5 min).');
}

async function runFollowups() {
  const delayHours = parseInt(process.env.FOLLOWUP_DELAY_HOURS || '2', 10);
  const offset     = `-${delayHours} hours`;
  const owner      = process.env.OWNER_WHATSAPP;
  const agency     = process.env.CLIENT_NAME || 'Our Agency';

  let leads;
  try {
    leads = getLeadsForFollowup.all({ offset });
  } catch (err) {
    console.error('[Scheduler] DB query failed:', err.message);
    return;
  }

  for (const lead of leads) {
    let data = {};
    try { data = JSON.parse(lead.data || '{}'); } catch (_) {}

    const name = lead.name || 'there';
    const area = data.area || 'Dubai';

    try {
      // Follow-up to customer
      await sendText(
        lead.wa_number,
        `Hi ${name}! 👋 This is ${agency} following up on your property enquiry. ` +
        `Our agent will be reaching out to you shortly. ` +
        `In the meantime, is there anything specific you would like to know about properties in ${area}?`
      );

      // Reminder to owner
      if (owner) {
        await sendText(
          owner,
          `⏰ *FOLLOW-UP REMINDER*\n\n` +
          `${name} enquired ${delayHours} hour(s) ago and has not been contacted yet.\n` +
          `📱 Number: ${lead.wa_number}`
        );
      }

      markFollowupSent.run({ id: lead.id });
      console.log(`[Scheduler] Follow-up sent to ${lead.wa_number}`);
    } catch (err) {
      console.error(`[Scheduler] Failed to send follow-up to ${lead.wa_number}:`, err.message);
    }
  }
}

module.exports = { startScheduler };
