const mongoose = require('mongoose');

const listingSchema = new mongoose.Schema({
  client_id:     { type: String, index: true, default: 'default' },
  title:         { type: String, required: true },
  // property_type is the canonical field; "type" kept for backward compat
  property_type: { type: String, enum: ['Apartment', 'Villa', 'Townhouse', 'Penthouse', 'Studio', 'Office', 'Shop', ''] },
  type:          { type: String },           // legacy alias
  area:          { type: String },
  location:      { type: String },           // full address / tower name
  price:         { type: Number, default: 0 },
  // bedrooms/bathrooms are canonical; beds/baths kept for backward compat
  bedrooms:      { type: Number, default: 0 },
  bathrooms:     { type: Number, default: 0 },
  beds:          { type: Number, default: 0 },   // legacy alias
  baths:         { type: Number, default: 0 },   // legacy alias
  size_sqft:     { type: Number, default: 0 },
  description:   { type: String },
  amenities:     [String],
  image_url:     { type: String },
  listing_url:   { type: String },
  status:        { type: String, enum: ['available', 'reserved', 'sold'], default: 'available' },
  intent:        { type: String, enum: ['buy', 'rent', 'both', ''], default: 'buy' },
  created_at:    { type: Date, default: Date.now },
  updated_at:    { type: Date, default: Date.now },
});

module.exports = mongoose.model('Listing', listingSchema);
