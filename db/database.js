/**
 * Database layer — MongoDB Atlas via Mongoose.
 * All functions are async and accept an optional clientId (default: 'default')
 * to support multi-tenancy while remaining fully backwards compatible.
 */
const mongoose = require('mongoose');

const Lead         = require('./models/Lead');
const Session      = require('./models/Session');
const Message      = require('./models/Message');
const Setting      = require('./models/Setting');
const AgentModel   = require('./models/Agent');
const Listing      = require('./models/Listing');
const Appointment  = require('./models/Appointment');
const LeadNote     = require('./models/LeadNote');
const Availability = require('./models/Availability');
const FlowStep     = require('./models/FlowStep');

// ── Connection with retry ─────────────────────────────────────────────────────
function connectWithRetry(attempt = 1) {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn('[DB] MONGODB_URI not set — MongoDB disconnected. Add it to .env to enable persistence.');
    return;
  }
  console.log('[DB] Connecting to MongoDB Atlas...');
  mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 })
    .then(async () => {
      console.log('[DB] Connected to MongoDB Atlas');
      // Drop stale single-key unique index on settings.key (left from old schema).
      // Current schema uses compound index { key, client_id } — the old key_1
      // unique index blocks multi-tenant rows with the same key for different clients.
      try {
        const col = mongoose.connection.db.collection('settings');
        const indexes = await col.indexes();
        const stale = indexes.find(i => i.name === 'key_1');
        if (stale) {
          await col.dropIndex('key_1');
          console.log('[DB] Dropped stale settings index: key_1');
        }
      } catch (migrErr) {
        console.warn('[DB] Index migration warning (non-fatal):', migrErr.message);
      }
    })
    .catch((err) => {
      console.error(`[DB] Connection attempt ${attempt} failed:`, err.message);
      const delay = Math.min(attempt * 2000, 30000);
      setTimeout(() => connectWithRetry(attempt + 1), delay);
    });
}
connectWithRetry();

// ── Normalizers ───────────────────────────────────────────────────────────────
function normalizeLead(doc) {
  if (!doc) return null;
  const obj = doc.toObject ? doc.toObject() : { ...doc };
  return {
    ...obj,
    id:         obj._id?.toString(),
    created_at: obj.created_at instanceof Date ? obj.created_at.toISOString() : (obj.created_at || ''),
    updated_at: obj.updated_at instanceof Date ? obj.updated_at.toISOString() : (obj.updated_at || ''),
    data:       obj.data || {},
  };
}

function normalizeSession(doc) {
  if (!doc) return null;
  const obj = doc.toObject ? doc.toObject() : { ...doc };
  return {
    ...obj,
    id:         obj._id?.toString(),
    data:       obj.data || {},
    ai_history: obj.ai_history || [],
  };
}

function normalizeDoc(doc) {
  if (!doc) return null;
  const obj = doc.toObject ? doc.toObject() : { ...doc };
  return {
    ...obj,
    id:         obj._id?.toString(),
    created_at: obj.created_at instanceof Date ? obj.created_at.toISOString() : (obj.created_at || ''),
  };
}

function flattenLead(d) {
  return {
    ...d,
    id:         d._id.toString(),
    created_at: d.created_at instanceof Date ? d.created_at.toISOString() : (d.created_at || ''),
    updated_at: d.updated_at instanceof Date ? d.updated_at.toISOString() : (d.updated_at || ''),
    data:       d.data || {},
  };
}

// ── Leads ─────────────────────────────────────────────────────────────────────
async function getLead(waNumber, clientId = 'default') {
  const doc = await Lead.findOne({ wa_number: waNumber, client_id: clientId });
  return normalizeLead(doc);
}

async function getLeadById(id) {
  try {
    const doc = await Lead.findById(id);
    return normalizeLead(doc);
  } catch (_) { return null; }
}

async function saveLead(waNumber, name, status, score, data, language, flowName, pipelineStage, clientId = 'default') {
  const doc = await Lead.findOneAndUpdate(
    { wa_number: waNumber, client_id: clientId },
    {
      $set: {
        name:           name || '',
        status:         status || 'new',
        score:          score || 0,
        data:           data || {},
        language:       language || 'en',
        flow_name:      flowName || 'realEstate',
        pipeline_stage: pipelineStage || 'new_lead',
        client_id:      clientId,
        updated_at:     new Date(),
      },
      $setOnInsert: { created_at: new Date() },
    },
    { upsert: true, returnDocument: 'after' }
  );
  return normalizeLead(doc);
}

