# WhatsApp Real Estate Bot

A WhatsApp Cloud API chatbot for UAE real estate lead qualification, built with Node.js + Express + SQLite.

## Quick Start

```bash
cp .env.example .env
# Fill in your values (see below)
npm install
node server.js
```

Open `http://localhost:3000/dashboard` to see the leads dashboard.

## Environment Variables

| Variable           | Description                                          |
|--------------------|------------------------------------------------------|
| `WHATSAPP_TOKEN`   | Permanent System User token from Meta Business Suite |
| `WHATSAPP_PHONE_ID`| Phone Number ID from the Meta Developer App          |
| `VERIFY_TOKEN`     | Any random string — used to verify the webhook URL   |
| `OWNER_WHATSAPP`   | Your WhatsApp number in E.164 format (e.g. `971501234567`) |
| `PORT`             | HTTP port (default `3000`)                           |
| `ACTIVE_FLOW`      | Flow to run — currently `realEstate`                 |
| `CLIENT_NAME`      | Agency name shown in bot messages                    |

## Conversation Flow

```
START (Buy / Rent / Sell)
  └─> ASK_NAME (free text)
        └─> ASK_PROPERTY_TYPE (Apartment / Villa / Commercial)
              └─> ASK_BUDGET (5 ranges list picker)
                    └─> ASK_AREA (7 Dubai areas list picker)
                          └─> COMPLETE → save lead + notify owner
```

Type **menu** or **restart** at any point to restart the flow.

## API Routes

| Method | Path                      | Description               |
|--------|---------------------------|---------------------------|
| GET    | `/webhook`                | Meta webhook verification |
| POST   | `/webhook`                | Incoming messages         |
| GET    | `/dashboard`              | Leads dashboard (HTML)    |
| GET    | `/api/leads`              | All leads (JSON)          |
| GET    | `/api/stats`              | Lead counts by status     |
| POST   | `/api/leads/:id/status`   | Update a lead's status    |
| GET    | `/health`                 | Uptime check              |

## Deploy to Render.com

1. Push this repo to GitHub.
2. In Render, click **New → Web Service** and connect your repo.
3. Render auto-detects `render.yaml` — click **Apply**.
4. Add your secret env vars in the Render dashboard under **Environment**.
5. Copy your Render URL (e.g. `https://whatsapp-bot.onrender.com`) and set it as the webhook URL in Meta Developer App:
   - URL: `https://your-app.onrender.com/webhook`
   - Verify Token: value of `VERIFY_TOKEN`
   - Subscribe to: `messages`

## Project Structure

```
whatsapp-bot/
├── server.js               # Express app & all routes
├── flows/
│   ├── flowEngine.js       # Generic state machine
│   └── realEstate.js       # Lead qualification flow
├── db/
│   └── database.js         # SQLite schema & prepared statements
├── whatsapp/
│   └── api.js              # Meta Cloud API helpers
├── dashboard/
│   └── index.html          # Leads dashboard
├── data/                   # SQLite DB file (auto-created, gitignored)
├── .env.example
├── render.yaml
└── package.json
```

## Adding a New Flow

1. Create `flows/myFlow.js` exporting `{ FLOW_NAME, STEPS, onComplete, triggerKeywords }`.
2. The engine auto-loads all `.js` files in the `flows/` directory — no registration needed.
3. Set `ACTIVE_FLOW=myFlow` in your `.env` to make it the default fallback flow.

---

## Generating a Permanent Access Token

Short-lived tokens expire every 60 days. Use a **System User token** for production.

### Steps

1. Go to [Meta Business Suite](https://business.facebook.com) → **Settings** → **Users** → **System Users**.
2. Click **Add** → give the system user a name (e.g. `whatsapp-bot`) → Role: **Admin**.
3. Click **Generate New Token** next to your system user.
4. Select your **App** (the one connected to your WhatsApp Business Account).
5. Under **Permissions**, enable:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
6. Click **Generate Token** — copy it immediately (shown only once).
7. Assign the system user to your WhatsApp Business Account:
   - In **Business Settings** → **Accounts** → **WhatsApp Accounts** → select your account → **Add People** → add the system user with **Full Control**.
8. Paste the token as `WHATSAPP_TOKEN` in your `.env`.

System User tokens **never expire** as long as the system user remains active.

### Verify Your Token

```
GET /api/token-check
```

Returns `{ "valid": true, "expires": "never (System User token)" }` if the token is working.

---

## V2 Features

| Feature | Description |
|---------|-------------|
| Human Handoff | Owner sends `TAKE <number>` / `DONE <number>` to go live with a customer |
| Business Hours | Auto out-of-hours reply; flow still captures the lead |
| CSV Export | `GET /api/leads/export?status=all` — downloads a CSV |
| Follow-up | Automatic WhatsApp reminder 2h after new lead if not contacted |
| Lead Scoring | 1–10 score based on intent, budget, area, property type |
| Arabic Support | Auto-detected; entire flow switches to Arabic |
| Broadcast | `POST /api/broadcast` — bulk message with filters + rate limiting |
| Enhanced Dashboard | Score badges, filter tabs, search, export buttons, broadcast panel |
| Token Check | `GET /api/token-check` verifies token validity |
| Multi-flow | Drop any `.js` flow into `flows/` — auto-loaded with keyword routing |
