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
    next: 'COMPLETE',
  },
  COMPLETE: { terminal: true },
};

async function onComplete(waNumber, data, { sendText, insertLead }, options = {}) {
  const agency = process.env.CLIENT_NAME || 'Our Store';
  await sendText(waNumber, `Thank you, ${data.name}! 🛍\nWe've received your enquiry for ${data.category}. Our team will reach out shortly.\n\n_${agency}_`);
  insertLead.run({ wa_number: waNumber, name: data.name || '', flow_name: FLOW_NAME, data: JSON.stringify(data), score: options.score || 3, language: options.language || 'en' });
  const owner = process.env.OWNER_WHATSAPP;
  if (owner) await sendText(owner, `🛍 New Retail Enquiry: ${data.name} | ${data.category} | ${data.budget}\n📱 ${waNumber}`);
}

module.exports = { FLOW_NAME, STEPS, onComplete, triggerKeywords };
