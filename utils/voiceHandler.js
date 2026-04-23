const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');
const { OpenAI } = require('openai');

// Lazy-initialise so missing key doesn't crash at startup
let _openai = null;
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

/**
 * Download audio from a Twilio media URL using native https + Basic Auth.
 * Follows redirects automatically (Twilio media URLs often redirect).
 */
async function downloadAudioFromUrl(audioUrl) {
  const tempDir = path.join(process.cwd(), 'temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const tempFilePath = path.join(tempDir, `voice_twilio_${Date.now()}.ogg`);

  const authHeader = 'Basic ' + Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString('base64');

  await new Promise((resolve, reject) => {
    function download(url, redirects = 0) {
      if (redirects > 5) return reject(new Error('Too many redirects downloading Twilio audio'));

      const parsed   = new URL(url);
      const protocol = parsed.protocol === 'https:' ? https : http;

      const options = {
        hostname: parsed.hostname,
        path:     parsed.pathname + parsed.search,
        headers:  { Authorization: authHeader },
      };

      protocol.get(options, (res) => {
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return download(res.headers.location, redirects + 1);
        }

        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Twilio audio download failed: HTTP ${res.statusCode}`));
        }

        const file = fs.createWriteStream(tempFilePath);
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          const size = fs.statSync(tempFilePath).size;
          console.log(`[Voice] Saved ${size} bytes → ${tempFilePath}`);
          resolve();
        });
        file.on('error', (err) => { fs.unlink(tempFilePath, () => {}); reject(err); });
      }).on('error', (err) => { fs.unlink(tempFilePath, () => {}); reject(err); });
    }

    download(audioUrl);
  });

  return tempFilePath;
}

/**
 * Download audio file from Meta's servers.
 * Meta requires Authorization header to download media.
 */
async function downloadAudio(mediaId) {
  // Step 1: Get the media URL from Meta
  const fetch = require('node-fetch');
  const mediaUrl = `https://graph.facebook.com/v19.0/${mediaId}`;
  const urlResponse = await fetch(mediaUrl, {
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
  });

  if (!urlResponse.ok) {
    throw new Error(`Failed to get media URL: ${urlResponse.status}`);
  }

  const urlData     = await urlResponse.json();
  const downloadUrl = urlData.url;

  // Step 2: Download the actual audio file
  const tempDir = path.join(process.cwd(), 'temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const tempFilePath = path.join(tempDir, `voice_${mediaId}_${Date.now()}.ogg`);

  await new Promise((resolve, reject) => {
    const file     = fs.createWriteStream(tempFilePath);
    const protocol = downloadUrl.startsWith('https') ? https : http;
    const options  = new URL(downloadUrl);

    const reqOptions = {
      hostname: options.hostname,
      path:     options.pathname + options.search,
      headers:  { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
    };

    protocol.get(reqOptions, (response) => {
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', (err) => { fs.unlink(tempFilePath, () => {}); reject(err); });
    }).on('error', (err) => { fs.unlink(tempFilePath, () => {}); reject(err); });
  });

  return tempFilePath;
}

/**
 * Transcribe audio file using OpenAI Whisper.
 * Returns { transcript, language } — language is ISO 639-1 code.
 */
async function transcribeAudio(filePath) {
  const audioStream = fs.createReadStream(filePath);

  const transcription = await getOpenAI().audio.transcriptions.create({
    file:            audioStream,
    model:           'whisper-1',
    response_format: 'verbose_json',
    temperature:     0.2,
  });

  // Clean up temp file
  try { fs.unlinkSync(filePath); } catch (_) {}

  return {
    transcript: (transcription.text || '').trim(),
    language:   transcription.language || 'en',
  };
}

/**
 * Map Whisper language code to our app's language code ('ar' or 'en').
 */
function mapLanguage(whisperLang) {
  if (['ar', 'arabic'].includes((whisperLang || '').toLowerCase())) return 'ar';
  return 'en';
}

/**
 * Main entry: takes an audio object.
 *   Twilio format: { url, mime_type }
 *   Meta format:   { id, mime_type }
 * Returns { transcript, language, originalLanguage }
 */
async function processVoiceMessage(audioMessage) {
  let filePath;
  if (audioMessage.url) {
    console.log(`[Voice] Downloading from Twilio URL: ${audioMessage.url}`);
    filePath = await downloadAudioFromUrl(audioMessage.url);
  } else {
    console.log(`[Voice] Processing voice note, media ID: ${audioMessage.id}`);
    filePath = await downloadAudio(audioMessage.id);
  }
  console.log(`[Voice] Audio downloaded to: ${filePath}`);

  const { transcript, language } = await transcribeAudio(filePath);
  console.log(`[Voice] Transcribed (${language}): "${transcript}"`);

  return {
    transcript,
    language:         mapLanguage(language),
    originalLanguage: language,
  };
}

module.exports = { processVoiceMessage };
