import { LocalLinter, BinaryModule } from 'harper.js';
import { runCustomRules, COMMON_MISSPELLINGS } from './custom-rules.js';

let linter = null;
let isEnabled = true;
const tabLints = new Map(); // tabId -> lints array

// ── Offscreen Document (for Prompt API — needs DOM context) ──────────────

let offscreenCreating = null;

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  if (existing) return;
  if (offscreenCreating) { await offscreenCreating; return; }
  offscreenCreating = chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['DOM_PARSER'],
    justification: 'Chrome Prompt API requires DOM context for AI text improvement',
  });
  await offscreenCreating;
  offscreenCreating = null;
}

async function sendToOffscreen(message) {
  try {
    await ensureOffscreen();
    return await chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
  } catch (err) {
    console.warn('Spelling Tab: offscreen message failed', err);
    return { available: false };
  }
}

async function initLinter() {
  if (linter) return linter;
  const wasmUrl = chrome.runtime.getURL('wasm/harper_wasm_bg.wasm');
  const binary = BinaryModule.create(wasmUrl);
  linter = new LocalLinter({ binary });
  await linter.setup();
  return linter;
}

/**
 * Post-process Harper lints to fix bad suggestions.
 *
 * Harper's SplitWords rule sometimes splits misspelled words nonsensically
 * (e.g. "writting" → "writ ting" instead of "writing").
 * If the original word is a known misspelling, replace the suggestion.
 * If the suggestion introduces a space but the original had none, and
 * it's not a real compound word split, drop the bad suggestion.
 */
function fixHarperSuggestions(lints, text) {
  for (const lint of lints) {
    const problem = lint.problemText?.toLowerCase();
    if (!problem) continue;

    // Check if it's a known misspelling we can correct
    const knownFix = COMMON_MISSPELLINGS[problem];
    if (knownFix) {
      // Replace all suggestions with the correct one
      lint.suggestions = [{ text: knownFix, kind: 'ReplaceWith' }];
      lint.message = `Did you mean "${knownFix}"?`;
      continue;
    }

    // Filter out bad split-word suggestions: if original has no space
    // but the suggestion introduces one, it's likely a bad split
    if (!problem.includes(' ')) {
      lint.suggestions = lint.suggestions.filter(s => {
        const sugText = s.text;
        // If suggestion has a space, check if both parts are real words (3+ chars)
        if (sugText.includes(' ')) {
          const parts = sugText.split(/\s+/);
          // Keep if all parts are 3+ chars (likely a real compound split like "some thing")
          // Drop if any part is <= 2 chars (likely nonsense like "writ ting")
          const allPartsReasonable = parts.every(p => p.length >= 3);
          if (!allPartsReasonable) return false;
          // Also drop if the combined parts look like a misspelling variant
          // (the original word minus/plus a letter → not a real split)
          const combined = parts.join('');
          if (Math.abs(combined.length - problem.length) <= 1) return false;
        }
        return true;
      });

      // If all suggestions got filtered out and it's a spelling/typo lint,
      // try to generate a basic suggestion by removing doubled letters
      if (lint.suggestions.length === 0 &&
          (lint.lintKind === 'Spelling' || lint.lintKind === 'Typo')) {
        const fixed = fixDoubledLetters(problem);
        if (fixed && fixed !== problem) {
          lint.suggestions = [{ text: matchCase(fixed, lint.problemText), kind: 'ReplaceWith' }];
          lint.message = `Did you mean "${matchCase(fixed, lint.problemText)}"?`;
        }
      }
    }
  }

  // Remove lints that have no suggestions and are just SplitWords noise
  return lints.filter(l => {
    if (l.suggestions.length === 0 &&
        (l.lintKind === 'Spelling' || l.lintKind === 'Typo')) {
      // Keep it — still shows the underline, user just won't get a fix suggestion
      // Actually, let's keep these so the error is still shown
      return true;
    }
    return true;
  });
}

/**
 * Fix common doubled-letter misspellings:
 * "writting" → "writing", "comming" → "coming", "runing" → "running"
 */