// Compatibility wrapper for flows
async function insertLead(params, clientId = 'default') {
  let data = params.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (_) { data = {}; }
  }
  return saveLead(
    params.wa_number,
    params.name           || '',
    params.status         || 'new',
    params.score          || 0,
    data                  || {},
    params.language       || 'en',
    params.flow_name      || 'realEstate',
    params.pipeline_stage || 'new_lead',
    clientId
  );
}

async function updateLeadStatus(id, status) {
  try { await Lead.findByIdAndUpdate(id, { $set: { status, updated_at: new Date() } }); } catch (_) {}
}

async function updateLeadPipelineStage(id, stage) {
  try { await Lead.findByIdAndUpdate(id, { $set: { pipeline_stage: stage, updated_at: new Date() } }); } catch (_) {}
}

async function updateLeadScore(waNumber, score, clientId = 'default') {
  const lead = await Lead.findOne({ wa_number: waNumber, client_id: clientId }).lean();
  const update = { score, updated_at: new Date() };
  if (lead) {
    const currentStage = lead.pipeline_stage || 'new_lead';
    if (score >= 7 && currentStage === 'new_lead') {
      update.pipeline_stage = 'qualified_hot';
    } else if (score >= 4 && score < 7 && currentStage === 'new_lead') {
      update.pipeline_stage = 'qualified_warm';
    }
  }
  await Lead.findOneAndUpdate({ wa_number: waNumber, client_id: clientId }, { $set: update });
}

async function updateLeadAgent(id, agentWaNumber) {
  try { await Lead.findByIdAndUpdate(id, { $set: { assigned_agent: agentWaNumber, updated_at: new Date() } }); } catch (_) {}
}

async function getAllLeads(clientId = 'default') {
  const docs = await Lead.find({ client_id: clientId }).sort({ score: -1, created_at: -1 }).lean();
  return docs.map(flattenLead);
}

async function getLeadStats(clientId = 'default') {
  const result = await Lead.aggregate([
    { $match: { client_id: clientId } },
    {
      $group: {
        _id:       null,
        total:     { $sum: 1 },
        new:       { $sum: { $cond: [{ $eq: ['$status', 'new'] }, 1, 0] } },
        contacted: { $sum: { $cond: [{ $eq: ['$status', 'contacted'] }, 1, 0] } },
        converted: { $sum: { $cond: [{ $eq: ['$status', 'converted'] }, 1, 0] } },
        lost:      { $sum: { $cond: [{ $eq: ['$status', 'lost'] }, 1, 0] } },
        hot:       { $sum: { $cond: [{ $gte: ['$score', 8] }, 1, 0] } },
        avg_score: { $avg: { $cond: [{ $gt: ['$score', 0] }, '$score', null] } },
      },
    },
  ]);
  if (!result.length) return { total: 0, new: 0, contacted: 0, converted: 0, lost: 0, hot: 0, avg_score: null };
  const r = result[0];
  return { ...r, avg_score: r.avg_score != null ? Math.round(r.avg_score * 10) / 10 : null };
}

async function exportLeads(status, clientId = 'default') {
  const filter = { client_id: clientId };
  if (status && status !== 'all') filter.status = status;
  const docs = await Lead.find(filter).sort({ created_at: -1 }).lean();
  return docs.map(flattenLead);
}

async function getLeadsForFollowup(delayHours, clientId = 'default') {
  const cutoff = new Date(Date.now() - delayHours * 60 * 60 * 1000);
  const docs = await Lead.find({ client_id: clientId, status: 'new', followup_sent: 0, created_at: { $lte: cutoff } }).lean();
  return docs.map(flattenLead);
}

async function markFollowupSent(id) {
  try { await Lead.findByIdAndUpdate(id, { $set: { followup_sent: 1 } }); } catch (_) {}
}

