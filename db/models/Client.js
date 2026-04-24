const mongoose = require('mongoose');

const clientSchema = new mongoose.Schema({
  // Identity
  client_id:    { type: String, required: true, unique: true },
  company_name: { type: String, required: true },
  industry:     { type: String, default: 'realEstate' },

  // Contact
  owner_name:      { type: String },
  owner_email:     { type: String },
  owner_whatsapp:  { type: String },

  // WhatsApp config
  whatsapp_provider:  { type: String, default: 'twilio' },
  twilio_account_sid: { type: String },
  twilio_auth_token:  { type: String },
  whatsapp_number:    { type: String },

  // Bot config
  active_flow:           { type: String, default: 'realEstate' },
  business_hours_start:  { type: Number, default: 9 },
  business_hours_end:    { type: Number, default: 18 },
  timezone:              { type: String, default: 'Asia/Dubai' },
  out_of_hours_message:  { type: String },

  // Branding
  brand_name:  { type: String },
  brand_color: { type: String, default: '#3B82F6' },
  logo_url:    { type: String },

  // Notifications
  notification_emails: { type: String },
  smtp_user:           { type: String },
  smtp_pass:           { type: String },

  // Features
  arabic_enabled:       { type: Boolean, default: true },
  voice_enabled:        { type: Boolean, default: true },
  ai_mode_enabled:      { type: Boolean, default: true },
  reengagement_enabled: { type: Boolean, default: true },
  property_match_alerts:{ type: Boolean, default: true },
  hot_lead_alerts:      { type: Boolean, default: true },
  appointment_booking:  { type: Boolean, default: true },

  // API
  api_key: { type: String, unique: true, sparse: true },

  // Subscription
  plan:       { type: String, default: 'professional' },
  status:     { type: String, default: 'active' },
  trial_ends: { type: Date },
  notes:      { type: String },

  // Stats (cached)
  total_leads:       { type: Number, default: 0 },
  leads_this_month:  { type: Number, default: 0 },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Client', clientSchema);
