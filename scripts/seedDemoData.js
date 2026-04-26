const mongoose = require('mongoose');
require('dotenv').config();

// ── Use the app's real models (shared collections, filtered by client_id) ──
const Lead        = require('../db/models/Lead');
const Appointment = require('../db/models/Appointment');
const Message     = require('../db/models/Message');
const Listing     = require('../db/models/Listing');

const DEMO_CLIENT_ID = 'demo';

// ── Realistic UAE names ──
const NAMES = [
  'Ahmed Al Mansoori', 'Sara Al Hashimi', 'Mohammed Al Rashidi',
  'Fatima Al Zaabi', 'Khalid Al Kaabi', 'Mariam Al Nuaimi',
  'Omar Al Shamsi', 'Noura Al Mazrouei', 'Saeed Al Dhaheri',
  'Latifa Al Suwaidi', 'Rashid Al Muhairi', 'Aisha Al Falasi',
  'Sultan Al Ketbi', 'Hessa Al Blooshi', 'Hamad Al Qubaisi',
  'Shamma Al Remeithi', 'Zayed Al Mansouri', 'Maryam Al Junaibi',
  'Jassim Al Hammadi', 'Reem Al Mazrouei'
];

const AREAS = [
  'Dubai Marina', 'Downtown Dubai', 'JVC', 'Business Bay',
  'Palm Jumeirah', 'JLT', 'Arabian Ranches', 'Meydan',
  'Dubai Hills', 'Al Barsha', 'Jumeirah', 'DIFC'
];

const PROPERTY_TYPES = ['Apartment', 'Villa', 'Townhouse', 'Penthouse', 'Studio'];
const INTENTS = ['buy', 'rent', 'invest'];
const LANGUAGES = ['en', 'ar'];
const STAGES = [
  'new_lead', 'ai_contacted', 'qualified_hot', 'qualified_warm',
  'viewing_requested', 'viewing_confirmed', 'offer_made', 'won', 'lost'
];
const STAGE_WEIGHTS = [3, 4, 3, 3, 2, 2, 1, 1, 1];

const TIME_SLOTS = [
  'Morning (9am - 12pm)', 'Afternoon (12pm - 3pm)',
  'Evening (3pm - 6pm)', 'Late Evening (6pm - 8pm)'
];

const BUDGETS = [
  500000, 750000, 1000000, 1200000, 1500000,
  2000000, 2500000, 3000000, 5000000, 800000
];

function pickStage() {
  const total = STAGE_WEIGHTS.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < STAGES.length; i++) {
    r -= STAGE_WEIGHTS[i];
    if (r <= 0) return STAGES[i];
  }
  return STAGES[0];
}

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function randomDate(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - randInt(0, daysAgo));
  d.setHours(randInt(8, 22), randInt(0, 59), 0, 0);
  return d;
}

function generateScore(stage) {
  const scoreMap = {
    'new_lead':          [1, 4],
    'ai_contacted':      [3, 6],
    'qualified_hot':     [7, 9],
    'qualified_warm':    [4, 6],
    'viewing_requested': [7, 9],
    'viewing_confirmed': [8, 10],
    'offer_made':        [9, 10],
    'won':               [9, 10],
    'lost':              [1, 5]
  };
  const [min, max] = scoreMap[stage] || [1, 10];
  return randInt(min, max);
}

