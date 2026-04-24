const FLOW_NAME = 'retail';
const triggerKeywords = ['shop', 'buy', 'product', 'order', 'return', 'exchange', 'retail', 'store'];

const STEPS = {
  START: {
    send: async (wa, _d, { sendButtons }) => {
      const agency = process.env.CLIENT_NAME || 'Our Store';
      await sendButtons(wa, `Hi! Welcome to ${agency}. What brings you here today?`, [
        { id: 'product_enquiry', title: 'Product Enquiry'   },
        { id: 'order_status',    title: 'Order Status'      },
        { id: 'return_exchange', title: 'Return / Exchange' },
      ]);
    },
    acceptIds: ['product_enquiry', 'order_status', 'return_exchange'],
    collect: (msg) => ({ enquiry_type: msg.id || msg.text }),
    next: 'ASK_NAME',
  },
  ASK_NAME: {
    send: async (wa, _d, { sendText }) => { await sendText(wa, "I'd be happy to help! May I have your name?"); },
    freeText: true,
    collect: (msg) => ({ name: msg.text.trim() }),
    next: 'ASK_CATEGORY',
  },
  ASK_CATEGORY: {
    send: async (wa, d, { sendList }) => {
      await sendList(wa, 'Category', `Which product category, ${d.name || 'there'}?`, 'Select category', [{
        title: 'Categories',
        rows: [
          { id: 'electronics', title: 'Electronics'       },
          { id: 'fashion',     title: 'Fashion & Apparel' },
          { id: 'home',        title: 'Home & Living'     },
          { id: 'beauty',      title: 'Beauty & Health'   },
          { id: 'sports',      title: 'Sports & Outdoor'  },
        ],
      }]);
    },
    acceptIds: ['electronics', 'fashion', 'home', 'beauty', 'sports'],
    collect: (msg) => ({ category: msg.id || msg.text }),
    next: 'ASK_BUDGET',
  },
  ASK_BUDGET: {
    send: async (wa, _d, { sendButtons }) => {
      await sendButtons(wa, "What's your budget range?", [
        { id: 'under_500',   title: 'Under AED 500'   },
        { id: '500_2000',    title: 'AED 500–2,000'   },
        { id: 'above_2000',  title: 'Above AED 2,000' },
      ]);
    },
    acceptIds: ['under_500', '500_2000', 'above_2000'],
    collect: (msg) => ({ budget: msg.id || msg.text }),
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
  const agency = process.env.CLIENT_NAME || 'Our Store';
  await sendText(waNumber, `Thank you, ${data.name}! 🛍\nWe've received your enquiry for ${data.category}. Our team will reach out shortly.\n\n_${agency}_`);
  await insertLead({ wa_number: waNumber, name: data.name || '', flow_name: FLOW_NAME, data, score: options.score || 3, language: options.language || 'en' });
  const owner = process.env.OWNER_WHATSAPP;
  if (owner) await sendText(owner, `🛍 New Retail Enquiry: ${data.name} | ${data.category} | ${data.budget}\n📱 ${waNumber}`);
}

module.exports = { FLOW_NAME, STEPS, onComplete, triggerKeywords };
