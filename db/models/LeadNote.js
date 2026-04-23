const mongoose = require('mongoose');

const leadNoteSchema = new mongoose.Schema({
  lead_id:    { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
  note:       { type: String },
  created_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model('LeadNote', leadNoteSchema);
