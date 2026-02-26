# Changelog

All notable changes to Writing Helper are documented here.

## [1.0.1] - 2026-02-26

### Added
- **Shadow DOM / Web Components support** -- Extension now works on sites using Shadow DOM (e.g., Reddit). CSS is injected into shadow roots via `<link>` tags with inline fallback styles. Focus detection uses `composedPath()` to pierce shadow boundaries.
- **`contenteditable="plaintext-only"` support** -- Centralized `CE_SELECTOR` constant detects all contenteditable variants.
- **Known Limitations section** in README covering Google Docs, Shadow DOM, AI requirements, and more.
- **`web_accessible_resources`** -- `styles.css` exposed for shadow root CSS injection.

### Fixed
- **Text extraction concatenating words** on sites with custom web components (e.g., Reddit's `<shreddit-*>` Lit components). Switched from `blockTags` allowlist to `inlineTags` set -- any non-inline element is now treated as a block boundary.
- **AI toolbar not appearing** in Shadow DOM -- added shadow-aware `getSelection()` and direct `mouseup` listeners on shadow DOM contenteditable elements.
- **Capitalization detection** now handles leading whitespace and newlines from DOM extraction.
- **Cursor jumping to first fix** after pressing Tab to fix all -- cursor position is now saved, adjusted for text shifts, and restored after all fixes are applied.
- **"Tab to fix" hint blocking view** -- hint now appears below the cursor instead of to the right.

### Changed
- Excluded Google Docs, Sheets, and Slides via `exclude_matches` (canvas-based rendering, not DOM-accessible).
- Updated package.json: renamed to `writing-helper`, updated description.
- Updated README with Shadow DOM documentation and accurate project structure table.

## [1.0.0] - 2026-02-20

### Added
- **AI-Powered features** using Chrome's built-in Gemini Nano (optional, Chrome 138+):
  - **AI Improve** -- Select text and click "Improve with AI" for intelligent rewrites.
  - **AI Rephrase** -- Tone variants: Friendly, Professional, Casual.
  - **AI Sentence suggestions** -- Grammarly-style word-level diff popup with highlights.
  - Keyboard shortcut: `Ctrl+Shift+I` to improve selected text.
  - All AI runs locally via offscreen document (Prompt API needs DOM context).
- **Paragraph-scoped Tab fix** -- Tab key only fixes errors in the current paragraph, not the entire field.
- **Sentence-start capitalization detection** for words after `.!?` and at text start.
- **Run-on sentence detection** with subject+verb and imperative patterns.
- **Comma rules** -- splices, missing commas before conjunctions, introductory word commas.
- **50+ custom regex rules** covering homophones, subject-verb agreement, pronoun case, double negatives, wordy phrases, and more.
- **250+ common misspelling corrections** dictionary that overrides Harper's bad suggestions.
- **Suggestion post-processing** -- fixes Harper's nonsensical split-word suggestions.
- Open source under MIT license.
- Quick install via release zip (no build needed).

### Initial Features
- **100% offline** grammar and spell checking via Harper.js (Rust WASM).
- Three underline types: red (spelling), blue (grammar), amber (style).
- Click underlines to see suggestions in a popup.
- Press Tab to auto-fix all issues.
- Extension popup to review and fix issues.
- Works on `<textarea>`, `<input>`, and `contenteditable` elements.
- Non-destructive -- never auto-corrects without user action.
