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
    console.log('[Spelling Tab AI] LanguageModel not available in this environment');
    _promptApiAvailable = false;
    return false;
  }

  try {
    const avail = await LanguageModel.availability();
    _promptApiAvailable = (avail === 'available' || avail === 'downloadable' || avail === 'downloading');
    console.log('[Spelling Tab AI] Prompt API availability:', avail);
  } catch (e) {
    console.log('[Spelling Tab AI] Prompt API check failed:', e.message);
    _promptApiAvailable = false;
  }

  return _promptApiAvailable;
}

async function handleImprove(text) {
  const available = await checkPromptApi();
  if (!available) return { available: false, improved: null };

  try {
    const session = await LanguageModel.create({
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
    console.error('[Spelling Tab AI] Improve failed:', e);
  }

  return { available: false, improved: null };
}

// Message router — only handle messages targeted at offscreen
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return false;

  if (message.type === 'ai-improve') {
    handleImprove(message.text).then(sendResponse);
    return true;
  }

  if (message.type === 'ai-check') {
    checkPromptApi().then(available => sendResponse({ available }));
    return true;
  }

  return false;
});

console.log('[Spelling Tab AI] Offscreen document loaded');
