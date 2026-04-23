const mongoose = require('mongoose');

const availabilitySchema = new mongoose.Schema({
  day_of_week:   { type: Number },
  start_time:    { type: String },
  end_time:      { type: String },
  slot_duration: { type: Number, default: 60 },
  max_per_slot:  { type: Number, default: 1 },
});

module.exports = mongoose.model('Availability', availabilitySchema);
