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
    next: 'COMPLETE',
  },
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
