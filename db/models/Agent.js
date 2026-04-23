const mongoose = require('mongoose');

const agentSchema = new mongoose.Schema({
  name:       { type: String, required: true },
  wa_number:  { type: String, unique: true },
  email:      { type: String },
  role:       { type: String, default: 'agent' },
  status:     { type: String, default: 'active' },
  created_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Agent', agentSchema);
