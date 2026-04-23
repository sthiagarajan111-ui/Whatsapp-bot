# WhatsApp Bot V3 — Voice Note Transcription
## Add voice input (speech-to-text) to existing bot
## Run this in Claude Code inside C:\projects\whatsapp-bot

---

## CONTEXT

The bot already has all V2 features working. This adds ONE new capability:
- Customer sends a WhatsApp voice note (in any language including Arabic)
- Bot transcribes it using OpenAI Whisper API
- Bot detects the language from the transcription
- Bot processes the transcribed text through the normal flow engine
- Bot replies in text (in the detected language — Arabic or English)

DO NOT rewrite existing files from scratch.
Make targeted additions only.
Preserve all existing working functionality.

---

## NEW DEPENDENCY

Add to package.json dependencies:
```
"openai": "^4.28.0"
```

Run npm install after adding.

---

## NEW FILE — utils/voiceHandler.js

```javascript
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { OpenAI } = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Download audio file from Meta's servers
 * Meta requires Authorization header to download media
 */
async function downloadAudio(mediaId) {
  // Step 1: Get the media URL from Meta
  const mediaUrl = `https://graph.facebook.com/v19.0/${mediaId}`;
  const urlResponse = await fetch(mediaUrl, {
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
  });
  
  if (!urlResponse.ok) {
    throw new Error(`Failed to get media URL: ${urlResponse.status}`);
  }
  
  const urlData = await urlResponse.json();
  const downloadUrl = urlData.url;

  // Step 2: Download the actual audio file
  const tempDir = path.join(process.cwd(), 'temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  
  const tempFilePath = path.join(tempDir, `voice_${mediaId}_${Date.now()}.ogg`);
  
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(tempFilePath);
    const protocol = downloadUrl.startsWith('https') ? https : http;
    
    const options = new URL(downloadUrl);
    const reqOptions = {
      hostname: options.hostname,
      path: options.pathname + options.search,
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
    };
    
    protocol.get(reqOptions, (response) => {
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', reject);
    }).on('error', reject);
  });

  return tempFilePath;
}

/**
 * Transcribe audio file using OpenAI Whisper
 * Returns { transcript, language }
 * language is ISO code: 'ar', 'en', 'hi', 'ur' etc.
 */
async function transcribeAudio(filePath) {
  const audioStream = fs.createReadStream(filePath);
  
  const transcription = await openai.audio.transcriptions.create({
    file: audioStream,
    model: 'whisper-1',
    response_format: 'verbose_json', // gives us language detection
    temperature: 0.2
  });

  // Clean up temp file after transcription
  try { fs.unlinkSync(filePath); } catch (e) { /* ignore cleanup errors */ }

  return {
    transcript: transcription.text.trim(),
    language: transcription.language || 'en' // ISO 639-1 code
  };
}

/**
 * Map Whisper language code to our app's language code
 * Whisper returns full ISO codes, we use 'ar' or 'en'
 */
function mapLanguage(whisperLang) {
  const arabicCodes = ['ar', 'arabic'];
  if (arabicCodes.includes(whisperLang.toLowerCase())) return 'ar';
  return 'en'; // default to English for all other languages
}

/**
 * Main function: takes a WhatsApp audio message object
 * Returns { transcript, language, originalLanguage }
 */
async function processVoiceMessage(audioMessage) {
  const mediaId = audioMessage.id;
  
  console.log(`[Voice] Processing voice note, media ID: ${mediaId}`);
  
  // Download the audio file from Meta
  const filePath = await downloadAudio(mediaId);
  console.log(`[Voice] Audio downloaded to: ${filePath}`);
  
  // Transcribe with Whisper
  const { transcript, language } = await transcribeAudio(filePath);
  console.log(`[Voice] Transcribed (${language}): "${transcript}"`);
  
  return {
    transcript,
    language: mapLanguage(language),
    originalLanguage: language
  };
}

