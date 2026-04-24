/**
 * Follow-up reminder scheduler.
 * Runs every 5 minutes; sends WhatsApp follow-up to leads that are
 * still 'new' after FOLLOWUP_DELAY_HOURS (default 2).
 * Also schedules daily 8AM email reports for agents.
 */
const cron = require('node-cron');
const { getLeadsForFollowup, markFollowupSent } = require('../db/database');
const db = require('../db/database');
const { sendText } = require('../whatsapp/api');
const { runReengagement } = require('./reengagementEngine');
const { sendReminder } = require('./appointmentNotifier');

function startScheduler() {
  const intervalMs = 5 * 60 * 1000; // 5 minutes
  setInterval(runFollowups, intervalMs);
  console.log('[Scheduler] Follow-up scheduler started (every 5 min).');
}

async function runFollowups() {
  const delayHours = parseInt(process.env.FOLLOWUP_DELAY_HOURS || '2', 10);
  const owner      = process.env.OWNER_WHATSAPP;
  const agency     = process.env.CLIENT_NAME || 'Our Agency';

  let leads;
  try {
    leads = await getLeadsForFollowup(delayHours);
  } catch (err) {
    console.error('[Scheduler] DB query failed:', err.message);
    return;
  }

  for (const lead of leads) {
    const data = lead.data || {};
    const name = lead.name || 'there';
    const area = data.area || 'Dubai';

    try {
      await sendText(
        lead.wa_number,
        `Hi ${name}! 👋 This is ${agency} following up on your property enquiry. ` +
        `Our agent will be reaching out to you shortly. ` +
        `In the meantime, is there anything specific you would like to know about properties in ${area}?`
      );

      if (owner) {
        await sendText(
          owner,
          `⏰ *FOLLOW-UP REMINDER*\n\n` +
          `${name} enquired ${delayHours} hour(s) ago and has not been contacted yet.\n` +
          `📱 Number: ${lead.wa_number}`
        );
      }

      await markFollowupSent(lead.id);
      console.log(`[Scheduler] Follow-up sent to ${lead.wa_number}`);
    } catch (err) {
      console.error(`[Scheduler] Failed to send follow-up to ${lead.wa_number}:`, err.message);
    }
  }
}

// ── Appointment reminders — every 30 minutes ─────────────────────────────────
cron.schedule('*/30 * * * *', async () => {
  try {
    const upcoming = await db.getUpcomingAppointments();
    const now = Date.now();
    const Appointment = require('../db/models/Appointment');
    for (const appt of upcoming) {
      if (appt.reminder_sent) continue;
      const apptTime = new Date(appt.appointment_date).getTime();
      const minutesAway = (apptTime - now) / 60000;
      if (minutesAway > 60 && minutesAway <= 90) {
        await sendReminder(appt);
        await Appointment.findByIdAndUpdate(appt._id, { reminder_sent: true });
      }
    }
  } catch (e) {
    console.error('[Scheduler] Reminder check failed:', e.message);
  }
});

// ── Daily 10AM re-engagement ────────────────────────────────────────────────
cron.schedule('0 10 * * *', async () => { await runReengagement(); }, { timezone: 'Asia/Dubai' });

// ── Daily 8AM email report ──────────────────────────────────────────────────
cron.schedule('0 8 * * *', async () => {
  if (process.env.REPORT_ENABLED !== 'true') return;
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log('[Report] SMTP not configured — skipping daily report');
    return;
  }
  try {
    console.log('[Report] Generating daily reports...');
    const leads = await db.getAllLeads();
    const stats = await db.getLeadStats();
    const todayAppointments = await db.getAppointmentsByDate(new Date()).catch(() => []);

    // Send to all configured agents
    const agents = await db.getAgents();
    let sentCount = 0;

    for (const agent of agents) {
      if (agent.email) {
        await sendDailyReport(agent.email, agent.name, leads, stats, todayAppointments);
        sentCount++;
      }
    }

    // Always send to owner/notification emails (comma-separated)
    const notificationEmails = (process.env.NOTIFICATION_EMAIL || '')
      .split(',')
      .map(e => e.trim())
      .filter(e => e.length > 0);

    for (const email of notificationEmails) {
      await sendDailyReport(email, 'Team', leads, stats, todayAppointments);
      sentCount++;
    }

    console.log(`[Report] Daily reports sent to ${sentCount} recipients`);
  } catch (e) {
    console.error('[Report] Failed to send daily reports:', e.message);
  }
}, { timezone: 'Asia/Dubai' });

async function sendDailyReport(email, name, leads, stats, todayAppointments = []) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log('[Report] SMTP not configured — skipping report for', email);
    return;
  }
  const nodemailer = require('nodemailer');
  const { generateDailyEmailReport } = require('./emailReportGenerator');

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const html = generateDailyEmailReport(email, name, leads, stats, todayAppointments);
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const newYesterday = leads.filter(l => {
    const d = new Date(l.created_at);
    return d >= yesterday;
  }).length;

  await transporter.sendMail({
    from: `LeadPulse CRM <${process.env.SMTP_USER}>`,
    to: email,
    subject: `🔥 Daily Lead Report — ${newYesterday} new leads | ${new Date().toLocaleDateString('en-AE', { weekday: 'long', day: 'numeric', month: 'long' })}`,
    html,
  });
  console.log(`[Report] Sent to ${email}`);
}

module.exports = { startScheduler, sendDailyReport };
