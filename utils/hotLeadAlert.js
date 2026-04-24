const nodemailer = require('nodemailer');
const { sendText } = require('../whatsapp/api');

async function triggerHotLeadAlert(waNumber, leadData, score) {
  if (process.env.HOT_LEAD_ALERTS_ENABLED !== 'true') return;

  console.log(`[HOT ALERT] Score ${score}/10 — ${leadData.name} (${waNumber})`);

  const name = leadData.name || 'Unknown';
  const interest = leadData.interest || 'Property';
  const budget = leadData.budget || 'Not specified';
  const area = leadData.area || 'Not specified';
  const language = leadData.language || 'en';
  const source = leadData.source || 'WhatsApp';

  const budgetMap = {
    under_500k: 'Under AED 500K',
    '500k_1m': 'AED 500K-1M',
    '1m_2m': 'AED 1M-2M',
    '2m_5m': 'AED 2M-5M',
    above_5m: 'Above AED 5M'
  };
  const budgetDisplay = budgetMap[budget] || budget;

  const areaMap = {
    downtown: 'Downtown Dubai',
    marina: 'Dubai Marina',
    jvc: 'JVC/JVT',
    business_bay: 'Business Bay',
    palm: 'Palm Jumeirah',
    mirdif: 'Mirdif',
    open: 'Flexible'
  };
  const areaDisplay = areaMap[area] || area;

  const dashboardUrl = process.env.DASHBOARD_URL || 'https://whatsapp-bot-41x7.onrender.com/dashboard';

  // 1. WhatsApp alert to OWNER_WHATSAPP
  if (process.env.OWNER_WHATSAPP) {
    const waMessage = `🔥 *HOT LEAD ALERT — Score ${score}/10*

👤 *Name:* ${name}
📱 *WhatsApp:* +${waNumber}
🏠 *Looking to:* ${interest}
💰 *Budget:* ${budgetDisplay}
📍 *Area:* ${areaDisplay}
🌐 *Language:* ${language === 'ar' ? 'Arabic 🇦🇪' : 'English'}
📊 *Source:* ${source}

⚡ Reply *TAKE ${waNumber}* to take over this conversation now.

Dashboard: ${dashboardUrl}`;

    try {
      await sendText(process.env.OWNER_WHATSAPP, waMessage);
      console.log(`[HOT ALERT] WhatsApp sent to owner`);
    } catch(e) {
      console.error(`[HOT ALERT] WhatsApp to owner failed:`, e.message);
    }
  }

  // 2. WhatsApp alert to additional agent numbers
  const agentNumbers = (process.env.AGENT_WHATSAPP_NUMBERS || '')
    .split(',')
    .map(n => n.trim())
    .filter(n => n.length > 0 && n !== process.env.OWNER_WHATSAPP);

  for (const agentNumber of agentNumbers) {
    try {
      await sendText(agentNumber,
        `🔥 HOT LEAD: ${name} — ${interest} in ${areaDisplay} (${budgetDisplay}) Score: ${score}/10. Reply TAKE ${waNumber} to take over.`
      );
      console.log(`[HOT ALERT] WhatsApp sent to agent ${agentNumber}`);
    } catch(e) {
      console.error(`[HOT ALERT] WhatsApp to ${agentNumber} failed:`, e.message);
    }
  }

  // 3. Email alert to all notification emails
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS || !process.env.NOTIFICATION_EMAIL) {
    console.log('[HOT ALERT] SMTP not configured — skipping email alert');
    return;
  }

  const emails = process.env.NOTIFICATION_EMAIL
    .split(',')
    .map(e => e.trim())
    .filter(e => e.length > 0);

  const scoreBarWidth = score * 10;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6fa;font-family:Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:20px">

  <div style="background:#EF4444;border-radius:12px 12px 0 0;padding:28px;text-align:center">
    <div style="font-size:36px;margin-bottom:8px">🔥</div>
    <div style="color:white;font-size:24px;font-weight:bold">HOT LEAD ALERT</div>
    <div style="color:rgba(255,255,255,0.9);font-size:15px;margin-top:6px">Score: ${score}/10 — Immediate Action Required</div>
  </div>

  <div style="background:white;padding:24px;border-left:4px solid #EF4444;border-right:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb">
    <table style="width:100%;border-collapse:collapse">
      <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:13px;width:35%">👤 Name</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-weight:bold;font-size:14px;color:#111">${name}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:13px">📱 WhatsApp</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-size:14px;color:#111">+${waNumber}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:13px">🏠 Interest</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-size:14px;color:#111;text-transform:capitalize">${interest}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:13px">💰 Budget</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-size:14px;color:#111">${budgetDisplay}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:13px">📍 Area</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-size:14px;color:#111">${areaDisplay}</td></tr>
      <tr><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:13px">🌐 Language</td><td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-size:14px;color:#111">${language === 'ar' ? 'Arabic 🇦🇪' : 'English'}</td></tr>
      <tr><td style="padding:10px 0;color:#6b7280;font-size:13px">📊 Source</td><td style="padding:10px 0;font-size:14px;color:#111">${source}</td></tr>
    </table>
  </div>

  <div style="background:white;padding:16px 24px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb">
    <div style="font-size:12px;color:#6b7280;margin-bottom:6px">Lead Score</div>
    <div style="background:#f3f4f6;border-radius:999px;height:14px;overflow:hidden">
      <div style="background:#EF4444;width:${scoreBarWidth}%;height:100%;border-radius:999px"></div>
    </div>
    <div style="font-size:14px;font-weight:bold;color:#EF4444;margin-top:6px">${score} / 10</div>
  </div>

  <div style="background:#FEF2F2;padding:20px 24px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;text-align:center">
    <div style="font-size:14px;color:#991B1B;font-weight:bold;margin-bottom:14px">⚡ Act now — HOT leads go cold within 30 minutes</div>
    <a href="${dashboardUrl}" style="display:inline-block;background:#EF4444;color:white;padding:13px 28px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:14px;margin:5px">Open Dashboard</a>
    <a href="https://wa.me/${waNumber}" style="display:inline-block;background:#25D366;color:white;padding:13px 28px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:14px;margin:5px">WhatsApp ${name}</a>
  </div>

  <div style="background:#f9fafb;padding:16px 24px;border-radius:0 0 12px 12px;border:1px solid #e5e7eb;border-top:none;text-align:center">
    <div style="font-size:12px;color:#9ca3af">LeadPulse AI Alert • ${new Date().toLocaleString('en-AE', {timeZone:'Asia/Dubai'})} UAE Time</div>
  </div>

</div>
</body>
</html>`;

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });

    for (const email of emails) {
      await transporter.sendMail({
        from: `LeadPulse CRM <${process.env.SMTP_USER}>`,
        to: email,
        subject: `🔥 HOT LEAD: ${name} — Score ${score}/10 — ${interest} in ${areaDisplay} (${budgetDisplay})`,
        html: html
      });
      console.log(`[HOT ALERT] Email sent to ${email}`);
    }
  } catch(e) {
    console.error(`[HOT ALERT] Email failed:`, e.message);
  }
}

module.exports = { triggerHotLeadAlert };
