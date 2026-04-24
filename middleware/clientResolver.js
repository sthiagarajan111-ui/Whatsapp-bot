/**
 * Client Resolver — identifies which client an incoming request belongs to.
 * Caches client lookups in memory for 5 minutes to reduce DB round-trips.
 */
const Client = require('../db/models/Client');

const clientCache = new Map();
const CACHE_TTL   = 5 * 60 * 1000; // 5 minutes

function _cached(key) {
  const entry = clientCache.get(key);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) return entry.client;
  return null;
}

function _store(key, client) {
  clientCache.set(key, { client, timestamp: Date.now() });
}

async function getClientByWhatsAppNumber(whatsappNumber) {
  const key    = `wa_${whatsappNumber}`;
  const cached = _cached(key);
  if (cached) return cached;
  const client = await Client.findOne({ whatsapp_number: whatsappNumber, status: 'active' });
  if (client) _store(key, client);
  return client;
}

async function getClientByApiKey(apiKey) {
  const key    = `key_${apiKey}`;
  const cached = _cached(key);
  if (cached) return cached;
  const client = await Client.findOne({ api_key: apiKey, status: 'active' });
  if (client) _store(key, client);
  return client;
}

async function getClientById(clientId) {
  const key    = `id_${clientId}`;
  const cached = _cached(key);
  if (cached) return cached;
  const client = await Client.findOne({ client_id: clientId, status: 'active' });
  if (client) _store(key, client);
  return client;
}

function clearClientCache(clientId) {
  for (const [key] of clientCache) {
    if (key.includes(clientId)) clientCache.delete(key);
  }
}

/**
 * Middleware for dashboard/API routes.
 * Reads client_id from x-client-id header or query param.
 * Reads API key from x-api-key header.
 * Falls back to env vars for single-tenant backwards compatibility.
 */
async function requireClient(req, res, next) {
  const clientId = req.headers['x-client-id'] || req.query.client_id;
  const apiKey   = req.headers['x-api-key'];

  // Admin bypass
  if (apiKey && apiKey === process.env.ADMIN_API_KEY) {
    req.isAdmin = true;
    if (clientId) {
      req.client = await getClientById(clientId);
    }
    return next();
  }

  if (apiKey) {
    const client = await getClientByApiKey(apiKey);
    if (!client) return res.status(401).json({ error: 'Invalid API key' });
    req.client = client;
    return next();
  }

  // Fallback: single-tenant mode via env vars (only when MULTI_TENANT_MODE is not 'true')
  if (process.env.MULTI_TENANT_MODE !== 'true') {
    req.client = {
      client_id:          'default',
      company_name:       process.env.CLIENT_NAME || 'Axyren',
      active_flow:        process.env.ACTIVE_FLOW || 'realEstate',
      twilio_account_sid: process.env.TWILIO_ACCOUNT_SID,
      twilio_auth_token:  process.env.TWILIO_AUTH_TOKEN,
      whatsapp_number:    process.env.TWILIO_WHATSAPP_NUMBER,
      owner_whatsapp:     process.env.OWNER_WHATSAPP,
      notification_emails:process.env.NOTIFICATION_EMAIL,
      isLegacy:           true,
    };
    return next();
  }

  res.status(401).json({ error: 'Client identification required' });
}

module.exports = {
  getClientByWhatsAppNumber,
  getClientByApiKey,
  getClientById,
  clearClientCache,
  requireClient,
};