async function deleteLead(id) {
  try { await Lead.findByIdAndDelete(id); } catch (_) {}
}

async function getLeadsByDateRange(from, to, clientId = 'default') {
  const filter = { client_id: clientId };
  if (from) filter.created_at = { $gte: new Date(from) };
  if (to)   filter.created_at = { ...(filter.created_at || {}), $lt: new Date(to) };
  const docs = await Lead.find(filter).sort({ created_at: 1 }).lean();
  return docs.map(flattenLead);
}

// ── Sessions ──────────────────────────────────────────────────────────────────
async function getSession(waNumber, clientId = 'default') {
  const doc = await Session.findOne({ wa_number: waNumber, client_id: clientId });
  return normalizeSession(doc);
}

async function saveSession(waNumber, sessionData, clientId = 'default') {
  await Session.findOneAndUpdate(
    { wa_number: waNumber, client_id: clientId },
    { $set: { ...sessionData, client_id: clientId, updated_at: new Date() } },
    { upsert: true, returnDocument: 'after' }
  );
}

async function clearSession(waNumber, clientId = 'default') {
  await Session.deleteOne({ wa_number: waNumber, client_id: clientId });
}

async function setHumanMode(waNumber, humanMode, agentNumber, clientId = 'default') {
  await Session.findOneAndUpdate(
    { wa_number: waNumber, client_id: clientId },
    { $set: { human_mode: !!humanMode, agent_number: agentNumber || null, client_id: clientId, updated_at: new Date() } },
    { upsert: true }
  );
}

async function getSessionByAgent(agentNumber, clientId = 'default') {
  const doc = await Session.findOne({ agent_number: agentNumber, human_mode: true, client_id: clientId });
  return normalizeSession(doc);
}

async function getSessionsHumanMode(clientId = 'default') {
  const docs = await Session.find({ human_mode: true, client_id: clientId }, { wa_number: 1, human_mode: 1 }).lean();
  const result = {};
  docs.forEach(d => { result[d.wa_number] = 1; });
  return result;
}

// ── Messages ──────────────────────────────────────────────────────────────────
async function saveMessage(waNumber, direction, type, content, rawData, clientId = 'default') {
  let raw = rawData;
  if (typeof rawData === 'string') {
    try { raw = JSON.parse(rawData); } catch (_) { raw = rawData; }
  }
  await Message.create({ client_id: clientId, wa_number: waNumber, direction, message_type: type || 'text', content, raw_data: raw });
}

async function getMessages(waNumber, clientId = 'default') {
  const docs = await Message.find({ wa_number: waNumber, client_id: clientId }).sort({ created_at: 1 }).lean();
  return docs.map(d => ({
    ...d,
    id:         d._id.toString(),
    created_at: d.created_at instanceof Date ? d.created_at.toISOString() : (d.created_at || ''),
  }));
}

async function getRecentConversations(limit = 50, clientId = 'default') {
  const agg = await Message.aggregate([
    { $match: { client_id: clientId } },
    { $sort: { created_at: -1 } },
    {
      $group: {
        _id:            '$wa_number',
        last_message:   { $first: '$content' },
        last_at:        { $first: '$created_at' },
        last_direction: { $first: '$direction' },
      },
    },
    { $sort: { last_at: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from:         'leads',
        localField:   '_id',
        foreignField: 'wa_number',
        as:           'lead',
      },
    },
  ]);
  return agg.map(r => ({
    wa_number:      r._id,
    last_message:   r.last_message,
    last_at:        r.last_at instanceof Date ? r.last_at.toISOString() : (r.last_at || ''),
    last_direction: r.last_direction,
    name:           r.lead?.[0]?.name || null,
  }));
}

// ── Settings ──────────────────────────────────────────────────────────────────
async function getSetting(key, clientId = 'default') {
  let setting = await Setting.findOne({ key, client_id: clientId });
  if (!setting && clientId !== 'default') {
    setting = await Setting.findOne({ key, client_id: 'default' });
  }
  return setting;
}

async function saveSetting(key, value, clientId = 'default') {
  return await Setting.findOneAndUpdate(
    { key, client_id: clientId },
    { $set: { value, updated_at: new Date() } },
    { upsert: true, returnDocument: 'after' }
  );
}

