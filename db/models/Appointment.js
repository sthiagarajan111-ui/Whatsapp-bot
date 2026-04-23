const mongoose = require('mongoose');

const appointmentSchema = new mongoose.Schema({
  lead_id:    { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
  wa_number:  { type: String },
  slot_date:  { type: String },
  slot_time:  { type: String },
  status:     { type: String, default: 'pending' },
  notes:      { type: String },
  created_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Appointment', appointmentSchema);
