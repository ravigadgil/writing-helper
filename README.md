# Writing Helper

A privacy-first, offline grammar and spell checker Chrome extension. Works like Grammarly but runs **entirely locally** on your machine using WebAssembly and Chrome's built-in AI. No data ever leaves your browser.

Powered by [Harper.js](https://github.com/automattic/harper) (Rust grammar engine compiled to WASM), a custom 50+ rule pattern engine, and **Chrome's built-in Gemini Nano AI** for intelligent proofreading, rewrites, and style improvements.

---

## Features

- **100% Offline** -- All checking runs locally via WASM. Zero API calls, zero data collection.
- **Spelling** -- Catches misspellings with 250+ common misspelling corrections. Red wavy underlines.
- **Grammar** -- Subject-verb agreement, pronoun case, articles (a/an), homophones (your/you're, their/they're), tense errors, and more. Blue wavy underlines.
- **Style** -- Wordy phrases, redundant expressions, informal language, and rephrase suggestions. Amber wavy underlines.
- **Punctuation** -- Run-on sentences, comma splices, missing commas before conjunctions, introductory word commas.
- **Works Everywhere** -- Supports `<textarea>`, `<input>`, and `contenteditable` elements on any webpage.
- **Multiple Fix Methods**:
  - **Click** an underline to see suggestions in a popup
  - Press **Tab** to auto-fix all issues at once
  - Use the **extension popup** to review and fix issues one by one
- **Non-destructive** -- Never auto-corrects. All fixes are user-initiated.
- **AI-Powered (Optional)** -- On Chrome 138+, uses Chrome's built-in Gemini Nano for:
  - **AI Proofreading** -- Additional grammar/spelling detection with explanations (purple underlines)
  - **AI Rewrite** -- "Rephrase this sentence" with tone variants (Formal, Casual, Shorter)
  - **AI Improve** -- Select text and click "Improve with AI" for intelligent rewrites
  - Gracefully degrades -- all AI features are optional and additive

---

## Screenshots

| Underlines on page | Click to see suggestions | Extension popup |
|---|---|---|
| Red (spelling), Blue (grammar), Amber (style) wavy underlines appear under errors | Click any underline to see the issue details and fix options | Click the extension icon to see all issues and fix them |

---

## Architecture

```
src/
├── background/                  # Service Worker (runs Harper WASM)
│   ├── service-worker.js        # WASM init, linting pipeline, suggestion post-processing, AI relay
│   └── custom-rules.js          # 50+ regex pattern rules + 250 misspelling corrections
├── offscreen/                   # Offscreen Document (AI Hub — Gemini Nano)
│   ├── offscreen.html           # Minimal page for AI API access
│   └── offscreen.js             # Proofreader, Rewriter, Prompt API handlers
├── content/                     # Content Scripts (injected into web pages)
│   ├── content-script.js        # Main orchestrator, Tab key, AI lint updates, improve button
│   ├── linter-client.js         # Sends text to service worker, caches results
│   ├── element-detector.js      # Detects textarea/input/contenteditable on focus
│   ├── overlay-manager.js       # Mirror-div overlay for textarea/input underlines
│   ├── contenteditable-handler.js # Range API underlines for contenteditable elements
│   ├── suggestion-popup.js      # Click-on-underline popup with fix buttons + AI rewrite
│   ├── fix-pill.js              # "Tab to fix" hint that follows the cursor
│   └── styles.css               # All extension styles (underlines, popups, hints, AI)
├── popup/                       # Extension Popup UI
│   ├── popup.html               # Popup markup with AI status
│   ├── popup.js                 # Loads issues for current tab, fix buttons, AI status
│   └── popup.css                # Popup styling + AI badges
├── icons/                       # Extension icons (16, 48, 128px)
└── manifest.json                # Chrome Extension Manifest V3
```

### How It Works

```
User types in a text field
       │
       ▼
ElementDetector attaches on focusin
       │
       ▼
OverlayManager (textarea/input) OR ContentEditableHandler (contenteditable)
       │
       ▼ (300ms debounce)
LinterClient sends text to Service Worker
       │
       ▼
Service Worker runs Harper.js WASM linter
       │
       ▼
fixHarperSuggestions() patches bad split-word suggestions
       │
       ▼
runCustomRules() adds 50+ pattern-based checks
       │
       ▼
Combined & sorted lints sent back to content script
       │
       ▼
Colored wavy underlines rendered on the page
       │
       ▼ (async, non-blocking — Phase 2)
AI Proofreader runs via Offscreen Document (Gemini Nano)
       │
       ▼
New AI lints merge in via 'ai-lints-update' message
       │
       ▼
Purple AI underlines added alongside existing ones
```

### AI Architecture (Chrome Built-in Gemini Nano)

Chrome's AI APIs (Proofreader, Rewriter, Prompt) require a DOM context and cannot run in service workers. The extension uses an **offscreen document** as a hidden AI hub:

```
Content Script → Service Worker → Offscreen Document (AI APIs) → back
```

**Two-Phase Lint Pipeline:**
- **Phase 1 (instant, ~50ms):** Harper + custom rules render underlines immediately
- **Phase 2 (async, 200-2000ms):** AI Proofreader results merge in without blocking

**AI APIs Used:**
| API | Purpose | Chrome Version |
|-----|---------|---------------|
| [Proofreader API](https://developer.chrome.com/docs/ai/proofreader-api) | Grammar/spelling detection with explanations | 141+ (origin trial) |
| [Rewriter API](https://developer.chrome.com/docs/ai/rewriter-api) | Sentence rephrasing with tone variants | 137+ (origin trial) |
| [Prompt API](https://developer.chrome.com/docs/ai/prompt-api) | Fallback for text improvement | 138+ (stable) |

**Requirements for AI features:** macOS 13+, Windows 10+, or Linux. 22GB free storage, GPU (4GB+ VRAM) or CPU (16GB RAM, 4+ cores). AI features are completely optional — the extension works fully without them.

### Linting Pipeline

1. **Harper.js** -- The Rust-based grammar engine handles ~571 built-in rules including spelling, capitalization, and many grammar patterns.

2. **Suggestion Post-Processing** -- Harper sometimes produces bad suggestions (e.g., splitting "writting" into "writ ting"). The `fixHarperSuggestions()` function:
   - Checks a 250+ entry misspelling dictionary for known corrections
   - Filters out nonsensical split-word suggestions
   - Falls back to doubled-letter deduplication for unknown typos

3. **Custom Rules Engine** -- 50+ regex-based patterns organized by category:
   - Missing articles ("eat apple" -> "eat an apple")
   - Homophones (your/you're, their/they're, affect/effect, then/than, loose/lose)
   - Subject-verb agreement ("he don't" -> "he doesn't")
   - Pronoun case ("between you and I" -> "between you and me")
   - Lay/lie, good/well, everyday/every day, amount/number, borrow/lend
   - Double negatives, redundant expressions, wordy phrases
   - Run-on sentence detection (subject+verb patterns AND imperative patterns)
   - Comma splices, missing commas before conjunctions, introductory word commas
   - "as...as" correlative comparison suggestions
   - Plural after numbers ("5 apple" -> "5 apples")

4. **Overlap Prevention** -- Custom rules skip any text span already flagged by Harper, preventing duplicate errors.

---

## Installation

### Quick Install (no build needed)

1. Download `writing-helper.zip` from the [latest release](https://github.com/ravigadgil/writing-helper/releases/latest)
2. Extract the zip folder
3. Open Chrome and go to `chrome://extensions/`
4. Enable **Developer mode** (toggle in the top-right corner)
5. Click **Load unpacked** and select the extracted folder
6. The extension icon appears in your toolbar — you're ready to go!

### Build from Source (for developers)

If you want to modify the code or contribute:

```bash
# 1. Clone the repository
git clone https://github.com/ravigadgil/writing-helper.git
cd writing-helper

# 2. Install dependencies
npm install

# 3. Build the extension
npm run build
```

This compiles the source into the `dist/` folder. Then load `dist/` as an unpacked extension in Chrome (same steps 3-6 above).

### Development

```bash
# Watch mode -- rebuilds on file changes
npm run watch
```

After rebuilding, go to `chrome://extensions/` and click the reload button on the extension card.

---

## Usage

### Basic Usage

1. Navigate to any webpage with a text input, textarea, or contenteditable field
2. Click/focus on the text field and start typing
3. Errors appear as colored wavy underlines:
   - **Red** = Spelling error
   - **Blue** = Grammar error
   - **Amber** = Style suggestion
4. Fix errors using any of these methods:
   - **Click** an underline to see a popup with suggestions
   - Press **Tab** to fix all errors at once
   - Click the **extension icon** to see all issues and fix individually

### Extension Popup

Click the extension icon in your toolbar to:
- See a list of all detected issues on the current page
- Click green fix buttons to apply individual corrections
- Click "Fix All" to apply all corrections at once
- Toggle the extension on/off with the switch

### Keyboard Shortcuts

| Key | Action |
|---|---|
| `Tab` | Fix all errors in the focused field |
| `Escape` | Close the suggestion popup |

---

## Technical Details

### Chrome Extension Manifest V3

- **Permissions**: `storage` (to persist enable/disable state)
- **Content Security Policy**: `wasm-unsafe-eval` required for loading Harper's WASM binary
- **Content Scripts**: Injected on all URLs at `document_idle` in all frames
- **Service Worker**: ESM module type for dynamic imports

### Underline Rendering

**For `<textarea>` and `<input>`:**
Uses a mirror-div overlay technique. A transparent `<div>` is positioned exactly over the input element, matching its font, padding, and scroll position. `<mark>` elements inside the div create the wavy underlines.

**For `contenteditable`:**
Uses the Range API with `getClientRects()` to calculate exact positions of error text. Absolutely-positioned `<div>` underlines are placed below each error span. The system handles multi-line wrapping and scroll offsets.

### Custom Rules Format

Each rule in `custom-rules.js` follows this structure:

```javascript
{
  regex: /pattern/gi,       // RegExp with global + case-insensitive flags
  match: 0,                 // Capture group index to use as the error span (default: 0)
  message: 'Explanation',   // String or function(match) => string
  suggest: ['fix1', 'fix2'],// Array or function(match) => string[]
  kind: 'Grammar',          // Lint kind label
  pretty: 'Category Name',  // Human-readable category
  category: 'grammar',      // Visual bucket: 'spelling' | 'grammar' | 'style'
}
```

### Common Misspellings Dictionary

The `COMMON_MISSPELLINGS` export in `custom-rules.js` maps ~250 frequently misspelled words to their correct spelling. This overrides Harper's sometimes incorrect suggestions (e.g., preventing "writting" from being suggested as "writ ting" instead of "writing").

---

## Project Structure

| File | Lines | Purpose |
|---|---|---|
| `src/background/service-worker.js` | ~220 | WASM initialization, Harper linting, suggestion post-processing, message handling |
| `src/background/custom-rules.js` | ~1070 | 250+ misspelling corrections, 50+ grammar/style/punctuation rules, run-on detection |
| `src/content/content-script.js` | ~195 | Main orchestrator: wires up all content modules, Tab key handler, fix routing |
| `src/content/linter-client.js` | ~35 | Message bridge to service worker with LRU cache (50 entries) |
| `src/content/element-detector.js` | ~45 | Focus-based element detection (no DOM scanning on page load) |
| `src/content/overlay-manager.js` | ~180 | Mirror-div overlay system for textarea/input underlines |
| `src/content/contenteditable-handler.js` | ~310 | Range API underlines, targeted DOM range fix application |
| `src/content/suggestion-popup.js` | ~100 | Click-on-underline popup with category labels and fix buttons |
| `src/content/fix-pill.js` | varies | "Tab to fix" floating hint near cursor |
| `src/content/styles.css` | ~220 | All visual styles: underlines, popups, hints (3-color system) |
| `src/popup/popup.html` | ~25 | Popup markup: toggle, issue list, fix-all button |
| `src/popup/popup.js` | ~110 | Popup logic: loads lints, renders issue cards with fix buttons |
| `src/popup/popup.css` | ~210 | Popup styling |
| `esbuild.config.mjs` | ~65 | Build config: 3 bundles + asset copying |

---

## Adding Custom Rules

To add a new grammar or style rule:

1. Open `src/background/custom-rules.js`
2. Add a new entry to the `RULES` array:

```javascript
{
  regex: wordBoundary("your\\s+pattern\\s+here"),
  match: 0,
  message: 'Explanation of the issue',
  suggest: (m) => ['suggested fix'],
  kind: 'Grammar',        // or 'Spelling', 'Style', 'Punctuation', etc.
  pretty: 'Rule Name',
  category: 'grammar',    // 'spelling', 'grammar', or 'style'
},
```

3. Rebuild with `npm run build`
4. Reload the extension in `chrome://extensions/`

### Adding Misspelling Corrections

Add entries to the `COMMON_MISSPELLINGS` object:

```javascript
export const COMMON_MISSPELLINGS = {
  'mispeled': 'misspelled',
  // ... existing entries
};
```

Keys must be lowercase. The correction is case-matched to the original automatically.

---

## Testing

Two test scripts are included:

```bash
# Test Harper.js detection capabilities
node test-harper.mjs

# Test custom rules (true positives + false positive checks)
node test-custom-rules.mjs
```

> **Note**: If your project path contains spaces, the test scripts use a symlink at `/tmp/spelling-tab-link` to work around a WASM loading issue in Node.js.

---

## Dependencies

| Package | Version | Purpose |
|---|---|---|
| [harper.js](https://github.com/automattic/harper) | ^1.7.0 | Rust grammar/spell checker compiled to WASM |
| [esbuild](https://esbuild.github.io/) | ^0.27.3 | Fast JavaScript bundler (dev dependency) |

No runtime dependencies beyond Harper.js. No API keys, no cloud services, no tracking.

---

## License

MIT — see [LICENSE](LICENSE) for details.