async function getAllSettings(clientId = 'default') {
  const settings = await Setting.find({ client_id: clientId });
  return settings.reduce((acc, s) => { acc[s.key] = s.value; return acc; }, {});
}

// ── Agents ────────────────────────────────────────────────────────────────────
async function getAgents(clientId = 'default') {
  const docs = await AgentModel.find({ status: 'active', client_id: clientId }).lean();
  return docs.map(d => ({
    ...d,
    id:         d._id.toString(),
    created_at: d.created_at instanceof Date ? d.created_at.toISOString() : (d.created_at || ''),
  }));
}

async function saveAgent(data, clientId = 'default') {
  const doc = await AgentModel.create({ ...data, client_id: clientId });
  return normalizeDoc(doc);
}

async function updateAgent(id, data) {
  try { await AgentModel.findByIdAndUpdate(id, { $set: data }); } catch (_) {}
}

async function deleteAgent(id) {
  try { await AgentModel.findByIdAndUpdate(id, { $set: { status: 'inactive' } }); } catch (_) {}
}

// ── Listings ──────────────────────────────────────────────────────────────────
function normalizeListing(d) {
  if (!d) return null;
  return {
    ...d,
    id:         d._id ? d._id.toString() : (d.id || ''),
    // expose canonical fields with fallback to legacy aliases
    bedrooms:   d.bedrooms || d.beds || 0,
    bathrooms:  d.bathrooms || d.baths || 0,
    property_type: d.property_type || d.type || '',
    created_at: d.created_at instanceof Date ? d.created_at.toISOString() : (d.created_at || ''),
    updated_at: d.updated_at instanceof Date ? d.updated_at.toISOString() : (d.updated_at || ''),
  };
}

async function getListings(clientId = 'default', filters = {}) {
  const query = { client_id: clientId };
  if (filters.status) query.status = filters.status;
  if (filters.intent) query.intent = filters.intent;
  if (filters.area)   query.area = new RegExp(filters.area, 'i');
  const docs = await Listing.find(query).sort({ created_at: -1 }).lean();
  return docs.map(normalizeListing);
}

async function getListing(clientId, listingId) {
  try {
    const doc = await Listing.findOne({ _id: listingId, client_id: clientId }).lean();
    return normalizeListing(doc);
  } catch (_) { return null; }
}

async function getAllListings(clientId = 'default') {
  return getListings(clientId);
}

async function saveListing(data, clientId = 'default') {
  const cid = data.client_id || clientId;
  if (data._id) {
    // Update existing
    const updated = await Listing.findOneAndUpdate(
      { _id: data._id, client_id: cid },
      { $set: { ...data, client_id: cid, updated_at: new Date() } },
      { returnDocument: 'after', new: true }
    ).lean();
    return normalizeListing(updated);
  }
  // Create new
  const doc = await Listing.create({ ...data, client_id: cid });
  return normalizeListing(doc.toObject ? doc.toObject() : doc);
}

async function updateListing(id, data) {
  try { await Listing.findByIdAndUpdate(id, { $set: { ...data, updated_at: new Date() } }); } catch (_) {}
}

async function deleteListing(id, clientId) {
  try {
    if (clientId) {
      await Listing.findOneAndDelete({ _id: id, client_id: clientId });
    } else {
      await Listing.findByIdAndDelete(id);
    }
  } catch (_) {}
}

async function matchListings(criteria, clientId = 'default') {
  const { type, min, max, area } = criteria;
  const filter = { client_id: clientId, status: 'available', price: { $gte: min || 0, $lte: max || 99999999 } };
  if (type) filter.type = type;
  if (area && area !== 'open') filter.area = area;
  const docs = await Listing.find(filter).limit(3).lean();
  return docs.map(d => ({ ...d, id: d._id.toString() }));
}

// ── Appointments ──────────────────────────────────────────────────────────────
function normalizeAppointment(d) {
  return {
    ...d,
    id:         d._id.toString(),
    lead_id:    d.lead_id?.toString(),
    created_at: d.created_at instanceof Date ? d.created_at.toISOString() : (d.created_at || ''),
  };
}

