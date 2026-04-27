const mongoose = require('mongoose');

function getLeadCounterModel(clientId) {
  const modelName = `${clientId}_LeadCounter`;
  if (mongoose.models[modelName]) return mongoose.models[modelName];

  const schema = new mongoose.Schema({
    client_id:     { type: String, required: true, unique: true },
    current_count: { type: Number, default: 0 },
    prefix:        { type: String, default: 'AXY' }
  }, { collection: `${clientId}_lead_counter` });

  return mongoose.model(modelName, schema);
}

module.exports = { getLeadCounterModel };
