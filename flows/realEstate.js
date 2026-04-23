/**
 * Real Estate Lead Qualification Flow
 *
 * Steps:
 *   START → ASK_NAME → ASK_PROPERTY_TYPE → ASK_BUDGET → ASK_AREA → COMPLETE
 */

const FLOW_NAME = 'realEstate';

// Keywords that trigger this flow for new conversations
const triggerKeywords = [
  'property', 'real estate', 'apartment', 'villa', 'buy', 'rent', 'sell',
  'عقار', 'شقة', 'فيلا',
];

// ── Step definitions ──────────────────────────────────────────────────────────

const STEPS = {
  START: {
    send: async (wa, _data, { sendButtons }, lang) => {
      const agency = process.env.CLIENT_NAME || 'Our Agency';
      if (lang === 'ar') {
        await sendButtons(
          wa,
          `مرحباً! أهلاً بكم في ${agency}. أنا هنا لمساعدتك في إيجاد عقارك المثالي.\n\nماذا تبحث عن اليوم؟`,
          [
            { id: 'intent_buy',  title: 'شراء عقار'  },
            { id: 'intent_rent', title: 'استئجار عقار' },
            { id: 'intent_sell', title: 'بيع عقاري'  },
          ]
        );
      } else {
        await sendButtons(
          wa,
          `Welcome to ${agency}! 🏡\n\nHow can we help you today?`,
          [
            { id: 'intent_buy',  title: 'Buy a Property'  },
            { id: 'intent_rent', title: 'Rent a Property' },
            { id: 'intent_sell', title: 'Sell a Property' },
          ]
        );
      }
    },
    next: 'ASK_NAME',
    acceptIds: ['intent_buy', 'intent_rent', 'intent_sell'],
    collect: (msg) => ({ intent: INTENT_LABEL[msg.id || msg.text] }),
  },

  ASK_NAME: {
    send: async (wa, _data, { sendText }, lang) => {
      if (lang === 'ar') {
        await sendText(wa, 'ممتاز! للمساعدة بشكل أفضل، هل يمكنك إخباري باسمك الكريم؟');
      } else {
        await sendText(wa, 'May I have your full name, please?');
      }
    },
    next: 'ASK_PROPERTY_TYPE',
    freeText: true,
    collect: (msg) => ({ name: msg.text.trim() }),
  },

  ASK_PROPERTY_TYPE: {
    send: async (wa, data, { sendButtons }, lang) => {
      const name = data.name || 'there';
      if (lang === 'ar') {
        await sendButtons(
          wa,
          `شكراً، ${name}! ما نوع العقار الذي تهتم به؟`,
          [
            { id: 'type_apartment',  title: 'شقة'             },
            { id: 'type_villa',      title: 'فيلا / تاون هاوس' },
            { id: 'type_commercial', title: 'تجاري'            },
          ]
        );
      } else {
        await sendButtons(
          wa,
          `Nice to meet you, ${name}! 😊\n\nWhat type of property are you interested in?`,
          [
            { id: 'type_apartment',  title: 'Apartment'   },
            { id: 'type_villa',      title: 'Villa'       },
            { id: 'type_commercial', title: 'Commercial'  },
          ]
        );
      }
    },
    next: 'ASK_BUDGET',
    acceptIds: ['type_apartment', 'type_villa', 'type_commercial'],
    collect: (msg) => ({ propertyType: PROPERTY_LABEL[msg.id || msg.text] }),
  },

  ASK_BUDGET: {
    send: async (wa, _data, { sendList }, lang) => {
      if (lang === 'ar') {
        await sendList(
          wa,
          'نطاق الميزانية',
          'ما هو نطاق ميزانيتك؟',
          'اختر الميزانية',
          [
            {
              title: 'الميزانية',
              rows: [
                { id: 'budget_1', title: 'أقل من 500,000 درهم',      description: 'Up to AED 500,000'          },
                { id: 'budget_2', title: '500 ألف - مليون درهم',      description: 'AED 500,000 – 1,000,000'   },
                { id: 'budget_3', title: 'مليون - مليونين',            description: 'AED 1,000,000 – 2,000,000' },
                { id: 'budget_4', title: '2 - 5 مليون',               description: 'AED 2,000,000 – 5,000,000' },
                { id: 'budget_5', title: 'أكثر من 5 ملايين',          description: 'AED 5,000,000+'            },
              ],
            },
          ]
        );
      } else {
        await sendList(
          wa,
          'Budget Range',
          'Please select your budget range (AED):',
          'Select Budget',
          [
            {
              title: 'Budget Options',
              rows: [
                { id: 'budget_1', title: 'Under 500K',  description: 'Up to AED 500,000'          },
                { id: 'budget_2', title: '500K – 1M',   description: 'AED 500,000 – 1,000,000'    },
                { id: 'budget_3', title: '1M – 2M',     description: 'AED 1,000,000 – 2,000,000'  },
                { id: 'budget_4', title: '2M – 5M',     description: 'AED 2,000,000 – 5,000,000'  },
                { id: 'budget_5', title: 'Above 5M',    description: 'AED 5,000,000+'             },
              ],
            },
          ]
        );
      }
    },
    next: 'ASK_AREA',
    acceptIds: ['budget_1', 'budget_2', 'budget_3', 'budget_4', 'budget_5'],
    collect: (msg) => ({ budget: BUDGET_LABEL[msg.id || msg.text] }),
  },

  ASK_AREA: {
    send: async (wa, _data, { sendList }, lang) => {
      if (lang === 'ar') {
        await sendList(
          wa,
          'المنطقة المفضلة',
          'ما هي المناطق التي تفكر فيها؟',
          'اختر المنطقة',
          [
            {
              title: 'المناطق الشعبية',
              rows: [
                { id: 'area_downtown', title: 'وسط مدينة دبي',   description: 'برج خليفة، دبي مول' },
                { id: 'area_marina',   title: 'مرسى دبي / JBR',  description: 'حياة على الواجهة المائية' },
                { id: 'area_jvc',      title: 'JVC / JVT',        description: 'Jumeirah Village'       },
                { id: 'area_business', title: 'الخليج التجاري',   description: 'المنطقة التجارية المركزية' },
                { id: 'area_palm',     title: 'نخلة الجميرا',     description: 'الحياة على الجزيرة الأيقونية' },
                { id: 'area_creek',    title: 'خور دبي',          description: 'مزيج من التراث والحداثة' },
                { id: 'area_other',    title: 'مفتوح للاقتراحات', description: 'منفتح على الاقتراحات'    },
              ],
            },
          ]
        );
      } else {
        await sendList(
          wa,
          'Preferred Area',
          'Which area in Dubai are you interested in?',
          'Select Area',
          [
            {
              title: 'Popular Areas',
              rows: [
                { id: 'area_downtown', title: 'Downtown Dubai',   description: 'Burj Khalifa, Dubai Mall' },
                { id: 'area_marina',   title: 'Dubai Marina',     description: 'Waterfront living'        },
                { id: 'area_jvc',      title: 'JVC',              description: 'Jumeirah Village Circle'  },
                { id: 'area_business', title: 'Business Bay',     description: 'Central business district'},
                { id: 'area_palm',     title: 'Palm Jumeirah',    description: 'Iconic island living'     },
                { id: 'area_creek',    title: 'Dubai Creek',      description: 'Heritage & modern blend'  },
                { id: 'area_other',    title: 'Other / Flexible', description: 'Open to suggestions'     },
              ],
            },
          ]
        );
      }
    },
    next: 'COMPLETE',
    acceptIds: ['area_downtown', 'area_marina', 'area_jvc', 'area_business', 'area_palm', 'area_creek', 'area_other'],
    collect: (msg) => ({ area: AREA_LABEL[msg.id || msg.text] }),
  },

  COMPLETE: {
    terminal: true,
  },
};