async function getAppointments(filters = {}, clientId = 'default') {
  const query = { client_id: clientId };
  if (filters.status) query.status = filters.status;
  if (filters.agent)  query.agent_wa = filters.agent;
  if (filters.date_from || filters.date_to) {
    query.appointment_date = {};
    if (filters.date_from) query.appointment_date.$gte = new Date(filters.date_from);
    if (filters.date_to)   query.appointment_date.$lte = new Date(filters.date_to);
  }
  const docs = await Appointment.find(query).sort({ appointment_date: -1 }).lean();
  return docs.map(normalizeAppointment);
}

async function getAppointmentsByDate(date, clientId = 'default') {
  const start = new Date(date); start.setHours(0, 0, 0, 0);
  const end   = new Date(date); end.setHours(23, 59, 59, 999);
  const docs  = await Appointment.find({ client_id: clientId, appointment_date: { $gte: start, $lte: end } }).sort({ appointment_date: 1 }).lean();
  return docs.map(normalizeAppointment);
}

async function saveAppointment(data, clientId = 'default') {
  const doc = await Appointment.create({ ...data, client_id: clientId });
  return normalizeDoc(doc);
}

async function updateAppointmentStatus(id, status) {
  try { await Appointment.findByIdAndUpdate(id, { $set: { status } }); } catch (_) {}
}

async function getUpcomingAppointments(clientId = 'default') {
  const now      = new Date();
  const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const docs = await Appointment.find({
    client_id:        clientId,
    appointment_date: { $gte: now, $lte: nextWeek },
    status:           { $ne: 'cancelled' },
  }).lean();
  return docs.map(normalizeAppointment);
}

// ── Notes ─────────────────────────────────────────────────────────────────────
async function getNotes(leadId) {
  const docs = await LeadNote.find({ lead_id: leadId }).sort({ created_at: -1 }).lean();
  return docs.map(d => ({
    ...d,
    id:         d._id.toString(),
    lead_id:    d.lead_id?.toString(),
    created_at: d.created_at instanceof Date ? d.created_at.toISOString() : (d.created_at || ''),
  }));
}

async function saveNote(leadId, note) {
  const doc = await LeadNote.create({ lead_id: leadId, note });
  return normalizeDoc(doc);
}

async function deleteNote(noteId) {
  try { await LeadNote.findByIdAndDelete(noteId); } catch (_) {}
}

// ── Availability ──────────────────────────────────────────────────────────────
async function getAvailability() {
  return Availability.find().lean();
}

// ── Flow Steps ────────────────────────────────────────────────────────────────
async function getFlowStep(clientId, vertical, stepId) {
  return await FlowStep.findOne({ client_id: clientId, vertical, stepId }).lean();
}

async function getFlowSteps(clientId, vertical) {
  return await FlowStep.find({ client_id: clientId, vertical }).lean();
}

async function saveFlowStep(clientId, vertical, stepId, message) {
  await FlowStep.findOneAndUpdate(
    { client_id: clientId, vertical, stepId },
    { message, updated_at: new Date() },
    { upsert: true, returnDocument: 'after' }
  );
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  mongoose,
  // Leads
  getLead, getLeadById, saveLead, insertLead,
  updateLeadStatus, updateLeadPipelineStage, updateLeadScore, updateLeadAgent,
  getAllLeads, getLeadStats, exportLeads, getLeadsForFollowup, markFollowupSent,
  deleteLead, getLeadsByDateRange,
  // Sessions
  getSession, saveSession, clearSession, setHumanMode, getSessionByAgent, getSessionsHumanMode,
  // Messages
  saveMessage, getMessages, getRecentConversations,
  // Settings
  getSetting, saveSetting, getAllSettings,
  // Agents
  getAgents, saveAgent, updateAgent, deleteAgent,
  // Listings
  getListings, getListing, getAllListings, saveListing, updateListing, deleteListing, matchListings,
  // Appointments
  getAppointments, getAppointmentsByDate, saveAppointment, updateAppointmentStatus, getUpcomingAppointments,
  // Notes
  getNotes, saveNote, deleteNote,
  // Availability
  getAvailability,
  // Flow Steps
  getFlowStep, getFlowSteps, saveFlowStep,
};
