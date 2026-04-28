'use strict';
const path = require('path');
const fs   = require('fs');
const {
  Document, Packer, Paragraph, Table, TableRow, TableCell,
  TextRun, HeadingLevel, AlignmentType, WidthType, BorderStyle,
  ShadingType, TableLayoutType
} = require('docx');

// ── helpers ──────────────────────────────────────────────────────────────────
const BLUE   = '1E5799';
const LBLUE  = 'EFF6FF';
const GREY   = 'F8FAFC';
const BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'E2E8F0' };
const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };

function h1(text) {
  return new Paragraph({
    text,
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 400, after: 160 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '4F86C6' } },
  });
}

function h2(text) {
  return new Paragraph({
    text,
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 320, after: 120 },
  });
}

function body(text, opts = {}) {
  return new Paragraph({
    children: [new TextRun({ text, size: 22, color: '334155', ...opts })],
    spacing: { after: 80 },
  });
}

function bullet(text) {
  return new Paragraph({
    children: [new TextRun({ text: '• ' + text, size: 22, color: '334155' })],
    spacing: { after: 60 },
    indent: { left: 360 },
  });
}

function spacer() {
  return new Paragraph({ text: '', spacing: { after: 80 } });
}

function featureTable(rows) {
  const tableRows = [
    new TableRow({
      children: [
        tableCell('Feature', true, '35%'),
        tableCell('Description', true, '65%'),
      ],
      tableHeader: true,
    }),
    ...rows.map(([feat, desc]) =>
      new TableRow({
        children: [
          tableCell(feat, false, '35%', GREY),
          tableCell(desc, false, '65%'),
        ],
      })
    ),
  ];
  return new Table({
    rows: tableRows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    margins: { bottom: 200 },
  });
}

function tableCell(text, isHeader, width, bg) {
  return new TableCell({
    children: [new Paragraph({
      children: [new TextRun({
        text,
        size: isHeader ? 20 : 20,
        bold: isHeader,
        color: isHeader ? 'FFFFFF' : '1E293B',
      })],
      spacing: { before: 60, after: 60 },
    })],
    width: { size: parseInt(width), type: WidthType.PERCENTAGE },
    shading: isHeader
      ? { type: ShadingType.SOLID, fill: '4F86C6' }
      : bg ? { type: ShadingType.SOLID, fill: bg } : undefined,
    borders: { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER },
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
  });
}

