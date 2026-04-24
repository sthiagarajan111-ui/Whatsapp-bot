const mongoose = require('mongoose');

const leadSchema = new mongoose.Schema({
  client_id:      { type: String, required: true, index: true, default: 'default' },
  wa_number:      { type: String, required: true },
  name:           { type: String, default: '' },
  status:         { type: String, default: 'new' },
  score:          { type: Number, default: 0 },
  data:           { type: mongoose.Schema.Types.Mixed, default: {} },
  flow_name:      { type: String, default: 'realEstate' },
  pipeline_stage: { type: String, default: 'new_lead' },
  human_mode:     { type: Number, default: 0 },
  followup_sent:  { type: Number, default: 0 },
  assigned_agent: { type: String },
  language:       { type: String, default: 'en' },
  created_at:     { type: Date, default: Date.now },
  updated_at:     { type: Date, default: Date.now },
});

// Compound unique index: one lead per wa_number per client
leadSchema.index({ wa_number: 1, client_id: 1 }, { unique: true });

module.exports = mongoose.model('Lead', leadSchema);