module.exports = { processVoiceMessage };
```

---

## MODIFY — server.js

In the POST /webhook route, inside the message processing loop,
add voice note handling BEFORE the existing processMessage call.

Find the section where message type is checked and add:

```javascript
// Handle voice notes
if (message.type === 'audio') {
  // Check if OpenAI key is configured
  if (!process.env.OPENAI_API_KEY) {
    await sendText(waNumber, 
      process.env.DEFAULT_LANGUAGE === 'ar'
        ? 'عذراً، خدمة الرسائل الصوتية غير متاحة حالياً. يرجى كتابة رسالتك.'
        : 'Sorry, voice messages are not supported yet. Please type your message.'
    );
    return;
  }

  try {
    // Send acknowledgement immediately while processing
    await sendText(waNumber,
      '🎙️ Processing your voice message...'
    );

    const { transcript, language } = await processVoiceMessage(message.audio);
    
    if (!transcript || transcript.length < 2) {
      await sendText(waNumber,
        language === 'ar'
          ? 'لم أتمكن من فهم الرسالة الصوتية. يرجى المحاولة مرة أخرى أو كتابة رسالتك.'
          : 'Could not understand the voice message. Please try again or type your message.'
      );
      return;
    }

    // Log the transcription for dashboard visibility
    console.log(`[Voice] ${waNumber} said: "${transcript}" (${language})`);

    // Create a synthetic text message object that the flow engine can process
    // This makes voice notes go through the exact same flow as typed messages
    const syntheticMessage = {
      type: 'text',
      text: { body: transcript },
      _fromVoice: true,
      _detectedLanguage: language
    };

    // Process through normal flow engine
    await processMessage(waNumber, syntheticMessage, activeFlows);

  } catch (err) {
    console.error('[Voice] Error processing voice note:', err.message);
    await sendText(waNumber,
      'Sorry, there was an error processing your voice message. Please type your message instead.'
    );
  }
  return; // Don't fall through to normal message processing
}
```

Also add this import at the top of server.js:
```javascript
const { processVoiceMessage } = require('./utils/voiceHandler');
```

---

## MODIFY — flows/flowEngine.js

When a voice message is processed, the session language should be
set from the detected audio language, not text detection.

In the processMessage function, find where language detection happens
(at the START step for new sessions) and add:

```javascript
// If this came from a voice note with detected language, use that
if (message._fromVoice && message._detectedLanguage) {
  sessionLanguage = message._detectedLanguage;
} else {
  // Existing text-based language detection
  sessionLanguage = detectLanguage(incomingText);
}
```

Also, when the bot sends a "transcription acknowledgement" in Arabic,
if the session is already in Arabic, send confirmation in Arabic:

After the voice is processed and before the flow responds,
if language is 'ar', the synthetic message body is Arabic text
which will naturally trigger Arabic responses through the existing flow.

---

## NEW .env VARIABLES

Add to .env.example:

```
# OpenAI API (for voice transcription)
# Get your key at: platform.openai.com/api-keys
# Cost: ~USD 0.006 per minute of audio (30-second voice note = USD 0.003)
OPENAI_API_KEY=sk-your-openai-api-key-here

