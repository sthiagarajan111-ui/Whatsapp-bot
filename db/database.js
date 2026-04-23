/**
 * Database layer — uses Node.js built-in node:sqlite (Node >= 22.5.0).
 * Synchronous API; identical surface to better-sqlite3 for our use case.
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs   = require('fs');

const DB_DIR  = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DB_DIR, 'leads.db');

// Ensure data directory exists (Render.com persistent disk or local)
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

// --- Schema ---
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    wa_number   TEXT NOT NULL,
    name        TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    flow_name   TEXT NOT NULL,
    data        TEXT NOT NULL DEFAULT '{}',
    status      TEXT NOT NULL DEFAULT 'new'
      CHECK(status IN ('new','contacted','converted','lost'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    wa_number      TEXT PRIMARY KEY,
    current_step   TEXT NOT NULL,
    collected_data TEXT NOT NULL DEFAULT '{}',
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// --- Safe migrations (idempotent) ---
const migrations = [
  "ALTER TABLE leads    ADD COLUMN score           INTEGER DEFAULT 0",
  "ALTER TABLE leads    ADD COLUMN followup_sent   INTEGER DEFAULT 0",
  "ALTER TABLE leads    ADD COLUMN language        TEXT    DEFAULT 'en'",
  "ALTER TABLE sessions ADD COLUMN human_mode      INTEGER DEFAULT 0",
  "ALTER TABLE sessions ADD COLUMN agent_number    TEXT",
  "ALTER TABLE sessions ADD COLUMN language        TEXT    DEFAULT 'en'",
  // V4 migrations
  "ALTER TABLE leads    ADD COLUMN pipeline_stage  TEXT    DEFAULT 'new_lead'",
  "ALTER TABLE leads    ADD COLUMN assigned_agent  TEXT",
  "ALTER TABLE leads    ADD COLUMN assigned_at     TEXT",
  "ALTER TABLE sessions ADD COLUMN ai_mode         INTEGER DEFAULT 0",
  "ALTER TABLE sessions ADD COLUMN ai_history      TEXT    DEFAULT '[]'",
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (_) { /* column already exists — ignore */ }
}

