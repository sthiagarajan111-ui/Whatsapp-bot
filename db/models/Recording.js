const mongoose = require('mongoose');

function getRecordingModel(clientId) {
  const modelName = `${clientId}_Recording`;
  if (mongoose.models[modelName]) return mongoose.models[modelName];

  const schema = new mongoose.Schema({
    client_id:  { type: String, default: 'default' },
    lead_id:    String,
    wa_number:  String,
    agent:      String,
    duration:   Number,
    file_url:   String,
    file_size:  Number,
    mime_type:  String,
    created_at: { type: Date, default: Date.now }
  }, { collection: `${clientId}_recordings` });

  return mongoose.model(modelName, schema);
}

module.exports = { getRecordingModel };
