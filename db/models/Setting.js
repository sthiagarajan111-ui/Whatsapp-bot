const mongoose = require('mongoose');

const settingSchema = new mongoose.Schema({
  client_id:  { type: String, index: true, default: 'default' },
  key:        { type: String, required: true },
  value:      { type: mongoose.Schema.Types.Mixed },
  updated_at: { type: Date, default: Date.now },
});

// Per-client unique key
settingSchema.index({ key: 1, client_id: 1 }, { unique: true });

module.exports = mongoose.model('Setting', settingSchema);