// ── Label maps (id → human-readable) ─────────────────────────────────────────

const INTENT_LABEL = {
  intent_buy:  'Buy',
  intent_rent: 'Rent',
  intent_sell: 'Sell',
  Buy: 'Buy', Rent: 'Rent', Sell: 'Sell',
};

const PROPERTY_LABEL = {
  type_apartment:  'Apartment',
  type_villa:      'Villa',
  type_commercial: 'Commercial',
  Apartment: 'Apartment', Villa: 'Villa', Commercial: 'Commercial',
};

const BUDGET_LABEL = {
  budget_1: 'Under 500K',
  budget_2: '500K – 1M',
  budget_3: '1M – 2M',
  budget_4: '2M – 5M',
  budget_5: 'Above 5M',
};

const AREA_LABEL = {
  area_downtown: 'Downtown Dubai',
  area_marina:   'Dubai Marina',
  area_jvc:      'JVC',
  area_business: 'Business Bay',
  area_palm:     'Palm Jumeirah',
  area_creek:    'Dubai Creek',
  area_other:    'Other / Flexible',
};

// ── Completion handler ────────────────────────────────────────────────────────

async function onComplete(waNumber, collectedData, { sendText, insertLead }, options = {}) {
  const { name, intent, propertyType, budget, area } = collectedData;
  const agency = process.env.CLIENT_NAME || 'Our Agency';
  const lang   = options.language || 'en';
  const score  = options.score || 1;

  // Thank the user
  if (lang === 'ar') {
    await sendText(
      waNumber,
      `شكراً جزيلاً، ${name || 'صديقي'}! 🙏\n\n` +
      `تم استلام تفاصيلك. سيتواصل معك أحد وكلائنا خلال ساعتين.\n\n` +
      `_${agency} — شريكك الموثوق في العقارات._`
    );
  } else {
    await sendText(
      waNumber,
      `Thank you, ${name || 'friend'}! 🙏\n\n` +
      `Your details have been received. One of our agents will contact you shortly.\n\n` +
      `_${agency} — Your trusted UAE real estate partner._`
    );
  }

  // Save lead to DB
  await insertLead({
    wa_number: waNumber,
    name:      name || '',
    flow_name: FLOW_NAME,
    data:      collectedData,
    score,
    language:  lang,
  });

  // Notify owner
  const owner = process.env.OWNER_WHATSAPP;
  if (owner) {
    const langTag = lang === 'ar' ? '(AR) ' : '';
    const summary =
      `🏠 *${langTag}New Lead — ${agency}*\n\n` +
      `👤 Name: ${name || 'N/A'}\n` +
      `📱 WhatsApp: ${waNumber}\n` +
      `🎯 Interest: ${intent || 'N/A'}\n` +
      `🏗 Type: ${propertyType || 'N/A'}\n` +
      `💰 Budget: ${budget || 'N/A'}\n` +
      `📍 Area: ${area || 'N/A'}\n` +
      `⭐ Score: ${score}/10\n` +
      `🕐 Time: ${new Date().toLocaleString('en-AE', { timeZone: 'Asia/Dubai' })}\n\n` +
      `To take this conversation live, reply: TAKE ${waNumber}`;
    await sendText(owner, summary);
  }
}

module.exports = { FLOW_NAME, STEPS, onComplete, triggerKeywords };
