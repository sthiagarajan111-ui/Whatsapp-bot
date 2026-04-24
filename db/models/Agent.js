const mongoose = require('mongoose');

const agentSchema = new mongoose.Schema({
  client_id:  { type: String, index: true, default: 'default' },
  name:       { type: String, required: true },
  wa_number:  { type: String },
  email:      { type: String },
  role:       { type: String, default: 'agent' },
  status:     { type: String, default: 'active' },
  created_at: { type: Date, default: Date.now },
});

// Per-client unique wa_number
agentSchema.index({ wa_number: 1, client_id: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Agent', agentSchema);
