/**
 * AI free-text mode using Claude API (Anthropic SDK).
 * Activated after the structured flow completes (session.ai_mode = 1).
 * Falls back gracefully if ANTHROPIC_API_KEY is not set.
 */

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch (_) { Anthropic = null; }

async function getAIResponse(waNumber, userMessage, leadData, conversationHistory, language) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY || process.env.AI_MODE_ENABLED === 'false') {
    return null; // AI mode not available — caller should fall back to default
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const systemPrompt = buildSystemPrompt(leadData, language);

  // Use last 10 messages for context
  const messages = (conversationHistory || []).slice(-10);

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system: systemPrompt,
    messages,
  });

  return response.content[0]?.text || null;
}

function buildSystemPrompt(leadData, language) {
  const lang = language === 'ar' ? 'Arabic' : 'English';
  const d = leadData || {};
  const agency = process.env.CLIENT_NAME || 'Our Agency';
  const kb = process.env.KNOWLEDGE_BASE || (d.knowledge_base || '');

  return `You are a helpful real estate assistant for ${agency}.

Customer profile:
- Name: ${d.name || 'Customer'}
- Interest: ${d.intent || 'unknown'} a ${d.propertyType || 'property'}
- Budget: ${d.budget || 'unknown'}
- Preferred area: ${d.area || 'open'}
- Score: ${d.score || '?'}/10

Instructions:
- Always respond in ${lang}
- Keep responses under 150 words
- Be helpful and professional
- Answer property questions based on Dubai real estate knowledge
- Encourage booking a viewing if appropriate
- Never make up specific property listings unless provided
- If asked about specific properties, say "Our agent will send you options shortly"
- End responses with a helpful question or call-to-action
- If the user types "menu" or "restart", tell them it will reset the conversation${kb ? `\n\nKnowledge base:\n${kb}` : ''}`;
}

module.exports = { getAIResponse };
