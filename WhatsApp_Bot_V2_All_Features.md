# WhatsApp Bot V2 — Complete Feature Enhancement
## Add all advanced features to existing bot
## Run this in Claude Code inside C:\projects\whatsapp-bot

---

## CONTEXT

The base bot is already built with these files:
- server.js, flows/flowEngine.js, flows/realEstate.js
- db/database.js, whatsapp/api.js, dashboard/index.html
- .env.example, package.json, render.yaml, README.md

DO NOT rewrite existing files from scratch.
Make targeted additions and modifications only.
Preserve all existing working functionality.

---

## FEATURES TO ADD

---

### FEATURE 1 — Human Handoff Mode

**How it works:**
- After bot completes lead qualification (COMPLETE step), session status becomes "awaiting_agent"
- Owner receives lead notification WITH a TAKE command hint at the bottom
- Owner sends "TAKE 971501234567" (the lead's WhatsApp number) to the bot number
- Bot switches that lead's conversation to "human_mode"
- Everything the owner types gets forwarded to the customer as a normal WhatsApp message
- Everything the customer replies gets forwarded to the owner
- Owner sends "DONE 971501234567" to end human mode
- Customer receives: "Thank you for chatting with us! Have a great day."
- Lead status on dashboard updates to "contacted" automatically

**Database changes needed:**
- Add column `human_mode` (INTEGER DEFAULT 0) to sessions table
- Add column `agent_number` (TEXT) to sessions table — stores which agent took over
- Handle migration: use ALTER TABLE IF NOT EXISTS pattern

**server.js changes:**
- In POST /webhook, before calling processMessage, check if incoming message is FROM OWNER_WHATSAPP
- If from owner and message starts with "TAKE ": extract number, activate human mode for that session, confirm to owner "You are now live with [name]. Type your message. Send DONE [number] to end."
- If from owner and message starts with "DONE ": deactivate human mode, send goodbye to customer, update lead status to contacted, confirm to owner "Conversation ended."
- If from owner and no TAKE/DONE prefix and there is an active human mode session they own: forward their message to the customer
- If message is FROM a customer who is in human_mode: forward to OWNER_WHATSAPP with prefix "[CustomerName]: " so owner knows who is replying

**Owner notification message update:**
Add at the bottom of the lead notification:
"To take this conversation live, reply: TAKE [wa_number]"

**Dashboard changes:**
- Add a "LIVE" badge (red pulsing dot) next to leads that are currently in human_mode
- Show agent column if human mode was used

---

### FEATURE 2 — Working Hours Auto-Reply

**How it works:**
- Configurable business hours in .env: BUSINESS_HOURS_START=9 and BUSINESS_HOURS_END=18 and TIMEZONE=Asia/Dubai
- If message arrives outside business hours, bot sends auto-reply BEFORE starting the flow:
  "Thank you for reaching out to [CLIENT_NAME]! 🌙 Our team is available 9am–6pm UAE time (Mon–Sat). We have noted your enquiry and will contact you first thing tomorrow morning. Feel free to leave your name and what you are looking for — we will get back to you!"
- Bot STILL runs the qualification flow even outside hours — captures the lead
- Just prepends the out-of-hours message before the first question
- Add to .env.example: BUSINESS_HOURS_START=9, BUSINESS_HOURS_END=18, TIMEZONE=Asia/Dubai, BUSINESS_DAYS=1,2,3,4,5,6 (1=Monday, 6=Saturday)

**Implementation:**
- Create utils/timeUtils.js with isBusinessHours() function
- Uses process.env values, calculates current time in Asia/Dubai timezone
- Returns true/false
- In flowEngine.js, at START step only: if !isBusinessHours(), send the out-of-hours message first, then continue with START step normally

---

### FEATURE 3 — Lead Export to Excel/CSV

**How it works:**
- Button on dashboard: "Export All Leads" → downloads leads.csv
- Button: "Export New Leads" → downloads only leads with status='new'
- CSV columns: Date, Name, WhatsApp, Interest, Property Type, Budget, Area, Status, Score

**Server changes:**
- Add route: GET /api/leads/export?status=all (or new/contacted/converted)
- Returns CSV file with proper headers: Content-Type: text/csv, Content-Disposition: attachment; filename="leads-[date].csv"
- Parse the JSON data field to extract individual columns

**Dashboard changes:**
- Add two export buttons above the leads table
- "Export All" and "Export New Leads" buttons
- Both trigger file download via window.location href

---

### FEATURE 4 — Auto Follow-Up Reminder System

**How it works:**
- 2 hours after a lead is captured, if status is still "new", automatically send customer a WhatsApp follow-up
- Message: "Hi [name]! 👋 This is [CLIENT_NAME] following up on your property enquiry. Our agent will be reaching out to you shortly. In the meantime, is there anything specific you would like to know about properties in [area]?"
- Also send owner a reminder: "⏰ FOLLOW-UP REMINDER: [name] enquired 2 hours ago and has not been contacted yet. Number: [wa_number]"
- Only send once per lead — track with a `followup_sent` column

**Database changes:**
- Add column `followup_sent` (INTEGER DEFAULT 0) to leads table
- Add column `score` (INTEGER DEFAULT 0) to leads table (for feature 5)

**Implementation:**
- Create utils/scheduler.js
- On server startup, run setInterval every 5 minutes
- Query leads where status='new' AND followup_sent=0 AND created_at is older than 2 hours
- For each such lead: send follow-up WhatsApp to customer, send reminder to owner, set followup_sent=1
- Add FOLLOWUP_DELAY_HOURS=2 to .env.example

---

### FEATURE 5 — Lead Scoring System

**How it works:**
Automatically score each lead 1–10 when they complete the flow.

Scoring rules:
- Interest = "buy" → +3 points
- Interest = "rent" → +1 point  
- Interest = "sell" → +2 points
- Budget = "above_5m" → +4 points
- Budget = "2m_5m" → +3 points
- Budget = "1m_2m" → +2 points
- Budget = "500k_1m" → +1 point
- Area = "palm" → +2 points
- Area = "downtown" or "marina" → +1 point
- Property type = "villa" → +1 point

Maximum 10 points. Minimum 1 point.

**Implementation:**
- Create utils/scorer.js with calculateScore(collectedData) function
- In flowEngine.js at COMPLETE step, calculate score before saving lead
- Pass score to saveLead() function
- Store in leads.score column

**Dashboard changes:**
- Add Score column to leads table
- Show score as coloured badge: 8-10 = green "HOT", 5-7 = amber "WARM", 1-4 = gray "COLD"
- Sort leads by score descending by default (hottest leads at top)
- Add filter buttons: All / HOT / WARM / COLD

---

### FEATURE 6 — Arabic Language Support

**How it works:**
- Bot detects if user's first message contains Arabic characters
- Switches entire conversation to Arabic for that session
- All subsequent messages from bot are in Arabic
- Store language preference in session: `language` field (default 'en')

**Implementation:**
- Create utils/langDetect.js with detectLanguage(text) function
- Simple check: if text contains Arabic Unicode range (\u0600-\u06FF), return 'ar', else 'en'
- In flowEngine.js at START step: detect language from incoming message, save to session
- In realEstate.js, add Arabic versions of all messages as `message_ar` alongside `message`
- In flowEngine.js when sending messages: if session.language === 'ar' and step.message_ar exists, use Arabic version

**Arabic messages for realEstate.js:**
Add these Arabic versions to each step:

START message_ar: "مرحباً! أهلاً بكم في [CLIENT_NAME]. أنا هنا لمساعدتك في إيجاد عقارك المثالي.\n\nماذا تبحث عن اليوم؟"
START options_ar: [{id:"buy",title:"شراء عقار"},{id:"rent",title:"استئجار عقار"},{id:"sell",title:"بيع عقاري"}]

ASK_NAME message_ar: "ممتاز! للمساعدة بشكل أفضل، هل يمكنك إخباري باسمك الكريم؟"

ASK_PROPERTY_TYPE message_ar: "شكراً، {name}! ما نوع العقار الذي تهتم به؟"
ASK_PROPERTY_TYPE options_ar: [{id:"apartment",title:"شقة"},{id:"villa",title:"فيلا / تاون هاوس"},{id:"commercial",title:"تجاري"}]

ASK_BUDGET message_ar: "ما هو نطاق ميزانيتك؟"
ASK_BUDGET buttonText_ar: "اختر الميزانية"
Budget rows_ar: Under 500K="أقل من 500,000 درهم", 500K-1M="500 ألف - مليون درهم", 1M-2M="مليون - مليونين", 2M-5M="2 - 5 مليون", Above 5M="أكثر من 5 ملايين"

ASK_AREA message_ar: "ما هي المناطق التي تفكر فيها؟"
ASK_AREA buttonText_ar: "اختر المنطقة"
Area rows_ar: downtown="وسط مدينة دبي", marina="مرسى دبي / JBR", jvc="JVC / JVT", business_bay="الخليج التجاري", palm="نخلة الجميرا", mirdif="مردف / الراشدية", open="مفتوح للاقتراحات"

completionMessage_ar: "شكراً جزيلاً! سيتواصل معك أحد وكلائنا خلال ساعتين. نتمنى لك يوماً سعيداً!"

ownerNotification: add "(AR)" prefix to notification when lead came in Arabic so agent knows to reply in Arabic

---

### FEATURE 7 — Broadcast Messaging

**How it works:**
- New dashboard section: "Send Broadcast"
- Form fields: Message text, Filter (All leads / HOT only / By area / By interest)
- Preview shows count: "This will send to 23 leads"
- Send button triggers POST /api/broadcast
- Server sends WhatsApp message to all matching leads
- Rate limited: max 10 messages per second to avoid Meta limits
- Shows success count in dashboard

**Server changes:**
- Add POST /api/broadcast route
- Body: { message, filter: { status, score_min, area, interest } }
- Query leads matching filter
- Send messages with 100ms delay between each (rate limiting)
- Return { sent: 23, failed: 1 }

**Dashboard changes:**
- Add "Broadcast" section below stats row
- Textarea for message
- Dropdown filters: All / New only / Hot leads / By area (dropdown of areas)
- "Preview recipients" button — shows count without sending
- "Send Broadcast" button with confirmation dialog: "Send to 23 leads? This cannot be undone."
- Shows last broadcast result

---

### FEATURE 8 — Enhanced Dashboard

Upgrade the existing dashboard/index.html with all new features integrated:

**New stats row:**
- Total Leads | New | Contacted | Converted | HOT Leads | Avg Score

**Lead table enhancements:**
- Score column with HOT/WARM/COLD badge
- Language column (EN/AR flag indicator)
- Human Mode indicator (LIVE badge in red for active sessions)
- Filter tabs above table: All | HOT | New | Contacted | Converted
- Search box to filter by name or WhatsApp number
- Sort by: Date (default) / Score / Status

**Broadcast section:**
- Collapsible panel below stats
- Full broadcast form as described in Feature 7

**Export buttons:**
- "Export All" and "Export New" buttons above the table

**Auto-refresh:**
- Keep existing 30-second auto-refresh
- Add visual indicator showing "Last refreshed: [time]" (already exists — keep it)

---

### FEATURE 9 — Permanent Token Helper (Utility)

Add a note and helper route for generating permanent tokens.

**Add to README.md a new section:**
"Generating a Permanent Access Token"
- Steps to create a System User in Meta Business Manager
- How to generate a never-expiring token
- Which permissions to select: whatsapp_business_messaging, whatsapp_business_management

**Add GET /api/token-check route:**
- Makes a test call to WhatsApp API to verify token is valid
- Returns { valid: true, expires: "never" or date } 
- Dashboard shows token status indicator (green = valid, red = expired)

---

### FEATURE 10 — Multi-flow Support

Update server.js and flow loading to support multiple flows simultaneously.

**How it works:**
- Instead of loading ONE flow from ACTIVE_FLOW env var
- Load ALL flow files from the flows/ directory automatically
- Each flow has a `triggerKeywords` array in its config
- When a new conversation starts, bot checks if first message matches any flow's trigger keywords
- If match found, use that flow. If no match, use default flow (realEstate or whatever ACTIVE_FLOW is set to)

**realEstate.js additions:**
```
triggerKeywords: ['property', 'real estate', 'apartment', 'villa', 'buy', 'rent', 'sell', 'عقار', 'شقة', 'فيلا']
```

**flowEngine.js changes:**
- Accept flows object (all loaded flows) instead of single flow
- At START step for new sessions: check triggerKeywords of each flow against incoming message
- Select matching flow, save flow name to session
- Fall back to default flow if no keyword match

**server.js changes:**
- Load all .js files from flows/ directory except flowEngine.js
- Pass flows object to processMessage

---

## UPDATED .env.example

After all features, the complete .env.example should be:

```
# Meta WhatsApp Cloud API
WHATSAPP_TOKEN=your_permanent_access_token_here
WHATSAPP_PHONE_ID=your_phone_number_id_here
VERIFY_TOKEN=any_random_string_you_choose

# Notifications
OWNER_WHATSAPP=971501234567

# Server
PORT=3000

# Flow config
ACTIVE_FLOW=realEstate
CLIENT_NAME=My Real Estate Agency

# Business hours (24hr format, UAE timezone)
BUSINESS_HOURS_START=9
BUSINESS_HOURS_END=18
TIMEZONE=Asia/Dubai
BUSINESS_DAYS=1,2,3,4,5,6

# Follow-up timing
FOLLOWUP_DELAY_HOURS=2
```

---

## UPDATED PACKAGE.JSON

No new npm packages needed for most features.
All utilities use built-in Node.js modules.
The only possible addition: if Arabic timezone handling needs it, check if Intl is sufficient (it is in Node 20+).

---

## FINAL FILE TREE AFTER ALL FEATURES

```
whatsapp-bot/
├── server.js                    (modified)
├── flows/
│   ├── flowEngine.js            (modified)
│   └── realEstate.js            (modified — Arabic + triggerKeywords)
├── db/
│   └── database.js              (modified — new columns)
├── whatsapp/
│   └── api.js                   (unchanged)
├── utils/
│   ├── timeUtils.js             (NEW)
│   ├── langDetect.js            (NEW)
│   ├── scorer.js                (NEW)
│   └── scheduler.js             (NEW)
├── dashboard/
│   └── index.html               (modified — all new features)
├── .env.example                 (modified)
├── package.json                 (unchanged)
├── render.yaml                  (unchanged)
└── README.md                    (modified — permanent token section)
```

---

## IMPLEMENTATION INSTRUCTIONS FOR CLAUDE CODE

1. Start with database.js — add all new columns safely using ALTER TABLE IF NOT EXISTS pattern so existing data is preserved

2. Create all 4 utils files next — these are standalone with no dependencies

3. Update flowEngine.js — add language detection, scoring at COMPLETE, multi-flow support

4. Update realEstate.js — add Arabic messages, triggerKeywords

5. Update server.js — add human handoff logic, broadcast route, export route, token check route, scheduler startup, multi-flow loading

6. Update dashboard/index.html — add all new UI features, keep existing working code

7. After all changes: run node server.js and confirm server starts without errors

8. Show complete updated file tree

9. List any issues or edge cases to be aware of

---

## IMPORTANT NOTES

- All database changes must use ALTER TABLE ... ADD COLUMN IF NOT EXISTS pattern
- Do not drop or recreate existing tables — leads data must be preserved
- Human handoff: be careful about infinite loops — messages from OWNER_WHATSAPP that are NOT commands should only be forwarded if there is an active human mode session
- Broadcast: add a 100ms setTimeout between each send to avoid hitting Meta rate limits
- Arabic: WhatsApp renders Arabic right-to-left automatically — no special formatting needed
- Scheduler: use setInterval, not cron — keeps it simple and dependency-free
- Lead scoring: cap at 10, minimum 1 — never store 0 or negative
- Export: parse the JSON data column carefully — use try/catch around JSON.parse
