/**
 * Matches property listings to a lead's criteria and sends formatted WhatsApp messages.
 */

const db = require('../db/database');

const BUDGET_RANGES = {
  'Under 500K':  { min: 0,         max: 500000   },
  '500K – 1M':   { min: 500001,    max: 1000000  },
  '1M – 2M':     { min: 1000001,   max: 2000000  },
  '2M – 5M':     { min: 2000001,   max: 5000000  },
  'Above 5M':    { min: 5000001,   max: 99999999 },
};

function normaliseArea(area) {
  if (!area) return 'open';
  const lower = area.toLowerCase();
  if (lower.includes('downtown')) return 'downtown';
  if (lower.includes('marina'))   return 'marina';
  if (lower.includes('jvc'))      return 'jvc';
  if (lower.includes('business')) return 'business';
  if (lower.includes('palm'))     return 'palm';
  if (lower.includes('creek'))    return 'creek';
  return 'open';
}

function normaliseType(type) {
  if (!type) return '';
  const lower = type.toLowerCase();
  if (lower.includes('apartment'))  return 'apartment';
  if (lower.includes('villa'))      return 'villa';
  if (lower.includes('commercial')) return 'commercial';
  return '';
}

async function matchListings(leadData) {
  const budget = BUDGET_RANGES[leadData.budget] || { min: 0, max: 99999999 };
  const type   = normaliseType(leadData.propertyType);
  const area   = normaliseArea(leadData.area);

  return db.matchListings({ type, min: budget.min, max: budget.max, area });
}

function formatListingMessage(listings) {
  if (!listings.length) return null;
  let msg = '🏠 *Property Match Found!*\n\n';
  const nums = ['1️⃣', '2️⃣', '3️⃣'];
  listings.forEach((l, i) => {
    msg += `${nums[i]} *${l.title}* — AED ${(l.price || 0).toLocaleString()}\n`;
    if (l.area || l.beds || l.size_sqft) {
      msg += `   📍 ${l.area || '—'} | 🛏 ${l.beds || '—'} beds | 📐 ${l.size_sqft ? l.size_sqft.toLocaleString() + ' sqft' : '—'}\n`;
    }
    if (l.listing_url) msg += `   🔗 ${l.listing_url}\n`;
    msg += '\n';
  });
  msg += '💬 Would you like to schedule a viewing for any of these?';
  return msg;
}

module.exports = { matchListings, formatListingMessage };
