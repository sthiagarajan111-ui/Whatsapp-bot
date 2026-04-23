/**
 * Language detection — returns 'ar' if text contains Arabic characters, else 'en'.
 */
function detectLanguage(text) {
  if (!text) return 'en';
  return /[\u0600-\u06FF]/.test(text) ? 'ar' : 'en';
}

module.exports = { detectLanguage };
