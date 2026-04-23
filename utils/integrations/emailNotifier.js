/**
 * Email notifications via Nodemailer (Gmail SMTP or any SMTP).
 * Only activates if EMAIL_NOTIFICATIONS=true and SMTP_USER is set.
 */

let nodemailer;
try { nodemailer = require('nodemailer'); } catch (_) { nodemailer = null; }

function buildEmailTemplate(lead, data) {
  const score = lead.score || 0;
  const badge = score >= 8 ? '🔥 HOT' : score >= 5 ? '🌡 WARM' : '❄ COLD';
  return `
    <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;color:#0F1A35">
      <div style="background:linear-gradient(135deg,#3D7FFA,#06C8E0);padding:24px;border-radius:12px 12px 0 0;color:white">
        <h2 style="margin:0">🏠 New Lead — ${process.env.CLIENT_NAME || 'Your Agency'}</h2>
        <p style="margin:4px 0 0;opacity:.8">${badge} Lead Score: ${score}/10</p>
      </div>
      <div style="background:white;padding:24px;border:1px solid #E4E9F2;border-top:none;border-radius:0 0 12px 12px">
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:8px 0;color:#5A6A8A;width:140px">Name</td><td style="font-weight:600">${data.name || 'N/A'}</td></tr>
          <tr><td style="padding:8px 0;color:#5A6A8A">WhatsApp</td><td style="font-weight:600">${lead.wa_number}</td></tr>
          <tr><td style="padding:8px 0;color:#5A6A8A">Interest</td><td>${data.intent || 'N/A'}</td></tr>
          <tr><td style="padding:8px 0;color:#5A6A8A">Property Type</td><td>${data.propertyType || 'N/A'}</td></tr>
          <tr><td style="padding:8px 0;color:#5A6A8A">Budget</td><td>${data.budget || 'N/A'}</td></tr>
          <tr><td style="padding:8px 0;color:#5A6A8A">Area</td><td>${data.area || 'N/A'}</td></tr>
          <tr><td style="padding:8px 0;color:#5A6A8A">Language</td><td>${lead.language === 'ar' ? 'Arabic' : 'English'}</td></tr>
          <tr><td style="padding:8px 0;color:#5A6A8A">Received</td><td>${new Date().toLocaleString('en-AE', { timeZone: 'Asia/Dubai' })}</td></tr>
        </table>
      </div>
    </div>`;
}

async function sendLeadEmail(lead, collectedData) {
  if (!nodemailer) { console.warn('[Email] nodemailer not installed. Run: npm install nodemailer'); return; }
  if (process.env.EMAIL_NOTIFICATIONS !== 'true') return;
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return;

  try {
    const transporter = nodemailer.createTransporter({
      service: 'gmail',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    const score = lead.score || 0;
    const subject = `${score >= 8 ? '🔥 HOT' : '📩 New'} Lead: ${collectedData.name || 'Unknown'} — ${collectedData.area || 'N/A'}`;

    await transporter.sendMail({
      from:    process.env.SMTP_USER,
      to:      process.env.NOTIFICATION_EMAIL || process.env.SMTP_USER,
      subject,
      html:    buildEmailTemplate(lead, collectedData),
    });

    console.log('[Email] Lead notification sent to', process.env.NOTIFICATION_EMAIL);
  } catch (err) {
    console.error('[Email] Failed to send notification:', err.message);
  }
}

module.exports = { sendLeadEmail };
