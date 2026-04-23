/**
 * Zoho CRM sync — creates a Lead record on flow completion.
 * Only activates if ZOHO_SYNC_ENABLED=true and credentials are set.
 */

const fetch = require('node-fetch');

let zohoToken = null;
let zohoTokenExpiry = 0;

async function getZohoToken() {
  if (zohoToken && Date.now() < zohoTokenExpiry) return zohoToken;

  const res = await fetch('https://accounts.zoho.com/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    }).toString(),
  });

  const data = await res.json();
  if (!data.access_token) throw new Error('Zoho token refresh failed: ' + JSON.stringify(data));

  zohoToken       = data.access_token;
  zohoTokenExpiry = Date.now() + (data.expires_in || 3600) * 1000 - 60000;
  return zohoToken;
}

async function createZohoLead(leadData) {
  if (process.env.ZOHO_SYNC_ENABLED !== 'true') return;
  if (!process.env.ZOHO_CLIENT_ID || !process.env.ZOHO_CLIENT_SECRET || !process.env.ZOHO_REFRESH_TOKEN) return;

  try {
    const token = await getZohoToken();
    const d = leadData || {};
    const body = {
      data: [{
        Last_Name:   d.name || 'Unknown',
        Mobile:      d.wa_number,
        Lead_Source: 'WhatsApp Bot',
        Description: `Interest: ${d.intent || ''}, Budget: ${d.budget || ''}, Area: ${d.area || ''}`,
        Rating:      (d.score || 0) >= 8 ? 'Hot' : (d.score || 0) >= 5 ? 'Warm' : 'Cold',
      }],
    };

    const res = await fetch('https://www.zohoapis.com/crm/v2/Leads', {
      method: 'POST',
      headers: { Authorization: 'Zoho-oauthtoken ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const result = await res.json();
    console.log('[Zoho] Lead created:', result?.data?.[0]?.code);
  } catch (err) {
    console.error('[Zoho] Sync failed:', err.message);
  }
}

module.exports = { createZohoLead };
