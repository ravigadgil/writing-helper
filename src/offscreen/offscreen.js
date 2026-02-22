/**
 * Minimal offscreen document for "Improve with AI" feature.
 *
 * The Prompt API (LanguageModel) requires a DOM context — it doesn't work
 * in service workers. This offscreen document provides that context.
 */

let _promptApiAvailable = null;

async function checkPromptApi() {
  if (_promptApiAvailable !== null) return _promptApiAvailable;

  if (typeof LanguageModel === 'undefined') {
    console.log('[Writing Helper AI] LanguageModel not available in this environment');
    _promptApiAvailable = false;
    return false;
  }

  try {
    const avail = await LanguageModel.availability();
    _promptApiAvailable = (avail === 'available' || avail === 'downloadable' || avail === 'downloading');
    console.log('[Writing Helper AI] Prompt API availability:', avail);
  } catch (e) {
    console.log('[Writing Helper AI] Prompt API check failed:', e.message);
    _promptApiAvailable = false;
  }

  return _promptApiAvailable;
}

async function handleImprove(text) {
  const available = await checkPromptApi();
  if (!available) return { available: false, improved: null };

  try {
    const session = await LanguageModel.create({
      expectedOutputLanguages: ['en'],
      initialPrompts: [{
        role: 'system',
        content: `You are a proofreading and writing improvement assistant.

Your task: Fix ALL errors in the user's text and improve its clarity.

Rules:
- Fix every spelling mistake (e.g. "teh" → "the", "umbrellaumbrelaa" → "umbrella", "recieve" → "receive")
- Fix all grammar errors (e.g. "we need the fix" → "we need to fix", "I seen him" → "I saw him", "him and me went" → "he and I went")
- Fix punctuation and capitalization
- Remove repeated/duplicated words (e.g. "the the" → "the")
- Improve sentence clarity if awkward, but keep the meaning and tone
- Do NOT add new information or change the intent
- Return ONLY the corrected text — no explanations, no quotes, no commentary
- If the text is already correct, return it unchanged`,
      }],
    });

    const improved = await session.prompt(`Fix all errors and improve this text:\n${text}`);
    session.destroy();

    if (improved && improved.trim()) {
      let cleaned = improved.trim();
      // Strip quotes the model might wrap around the result
      if ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
          (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
        cleaned = cleaned.slice(1, -1);
      }
      return { available: true, improved: cleaned };
    }
  } catch (e) {
    console.error('[Writing Helper AI] Improve failed:', e);
  }

  return { available: false, improved: null };
}

/**
 * Rephrase text in a specific tone: friendly, professional, or casual.
 */
async function handleRephrase(text, tone) {
  const available = await checkPromptApi();
  if (!available) return { available: false, rephrased: null };

  const tonePrompts = {
    friendly: `You are a writing assistant. Make the user's text slightly warmer and friendlier.

Rules:
- Keep the SAME sentence structure and words as much as possible
- Only make small adjustments to sound a bit warmer (e.g. add "please", soften phrasing slightly)
- Do NOT rewrite the whole sentence — just tweak the tone
- Do NOT add emojis, exclamation marks, or filler phrases like "Oh dear" or "Let's remember"
- Fix any spelling or grammar errors along the way
- Keep it the same length — don't make it longer
- Return ONLY the adjusted text — no explanations, no quotes, no commentary`,

    professional: `You are a writing assistant. Make the user's text slightly more professional.

Rules:
- Keep the SAME sentence structure and words as much as possible
- Only make small adjustments to sound more polished (e.g. "bad" → "defective", "fix" → "repair")
- Do NOT rewrite the whole sentence or change its meaning
- Do NOT remove sentences or add new ones
- Fix any spelling or grammar errors along the way
- Keep it the same length — don't make it shorter or longer
- Return ONLY the adjusted text — no explanations, no quotes, no commentary`,

    casual: `You are a writing assistant. Make the user's text slightly more casual and natural.

Rules:
- Keep the SAME sentence structure and words as much as possible
- Only make small adjustments to sound more natural (e.g. "monitor" → "keep an eye on")
- Do NOT rewrite the whole sentence or change its meaning
- Do NOT add filler like "hey", "right?", "okay?" or make it sound like a chat
- Fix any spelling or grammar errors along the way
- Keep it the same length — don't make it longer
- Return ONLY the adjusted text — no explanations, no quotes, no commentary`,
  };

  const systemPrompt = tonePrompts[tone];
  if (!systemPrompt) return { available: false, rephrased: null };

  try {
    const session = await LanguageModel.create({
      expectedOutputLanguages: ['en'],
      initialPrompts: [{ role: 'system', content: systemPrompt }],
    });

    const rephrased = await session.prompt(`Rephrase this text:\n${text}`);
    session.destroy();

    if (rephrased && rephrased.trim()) {
      let cleaned = rephrased.trim();
      if ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
          (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
        cleaned = cleaned.slice(1, -1);
      }
      return { available: true, rephrased: cleaned };
    }
  } catch (e) {
    console.error('[Writing Helper AI] Rephrase failed:', e);
  }

  return { available: false, rephrased: null };
}

// Message router — only handle messages targeted at offscreen
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return false;

  if (message.type === 'ai-improve') {
    handleImprove(message.text).then(sendResponse);
    return true;
  }

  if (message.type === 'ai-rephrase') {
    handleRephrase(message.text, message.tone).then(sendResponse);
    return true;
  }

  if (message.type === 'ai-check') {
    checkPromptApi().then(available => sendResponse({ available }));
    return true;
  }

  return false;
});

console.log('[Writing Helper AI] Offscreen document loaded');
