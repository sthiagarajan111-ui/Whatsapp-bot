const mongoose = require('mongoose');

const settingSchema = new mongoose.Schema({
  key:        { type: String, required: true, unique: true },
  value:      { type: mongoose.Schema.Types.Mixed },
  updated_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Setting', settingSchema);
