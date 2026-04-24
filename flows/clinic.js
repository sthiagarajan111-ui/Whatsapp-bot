const FLOW_NAME = 'clinic';
const triggerKeywords = ['clinic', 'doctor', 'appointment', 'health', 'medical', 'dental', 'dermatology', 'orthopedic'];

const STEPS = {
  START: {
    send: async (wa, _d, { sendButtons }) => {
      const agency = process.env.CLIENT_NAME || 'Our Clinic';
      await sendButtons(wa, `Hello! Welcome to ${agency}. How can we assist you today?`, [
        { id: 'appointment', title: 'Book Appointment' },
        { id: 'enquiry',     title: 'General Enquiry'  },
        { id: 'followup',    title: 'Follow-up Visit'  },
      ]);
    },
    acceptIds: ['appointment', 'enquiry', 'followup'],
    collect: (msg) => ({ visit_type: msg.id || msg.text }),
    next: 'ASK_NAME',
  },
  ASK_NAME: {
    send: async (wa, _d, { sendText }) => { await sendText(wa, 'Please share your full name.'); },
    freeText: true,
    collect: (msg) => ({ name: msg.text.trim() }),
    next: 'ASK_SPECIALTY',
  },
  ASK_SPECIALTY: {
    send: async (wa, d, { sendList }) => {
      await sendList(wa, 'Department', `Which department do you need, ${d.name || 'there'}?`, 'Select department', [{
        title: 'Departments',
        rows: [
          { id: 'gp',          title: 'General Practice' },
          { id: 'dental',      title: 'Dental'           },
          { id: 'dermatology', title: 'Dermatology'      },
          { id: 'orthopedic',  title: 'Orthopedic'       },
          { id: 'gynecology',  title: 'Gynecology'       },
        ],
      }]);
    },
    acceptIds: ['gp', 'dental', 'dermatology', 'orthopedic', 'gynecology'],
    collect: (msg) => ({ specialty: msg.id || msg.text }),
    next: 'ASK_DATE',
  },
  ASK_DATE: {
    send: async (wa, _d, { sendButtons }) => {
      await sendButtons(wa, 'When would you like to visit?', [
        { id: 'today',     title: 'Today'     },
        { id: 'tomorrow',  title: 'Tomorrow'  },
        { id: 'this_week', title: 'This Week' },
      ]);
    },
    acceptIds: ['today', 'tomorrow', 'this_week'],
    collect: (msg) => ({ preferred_date: msg.id || msg.text }),
    next: 'ASK_INSURANCE',
  },
  ASK_INSURANCE: {
    send: async (wa, _d, { sendButtons }) => {
      await sendButtons(wa, 'Do you have insurance?', [
        { id: 'ins_daman',    title: 'Yes - Daman'     },
        { id: 'ins_abudhabi', title: 'Yes - Abu Dhabi' },
        { id: 'ins_other',    title: 'Yes - Other'     },
        // Note: WhatsApp allows max 3 buttons — using list fallback approach
      ]);
    },
    acceptIds: ['ins_daman', 'ins_abudhabi', 'ins_other', 'self_pay'],
    collect: (msg) => ({ insurance: msg.id || msg.text }),
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
  const agency = process.env.CLIENT_NAME || 'Our Clinic';
  await sendText(waNumber, `Thank you, ${data.name}! 🏥\nYour appointment request for ${data.specialty} has been received.\nWe will confirm your ${data.preferred_date} appointment shortly.\n\n_${agency}_`);
  await insertLead({ wa_number: waNumber, name: data.name || '', flow_name: FLOW_NAME, data, score: options.score || 5, language: options.language || 'en' });
  const owner = process.env.OWNER_WHATSAPP;
  if (owner) await sendText(owner, `🏥 New Clinic Enquiry: ${data.name} | ${data.specialty} | ${data.preferred_date}\n📱 ${waNumber}`);
}

module.exports = { FLOW_NAME, STEPS, onComplete, triggerKeywords };
