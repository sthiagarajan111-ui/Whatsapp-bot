# WhatsApp CRM — Complete Product Build V4
## Master upgrade instruction — ALL phases
## Run inside C:\projects\whatsapp-bot

---

## CONTEXT — WHAT IS ALREADY BUILT

The following are already working. DO NOT rewrite these:
- server.js — Express server, webhook handler, all API routes
- flows/flowEngine.js — conversation state machine with Arabic, voice, multi-flow
- flows/realEstate.js — real estate lead qualification flow
- db/database.js — SQLite with leads, sessions tables
- whatsapp/api.js — sendText, sendButtons, sendList, markAsRead
- utils/voiceHandler.js — OpenAI Whisper transcription
- utils/timeUtils.js — business hours
- utils/langDetect.js — Arabic detection
- utils/scorer.js — lead scoring
- utils/scheduler.js — follow-up reminders
- dashboard/index.html — GHL-style premium dashboard

---

## ARCHITECTURE CHANGE — MULTI-PAGE DASHBOARD

Convert dashboard from single-page to multi-page router.

The existing dashboard/index.html becomes the main layout shell.
Create these new files:
- dashboard/pages/conversations.html
- dashboard/pages/opportunities.html
- dashboard/pages/analytics.html
- dashboard/pages/settings.html
- dashboard/pages/lead-detail.html
- dashboard/js/router.js — client-side router (hash-based: #dashboard, #conversations etc)
- dashboard/js/shared.js — shared utilities used by all pages
- dashboard/css/shared.css — shared styles imported by all pages

Add these routes to server.js:
- GET /dashboard/pages/:page — serve page files
- GET /dashboard/js/:file — serve JS files
- GET /dashboard/css/:file — serve CSS files

The main dashboard/index.html should:
- Load router.js
- Have the sidebar with working nav links
- Load page content dynamically into a #page-content div
- Share the topbar and sidebar across all pages

---

## PHASE 4A — CONVERSATIONS PAGE

File: dashboard/pages/conversations.html

This page shows the full WhatsApp conversation history per lead.

### Database changes needed:

Add new table `messages` to db/database.js:
```sql
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_number TEXT NOT NULL,
  direction TEXT NOT NULL,  -- 'inbound' or 'outbound'
  message_type TEXT DEFAULT 'text',  -- 'text', 'audio', 'button', 'list'
  content TEXT,  -- message text or transcription
  raw_data TEXT,  -- full JSON of original message
  created_at TEXT DEFAULT (datetime('now'))
)
```

Add index: CREATE INDEX IF NOT EXISTS idx_messages_wa ON messages(wa_number);

Add these functions to database.js:
- `saveMessage(waNumber, direction, type, content, rawData)` — save every message
- `getMessages(waNumber)` — get all messages for a number ordered by created_at
- `getRecentConversations(limit)` — get latest message per unique wa_number with lead name

### server.js changes:

In POST /webhook, after processing each message:
- Save inbound messages: saveMessage(waNumber, 'inbound', message.type, extractedText, JSON.stringify(message))
- In processMessage/sendText/sendButtons/sendList: save outbound messages too

Add these API routes:
- GET /api/conversations — returns list of conversations with latest message, lead name, unread count
- GET /api/conversations/:waNumber — returns all messages for a number
- GET /api/conversations/:waNumber/lead — returns the lead record for this number

### Conversations page UI:

Two-panel layout:
- Left panel (280px): conversation list showing avatar, name, last message preview, time, unread dot
- Right panel: selected conversation showing full chat thread

Chat thread styling:
- Inbound messages (customer) — left aligned, gray bubble
- Outbound messages (bot) — right aligned, green/teal bubble  
- Bot messages have a small robot icon indicator
- Human messages (from TAKE command) have agent icon
- Voice messages show 🎙️ with transcription text
- Timestamps between message groups
- Lead info card at top of right panel: name, number, score badge, status pill, area, budget
- "Take Over" button at bottom of right panel (triggers TAKE command)

---

## PHASE 4B — OPPORTUNITIES KANBAN PAGE

File: dashboard/pages/opportunities.html

Full Kanban board with drag-and-drop between stages.

### Stages (matching GHL real estate pipeline):
1. New Lead (blue)
2. AI Contacted (cyan)
3. Qualified — HOT (red)
4. Qualified — WARM (amber)
5. Viewing Requested (purple)
6. Viewing Confirmed (teal)
7. Offer Made (orange)
8. Won (green)
9. Lost (gray)

### Database changes:
Add `pipeline_stage` TEXT column to leads table (default: derived from status)
Map existing statuses: new → 'new_lead', contacted → 'ai_contacted', converted → 'won', lost → 'lost'

Add API routes:
- GET /api/pipeline — returns leads grouped by pipeline_stage
- POST /api/leads/:id/stage — update pipeline stage

### Kanban UI:

Horizontal scrollable board.
Each column:
- Header with stage name, count badge, total value (AED)
- Scrollable card list
- Cards show: avatar, name, score tag, budget, area, time-ago, Arabic/Voice indicators
- Color-coded card left border matching stage color
- Card click → opens lead detail panel (right slide-in)

Add drag-and-drop using HTML5 native drag events:
- dragstart on cards
- dragover and drop on columns
- On drop: call POST /api/leads/:id/stage
- Visual feedback: column highlights on dragover

Pipeline summary bar at top:
- Total pipeline value (AED)
- Count per stage as mini pills
- Conversion rate

---

## PHASE 4C — ANALYTICS PAGE

File: dashboard/pages/analytics.html

Deep analytics with date range filtering.

### Charts to include:

1. **Leads trend** — line chart, configurable 7/30/90 days
2. **Conversion funnel** — full GHL-style funnel with cumulative %
3. **Lead score distribution** — bar chart showing count per score (1-10)
4. **Leads by area** — horizontal bar, sorted by volume
5. **Leads by budget range** — pie/donut chart
6. **Leads by interest type** — donut (Buy/Rent/Sell)
7. **Hour of day heatmap** — when do leads message? (24 hours × 7 days grid)
8. **Response time** — average time between lead message and agent TAKE command
9. **Arabic vs English** — donut showing language split
10. **Voice vs Text** — source split donut

### Date range filter:
- Today / Last 7 days / Last 30 days / Last 90 days / All time
- Custom date range picker (two date inputs)

### KPI summary row at top:
- Total leads in period
- Conversion rate
- Avg response time
- Best performing area
- Best performing day of week

### Add API routes:
- GET /api/analytics?from=DATE&to=DATE — returns all analytics data as JSON
- Calculate server-side: hourly distribution, language split, score distribution, area counts

---

## PHASE 4D — SETTINGS PAGE

File: dashboard/pages/settings.html

Configure the entire bot from the UI — no more .env editing.

### Settings sections:

**Bot Configuration:**
- Client Name (text input)
- Business Hours Start/End (time pickers)
- Business Days (checkboxes Mon-Sat)
- Active Flow selector (dropdown of available flows)
- Out-of-hours message (textarea)
- Follow-up delay in hours (number input)

**WhatsApp Connection:**
- Token status indicator (green/red)
- Phone Number ID (masked input)
- Owner WhatsApp number
- Test connection button → calls /api/token-check
- Re-enter token button (shows input field temporarily)

**Flow Customization:**
- Client name in greetings (replaces [CLIENT_NAME] placeholder)
- Completion message (textarea)
- Areas list (editable list — add/remove Dubai areas)
- Budget ranges (editable list)

**Notifications:**
- Email notification toggle + email address input
- Owner WhatsApp notification toggle
- Daily summary report toggle + time picker

**Branding:**
- Dashboard title
- Primary color picker (changes accent color throughout dashboard)
- Logo URL (shown in sidebar)

### Storage:
Create a `settings` table in SQLite:
```sql
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
)
```

Add API routes:
- GET /api/settings — returns all settings as JSON object
- POST /api/settings — saves settings (body: {key, value} or full object)

Update server.js to read settings from DB on startup as fallback to .env values.

---

## PHASE 4E — LEAD DETAIL PAGE

File: dashboard/pages/lead-detail.html

Full CRM-style lead profile page.

### Sections:

**Lead header:**
- Large avatar with initials
- Name, WhatsApp number, score badge, status pill
- HOT/WARM/COLD indicator with score bar
- Action buttons: Take Over | Mark Converted | Export | Delete

**Lead information cards (2-column grid):**
- Contact details: WhatsApp, language, source (voice/text)
- Property interest: interest type, property type, budget, area
- Timeline: first contact, last message, follow-up sent
- Bot journey: which flow, how many steps completed

**Conversation history:**
- Embedded mini chat thread (same as conversations page)
- Shows full message history

**Notes section:**
- Add note textarea + save button
- List of all saved notes with timestamp
- Notes stored in new `lead_notes` table

**Activity timeline:**
- All events for this lead in chronological order
- Lead captured, status changes, notes added, broadcast received, human handoff

### Database:
Add `lead_notes` table:
- id, lead_id, note TEXT, created_at

Add API routes:
- GET /api/leads/:id/detail — full lead with notes, messages, timeline
- POST /api/leads/:id/notes — add a note
- DELETE /api/leads/:id/notes/:noteId — delete note

---

## PHASE 5A — AI FREE-TEXT MODE (Claude API)

File: utils/aiHandler.js

After the structured flow COMPLETES, bot enters AI mode for natural conversation.

### How it works:

Session gets a new field: `ai_mode: true` after COMPLETE step.

In flowEngine.js, if session.ai_mode is true:
- Skip flow engine entirely
- Pass message to aiHandler.js
- Get AI response
- Send response back to user

### aiHandler.js:

```javascript
const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function getAIResponse(waNumber, userMessage, leadData, conversationHistory, language) {
  const systemPrompt = buildSystemPrompt(leadData, language);
  
  const response = await client.messages.create({
    model: 'claude-3-haiku-20240307',
    max_tokens: 300,
    system: systemPrompt,
    messages: conversationHistory.slice(-10) // last 10 messages for context
  });
  
  return response.content[0].text;
}

function buildSystemPrompt(leadData, language) {
  const lang = language === 'ar' ? 'Arabic' : 'English';
  return `You are a helpful real estate assistant for ${process.env.CLIENT_NAME}.
  
Customer profile:
- Name: ${leadData.name}
- Interest: ${leadData.interest} a ${leadData.propertyType}
- Budget: ${leadData.budget}
- Preferred area: ${leadData.area}
- Score: ${leadData.score}/10

Instructions:
- Always respond in ${lang}
- Keep responses under 150 words
- Be helpful and professional
- Answer property questions based on Dubai real estate knowledge
- Encourage booking a viewing if appropriate
- Never make up specific property listings unless provided
- If asked about specific properties, say "Our agent will send you options shortly"
- End responses with a helpful question or call-to-action
${process.env.KNOWLEDGE_BASE ? `\nKnowledge base:\n${process.env.KNOWLEDGE_BASE}` : ''}`;
}
```

### Conversation history tracking:
In flowEngine.js, maintain a rolling window of last 10 messages per session for AI context.
Store in session.ai_history as JSON array: [{role: 'user', content: '...'}, {role: 'assistant', content: '...'}]

### .env additions:
```
ANTHROPIC_API_KEY=your_claude_api_key
AI_MODE_ENABLED=true
KNOWLEDGE_BASE=Optional text about your properties and areas
```

### Exit AI mode:
- User types "menu" or "restart" → resets to START of flow
- After 24 hours of inactivity → session cleared

---

## PHASE 5B — PROPERTY LISTING MATCHING

File: utils/listingsMatcher.js

Client can upload their property listings. Bot matches and sends relevant ones.

### How it works:

1. Client uploads listings via Settings page (CSV upload or manual entry)
2. Listings stored in new `listings` table in SQLite
3. After COMPLETE step, before AI mode, bot queries listings matching criteria
4. If 1-3 matches found: send them as formatted WhatsApp messages with details
5. If no matches: send "Our agent will contact you with matching properties"

### Listings table:
```sql
CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  type TEXT,        -- apartment, villa, commercial
  area TEXT,        -- jvc, marina, downtown etc
  price INTEGER,    -- in AED
  beds INTEGER,
  baths INTEGER,
  size_sqft INTEGER,
  description TEXT,
  image_url TEXT,
  listing_url TEXT,
  status TEXT DEFAULT 'available',
  created_at TEXT DEFAULT (datetime('now'))
)
```

### Matching logic in listingsMatcher.js:
```javascript
function matchListings(db, leadData) {
  const budget = budgetRanges[leadData.budget]; // {min, max}
  const type = leadData.propertyType;
  const area = leadData.area;
  
  return db.prepare(`
    SELECT * FROM listings 
    WHERE status = 'available'
    AND type = ? 
    AND price BETWEEN ? AND ?
    AND (area = ? OR ? = 'open')
    LIMIT 3
  `).all(type, budget.min, budget.max, area, area);
}
```

### WhatsApp listing message format:
```
🏠 *Property Match Found!*

1️⃣ *[Title]* — AED [price]
   📍 [Area] | 🛏 [beds] beds | 📐 [size] sqft
   [listing_url]

2️⃣ *[Title]* — AED [price]
   📍 [Area] | 🛏 [beds] beds | 📐 [size] sqft
   [listing_url]

💬 Would you like to schedule a viewing for any of these?
```

### API routes:
- GET /api/listings — get all listings
- POST /api/listings — add listing
- PUT /api/listings/:id — update listing
- DELETE /api/listings/:id — delete listing
- POST /api/listings/import — import from CSV (parse CSV body)

### Settings page addition:
Add "Property Listings" tab with:
- Add listing form
- Listings table with edit/delete
- Import CSV button

---

## PHASE 5C — APPOINTMENT BOOKING

File: utils/appointmentHandler.js

After lead shows interest in viewing, bot offers time slots.

### How it works:

1. After COMPLETE step (or in AI mode), if lead mentions "viewing" or "visit" or "appointment":
   - Bot sends available time slots as list picker
   - Slots come from availability settings
   
2. Lead selects a slot → appointment created → both lead and agent notified

3. Confirmation message sent to lead with date/time

### Database:
```sql
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER,
  wa_number TEXT,
  slot_date TEXT,
  slot_time TEXT,
  status TEXT DEFAULT 'pending',  -- pending, confirmed, cancelled
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
)

CREATE TABLE IF NOT EXISTS availability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day_of_week INTEGER,  -- 1=Mon, 7=Sun
  start_time TEXT,       -- "09:00"
  end_time TEXT,         -- "18:00"
  slot_duration INTEGER DEFAULT 60,  -- minutes
  max_per_slot INTEGER DEFAULT 1
)
```

### appointmentHandler.js:
- `getAvailableSlots(date)` — returns available slots for a given date
- `bookSlot(waNumber, leadId, date, time)` — creates appointment
- `sendConfirmation(waNumber, appointment)` — sends WhatsApp confirmation
- `notifyAgent(appointment, leadData)` — sends agent notification

### Settings page — Availability tab:
- Set working hours per day
- Block specific dates
- View upcoming appointments calendar

### API routes:
- GET /api/appointments — list all appointments
- POST /api/appointments — create appointment
- PUT /api/appointments/:id/status — confirm/cancel
- GET /api/availability — get available slots for next 7 days

---

## PHASE 5D — MONTHLY PDF REPORT

File: utils/reportGenerator.js

Auto-generates a professional monthly performance report sent to client email.

### Report content:

**Page 1 — Executive Summary:**
- Month name and year
- Total leads captured
- Conversion rate vs previous month (% change)
- Pipeline value
- Best performing area
- Best performing day

**Page 2 — Lead Analytics:**
- Leads by source chart
- Leads by budget range chart
- Leads by area chart
- Score distribution

**Page 3 — Conversion Funnel:**
- Full GHL-style funnel
- Stage-by-stage conversion rates

**Page 4 — AI Recommendations (3 bullet points):**
- Generated by Claude API based on the data
- Example: "47% of HOT leads are interested in Palm Jumeirah — consider promoting listings there"

### Implementation:
- Use `puppeteer` npm package to render HTML to PDF
- Create a report HTML template
- Populate with real data
- Save to /reports/ folder
- Send via Nodemailer to configured email

### Scheduler addition:
In utils/scheduler.js, add monthly report generation:
- On 1st of each month at 8am UAE time
- Also add manual trigger: GET /api/reports/generate

### API routes:
- GET /api/reports — list generated reports
- GET /api/reports/generate — generate now (for testing)
- GET /api/reports/:filename — download report PDF

---

## PHASE 6 — ADDITIONAL FLOWS

Create these new flow files. Each is a copy of realEstate.js structure with different steps.

### flows/restaurant.js

```javascript
steps: {
  START: { message: "Welcome to [CLIENT_NAME]! How can we help you today?", type: "buttons",
    options: [{id:"dine_in", title:"Dine In"}, {id:"takeaway", title:"Takeaway"}, {id:"event", title:"Book for Event"}], field: "service_type", next: "ASK_NAME" },
  ASK_NAME: { message: "Wonderful! May I have your name?", type: "text", field: "name", next: "ASK_DATE" },
  ASK_DATE: { message: "Which date are you thinking, {name}?", type: "buttons",
    options: [{id:"today", title:"Today"}, {id:"tomorrow", title:"Tomorrow"}, {id:"this_weekend", title:"This Weekend"}], field: "date", next: "ASK_PARTY_SIZE" },
  ASK_PARTY_SIZE: { message: "How many guests will be joining?", type: "list", field: "party_size",
    buttonText: "Select size",
    sections: [{title: "Party Size", rows: [{id:"1-2",title:"1-2 guests"},{id:"3-5",title:"3-5 guests"},{id:"6-10",title:"6-10 guests"},{id:"10+",title:"10+ guests (event)"}]}],
    next: "ASK_DIETARY" },
  ASK_DIETARY: { message: "Any dietary requirements we should know about?", type: "buttons",
    options: [{id:"none",title:"No requirements"},{id:"vegetarian",title:"Vegetarian"},{id:"halal",title:"Halal only"}], field: "dietary", next: "COMPLETE" },
  COMPLETE: {}
}
```

### flows/clinic.js

```javascript
steps: {
  START: { message: "Hello! Welcome to [CLIENT_NAME]. How can we assist you today?", type: "buttons",
    options: [{id:"appointment",title:"Book Appointment"},{id:"enquiry",title:"General Enquiry"},{id:"followup",title:"Follow-up Visit"}], field: "visit_type", next: "ASK_NAME" },
  ASK_NAME: { message: "Please share your full name.", type: "text", field: "name", next: "ASK_SPECIALTY" },
  ASK_SPECIALTY: { message: "Which department do you need, {name}?", type: "list", field: "specialty",
    buttonText: "Select department",
    sections: [{title: "Departments", rows: [{id:"gp",title:"General Practice"},{id:"dental",title:"Dental"},{id:"dermatology",title:"Dermatology"},{id:"orthopedic",title:"Orthopedic"},{id:"gynecology",title:"Gynecology"}]}],
    next: "ASK_DATE" },
  ASK_DATE: { message: "When would you like to visit?", type: "buttons",
    options: [{id:"today",title:"Today"},{id:"tomorrow",title:"Tomorrow"},{id:"this_week",title:"This Week"}], field: "preferred_date", next: "ASK_INSURANCE" },
  ASK_INSURANCE: { message: "Do you have insurance?", type: "buttons",
    options: [{id:"yes_daman",title:"Yes - Daman"},{id:"yes_abudhabi",title:"Yes - Abu Dhabi"},{id:"yes_other",title:"Yes - Other"},{id:"self_pay",title:"Self Pay"}], field: "insurance", next: "COMPLETE" },
  COMPLETE: {}
}
```

### flows/retail.js

```javascript
steps: {
  START: { message: "Hi! Welcome to [CLIENT_NAME]. What brings you here today?", type: "buttons",
    options: [{id:"product_enquiry",title:"Product Enquiry"},{id:"order_status",title:"Order Status"},{id:"return_exchange",title:"Return/Exchange"}], field: "enquiry_type", next: "ASK_NAME" },
  ASK_NAME: { message: "I'd be happy to help! May I have your name?", type: "text", field: "name", next: "ASK_CATEGORY" },
  ASK_CATEGORY: { message: "Which product category are you interested in, {name}?", type: "list", field: "category",
    buttonText: "Select category",
    sections: [{title: "Categories", rows: [{id:"electronics",title:"Electronics"},{id:"fashion",title:"Fashion & Apparel"},{id:"home",title:"Home & Living"},{id:"beauty",title:"Beauty & Health"},{id:"sports",title:"Sports & Outdoor"}]}],
    next: "ASK_BUDGET" },
  ASK_BUDGET: { message: "What's your budget range?", type: "buttons",
    options: [{id:"under_500",title:"Under AED 500"},{id:"500_2000",title:"AED 500-2,000"},{id:"above_2000",title:"Above AED 2,000"}], field: "budget", next: "COMPLETE" },
  COMPLETE: {}
}
```

### flows/salon.js

```javascript
steps: {
  START: { message: "Welcome to [CLIENT_NAME]! 💇 What service are you looking for?", type: "buttons",
    options: [{id:"haircut",title:"Haircut & Style"},{id:"color",title:"Hair Color"},{id:"treatment",title:"Treatment & Spa"}], field: "service", next: "ASK_NAME" },
  ASK_NAME: { message: "Lovely choice! What's your name?", type: "text", field: "name", next: "ASK_STYLIST" },
  ASK_STYLIST: { message: "Do you have a preferred stylist, {name}?", type: "buttons",
    options: [{id:"any",title:"Any available"},{id:"senior",title:"Senior Stylist"},{id:"specific",title:"I'll specify"}], field: "stylist_pref", next: "ASK_DATE" },
  ASK_DATE: { message: "When would you like to come in?", type: "buttons",
    options: [{id:"today",title:"Today"},{id:"tomorrow",title:"Tomorrow"},{id:"this_week",title:"This Week"}], field: "date", next: "COMPLETE" },
  COMPLETE: {}
}
```

### flows/carDealer.js

```javascript
steps: {
  START: { message: "Welcome to [CLIENT_NAME]! 🚗 What can we help you with today?", type: "buttons",
    options: [{id:"buy_new",title:"Buy New Car"},{id:"buy_used",title:"Buy Used Car"},{id:"test_drive",title:"Book Test Drive"}], field: "interest", next: "ASK_NAME" },
  ASK_NAME: { message: "Great! May I have your name?", type: "text", field: "name", next: "ASK_BRAND" },
  ASK_BRAND: { message: "Which brand are you interested in, {name}?", type: "list", field: "brand",
    buttonText: "Select brand",
    sections: [{title: "Brands", rows: [{id:"toyota",title:"Toyota"},{id:"honda",title:"Honda"},{id:"bmw",title:"BMW"},{id:"mercedes",title:"Mercedes-Benz"},{id:"other",title:"Other / Open"}]}],
    next: "ASK_BUDGET" },
  ASK_BUDGET: { message: "What's your budget range?", type: "list", field: "budget",
    buttonText: "Select budget",
    sections: [{title: "Budget (AED)", rows: [{id:"under_100k",title:"Under AED 100,000"},{id:"100k_250k",title:"AED 100K-250K"},{id:"250k_500k",title:"AED 250K-500K"},{id:"above_500k",title:"Above AED 500K"}]}],
    next: "ASK_FINANCE" },
  ASK_FINANCE: { message: "Would you need financing?", type: "buttons",
    options: [{id:"cash",title:"Cash Purchase"},{id:"finance",title:"Yes, financing"},{id:"undecided",title:"Not decided yet"}], field: "finance", next: "COMPLETE" },
  COMPLETE: {}
}
```

---

## PHASE 7A — INTEGRATIONS

### Zoho CRM Sync

File: utils/integrations/zohoSync.js

On lead COMPLETE event, if ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET are configured:
1. Get access token using client credentials
2. Create a Lead record in Zoho CRM via REST API
3. Map fields: wa_number→Mobile, name→Full Name, interest→Lead Source, area→Lead Source Description, budget→Annual Revenue

```javascript
async function createZohoLead(leadData) {
  const token = await getZohoToken();
  const zohoLead = {
    "Last_Name": leadData.name,
    "Mobile": leadData.wa_number,
    "Lead_Source": "WhatsApp Bot",
    "Description": `Interest: ${leadData.interest}, Budget: ${leadData.budget}, Area: ${leadData.area}`,
    "Rating": leadData.score >= 8 ? "Hot" : leadData.score >= 5 ? "Warm" : "Cold"
  };
  // POST to https://www.zohoapis.com/crm/v2/Leads
}
```

Add to .env.example:
```
ZOHO_CLIENT_ID=
ZOHO_CLIENT_SECRET=
ZOHO_REFRESH_TOKEN=
ZOHO_SYNC_ENABLED=false
```

### Email Notifications

File: utils/integrations/emailNotifier.js

Using Nodemailer with Gmail or any SMTP:

```javascript
const nodemailer = require('nodemailer');

async function sendLeadEmail(lead, collectedData) {
  if (!process.env.SMTP_USER) return;
  
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });

  await transporter.sendMail({
    from: process.env.SMTP_USER,
    to: process.env.NOTIFICATION_EMAIL,
    subject: `🔥 New ${lead.score >= 8 ? 'HOT' : 'Lead'}: ${collectedData.name} — ${collectedData.area}`,
    html: buildEmailTemplate(lead, collectedData)
  });
}
```

Add to .env.example:
```
SMTP_USER=youremail@gmail.com
SMTP_PASS=your_app_password
NOTIFICATION_EMAIL=agent@agency.com
EMAIL_NOTIFICATIONS=false
```

npm install nodemailer

### Zapier Webhook

File: utils/integrations/zapierWebhook.js

On lead COMPLETE, if ZAPIER_WEBHOOK_URL is set:
POST to the URL with full lead data as JSON body.
Client can then connect this to any tool via Zapier (Google Sheets, HubSpot, Slack etc).

```javascript
async function triggerZapier(leadData) {
  if (!process.env.ZAPIER_WEBHOOK_URL) return;
  await fetch(process.env.ZAPIER_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(leadData)
  });
}
```

Add to .env.example:
```
ZAPIER_WEBHOOK_URL=
```

---

## PHASE 8A — MULTI-AGENT MANAGEMENT

### Database changes:

```sql
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  wa_number TEXT UNIQUE NOT NULL,
  email TEXT,
  role TEXT DEFAULT 'agent',  -- 'admin' or 'agent'
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now'))
)

-- Add to leads table:
ALTER TABLE leads ADD COLUMN assigned_agent TEXT;
ALTER TABLE leads ADD COLUMN assigned_at TEXT;
```

### API routes:
- GET /api/agents — list all agents
- POST /api/agents — add agent
- PUT /api/agents/:id — update agent
- DELETE /api/agents/:id — remove agent
- POST /api/leads/:id/assign — assign lead to agent (body: {agent_wa_number})

### Auto-assignment rules (round-robin):
In scheduler.js, add auto-assignment:
- New leads unassigned after 5 minutes → assign to next available agent (round-robin)
- Notification sent to assigned agent via WhatsApp

### Agent performance in analytics:
- Leads per agent chart (bar)
- Conversion rate per agent
- Average response time per agent
- HOT leads handled per agent

### Settings page — Agents tab:
- Add/remove agents
- View agent performance metrics
- Configure auto-assignment toggle

---

## PHASE 8B — WHITE-LABEL BRANDING

File: dashboard/pages/settings.html addition

Allow per-client branding of the dashboard.

### Branding settings:
- Company name (replaces "LeadPulse" in header)
- Logo URL (shown in sidebar)
- Primary color (hex picker — changes all accent colors via CSS variable)
- Secondary color
- Favicon URL

### Implementation:
Store in settings table with keys: brand_name, brand_logo, brand_color_primary, brand_color_secondary

In dashboard/index.html, on load:
- Fetch /api/settings
- Apply CSS variable: document.documentElement.style.setProperty('--blue', settings.brand_color_primary)
- Update sidebar logo text and image

---

## COMPLETE PACKAGE.JSON ADDITIONS

Add these to package.json dependencies:
```json
{
  "@anthropic-ai/sdk": "^0.20.0",
  "nodemailer": "^6.9.8",
  "puppeteer": "^21.0.0"
}
```

---

## COMPLETE .env.example AFTER ALL PHASES

```
# ── WhatsApp ──────────────────────────────────────
WHATSAPP_TOKEN=your_permanent_access_token
WHATSAPP_PHONE_ID=your_phone_number_id
VERIFY_TOKEN=your_verify_token
OWNER_WHATSAPP=971501234567

# ── Server ────────────────────────────────────────
PORT=3000
CLIENT_NAME=My Real Estate Agency
ACTIVE_FLOW=realEstate

# ── Business hours ────────────────────────────────
BUSINESS_HOURS_START=9
BUSINESS_HOURS_END=18
TIMEZONE=Asia/Dubai
BUSINESS_DAYS=1,2,3,4,5,6
FOLLOWUP_DELAY_HOURS=2

# ── AI (OpenAI for voice) ─────────────────────────
OPENAI_API_KEY=sk-your-openai-key
VOICE_ENABLED=true

# ── AI (Claude for free-text mode) ───────────────
ANTHROPIC_API_KEY=your-claude-api-key
AI_MODE_ENABLED=true
KNOWLEDGE_BASE=

# ── Email ─────────────────────────────────────────
SMTP_USER=
SMTP_PASS=
NOTIFICATION_EMAIL=
EMAIL_NOTIFICATIONS=false

# ── Zoho CRM ──────────────────────────────────────
ZOHO_CLIENT_ID=
ZOHO_CLIENT_SECRET=
ZOHO_REFRESH_TOKEN=
ZOHO_SYNC_ENABLED=false

# ── Zapier ────────────────────────────────────────
ZAPIER_WEBHOOK_URL=
```

---

## BUILD SEQUENCE FOR CLAUDE CODE

Implement in this exact order to avoid dependency issues:

1. Database migrations — add all new tables and columns safely
2. router.js and shared.js — dashboard routing infrastructure  
3. Conversations page — needs messages table
4. Opportunities/Kanban page — needs pipeline_stage column
5. Analytics page — pure read from existing data
6. Settings page — needs settings table
7. Lead detail page — needs lead_notes table
8. aiHandler.js — AI free-text mode
9. listingsMatcher.js + listings table
10. appointmentHandler.js + appointments table
11. Additional flows (restaurant, clinic, retail, salon, carDealer)
12. Zoho sync integration
13. Email notifier integration
14. Zapier webhook
15. Multi-agent management
16. White-label branding
17. Monthly report generator
18. Update server.js with all new routes
19. npm install new dependencies
20. Verify node server.js starts cleanly
21. Show complete file tree

---

## IMPORTANT NOTES

- All database changes use ALTER TABLE IF NOT EXISTS pattern — preserve existing data
- All new routes follow existing /api/ pattern
- Dashboard pages use hash routing (#conversations, #opportunities etc)
- All integrations are optional — only activate if env vars are set
- AI free-text mode falls back gracefully if ANTHROPIC_API_KEY is not set
- Puppeteer for PDF may need extra configuration on Windows — use html-pdf-node as fallback
- All new flows automatically loaded by multi-flow system in flowEngine.js
- Keep existing .env values — only ADD new ones, never remove

---

## AFTER COMPLETION

Run these verification commands in Claude Code:
1. node server.js — confirm clean start
2. List all API routes: check server.js exports
3. Confirm all flow files load: node -e "require('./flows/restaurant')"
4. Show complete file tree
5. List all new npm packages added
