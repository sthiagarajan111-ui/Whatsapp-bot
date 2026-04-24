const FLOW_NAME = 'salon';
const triggerKeywords = ['salon', 'hair', 'beauty', 'haircut', 'stylist', 'color treatment', 'spa', 'blowout'];

const STEPS = {
  START: {
    send: async (wa, _d, { sendButtons }) => {
      const agency = process.env.CLIENT_NAME || 'Our Salon';
      await sendButtons(wa, `Welcome to ${agency}! 💇 What service are you looking for?`, [
        { id: 'haircut',   title: 'Haircut & Style' },
        { id: 'color',     title: 'Hair Color'      },
        { id: 'treatment', title: 'Treatment & Spa' },
      ]);
    },
    acceptIds: ['haircut', 'color', 'treatment'],
    collect: (msg) => ({ service: msg.id || msg.text }),
    next: 'ASK_NAME',
  },
  ASK_NAME: {
    send: async (wa, _d, { sendText }) => { await sendText(wa, "Lovely choice! What's your name?"); },
    freeText: true,
    collect: (msg) => ({ name: msg.text.trim() }),
    next: 'ASK_STYLIST',
  },
  ASK_STYLIST: {
    send: async (wa, d, { sendButtons }) => {
      await sendButtons(wa, `Do you have a preferred stylist, ${d.name || 'there'}?`, [
        { id: 'any',      title: 'Any available'  },
        { id: 'senior',   title: 'Senior Stylist' },
        { id: 'specific', title: "I'll specify"   },
      ]);
    },
    acceptIds: ['any', 'senior', 'specific'],
    collect: (msg) => ({ stylist_pref: msg.id || msg.text }),
    next: 'ASK_DATE',
  },
  ASK_DATE: {
    send: async (wa, _d, { sendButtons }) => {
      await sendButtons(wa, 'When would you like to come in?', [
        { id: 'today',     title: 'Today'     },
        { id: 'tomorrow',  title: 'Tomorrow'  },
        { id: 'this_week', title: 'This Week' },
      ]);
    },
    acceptIds: ['today', 'tomorrow', 'this_week'],
    collect: (msg) => ({ date: msg.id || msg.text }),
    next: 'ASK_APPOINTMENT',
  },
  ASK_APPOINTMENT: {
    send: async (wa, _d, { sendButtons }, lang) => {
      if (lang === 'ar') {
        await sendButtons(wa,
          `أخبار رائعة! أحد خبرائنا سيسعد بمساعدتك أكثر. 🗓️\n\nهل تريد حجز وقت مناسب للاتصال؟`,
          [{ id: 'yes_appointment', title: 'نعم، احجز مكالمة' }, { id: 'no_appointment', title: 'لا شكراً' }]
        );
      } else {
        await sendButtons(wa,
          `Great news! One of our experts would love to help you further. 🗓️\n\nShall I book a convenient time for a call?`,
          [{ id: 'yes_appointment', title: 'Yes, book a call' }, { id: 'no_appointment', title: 'No thanks' }]
        );
      }
    },
    acceptIds: ['yes_appointment', 'no_appointment'],
    collect: (msg) => ({
      appointment_requested: msg.id || msg.text,
      _nextStep: (msg.id || msg.text) === 'yes_appointment' ? 'SELECT_DATE' : 'COMPLETE',
    }),
    next: 'SELECT_DATE',
  },
  SELECT_DATE: {
    send: async (wa, _d, { sendText }, lang) => {
      if (lang === 'ar') {
        await sendText(wa, `ممتاز! 📅 أي يوم يناسبك؟\n\n1. اليوم\n2. غداً\n3. بعد غد\n4. هذا الأسبوع\n5. الأسبوع القادم`);
      } else {
        await sendText(wa, `Perfect! 📅 Which date works best for you?\n\n1. Today\n2. Tomorrow\n3. Day after tomorrow\n4. This weekend\n5. Next week`);
      }
    },
    acceptIds: ['today', 'tomorrow', 'day_after', 'this_weekend', 'next_week'],
    collect: (msg) => ({ appointment_date_pref: msg.id || msg.text }),
    next: 'SELECT_TIME',
  },
  SELECT_TIME: {
    send: async (wa, _d, { sendText }, lang) => {
      if (lang === 'ar') {
        await sendText(wa, `وما هو الوقت المناسب؟ ⏰\n\n1. الصباح (9 – 12)\n2. الظهيرة (12 – 3)\n3. العصر (3 – 6)\n4. المساء (6 – 8)`);
      } else {
        await sendText(wa, `And what time suits you? ⏰\n\n1. Morning (9am – 12pm)\n2. Afternoon (12pm – 3pm)\n3. Evening (3pm – 6pm)\n4. Late evening (6pm – 8pm)`);
      }
    },
    acceptIds: ['morning', 'afternoon', 'evening', 'late_evening'],
    collect: (msg) => ({ appointment_time_pref: msg.id || msg.text }),
    next: 'CONFIRM_APPOINTMENT',
  },
  CONFIRM_APPOINTMENT: { terminal: true },
  COMPLETE: { terminal: true },
};

async function onComplete(waNumber, data, { sendText, insertLead }, options = {}) {
  const agency = process.env.CLIENT_NAME || 'Our Salon';
  await sendText(waNumber, `Thank you, ${data.name}! ✨\nYour ${data.service} appointment request is received. We'll confirm your ${data.date} booking shortly.\n\n_${agency}_`);
  await insertLead({ wa_number: waNumber, name: data.name || '', flow_name: FLOW_NAME, data, score: options.score || 4, language: options.language || 'en' });
  const owner = process.env.OWNER_WHATSAPP;
  if (owner) await sendText(owner, `💇 New Salon Booking: ${data.name} | ${data.service} | ${data.date}\n📱 ${waNumber}`);
}

module.exports = { FLOW_NAME, STEPS, onComplete, triggerKeywords };
