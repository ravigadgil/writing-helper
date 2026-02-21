export class OverlayManager {
  constructor(linterClient, suggestionPopup) {
    this.linterClient = linterClient;
    this.suggestionPopup = suggestionPopup;
    this.overlays = new Map(); // element -> { wrapper, overlay, debounceTimer, lints }
    this.onLintsChanged = null; // callback: (element, lints) => void
    // Cache AI sentence check results: sentenceText -> { improved: string|null }
    this._aiSentenceCache = new Map();
    this._aiSentenceChecking = new Set();
  }

  attach(element) {
    if (this.overlays.has(element)) return;

    const { wrapper, overlay } = this.createOverlay(element);
    const state = { wrapper, overlay, debounceTimer: null, lints: [] };
    this.overlays.set(element, state);

    element.addEventListener('input', () => this.scheduleCheck(element));

    // Sync scroll position
    element.addEventListener('scroll', () => {
      overlay.scrollTop = element.scrollTop;
      overlay.scrollLeft = element.scrollLeft;
    });

    // Handle textarea resize
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this.syncOverlaySize(element)).observe(element);
    }
  }

  createOverlay(element) {
    const wrapper = document.createElement('div');
    wrapper.className = 'spelling-tab-wrapper';

    const overlay = document.createElement('div');
    overlay.className = 'spelling-tab-overlay';
    overlay.setAttribute('aria-hidden', 'true');

    // Insert wrapper around element
    element.parentNode.insertBefore(wrapper, element);
    wrapper.appendChild(element);
    wrapper.appendChild(overlay);

    this.syncOverlayStyles(element, overlay);
    return { wrapper, overlay };
  }

  syncOverlayStyles(element, overlay) {
    const computed = window.getComputedStyle(element);

    const props = [
      'fontFamily', 'fontSize', 'fontWeight', 'fontStyle',
      'lineHeight', 'letterSpacing', 'wordSpacing',
      'textAlign', 'textTransform', 'textIndent',
      'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
      'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
      'boxSizing', 'whiteSpace', 'overflowWrap', 'wordWrap', 'wordBreak',
      'direction', 'textRendering',
    ];
    props.forEach(prop => {
      overlay.style[prop] = computed[prop];
    });

    overlay.style.position = 'absolute';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = computed.width;
    overlay.style.height = computed.height;
    overlay.style.pointerEvents = 'none';
    overlay.style.color = 'transparent';
    overlay.style.background = 'transparent';
    overlay.style.overflow = 'hidden';
    overlay.style.zIndex = '10000';
    overlay.style.borderColor = 'transparent';
    overlay.style.borderStyle = computed.borderStyle;
    overlay.style.borderTopWidth = computed.borderTopWidth;
    overlay.style.borderRightWidth = computed.borderRightWidth;
    overlay.style.borderBottomWidth = computed.borderBottomWidth;
    overlay.style.borderLeftWidth = computed.borderLeftWidth;
    overlay.style.margin = '0';
  }

  syncOverlaySize(element) {
    const state = this.overlays.get(element);
    if (!state) return;
    const computed = window.getComputedStyle(element);
    state.overlay.style.width = computed.width;
    state.overlay.style.height = computed.height;
  }

  scheduleCheck(element) {
    const state = this.overlays.get(element);
    if (!state) return;
    clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => this.runCheck(element), 300);
  }

  async runCheck(element) {
    const text = element.value;
    const lints = await this.linterClient.lint(text);
    const state = this.overlays.get(element);
    if (!state) return;
    state.lints = lints;
    this.renderOverlay(element, text, lints);
    if (this.onLintsChanged) this.onLintsChanged(element, lints);
  }

  /**
   * Extract sentence boundaries from text.
   * Returns array of { start, end, text } for sentences with 5+ words.
   */
  extractSentences(text) {
    const sentences = [];
    // Split on sentence-ending punctuation followed by space or end-of-string
    const re = /[^.!?\n]+[.!?]*/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      const s = match[0].trim();
      const wordCount = s.split(/\s+/).length;
      if (wordCount >= 5) {
        const start = match.index;
        const end = match.index + match[0].length;
        sentences.push({ start, end, text: s });
      }
    }
    return sentences;
  }

  renderOverlay(element, text, lints) {
    const state = this.overlays.get(element);
    if (!state) return;
    const overlay = state.overlay;
    overlay.innerHTML = '';

    // Find all sentences and check with AI in background
    const sentences = this.extractSentences(text);
    state.sentences = sentences;
    this._checkSentencesWithAI(sentences, element);

    // Build marks: lints + AI changed-word highlights
    const marks = [];

    // Add lint marks
    const sorted = [...lints].sort((a, b) => a.span.start - b.span.start);
    sorted.forEach((lint, i) => {
      marks.push({ type: 'lint', start: lint.span.start, end: lint.span.end, lint, index: i });
    });

    // Add AI changed-word marks (only specific words, not full sentences)
    const confirmedSentences = sentences.filter(s => this._aiSentenceCache.has(s.text));
    for (const sentence of confirmedSentences) {
      const cached = this._aiSentenceCache.get(sentence.text);
      if (!cached?.improved) continue;
      const changedRanges = this._findChangedWordRanges(sentence.text, cached.improved, sentence.start);
      for (const cr of changedRanges) {
        marks.push({ type: 'sentence', start: cr.start, end: cr.end, sentence });
      }
    }

    marks.sort((a, b) => a.start - b.start || (a.type === 'lint' ? -1 : 1));

    if (marks.length === 0) return;

    let lastIndex = 0;
    marks.forEach((mark) => {
      if (mark.start < lastIndex) return;

      if (mark.start > lastIndex) {
        overlay.appendChild(document.createTextNode(text.substring(lastIndex, mark.start)));
      }

      const el = document.createElement('mark');

      if (mark.type === 'lint') {
        const cat = mark.lint.category || (mark.lint.lintKind === 'Spelling' ? 'spelling' : 'grammar');
        el.className = 'spelling-tab-error-' + cat;
        el.textContent = text.substring(mark.start, mark.end);
        el.style.pointerEvents = 'auto';
        el.style.cursor = 'pointer';
        el.dataset.lintIndex = String(mark.index);
        el.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.suggestionPopup.show(mark.lint, element, el);
        });
      } else {
        // AI changed-word highlight
        el.className = 'spelling-tab-sentence-hint';
        el.textContent = text.substring(mark.start, mark.end);
        el.style.pointerEvents = 'auto';
        el.style.cursor = 'pointer';
        el.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const cached = this._aiSentenceCache.get(mark.sentence.text);
          document.dispatchEvent(new CustomEvent('spelling-tab-sentence-click', {
            detail: { sentence: mark.sentence, anchorEl: el, element, cachedImproved: cached?.improved },
          }));
        });
      }

      overlay.appendChild(el);
      lastIndex = mark.end;
    });

    if (lastIndex < text.length) {
      overlay.appendChild(document.createTextNode(text.substring(lastIndex)));
    }

    overlay.scrollTop = element.scrollTop;
    overlay.scrollLeft = element.scrollLeft;
  }

  /**
   * Check sentences with AI in the background.
   * Only checks sentences not already cached or in-flight.
   */
  async _checkSentencesWithAI(sentences, element) {
    for (const sentence of sentences) {
      if (this._aiSentenceCache.has(sentence.text)) continue;
      if (this._aiSentenceChecking.has(sentence.text)) continue;

      this._aiSentenceChecking.add(sentence.text);

      chrome.runtime.sendMessage({ type: 'ai-improve', text: sentence.text })
        .then(result => {
          this._aiSentenceChecking.delete(sentence.text);
          if (result?.available && result.improved && result.improved !== sentence.text) {
            this._aiSentenceCache.set(sentence.text, { improved: result.improved });
            // Re-render to show the new highlight
            const state = this.overlays.get(element);
            if (state) this.renderOverlay(element, element.value, state.lints);
          }
        })
        .catch(() => {
          this._aiSentenceChecking.delete(sentence.text);
        });
    }
  }

  /**
   * Find character ranges in the original sentence where words differ from improved.
   * Returns array of { start, end } (absolute offsets in the full text).
   */
  _findChangedWordRanges(original, improved, sentenceOffset) {
    const origWords = original.match(/\S+/g) || [];
    const impWords = improved.match(/\S+/g) || [];
    const ranges = [];

    // Build LCS to find matching words
    const lcs = this._lcsWords(origWords, impWords);
    const lcsSet = new Set(lcs.map(m => m.origIdx));

    // Any original word NOT in the LCS is "changed"
    let searchFrom = 0;
    for (let i = 0; i < origWords.length; i++) {
      if (lcsSet.has(i)) continue;
      const wordStart = original.indexOf(origWords[i], searchFrom);
      if (wordStart === -1) continue;
      const wordEnd = wordStart + origWords[i].length;
      ranges.push({ start: sentenceOffset + wordStart, end: sentenceOffset + wordEnd });
      searchFrom = wordEnd;
    }

    return ranges;
  }

  /**
   * Compute LCS of two word arrays. Returns array of { origIdx, impIdx }.
   */
  _lcsWords(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (a[i - 1].toLowerCase() === b[j - 1].toLowerCase()) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }
    const result = [];
    let i = m, j = n;
    while (i > 0 && j > 0) {
      if (a[i - 1].toLowerCase() === b[j - 1].toLowerCase()) {
        result.unshift({ origIdx: i - 1, impIdx: j - 1 });
        i--; j--;
      } else if (dp[i - 1][j] > dp[i][j - 1]) {
        i--;
      } else {
        j--;
      }
    }
    return result;
  }

  applyAllFixes(element) {
    const state = this.overlays.get(element);
    if (!state || state.lints.length === 0) return false;

    // Find paragraph around cursor
    const cursorPos = element.selectionStart ?? -1;
    let paraStart = 0;
    let paraEnd = element.value.length;
    if (cursorPos >= 0) {
      const text = element.value;
      const nlBefore = text.lastIndexOf('\n', cursorPos - 1);
      paraStart = nlBefore === -1 ? 0 : nlBefore + 1;
      const nlAfter = text.indexOf('\n', cursorPos);
      paraEnd = nlAfter === -1 ? text.length : nlAfter;
    }

    // Only fix lints within the cursor's paragraph
    const fixable = state.lints.filter(l =>
      l.suggestions.length > 0 &&
      l.span.start >= paraStart &&
      l.span.end <= paraEnd
    );
    if (fixable.length === 0) return false;

    let text = element.value;
    const sorted = [...fixable].sort((a, b) => b.span.start - a.span.start);
    sorted.forEach(lint => {
      const replacement = lint.suggestions[0].text;
      text = text.substring(0, lint.span.start) + replacement + text.substring(lint.span.end);
    });

    element.value = text;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    this.linterClient.clearCache();
    this.scheduleCheck(element);
    return true;
  }

  applySingleFix(element, lint, suggestion) {
    const text = element.value;
    element.value = text.substring(0, lint.span.start) + suggestion.text + text.substring(lint.span.end);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    this.linterClient.clearCache();
    this.scheduleCheck(element);
  }
}
