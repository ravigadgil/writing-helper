export class OverlayManager {
  constructor(linterClient, suggestionPopup) {
    this.linterClient = linterClient;
    this.suggestionPopup = suggestionPopup;
    this.overlays = new Map(); // element -> { wrapper, overlay, debounceTimer, lints }
    this.onLintsChanged = null; // callback: (element, lints) => void
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

    // Find all sentences (5+ words) — shown even if they contain errors
    const sentences = this.extractSentences(text);
    state.sentences = sentences; // store for later use

    // Build sorted lint marks
    const sorted = [...lints].sort((a, b) => a.span.start - b.span.start);

    // Build a coverage map: ranges covered by sentence hints (excluding lint spans)
    // For each sentence, split it around lint spans to produce non-overlapping hint fragments
    const sentenceFragments = [];
    sentences.forEach((sentence, i) => {
      // Find lints that overlap this sentence
      const overlapping = sorted.filter(l =>
        l.span.start < sentence.end && l.span.end > sentence.start
      );

      if (overlapping.length === 0) {
        // No lints overlap — whole sentence is a hint
        sentenceFragments.push({ start: sentence.start, end: sentence.end, sentence, index: i });
      } else {
        // Split sentence around lint spans
        let cursor = sentence.start;
        for (const lint of overlapping) {
          const lintStart = Math.max(lint.span.start, sentence.start);
          const lintEnd = Math.min(lint.span.end, sentence.end);
          if (cursor < lintStart) {
            sentenceFragments.push({ start: cursor, end: lintStart, sentence, index: i });
          }
          cursor = Math.max(cursor, lintEnd);
        }
        if (cursor < sentence.end) {
          sentenceFragments.push({ start: cursor, end: sentence.end, sentence, index: i });
        }
      }
    });

    // Merge lint marks and sentence fragment marks into one sorted list
    const marks = [];
    sorted.forEach((lint, i) => {
      marks.push({ type: 'lint', start: lint.span.start, end: lint.span.end, lint, index: i });
    });
    sentenceFragments.forEach((frag) => {
      marks.push({ type: 'sentence', start: frag.start, end: frag.end, sentence: frag.sentence, index: frag.index });
    });

    marks.sort((a, b) => a.start - b.start || (a.type === 'lint' ? -1 : 1));

    if (marks.length === 0) return;

    let lastIndex = 0;
    marks.forEach((mark) => {
      // Skip if this mark starts before our cursor (overlap case)
      if (mark.start < lastIndex) return;

      if (mark.start > lastIndex) {
        overlay.appendChild(
          document.createTextNode(text.substring(lastIndex, mark.start))
        );
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
        // Sentence hint — subtle purple highlight (fragment of a sentence)
        el.className = 'spelling-tab-sentence-hint';
        el.textContent = text.substring(mark.start, mark.end);
        el.dataset.sentenceIndex = String(mark.index);
        // Click dispatches custom event that content-script listens to
        el.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          document.dispatchEvent(new CustomEvent('spelling-tab-sentence-click', {
            detail: { sentence: mark.sentence, anchorEl: el, element },
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

  applyAllFixes(element) {
    const state = this.overlays.get(element);
    if (!state || state.lints.length === 0) return false;

    const fixable = state.lints.filter(l => l.suggestions.length > 0);
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