// ── document sections ─────────────────────────────────────────────────────────
const children = [

  // ── TITLE PAGE ──
  new Paragraph({
    children: [new TextRun({ text: 'Axyren CRM', bold: true, size: 64, color: '1E293B' })],
    alignment: AlignmentType.CENTER, spacing: { before: 800, after: 200 },
  }),
  new Paragraph({
    children: [new TextRun({ text: 'Features Reference v2.0', size: 36, color: '4F86C6' })],
    alignment: AlignmentType.CENTER, spacing: { after: 120 },
  }),
  new Paragraph({
    children: [new TextRun({ text: 'Sessions 1–5 · Updated April 2026', size: 24, color: '94A3B8' })],
    alignment: AlignmentType.CENTER, spacing: { after: 600 },
  }),
  new Paragraph({
    children: [new TextRun({ text: '─────────────────────────────────────────────', color: 'E2E8F0', size: 22 })],
    alignment: AlignmentType.CENTER, spacing: { after: 600 },
  }),

  // ── SECTIONS 1–8 (existing, summarised) ──
  h1('Sections 1–8: Core Platform (Pre-Session 1)'),
  body('The following sections cover the core Axyren platform features built prior to the session-based feature additions. These are included for reference.'),
  spacer(),

  ...['1 — WhatsApp Bot & Flow Engine','2 — Lead Management & Scoring','3 — Pipeline (Kanban Board)',
      '4 — Conversation Manager','5 — Analytics Dashboard','6 — Appointments Module',
      '7 — Settings & Agent Management','8 — Admin & Multi-Tenant Architecture']
    .flatMap(s => [h2(s), body('Core platform feature — see previous documentation for full detail.'), spacer()]),

  // ── SECTION 9 ──
  h1('Section 9 — Universal Lead ID (Session 1)'),
  body('Every lead is assigned a unique, human-readable ID at the point of capture. The ID encodes the client, year, sequence, channel, and vertical — making it instantly recognisable and searchable.'),
  spacer(),
  featureTable([
    ['Auto-Generated ID',      'Format: AXY-2026-0042-WA-RE — client prefix, year, 4-digit sequence, channel code, vertical code'],
    ['Client Prefix',          'Configurable per client (e.g. AXY, ORX, PSG). Set via CLIENT_PREFIX env var or admin panel'],
    ['Channel Codes',          'WA=WhatsApp · PH=Phone · FB=Facebook · IG=Instagram · WB=Web · WK=Walk-in'],
    ['Vertical Codes',         'RE=Real Estate · RS=Restaurant · CL=Clinic · RT=Retail · SL=Salon · CD=Car Dealer'],
    ['Global Search Bar',      'Top-bar search across all leads by ID, name, phone, or area — opens Lead 360° Profile on click'],
    ['Retroactive Assignment', 'POST /api/dev/assign-lead-ids migrates existing leads without IDs in bulk'],
    ['Unique Constraint',      'MongoDB sparse unique index prevents duplicate IDs; auto-increments per client'],
  ]),
  spacer(),

  // ── SECTION 10 ──
  h1('Section 10 — Manual Lead Capture (Session 2)'),
  body('Agents can capture phone, walk-in, or referral leads directly from the dashboard without a WhatsApp conversation. A guided modal with disclaimer and browser recording ensures compliance.'),
  spacer(),
  featureTable([
    ['+ New Lead Button',       'Persistent button in top-bar; opens multi-step modal from any dashboard page'],
    ['Mandatory Disclaimer',    'Step 1 requires agent to confirm recording consent before proceeding — legally compliant'],
    ['Browser Mic Recording',   'MediaRecorder API auto-starts on Step 2; timer shows live duration; stops on save'],
    ['Industry-Specific Form',  '6 vertical templates: Real Estate, Restaurant, Clinic, Retail, Salon, Car Dealer — each with relevant fields'],
    ['Lead ID Preview',         'ID generated client-side (GET /api/leads/preview-id) and shown before saving'],
    ['Automatic Scoring',       'Score computed server-side based on budget, timeline, intent — same logic as bot flow'],
    ['Recording Upload',        'Audio uploaded via multipart to POST /api/recordings/upload; stored with lead_id, agent, source, notes'],
  ]),
  spacer(),

  // ── SECTION 11 ──
  h1('Section 11 — Call Recordings Report (Session 3)'),
  body('A dedicated Call Recordings page gives managers full visibility of all recorded calls. Recordings can be played inline, filtered, starred for training, and exported.'),
  spacer(),
  featureTable([
    ['Sidebar Link',        '"Call Recordings" nav item in Reports section — hash-based SPA navigation'],
    ['4 KPI Cards',         'Total Recordings · Total Duration · Unique Agents · Today\'s Recordings — live from API'],
    ['Search & Filters',    'Search by Lead ID/agent/notes · Date range · Agent dropdown · Score (HOT/WARM/COLD) · Min Duration'],
    ['Inline Audio Player', 'Floating player bar at bottom; plays any recording without leaving the page'],
    ['Speed Control',       '1× / 1.5× / 2× playback speed buttons on the audio player bar'],
    ['Notes Per Recording', 'Editable notes field per row — saved via POST /api/recordings/:id/note'],
    ['Star / Training Lib', '★ button toggles starred; "Training Library" filter shows only starred recordings'],
    ['Export CSV',          'Downloads all visible recordings as CSV with all fields including duration and score'],
  ]),
  spacer(),

  // ── SECTION 12 ──
  h1('Section 12 — Lead 360° Profile (Session 4)'),
  body('A comprehensive single-screen view of every lead\'s complete history, KPIs, timeline, and available actions. Accessible from the Contacts table, Pipeline board, Conversation header, and global search.'),
  spacer(),
  featureTable([
    ['Hero Card',           'Avatar (initials, score-coloured) · Name · Lead ID chip · phone/email/channel meta · Score badge · Stage badge · Vertical badge'],
    ['6 KPI Cards',         'Touchpoints · Appointments · Recordings · Days Active · Budget · Lead Score — all from one API call'],
    ['Colour-Coded Timeline','8 event types: MSG (inbound) · BOT (outbound) · MANUAL · APPT · SCORE · REC · NOTE · LISTING · CAMP'],
    ['Lead Details Grid',   'Intent · Property Type · Area Interest · Timeline · Language · Source · Entry Method · Last Updated — all with formatLabel() normalisation'],
    ['Appointments Panel',  'Mini list of all booked appointments with date, time slot, and status badge'],
    ['6 Action Buttons',    '💬 WhatsApp Lead · 🏠 Send Listing · 📅 Book Appointment · 📝 Add Note · ⭐ Flag VIP · 🔄 Re-engage'],
    ['Click-to-Open',       'Lead name clickable in: Contacts table · Pipeline kanban cards · Conversation header · Search results'],
    ['Timeout Protection',  '8s client-side timeout with Retry button; 10s server-side 504 timeout with clearTimeout on all exits'],
  ]),
  spacer(),

  // ── SECTION 13 ──
  h1('Section 13 — Campaign Manager (Session 5)'),
  body('Agents can send personalised WhatsApp broadcast messages to precisely targeted lead segments. The segment builder provides 7 filters with a live lead count preview before sending.'),
  spacer(),
  featureTable([
    ['Segment Builder',       '7 filters: Score · Pipeline Stage · Channel · Language · Entry Method · Days Inactive · Area Interest'],
    ['Live Lead Count',       'Counter updates in real time as filters change — shows matching lead count + sample names'],
    ['Message Composer',      'Campaign name (required) · Textarea (1000 char max with counter) · Variable placeholder pill buttons'],
    ['Personalisation',       '{name} · {area} · {budget} replaced per-lead before sending — preview shows sample substitution'],
    ['Live Preview',          'Right-side preview panel updates as you type, showing message with sample data filled in'],
    ['Send to Segment',       'POST /api/campaigns/send — iterates matching leads, personalises, sends via WhatsApp, saves to messages'],
    ['Confirmation Modal',    'Summary modal: "Send [Name] to X leads?" with message excerpt before executing'],
    ['Campaign History',      'Table of past campaigns grouped by message content — shows recipient count, first/last sent date'],
  ]),
  spacer(),

  // ── SECTION 14: UPDATED ROADMAP ──
  h1('Section 14 — Features in Development'),
  body('The following features are planned for upcoming sessions:'),
  spacer(),
  featureTable([
    ['✅ Session 1 — Universal Lead ID',        'Complete — live in production'],
    ['✅ Session 2 — Manual Lead Capture',       'Complete — live in production'],
    ['✅ Session 3 — Call Recordings Report',    'Complete — live in production'],
    ['✅ Session 4 — Lead 360° Profile',         'Complete — live in production'],
    ['✅ Session 5 — Campaign Manager',          'Complete — live in production'],
    ['🔜 Facebook/Instagram Lead Intake',        'Meta webhook integration for FB/IG lead ads → auto-capture as leads'],
    ['🔜 Web Form Embed',                        'Embeddable JS snippet for client websites — leads flow directly into CRM'],
    ['🔜 AI Call Transcription',                 'Whisper/OpenAI transcription of recorded calls → searchable text in timeline'],
    ['🔜 Automated Campaign Scheduling',         'Schedule campaigns for future delivery with recurrence options'],
  ]),
  spacer(),

  // ── FOOTER ──
  new Paragraph({
    children: [new TextRun({ text: '─────────────────────────────────────────────', color: 'E2E8F0', size: 22 })],
    alignment: AlignmentType.CENTER, spacing: { before: 400, after: 120 },
  }),
  new Paragraph({
    children: [new TextRun({ text: 'Axyren CRM · Confidential · Generated ' + new Date().toLocaleDateString('en-AE', { timeZone: 'Asia/Dubai', day: '2-digit', month: 'long', year: 'numeric' }), size: 18, color: '94A3B8' })],
    alignment: AlignmentType.CENTER,
  }),
];

// ── build & write ─────────────────────────────────────────────────────────────
async function main() {
  const doc = new Document({
    creator: 'Axyren CRM',
    title:   'Axyren Features Reference v2',
    description: 'Complete feature reference for Axyren CRM — Sessions 1–5',
    styles: {
      default: {
        document: { run: { font: 'Calibri', size: 22 } },
        heading1: { run: { font: 'Calibri', size: 32, bold: true, color: '1E293B' }, paragraph: {} },
        heading2: { run: { font: 'Calibri', size: 26, bold: true, color: '4F86C6' }, paragraph: {} },
      }
    },
    sections: [{ children }],
  });

  const outPath = path.join(__dirname, '..', 'Axyren_Features_Reference_v2.docx');
  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync(outPath, buf);
  console.log('✓ Written:', outPath);
  console.log('  Size:', (buf.length / 1024).toFixed(1) + ' KB');
}

main().catch(e => { console.error(e); process.exit(1); });
