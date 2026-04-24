const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
  client_id:    { type: String, index: true, default: 'default' },
  wa_number:    { type: String, required: true },
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

// Compound unique index: one session per wa_number per client
sessionSchema.index({ wa_number: 1, client_id: 1 }, { unique: true });

module.exports = mongoose.model('Session', sessionSchema);
