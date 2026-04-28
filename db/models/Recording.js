const mongoose = require('mongoose');

function getRecordingModel(clientId) {
  const modelName = `${clientId}_Recording`;
  if (mongoose.models[modelName]) return mongoose.models[modelName];

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
    created_at: { type: Date, default: Date.now }
  }, { collection: `${clientId}_recordings` });

  return mongoose.model(modelName, schema);
}

module.exports = { getRecordingModel };
