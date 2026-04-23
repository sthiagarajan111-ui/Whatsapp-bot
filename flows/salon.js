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
    next: 'COMPLETE',
  },
  COMPLETE: { terminal: true },
};

async function onComplete(waNumber, data, { sendText, insertLead }, options = {}) {
  const agency = process.env.CLIENT_NAME || 'Our Salon';
  await sendText(waNumber, `Thank you, ${data.name}! ✨\nYour ${data.service} appointment request is received. We'll confirm your ${data.date} booking shortly.\n\n_${agency}_`);
  insertLead.run({ wa_number: waNumber, name: data.name || '', flow_name: FLOW_NAME, data: JSON.stringify(data), score: options.score || 4, language: options.language || 'en' });
  const owner = process.env.OWNER_WHATSAPP;
  if (owner) await sendText(owner, `💇 New Salon Booking: ${data.name} | ${data.service} | ${data.date}\n📱 ${waNumber}`);
}

module.exports = { FLOW_NAME, STEPS, onComplete, triggerKeywords };
