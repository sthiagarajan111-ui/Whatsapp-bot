const FLOW_NAME = 'restaurant';
const triggerKeywords = ['restaurant', 'dine', 'food', 'eat', 'table', 'reservation', 'takeaway', 'catering'];

const STEPS = {
  START: {
    send: async (wa, _d, { sendButtons }) => {
      const agency = process.env.CLIENT_NAME || 'Our Restaurant';
      await sendButtons(wa, `Welcome to ${agency}! How can we help you today?`, [
        { id: 'dine_in',  title: 'Dine In'        },
        { id: 'takeaway', title: 'Takeaway'        },
        { id: 'event',    title: 'Book for Event'  },
      ]);
    },
    acceptIds: ['dine_in', 'takeaway', 'event'],
    collect: (msg) => ({ service_type: msg.id || msg.text }),
    next: 'ASK_NAME',
  },
  ASK_NAME: {
    send: async (wa, _d, { sendText }) => {
      await sendText(wa, 'Wonderful! May I have your name?');
    },
    freeText: true,
    collect: (msg) => ({ name: msg.text.trim() }),
    next: 'ASK_DATE',
  },
  ASK_DATE: {
    send: async (wa, d, { sendButtons }) => {
      await sendButtons(wa, `Which date are you thinking, ${d.name || 'there'}?`, [
        { id: 'today',        title: 'Today'        },
        { id: 'tomorrow',     title: 'Tomorrow'     },
        { id: 'this_weekend', title: 'This Weekend' },
      ]);
    },
    acceptIds: ['today', 'tomorrow', 'this_weekend'],
    collect: (msg) => ({ date: msg.id || msg.text }),
    next: 'ASK_PARTY_SIZE',
  },
  ASK_PARTY_SIZE: {
    send: async (wa, _d, { sendList }) => {
      await sendList(wa, 'Party Size', 'How many guests will be joining?', 'Select size', [{
        title: 'Party Size',
        rows: [
          { id: 'p_1_2',  title: '1–2 guests'  },
          { id: 'p_3_5',  title: '3–5 guests'  },
          { id: 'p_6_10', title: '6–10 guests' },
          { id: 'p_10',   title: '10+ guests'  },
        ],
      }]);
    },
    acceptIds: ['p_1_2', 'p_3_5', 'p_6_10', 'p_10'],
    collect: (msg) => ({ party_size: msg.id || msg.text }),
    next: 'ASK_DIETARY',
  },
  ASK_DIETARY: {
    send: async (wa, _d, { sendButtons }) => {
      await sendButtons(wa, 'Any dietary requirements we should know about?', [
        { id: 'diet_none',       title: 'No requirements' },
        { id: 'diet_vegetarian', title: 'Vegetarian'      },
        { id: 'diet_halal',      title: 'Halal only'      },
      ]);
    },
    acceptIds: ['diet_none', 'diet_vegetarian', 'diet_halal'],
    collect: (msg) => ({ dietary: msg.id || msg.text }),
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
  const agency = process.env.CLIENT_NAME || 'Our Restaurant';
  await sendText(waNumber, `Thank you, ${data.name || 'there'}! 🙏\nYour reservation request has been received. We will confirm your booking shortly.\n\n_${agency}_`);
  await insertLead({ wa_number: waNumber, name: data.name || '', flow_name: FLOW_NAME, data, score: options.score || 5, language: options.language || 'en' });
  const owner = process.env.OWNER_WHATSAPP;
  if (owner) await sendText(owner, `🍽 New Reservation: ${data.name} | ${data.service_type} | ${data.date} | ${data.party_size}\n📱 ${waNumber}`);
}

module.exports = { FLOW_NAME, STEPS, onComplete, triggerKeywords };
