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
    next: 'COMPLETE',
  },
  COMPLETE: { terminal: true },
};

async function onComplete(waNumber, data, { sendText, insertLead }, options = {}) {
  const agency = process.env.CLIENT_NAME || 'Our Restaurant';
  await sendText(waNumber, `Thank you, ${data.name || 'there'}! 🙏\nYour reservation request has been received. We will confirm your booking shortly.\n\n_${agency}_`);
  insertLead.run({ wa_number: waNumber, name: data.name || '', flow_name: FLOW_NAME, data: JSON.stringify(data), score: options.score || 5, language: options.language || 'en' });
  const owner = process.env.OWNER_WHATSAPP;
  if (owner) await sendText(owner, `🍽 New Reservation: ${data.name} | ${data.service_type} | ${data.date} | ${data.party_size}\n📱 ${waNumber}`);
}

module.exports = { FLOW_NAME, STEPS, onComplete, triggerKeywords };
