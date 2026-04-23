const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
  wa_number:    { type: String, required: true, unique: true },
  flow:         { type: String },
  step:         { type: String },
  data:         { type: mongoose.Schema.Types.Mixed, default: {} },
  language:     { type: String, default: 'en' },
  ai_mode:      { type: Boolean, default: false },
  ai_history:   { type: Array, default: [] },
  human_mode:   { type: Boolean, default: false },
  agent_number: { type: String },
  updated_at:   { type: Date, default: Date.now },
});

module.exports = mongoose.model('Session', sessionSchema);