function fixDoubledLetters(word) {
  // Try removing doubled consonants
  const deduped = word.replace(/([bcdfghjklmnpqrstvwxyz])\1/g, '$1');
  // If the word changed and is a common pattern, return it
  if (deduped !== word) return deduped;
  return null;
}

/** Preserve the case pattern of the original when applying a fix */
function matchCase(fixed, original) {
  if (!original || !fixed) return fixed;
  if (original === original.toUpperCase()) return fixed.toUpperCase();
  if (original[0] === original[0].toUpperCase()) {
    return fixed[0].toUpperCase() + fixed.slice(1);
  }
  return fixed;
}

/**
 * Map Harper's 20 lintKind values into 3 visual categories:
 *  - 'spelling' → red underline (misspelled words)
 *  - 'grammar'  → blue underline (grammar, agreement, punctuation, etc.)
 *  - 'style'    → amber/yellow underline (suggestions, readability, enhancement)
 */
function categorize(lintKind) {
  switch (lintKind) {
    case 'Spelling':
    case 'Typo':
      return 'spelling';
    case 'Enhancement':
    case 'Readability':
    case 'Style':
    case 'Redundancy':
    case 'WordChoice':
    case 'Repetition':
      return 'style';
    default:
      // Agreement, Grammar, Punctuation, Capitalization, Miscellaneous,
      // BoundaryError, Eggcorn, Malapropism, Nonstandard, Regionalism,
      // Usage, Formatting
      return 'grammar';
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse);
  return true; // keep channel open for async
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'lint': {
      if (!isEnabled) return { lints: [] };
      try {
        const l = await initLinter();
        const lints = await l.lint(message.text, { language: 'plaintext' });
        const serialized = lints.map(lint => {
          const span = lint.span();
          const suggestions = lint.suggestions();
          const lintKind = lint.lint_kind();
          const result = {
            span: { start: span.start, end: span.end },
            message: lint.message(),
            lintKind: lintKind,
            lintKindPretty: lint.lint_kind_pretty(),
            category: categorize(lintKind),
            problemText: lint.get_problem_text(),
            suggestions: suggestions.map(s => ({
              text: s.get_replacement_text(),
              kind: s.kind(),
            })),
          };
          // Free WASM objects
          span.free();
          suggestions.forEach(s => s.free());
          lint.free();
          return result;
        });

        // Fix bad Harper suggestions (SplitWords nonsense etc.)
        const fixedHarper = fixHarperSuggestions(serialized, message.text);

        // Run custom pattern-based rules to supplement Harper
        const customLints = runCustomRules(message.text, fixedHarper);
        const allLints = [...fixedHarper, ...customLints];

        // Sort by position in text
        allLints.sort((a, b) => a.span.start - b.span.start);

        // Store lints for this tab so popup can access them
        const tabId = sender.tab?.id;
        if (tabId) {
          tabLints.set(tabId, allLints);
          chrome.action.setBadgeText({
            text: allLints.length > 0 ? String(allLints.length) : '',
            tabId,
          });
          chrome.action.setBadgeBackgroundColor({ color: '#e74c3c' });
        }

        return { lints: allLints };
      } catch (err) {
        console.error('Spelling Tab lint error:', err);
        return { lints: [] };
      }
    }

    case 'get-lints': {
      // Popup requests current lints for a tab
      const lints = tabLints.get(message.tabId) || [];
      return { lints };
    }
    case 'ai-improve':
      return sendToOffscreen({ type: 'ai-improve', text: message.text });

    case 'get-enabled':
      return { enabled: isEnabled };
    case 'set-enabled':
      isEnabled = message.enabled;
      chrome.storage.local.set({ enabled: isEnabled });
      return { enabled: isEnabled };
    default:
      return {};
  }
}

// Clean up when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  tabLints.delete(tabId);
});

// Restore saved state on startup
chrome.storage.local.get('enabled', (result) => {
  if (result.enabled !== undefined) isEnabled = result.enabled;
});