// --- V4 new tables ---
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    wa_number    TEXT NOT NULL,
    direction    TEXT NOT NULL,
    message_type TEXT DEFAULT 'text',
    content      TEXT,
    raw_data     TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_wa ON messages(wa_number);

  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS lead_notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id    INTEGER NOT NULL,
    note       TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS listings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT,
    type        TEXT,
    area        TEXT,
    price       INTEGER,
    beds        INTEGER,
    baths       INTEGER,
    size_sqft   INTEGER,
    description TEXT,
    image_url   TEXT,
    listing_url TEXT,
    status      TEXT DEFAULT 'available',
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id    INTEGER,
    wa_number  TEXT,
    slot_date  TEXT,
    slot_time  TEXT,
    status     TEXT DEFAULT 'pending',
    notes      TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS availability (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    day_of_week   INTEGER,
    start_time    TEXT,
    end_time      TEXT,
    slot_duration INTEGER DEFAULT 60,
    max_per_slot  INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS agents (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    wa_number  TEXT UNIQUE NOT NULL,
    email      TEXT,
    role       TEXT DEFAULT 'agent',
    status     TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// --- Leads ---
const insertLead = db.prepare(`
  INSERT INTO leads (wa_number, name, flow_name, data, status, score, language)
  VALUES (:wa_number, :name, :flow_name, :data, 'new', :score, :language)
`);

const getAllLeads = db.prepare(`
  SELECT * FROM leads ORDER BY score DESC, created_at DESC
`);

const updateLeadStatus = db.prepare(`
  UPDATE leads SET status = :status WHERE id = :id
`);

const getStats = db.prepare(`
  SELECT
    COUNT(*)                                           AS total,
    COUNT(CASE WHEN status = 'new'       THEN 1 END)  AS new,
    COUNT(CASE WHEN status = 'contacted' THEN 1 END)  AS contacted,
    COUNT(CASE WHEN status = 'converted' THEN 1 END)  AS converted,
    COUNT(CASE WHEN status = 'lost'      THEN 1 END)  AS lost,
    COUNT(CASE WHEN score >= 8           THEN 1 END)  AS hot,
    ROUND(AVG(CASE WHEN score > 0 THEN score END), 1) AS avg_score
  FROM leads
`);

const getLeadsForFollowup = db.prepare(`
  SELECT * FROM leads
  WHERE status = 'new'
    AND followup_sent = 0
    AND created_at <= datetime('now', :offset)
`);

const markFollowupSent = db.prepare(`
  UPDATE leads SET followup_sent = 1 WHERE id = :id
`);

const getLeadsForBroadcast = db.prepare(`
  SELECT * FROM leads WHERE 1=1
`);

// --- Sessions ---
const getSession = db.prepare(`
  SELECT * FROM sessions WHERE wa_number = ?
`);

const upsertSession = db.prepare(`
  INSERT INTO sessions (wa_number, current_step, collected_data, updated_at, language)
  VALUES (:wa_number, :current_step, :collected_data, datetime('now'), :language)
  ON CONFLICT(wa_number) DO UPDATE SET
    current_step   = excluded.current_step,
    collected_data = excluded.collected_data,
    updated_at     = excluded.updated_at,
    language       = excluded.language
`);

const deleteSession = db.prepare(`
  DELETE FROM sessions WHERE wa_number = ?
`);

const setHumanMode = db.prepare(`
  UPDATE sessions SET human_mode = :human_mode, agent_number = :agent_number
  WHERE wa_number = :wa_number
`);

const getSessionByAgent = db.prepare(`
  SELECT * FROM sessions WHERE agent_number = ? AND human_mode = 1
`);

// --- Pipeline ---
const updateLeadPipelineStage = db.prepare(`
  UPDATE leads SET pipeline_stage = :stage WHERE id = :id
`);

// --- Messages ---
const saveMessage = db.prepare(`
  INSERT INTO messages (wa_number, direction, message_type, content, raw_data)
  VALUES (:wa_number, :direction, :message_type, :content, :raw_data)
`);

const getMessages = db.prepare(`
  SELECT * FROM messages WHERE wa_number = ? ORDER BY created_at ASC
`);

const getRecentConversations = db.prepare(`
  SELECT m.wa_number,
         m.content AS last_message,
         m.created_at AS last_at,
         m.direction AS last_direction,
         l.name
  FROM messages m
  JOIN (SELECT wa_number, MAX(id) AS max_id FROM messages GROUP BY wa_number) latest
    ON m.wa_number = latest.wa_number AND m.id = latest.max_id
  LEFT JOIN leads l ON l.wa_number = m.wa_number
  ORDER BY m.created_at DESC
  LIMIT ?
`);

// --- Settings ---
const getSetting = db.prepare(`SELECT value FROM settings WHERE key = ?`);
const getAllSettings = db.prepare(`SELECT key, value FROM settings`);
const upsertSetting = db.prepare(`
  INSERT INTO settings (key, value, updated_at)
  VALUES (:key, :value, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`);

// --- Lead Notes ---
const getNotes = db.prepare(`SELECT * FROM lead_notes WHERE lead_id = ? ORDER BY created_at DESC`);
const insertNote = db.prepare(`INSERT INTO lead_notes (lead_id, note) VALUES (:lead_id, :note)`);
const deleteNote = db.prepare(`DELETE FROM lead_notes WHERE id = ? AND lead_id = ?`);

// --- Listings ---
const getAllListings = db.prepare(`SELECT * FROM listings ORDER BY created_at DESC`);
const insertListing = db.prepare(`
  INSERT INTO listings (title, type, area, price, beds, baths, size_sqft, description, image_url, listing_url, status)
  VALUES (:title, :type, :area, :price, :beds, :baths, :size_sqft, :description, :image_url, :listing_url, :status)
`);
const updateListing = db.prepare(`
  UPDATE listings SET title=:title, type=:type, area=:area, price=:price,
    beds=:beds, baths=:baths, size_sqft=:size_sqft, description=:description,
    image_url=:image_url, listing_url=:listing_url, status=:status
  WHERE id=:id
`);
const deleteListing = db.prepare(`DELETE FROM listings WHERE id = ?`);
const matchListings = db.prepare(`
  SELECT * FROM listings
  WHERE status = 'available'
    AND (type = :type OR :type = '')
    AND price BETWEEN :min AND :max
    AND (area = :area OR :area = 'open')
  LIMIT 3
`);

// --- Appointments ---
const getAllAppointments = db.prepare(`SELECT * FROM appointments ORDER BY slot_date, slot_time`);
const insertAppointment = db.prepare(`
  INSERT INTO appointments (lead_id, wa_number, slot_date, slot_time, notes)
  VALUES (:lead_id, :wa_number, :slot_date, :slot_time, :notes)
`);
const updateAppointmentStatus = db.prepare(`UPDATE appointments SET status = :status WHERE id = :id`);

// --- Agents ---
const getAllAgents = db.prepare(`SELECT * FROM agents WHERE status = 'active' ORDER BY id`);
const insertAgent = db.prepare(`
  INSERT INTO agents (name, wa_number, email, role) VALUES (:name, :wa_number, :email, :role)
`);
const updateAgent = db.prepare(`
  UPDATE agents SET name=:name, email=:email, role=:role, status=:status WHERE id=:id
`);
const deleteAgent = db.prepare(`UPDATE agents SET status = 'inactive' WHERE id = ?`);
const updateLeadAgent = db.prepare(`
  UPDATE leads SET assigned_agent = :agent_wa_number, assigned_at = datetime('now') WHERE id = :id
`);

module.exports = {
  insertLead,
  getAllLeads,
  updateLeadStatus,
  updateLeadPipelineStage,
  getStats,
  getLeadsForFollowup,
  markFollowupSent,
  getLeadsForBroadcast,
  getSession,
  upsertSession,
  deleteSession,
  setHumanMode,
  getSessionByAgent,
  // Messages
  saveMessage,
  getMessages,
  getRecentConversations,
  // Settings
  getSetting,
  getAllSettings,
  upsertSetting,
  // Notes
  getNotes,
  insertNote,
  deleteNote,
  // Listings
  getAllListings,
  insertListing,
  updateListing,
  deleteListing,
  matchListings,
  // Appointments
  getAllAppointments,
  insertAppointment,
  updateAppointmentStatus,
  // Agents
  getAllAgents,
  insertAgent,
  updateAgent,
  deleteAgent,
  updateLeadAgent,
  db,
};
