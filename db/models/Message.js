const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  wa_number:    { type: String, required: true, index: true },
  direction:    { type: String },
  message_type: { type: String, default: 'text' },
  content:      { type: String },
  raw_data:     { type: mongoose.Schema.Types.Mixed },
  created_at:   { type: Date, default: Date.now },
});

module.exports = mongoose.model('Message', messageSchema);