function scoreLabel(score) {
  if (score >= 7) return 'HOT';
  if (score >= 4) return 'WARM';
  return 'COLD';
}

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('[Seeder] Connected to MongoDB');

  // Clear existing demo data from the shared collections
  await Lead.deleteMany({ client_id: DEMO_CLIENT_ID });
  await Appointment.deleteMany({ client_id: DEMO_CLIENT_ID });
  await Message.deleteMany({ client_id: DEMO_CLIENT_ID });
  await Listing.deleteMany({ client_id: DEMO_CLIENT_ID });

  // Set brand_name for demo so stats API returns it (overrides default fallback)
  const col = mongoose.connection.db.collection('settings');
  await col.deleteMany({ client_id: DEMO_CLIENT_ID, key: 'brand_name' });
  await col.insertOne({ key: 'brand_name', value: 'Axyren Demo', client_id: DEMO_CLIENT_ID, updated_at: new Date() });

  console.log('[Seeder] Cleared existing demo data');

  // ── Seed 20 leads ──
  const leadDocs = [];
  for (let i = 0; i < 20; i++) {
    const stage = pickStage();
    const score = generateScore(stage);
    const name  = NAMES[i];
    const waNumber = `9715${randInt(10000000, 99999999)}`;
    const createdAt = randomDate(30);

    leadDocs.push({
      client_id:      DEMO_CLIENT_ID,
      wa_number:      waNumber,
      name,
      score,
      pipeline_stage: stage,
      language:       rand(LANGUAGES),
      status:         stage === 'won' ? 'converted' : stage === 'lost' ? 'lost' : 'new',
      data: {
        score_label:   scoreLabel(score),
        budget:        rand(BUDGETS),
        area_interest: rand(AREAS),
        property_type: rand(PROPERTY_TYPES),
        intent:        rand(INTENTS),
      },
      created_at: createdAt,
      updated_at: createdAt
    });
  }

  const insertedLeads = await Lead.insertMany(leadDocs);
  console.log(`[Seeder] Created ${insertedLeads.length} leads`);

  // ── Seed appointments for HOT/viewing/won leads ──
  const apptLeads = leadDocs.filter(l =>
    ['qualified_hot', 'viewing_requested', 'viewing_confirmed', 'offer_made', 'won']
    .includes(l.pipeline_stage)
  );

  const apptDocs = [];
  apptLeads.forEach(lead => {
    const numAppts = lead.pipeline_stage === 'won' ? 2 : 1;
    for (let j = 0; j < numAppts; j++) {
      const apptDate = new Date(lead.created_at);
      apptDate.setDate(apptDate.getDate() + randInt(1, 10));
      apptDocs.push({
        client_id:                DEMO_CLIENT_ID,
        wa_number:                lead.wa_number,
        lead_name:                lead.name,
        appointment_date:         apptDate,
        appointment_date_display: apptDate.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }),
        time_slot:                rand(TIME_SLOTS),
        status:                   lead.pipeline_stage === 'won'               ? 'completed' :
                                  lead.pipeline_stage === 'viewing_confirmed' ? 'confirmed'  : 'pending',
        lead_score:               lead.score,
        lead_label:               scoreLabel(lead.score),
        industry:                 'Real Estate',
        agent_wa:                 '96891336093',
        created_at:               lead.created_at
      });
    }
  });

  await Appointment.insertMany(apptDocs);
  console.log(`[Seeder] Created ${apptDocs.length} appointments`);

  // ── Seed sample messages for first 5 leads ──
  const sampleBotMsgs = [
    "Welcome! I'm your AI property assistant. Are you looking to Buy, Rent, or Invest?",
    "Great choice! May I have your name please?",
    "Thanks! What type of property are you interested in? Apartment, Villa, or Townhouse?",
    "What's your budget range?",
    "Which area of Dubai are you interested in?",
    "Excellent! We have great options available. When would you like to view a property?"
  ];

  for (let i = 0; i < 5; i++) {
    const lead = leadDocs[i];
    const msgs = [];

    msgs.push({
      client_id:    DEMO_CLIENT_ID,
      wa_number:    lead.wa_number,
      content:      'Hi',
      direction:    'inbound',
      message_type: 'text',
      created_at:   new Date(lead.created_at.getTime() + 1000)
    });

    sampleBotMsgs.forEach((msg, idx) => {
      msgs.push({
        client_id:    DEMO_CLIENT_ID,
        wa_number:    lead.wa_number,
        content:      msg,
        direction:    'outbound',
        message_type: 'text',
        created_at:   new Date(lead.created_at.getTime() + (idx + 2) * 30000)
      });
      if (idx < 5) {
        msgs.push({
          client_id:    DEMO_CLIENT_ID,
          wa_number:    lead.wa_number,
          content:      ['Buy', lead.name.split(' ')[0], 'Apartment', 'AED 1.5M', rand(AREAS), 'This week'][idx],
          direction:    'inbound',
          message_type: 'text',
          created_at:   new Date(lead.created_at.getTime() + (idx + 2) * 30000 + 15000)
        });
      }
    });

    await Message.insertMany(msgs);
  }
  console.log('[Seeder] Created sample messages for 5 leads');

  // ── Seed 10 demo listings ──
  const DEMO_LISTINGS = [
    { title: 'Luxury 2BR Apartment - Dubai Marina',    property_type: 'Apartment', type: 'Apartment', area: 'Dubai Marina',    price: 1800000,  bedrooms: 2, beds: 2, bathrooms: 2, baths: 2, size_sqft: 1200, intent: 'buy',  status: 'available', description: 'Stunning sea view apartment with premium finishes, gym, and pool access.' },
    { title: 'Spacious 3BR Villa - Arabian Ranches',   property_type: 'Villa',     type: 'Villa',     area: 'Arabian Ranches', price: 3500000,  bedrooms: 3, beds: 3, bathrooms: 4, baths: 4, size_sqft: 3200, intent: 'buy',  status: 'available', description: 'Corner villa with private garden, maid room, and community pool.' },
    { title: 'Modern Studio - JVC',                    property_type: 'Studio',    type: 'Studio',    area: 'JVC',             price: 520000,   bedrooms: 0, beds: 0, bathrooms: 1, baths: 1, size_sqft: 450,  intent: 'buy',  status: 'available', description: 'Fully fitted studio ideal for investment or first home.' },
    { title: '1BR Apartment for Rent - JLT',           property_type: 'Apartment', type: 'Apartment', area: 'JLT',             price: 65000,    bedrooms: 1, beds: 1, bathrooms: 1, baths: 1, size_sqft: 850,  intent: 'rent', status: 'available', description: 'Well maintained apartment with lake view and covered parking.' },
    { title: 'Penthouse - Downtown Dubai',             property_type: 'Penthouse', type: 'Penthouse', area: 'Downtown Dubai',  price: 12000000, bedrooms: 4, beds: 4, bathrooms: 5, baths: 5, size_sqft: 5500, intent: 'buy',  status: 'available', description: 'Exclusive penthouse with Burj Khalifa views and private rooftop terrace.' },
    { title: '4BR Townhouse - Dubai Hills',            property_type: 'Townhouse', type: 'Townhouse', area: 'Dubai Hills',     price: 4200000,  bedrooms: 4, beds: 4, bathrooms: 5, baths: 5, size_sqft: 3800, intent: 'buy',  status: 'available', description: 'Brand new townhouse in Dubai Hills Estate with park views.' },
    { title: '2BR Apartment for Rent - Business Bay',  property_type: 'Apartment', type: 'Apartment', area: 'Business Bay',   price: 110000,   bedrooms: 2, beds: 2, bathrooms: 2, baths: 2, size_sqft: 1100, intent: 'rent', status: 'available', description: 'High floor apartment with canal views, fully furnished option available.' },
    { title: '3BR Villa - Palm Jumeirah',              property_type: 'Villa',     type: 'Villa',     area: 'Palm Jumeirah',  price: 8500000,  bedrooms: 3, beds: 3, bathrooms: 4, baths: 4, size_sqft: 4200, intent: 'buy',  status: 'reserved',  description: 'Beachfront villa with private pool and direct beach access.' },
    { title: '1BR Apartment - Al Barsha',              property_type: 'Apartment', type: 'Apartment', area: 'Al Barsha',      price: 75000,    bedrooms: 1, beds: 1, bathrooms: 1, baths: 1, size_sqft: 780,  intent: 'rent', status: 'available', description: 'Spacious apartment near Mall of the Emirates with Metro access.' },
    { title: '2BR Apartment - Meydan',                 property_type: 'Apartment', type: 'Apartment', area: 'Meydan',         price: 1450000,  bedrooms: 2, beds: 2, bathrooms: 2, baths: 2, size_sqft: 1050, intent: 'buy',  status: 'available', description: 'Off-plan apartment with flexible payment plan, handover Q4 2026.' },
  ];
  const listingsToInsert = DEMO_LISTINGS.map(l => ({ ...l, client_id: DEMO_CLIENT_ID }));
  await Listing.insertMany(listingsToInsert);
  console.log(`[Seeder] Created ${listingsToInsert.length} demo listings`);

  console.log('\n[Seeder] ✅ Demo data seeding complete!');
  console.log(`  Leads:        ${insertedLeads.length}`);
  console.log(`  Appointments: ${apptDocs.length}`);
  console.log(`  Listings:     ${listingsToInsert.length}`);
  console.log(`  Messages:     seeded for 5 leads`);
  console.log(`  Client ID:    ${DEMO_CLIENT_ID}`);
  console.log('\n  Access demo dashboard at:');
  console.log('  http://localhost:3000/client-dashboard/demo');
  console.log('  https://whatsapp-bot-41x7.onrender.com/client-dashboard/demo\n');

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch(e => {
  console.error('[Seeder] Error:', e.message);
  process.exit(1);
});
