/**
 * Appointment booking handler.
 * Generates available slots and books appointments.
 */

const db = require('../db/database');
const { sendText, sendList } = require('../whatsapp/api');

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}

function toTimeStr(h, m) {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Returns available slots for the next `days` days based on availability collection.
 * Falls back to default Mon–Sat 10am–5pm if no availability docs.
 */
async function getAvailableSlots(daysAhead = 7) {
  let avail = [];
  try { avail = await db.getAvailability(); } catch (_) {}

  if (!avail.length) {
    avail = [1, 2, 3, 4, 5, 6].map(day => ({
      day_of_week: day, start_time: '10:00', end_time: '17:00', slot_duration: 60, max_per_slot: 1,
    }));
  }

  const slots = [];
  const now = new Date();
  for (let i = 1; i <= daysAhead; i++) {
    const date = addDays(now, i);
    const dow  = date.getDay() === 0 ? 7 : date.getDay();
    const rule = avail.find(a => a.day_of_week === dow);
    if (!rule) continue;

    const [sh, sm] = rule.start_time.split(':').map(Number);
    const [eh, em] = rule.end_time.split(':').map(Number);
    const duration = rule.slot_duration || 60;

    let hour = sh, minute = sm;
    while (hour * 60 + minute + duration <= eh * 60 + em) {
      slots.push({ date: toDateStr(date), time: toTimeStr(hour, minute) });
      minute += duration;
      hour += Math.floor(minute / 60);
      minute %= 60;
    }
  }
  return slots.slice(0, 9);
}

async function sendAvailableSlots(waNumber) {
  const slots = await getAvailableSlots(7);
  if (!slots.length) {
    await sendText(waNumber, 'Sorry, no available slots right now. Our agent will contact you to arrange a viewing.');
    return;
  }

  const rows = slots.slice(0, 9).map(s => ({
    id:          `appt_${s.date}_${s.time.replace(':', '')}`,
    title:       `${s.date} at ${s.time}`,
    description: '1 hour slot',
  }));

  await sendList(
    waNumber,
    'Available Viewings',
    'Please select a viewing time that works for you:',
    'Choose Time Slot',
    [{ title: 'Available Slots', rows }]
  );
}

async function bookSlot(waNumber, leadId, date, time) {
  await db.saveAppointment({ lead_id: leadId || null, wa_number: waNumber, slot_date: date, slot_time: time, notes: '' });
}

async function sendConfirmation(waNumber, date, time) {
  await sendText(
    waNumber,
    `✅ *Viewing Confirmed!*\n\n📅 Date: ${date}\n🕐 Time: ${time}\n\nWe look forward to meeting you! Our agent will contact you shortly with property details.\n\n_Reply "menu" to return to main menu._`
  );
}

async function notifyAgent(waNumber, date, time, leadName) {
  const owner = process.env.OWNER_WHATSAPP;
  if (!owner) return;
  await sendText(
    owner,
    `📅 *New Viewing Appointment*\n\n👤 ${leadName || waNumber}\n📱 ${waNumber}\n📅 ${date} at ${time}\n\nReply TAKE ${waNumber} to contact them directly.`
  );
}

module.exports = { getAvailableSlots, sendAvailableSlots, bookSlot, sendConfirmation, notifyAgent };
