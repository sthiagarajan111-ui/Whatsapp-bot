const { sendText } = require('../whatsapp/api');
const db = require('../db/database');

const MESSAGES = {
  day3: {
    en: (name, area) => `Hi ${name}! 👋 Still looking for a property in ${area || 'Dubai'}? We have new listings that might interest you. Reply YES to see options or STOP to unsubscribe.`,
    ar: (name, area) => `مرحباً ${name}! 👋 هل لا تزال تبحث عن عقار في ${area || 'دبي'}؟ لدينا عروض جديدة. رد بـ نعم لرؤية الخيارات.`
  },
  day7: {
    en: (name, area, budget) => `Hi ${name}! 🏠 Property prices in ${area || 'Dubai'} moved this week. Based on your ${budget || ''} budget, there are excellent opportunities now. Reply SHOW ME for top 3 listings.`,
    ar: (name, area) => `مرحباً ${name}! 🏠 تحركت أسعار العقارات في ${area || 'دبي'} هذا الأسبوع. هناك فرص ممتازة ضمن ميزانيتك. رد بـ أرني لرؤية أفضل 3 عروض.`
  },
  day14: {
    en: (name) => `Hi ${name}! Our team helped 12 clients close deals this month in Dubai. 🌟 Are you still in the market? Reply YES to reconnect with an agent.`,
    ar: (name) => `مرحباً ${name}! فريقنا ساعد 12 عميل هذا الشهر في دبي. 🌟 هل لا تزال مهتماً؟ رد بـ نعم للتواصل مع وكيل.`
  }
};

async function runReengagement() {
  if (process.env.REENGAGEMENT_ENABLED !== 'true') return;
  console.log('[Re-engagement] Running daily check...');
  const leads = await db.getAllLeads();
  const now = Date.now();
  let sent = 0;
  const areaMap = { downtown:'Downtown Dubai', marina:'Dubai Marina', jvc:'JVC/JVT', business_bay:'Business Bay', palm:'Palm Jumeirah', mirdif:'Mirdif', open:'Dubai' };
  const budgetMap = { under_500k:'under AED 500K', '500k_1m':'AED 500K-1M', '1m_2m':'AED 1M-2M', '2m_5m':'AED 2M-5M', above_5m:'above AED 5M' };
  for (const lead of leads) {
    if (['converted','lost'].includes(lead.status) || lead.human_mode) continue;
    const data = typeof lead.data === 'string' ? JSON.parse(lead.data||'{}') : (lead.data||{});
    if (data.reengagement_optout) continue;
    const daysSince = Math.floor((now - new Date(lead.created_at).getTime()) / 86400000);
    const lastDay = data.last_reengagement_day || 0;
    let key = null;
    if (daysSince >= 14 && lastDay < 14) key = 'day14';
    else if (daysSince >= 7 && lastDay < 7) key = 'day7';
    else if (daysSince >= 3 && lastDay < 3) key = 'day3';
    if (!key) continue;
    const lang = lead.language || 'en';
    const msgFn = MESSAGES[key][lang] || MESSAGES[key]['en'];
    const msg = msgFn(lead.name||'there', areaMap[data.area]||data.area||'Dubai', budgetMap[data.budget]||data.budget||'');
    try {
      await sendText(lead.wa_number, msg);
      const updated = {...data, last_reengagement_day: daysSince, last_reengagement_at: new Date().toISOString()};
      await db.saveLead(lead.wa_number, lead.name, lead.status, lead.score, updated, lang);
      sent++;
      console.log(`[Re-engagement] Sent ${key} to ${lead.wa_number}`);
      await new Promise(r => setTimeout(r, 1000));
    } catch(e) { console.error(`[Re-engagement] Failed ${lead.wa_number}:`, e.message); }
  }
  console.log(`[Re-engagement] Done — sent ${sent} messages`);
  return sent;
}

async function handleOptOut(waNumber) {
  try {
    const lead = await db.getLead(waNumber);
    if (lead) {
      const data = typeof lead.data === 'string' ? JSON.parse(lead.data||'{}') : (lead.data||{});
      await db.saveLead(waNumber, lead.name, lead.status, lead.score, {...data, reengagement_optout:true}, lead.language);
      await sendText(waNumber, "You've been unsubscribed from follow-up messages. Type 'menu' anytime to restart.");
    }
  } catch(e) { console.error('[Re-engagement] handleOptOut error:', e.message); }
}

module.exports = { runReengagement, handleOptOut };
