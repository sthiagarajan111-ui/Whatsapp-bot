const { sendText } = require('../whatsapp/api');
const nodemailer   = require('nodemailer');

async function notifyAgentNewAppointment(appointment, leadData) {
  const waMsg =
    `🗓️ *New Appointment Booked!*\n\n` +
    `👤 *Client:* ${appointment.lead_name}\n` +
    `📱 *WhatsApp:* +${appointment.wa_number}\n` +
    `📅 *Date:* ${appointment.appointment_date_display}\n` +
    `⏰ *Time:* ${appointment.time_slot}\n` +
    `🏠 *Interest:* ${leadData.interest || leadData.intent || 'General Enquiry'}\n` +
    `💰 *Budget:* ${leadData.budget || 'Not specified'}\n` +
    `📍 *Area:* ${leadData.area || 'Not specified'}\n` +
    `⭐ *Score:* ${leadData.score || leadData._score || 0}/10\n\n` +
    `Dashboard: ${process.env.DASHBOARD_URL || 'https://whatsapp-bot-41x7.onrender.com/dashboard'}`;

  try {
    if (process.env.OWNER_WHATSAPP) {
      await sendText(process.env.OWNER_WHATSAPP, waMsg);
    }
    const agentNumbers = (process.env.AGENT_WHATSAPP_NUMBERS || '')
      .split(',').map(n => n.trim())
      .filter(n => n && n !== process.env.OWNER_WHATSAPP);
    for (const num of agentNumbers) {
      await sendText(num, waMsg);
    }
    console.log(`[Appointment] Agent notified via WhatsApp`);
  } catch (e) {
    console.error('[Appointment] WhatsApp notification failed:', e.message);
  }

  if (process.env.SMTP_USER && process.env.SMTP_PASS && process.env.NOTIFICATION_EMAIL) {
    try {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      const emails = process.env.NOTIFICATION_EMAIL.split(',').map(e => e.trim()).filter(e => e);

      const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f4f6fa;font-family:Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:20px">
  <div style="background:#1C2333;border-radius:12px 12px 0 0;padding:24px;text-align:center">
    <div style="font-size:32px;margin-bottom:8px">🗓️</div>
    <div style="color:white;font-size:20px;font-weight:bold">New Appointment Booked</div>
    <div style="color:rgba(255,255,255,.7);font-size:13px;margin-top:4px">${appointment.appointment_date_display} · ${appointment.time_slot}</div>
  </div>
  <div style="background:white;padding:24px;border-left:4px solid #3B82F6;border-right:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb">
    <table style="width:100%;border-collapse:collapse">
      <tr><td style="padding:9px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:13px;width:35%">👤 Client Name</td><td style="padding:9px 0;border-bottom:1px solid #f3f4f6;font-weight:bold;font-size:14px">${appointment.lead_name}</td></tr>
      <tr><td style="padding:9px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:13px">📱 WhatsApp</td><td style="padding:9px 0;border-bottom:1px solid #f3f4f6;font-size:14px">+${appointment.wa_number}</td></tr>
      <tr><td style="padding:9px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:13px">📅 Date</td><td style="padding:9px 0;border-bottom:1px solid #f3f4f6;font-size:14px;font-weight:bold;color:#3B82F6">${appointment.appointment_date_display}</td></tr>
      <tr><td style="padding:9px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:13px">⏰ Time Slot</td><td style="padding:9px 0;border-bottom:1px solid #f3f4f6;font-size:14px;font-weight:bold;color:#3B82F6">${appointment.time_slot}</td></tr>
      <tr><td style="padding:9px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:13px">🏠 Interest</td><td style="padding:9px 0;border-bottom:1px solid #f3f4f6;font-size:14px;text-transform:capitalize">${leadData.interest || leadData.intent || 'General'}</td></tr>
      <tr><td style="padding:9px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:13px">💰 Budget</td><td style="padding:9px 0;border-bottom:1px solid #f3f4f6;font-size:14px">${leadData.budget || 'Not specified'}</td></tr>
      <tr><td style="padding:9px 0;color:#6b7280;font-size:13px">⭐ Lead Score</td><td style="padding:9px 0;font-size:14px;font-weight:bold;color:#EF4444">${leadData.score || leadData._score || 0}/10</td></tr>
    </table>
  </div>
  <div style="background:#EFF6FF;padding:16px 24px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;text-align:center">
    <a href="${process.env.DASHBOARD_URL || 'https://whatsapp-bot-41x7.onrender.com/dashboard'}" style="display:inline-block;background:#3B82F6;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:14px;margin:4px">View in Dashboard</a>
    <a href="https://wa.me/${appointment.wa_number}" style="display:inline-block;background:#25D366;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:14px;margin:4px">WhatsApp Client</a>
  </div>
  <div style="background:#f9fafb;padding:14px 24px;border-radius:0 0 12px 12px;border:1px solid #e5e7eb;border-top:none;text-align:center">
    <div style="font-size:12px;color:#9ca3af">Axyren AI · ${new Date().toLocaleString('en-AE', { timeZone: 'Asia/Dubai' })} UAE Time</div>
  </div>
</div></body></html>`;

      for (const email of emails) {
        await transporter.sendMail({
          from:    `Axyren CRM <${process.env.SMTP_USER}>`,
          to:      email,
          subject: `🗓️ New Appointment: ${appointment.lead_name} — ${appointment.appointment_date_display} ${appointment.time_slot}`,
          html,
        });
      }
      console.log(`[Appointment] Email notification sent`);
    } catch (e) {
      console.error('[Appointment] Email failed:', e.message);
    }
  }
}

async function sendReminder(appointment) {
  const msg =
    `⏰ *Appointment Reminder*\n\n` +
    `Your call with our expert is in 1 hour!\n\n` +
    `📅 ${appointment.appointment_date_display}\n` +
    `⏰ ${appointment.time_slot}\n\n` +
    `We'll call you at this number. Please ensure you're available.`;
  try {
    await sendText(appointment.wa_number, msg);
    console.log(`[Appointment] Reminder sent to ${appointment.wa_number}`);
  } catch (e) {
    console.error('[Appointment] Reminder failed:', e.message);
  }
}

module.exports = { notifyAgentNewAppointment, sendReminder };
