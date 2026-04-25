const mongoose = require('mongoose');

const flowStepSchema = new mongoose.Schema({
  client_id:  { type: String, index: true, default: 'default' },
  vertical:   { type: String, required: true },
  stepId:     { type: String, required: true },
  message:    { type: String, default: '' },
  updated_at: { type: Date, default: Date.now },
});

flowStepSchema.index({ client_id: 1, vertical: 1, stepId: 1 }, { unique: true });

module.exports = mongoose.model('FlowStep', flowStepSchema);
