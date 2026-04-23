const FLOW_NAME = 'carDealer';
const triggerKeywords = ['car', 'vehicle', 'auto', 'toyota', 'bmw', 'mercedes', 'test drive', 'buy car'];

const STEPS = {
  START: {
    send: async (wa, _d, { sendButtons }) => {
      const agency = process.env.CLIENT_NAME || 'Our Showroom';
      await sendButtons(wa, `Welcome to ${agency}! 🚗 What can we help you with today?`, [
        { id: 'buy_new',    title: 'Buy New Car'      },
        { id: 'buy_used',   title: 'Buy Used Car'     },
        { id: 'test_drive', title: 'Book Test Drive'  },
      ]);
    },
    acceptIds: ['buy_new', 'buy_used', 'test_drive'],
    collect: (msg) => ({ interest: msg.id || msg.text }),
    next: 'ASK_NAME',
  },
  ASK_NAME: {
    send: async (wa, _d, { sendText }) => { await sendText(wa, "Great! May I have your name?"); },
    freeText: true,
    collect: (msg) => ({ name: msg.text.trim() }),
    next: 'ASK_BRAND',
  },
  ASK_BRAND: {
    send: async (wa, d, { sendList }) => {
      await sendList(wa, 'Brand', `Which brand are you interested in, ${d.name || 'there'}?`, 'Select brand', [{
        title: 'Brands',
        rows: [
          { id: 'toyota',   title: 'Toyota'         },
          { id: 'honda',    title: 'Honda'           },
          { id: 'bmw',      title: 'BMW'             },
          { id: 'mercedes', title: 'Mercedes-Benz'   },
          { id: 'other',    title: 'Other / Open'    },
        ],
      }]);
    },
    acceptIds: ['toyota', 'honda', 'bmw', 'mercedes', 'other'],
    collect: (msg) => ({ brand: msg.id || msg.text }),
    next: 'ASK_BUDGET',
  },
  ASK_BUDGET: {
    send: async (wa, _d, { sendList }) => {
      await sendList(wa, 'Budget', "What's your budget range?", 'Select budget', [{
        title: 'Budget (AED)',
        rows: [
          { id: 'under_100k', title: 'Under AED 100,000'  },
          { id: '100k_250k',  title: 'AED 100K–250K'      },
          { id: '250k_500k',  title: 'AED 250K–500K'      },
          { id: 'above_500k', title: 'Above AED 500K'     },
        ],
      }]);
    },
    acceptIds: ['under_100k', '100k_250k', '250k_500k', 'above_500k'],
    collect: (msg) => ({ budget: msg.id || msg.text }),
    next: 'ASK_FINANCE',
  },
  ASK_FINANCE: {
    send: async (wa, _d, { sendButtons }) => {
      await sendButtons(wa, 'Would you need financing?', [
        { id: 'cash',      title: 'Cash Purchase'   },
        { id: 'finance',   title: 'Yes, financing'  },
        { id: 'undecided', title: 'Not decided yet' },
      ]);
    },
    acceptIds: ['cash', 'finance', 'undecided'],
    collect: (msg) => ({ finance: msg.id || msg.text }),
    next: 'COMPLETE',
  },
  COMPLETE: { terminal: true },
};

async function onComplete(waNumber, data, { sendText, insertLead }, options = {}) {
  const agency = process.env.CLIENT_NAME || 'Our Showroom';
  await sendText(waNumber, `Thank you, ${data.name}! 🚗\nWe've received your enquiry for a ${data.brand} vehicle. Our sales team will contact you shortly.\n\n_${agency}_`);
  insertLead.run({ wa_number: waNumber, name: data.name || '', flow_name: FLOW_NAME, data: JSON.stringify(data), score: options.score || 5, language: options.language || 'en' });
  const owner = process.env.OWNER_WHATSAPP;
  if (owner) await sendText(owner, `🚗 New Car Enquiry: ${data.name} | ${data.brand} | ${data.budget} | ${data.finance}\n📱 ${waNumber}`);
}

module.exports = { FLOW_NAME, STEPS, onComplete, triggerKeywords };