# Voice feature toggle (set to false to disable voice without removing code)
VOICE_ENABLED=true
```

---

## NEW FOLDER

Create temp/ folder in project root for temporary audio files:
- Add temp/ to .gitignore so audio files never get committed to GitHub
- The voiceHandler.js creates this folder automatically if it doesn't exist
- Files are deleted immediately after transcription

Add to .gitignore:
```
node_modules/
data/
temp/
.env
```

---

## MODIFY — dashboard/index.html

Add a small indicator in the leads table showing if a lead came in via voice.

In the leads table, add a "Source" column after the Date column:
- If lead data contains `_fromVoice: true` → show 🎙️ Voice badge
- Otherwise → show 💬 Text badge

Also add to the stats row:
- Voice Leads count (leads where source = voice)

To track this, when saving a lead from a voice message,
add `source: 'voice'` to the JSON data field.

In server.js, when processVoiceMessage succeeds, attach source info:
The synthetic message already has `_fromVoice: true` which flowEngine
can pass to saveLead as part of the data object.

In flowEngine.js at COMPLETE step, add to collectedData:
```javascript
if (message._fromVoice) {
  collectedData.source = 'voice';
  collectedData.originalTranscript = message.text.body;
}
```

---

## DASHBOARD — Show Transcription

When a lead came via voice, show what they actually said in the dashboard.

In the leads table, make the Name cell show a tooltip or expandable row:
- If source = 'voice', show a small info icon next to the name
- Hovering shows: "Original voice transcript: [transcript text]"

This helps agents understand exactly what the customer said,
even after it was processed through the flow.

---

## ERROR HANDLING — Important Edge Cases

Handle these in voiceHandler.js and server.js:

1. **Audio too short** (under 1 second) — Whisper returns empty or noise
   → Send: "Your voice message was too short. Please try again."

2. **Audio too long** (over 3 minutes) — Whisper has 25MB file limit
   → Send: "Voice messages over 3 minutes cannot be processed. Please type your message."

3. **Background noise only** — Whisper returns empty string
   → Send: "Could not understand. Please speak clearly or type your message."

4. **Network error downloading audio** — Meta URL expired (they expire after ~5 minutes)
   → Send: "Voice message expired. Please send it again."

5. **OpenAI API error** — Rate limit or service down
   → Send: "Voice processing temporarily unavailable. Please type your message."
   → Log error with full details for debugging

6. **Unsupported language** — Whisper transcribes but language is neither Arabic nor English
   → Process the transcription anyway in English mode
   → Log the detected language for monitoring

---

## TESTING THE VOICE FEATURE

After implementation, test these scenarios:

**Test 1 — English voice note**
Send: "I want to buy a villa in Palm Jumeirah with a budget of 3 million"
Expected: Bot asks for name in English, lead scored HOT

**Test 2 — Arabic voice note**
Send an Arabic voice note: "أريد شراء شقة في دبي مارينا"
Expected: Bot detects Arabic, entire conversation switches to Arabic

**Test 3 — Short unclear audio**
Send 1 second of silence
Expected: Bot asks user to try again or type their message

**Test 4 — Mixed language**
Send voice note mixing Arabic and English (common in UAE)
Expected: Whisper handles this — transcribes correctly, bot uses dominant language

---

## COMPLETE UPDATED FILE TREE AFTER THIS FEATURE

```
whatsapp-bot/
├── server.js                    (modified — voice handling in webhook)
├── flows/
│   ├── flowEngine.js            (modified — voice language detection)
│   └── realEstate.js            (unchanged)
├── db/
│   └── database.js              (unchanged)
├── whatsapp/
│   └── api.js                   (unchanged)
├── utils/
│   ├── voiceHandler.js          (NEW — download + transcribe)
│   ├── timeUtils.js             (unchanged)
│   ├── langDetect.js            (unchanged)
│   ├── scorer.js                (unchanged)
│   └── scheduler.js             (unchanged)
├── temp/                        (NEW — auto-created, gitignored)
├── dashboard/
│   └── index.html               (modified — voice source indicator)
├── .env.example                 (modified — OPENAI_API_KEY added)
├── .gitignore                   (modified — temp/ added)
├── package.json                 (modified — openai package added)
├── render.yaml                  (unchanged)
└── README.md                    (modified — voice feature section)
```

---

## COST ESTIMATE FOR CLIENTS

At typical real estate agency volumes:
- Average voice note length: 15–30 seconds
- Cost per voice note: USD 0.001–0.003 (less than 1 fil)
- 100 voice notes per month: USD 0.10–0.30 (under AED 1.20)
- 1,000 voice notes per month: USD 1–3 (under AED 12)

This cost is negligible. Include it in the monthly retainer — do not charge separately.

---

## AFTER IMPLEMENTATION — INSTRUCTIONS FOR CLAUDE CODE

1. Install new dependency: npm install openai
2. Create utils/voiceHandler.js with complete code
3. Modify server.js — add voice handling in webhook route
4. Modify flows/flowEngine.js — add voice language override
5. Modify dashboard/index.html — add Source column and voice badge
6. Update .env.example with OPENAI_API_KEY and VOICE_ENABLED
7. Create/update .gitignore with temp/ folder
8. Run node server.js — confirm server starts cleanly
9. Show complete file tree
10. Tell me exactly what OPENAI_API_KEY I need and where to get it
