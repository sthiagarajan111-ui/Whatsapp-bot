const mongoose = require('mongoose');

function getRecordingModel(clientId) {
  const modelName = `${clientId}_Recording`;

  const schema = new mongoose.Schema({
    client_id:  { type: String, required: true },
    lead_id:    { type: String, index: true },
    wa_number:  { type: String },
    agent:      { type: String, default: 'unknown' },
    duration:   { type: Number, default: 0 },
    file_url:   { type: String },
    file_size:  { type: Number, default: 0 },
    mime_type:  { type: String, default: 'audio/webm' },
    source:     { type: String, default: 'phone-inbound' },
    notes:      { type: String, default: '' },
    starred:    { type: Boolean, default: false },
    created_at: { type: Date, default: Date.now }
  }, { collection: `${clientId}_recordings` });

  // Only create if not already registered
  if (mongoose.models[modelName]) return mongoose.models[modelName];
  return mongoose.model(modelName, schema);
}

module.exports = { getRecordingModel };
