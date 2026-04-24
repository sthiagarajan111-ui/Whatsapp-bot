const mongoose = require('mongoose');

const appointmentSchema = new mongoose.Schema({
  client_id:                { type: String, index: true, default: 'default' },
  lead_id:                  { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
  wa_number:                { type: String },
  lead_name:                { type: String },
  lead_email:               { type: String },
  appointment_date:         { type: Date },
  appointment_date_display: { type: String },
  time_slot:                { type: String },
  slot_date:                { type: String },   // legacy
  slot_time:                { type: String },   // legacy
  status:                   { type: String, default: 'confirmed' },
  lead_score:               { type: Number, default: 0 },
  lead_label:               { type: String, default: 'cold' },
  agent_wa:                 { type: String },
  industry:                 { type: String },
  notes:                    { type: String },
  reminder_sent:            { type: Boolean, default: false },
  created_at:               { type: Date, default: Date.now },
});

module.exports = mongoose.model('Appointment', appointmentSchema);
