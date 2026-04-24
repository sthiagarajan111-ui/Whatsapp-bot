const mongoose = require('mongoose');

const listingSchema = new mongoose.Schema({
  client_id:   { type: String, index: true, default: 'default' },
  title:       { type: String },
  type:        { type: String },
  area:        { type: String },
  price:       { type: Number },
  beds:        { type: Number },
  baths:       { type: Number },
  size_sqft:   { type: Number },
  description: { type: String },
  image_url:   { type: String },
  listing_url: { type: String },
  status:      { type: String, default: 'available' },
  created_at:  { type: Date, default: Date.now },
});

module.exports = mongoose.model('Listing', listingSchema);
