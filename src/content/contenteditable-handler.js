export class ContentEditableHandler {
  constructor(linterClient, suggestionPopup) {
    this.linterClient = linterClient;
    this.suggestionPopup = suggestionPopup;
    this.tracked = new Map(); // element -> { container, debounceTimer, lints, text, nodeMap }
    this.onLintsChanged = null; // callback: (element, lints) => void
  }

  attach(element) {
    if (this.tracked.has(element)) return;

    const container = document.createElement('div');
    container.className = 'spelling-tab-ce-container';

    const parentStyle = window.getComputedStyle(element);
    if (parentStyle.position === 'static') {
      element.style.position = 'relative';
    }
    element.appendChild(container);

    const state = { container, debounceTimer: null, lints: [], text: '', nodeMap: [] };
    this.tracked.set(element, state);

    element.addEventListener('input', () => this.scheduleCheck(element));
    element.addEventListener('scroll', () => this.renderUnderlines(element));
  }

  /**
   * Ensure the overlay container is still inside the element.
   * After execCommand('insertText'), the container may get destroyed.
   */
  ensureContainer(element) {
    const state = this.tracked.get(element);
    if (!state) return;

    // Check if container is still in the DOM and inside this element
    if (!element.contains(state.container)) {
      const container = document.createElement('div');
      container.className = 'spelling-tab-ce-container';
      element.appendChild(container);
      state.container = container;
    }
  }

  scheduleCheck(element) {
    const state = this.tracked.get(element);
    if (!state) return;
    clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => this.runCheck(element), 300);
  }

  async runCheck(element) {
    // Make sure our container is still alive before building text map
    this.ensureContainer(element);

    const { text, nodeMap } = this.buildTextMap(element);
    const lints = await this.linterClient.lint(text);
    const state = this.tracked.get(element);
    if (!state) return;
    state.lints = lints;
    state.text = text;
    state.nodeMap = nodeMap;
    this.renderUnderlines(element);
    if (this.onLintsChanged) this.onLintsChanged(element, lints);
  }

  buildTextMap(root) {
    const nodeMap = [];
    let offset = 0;
    // Track which block-level elements we've already inserted newlines for,
    // so we don't double-count.
    const blockBreakInserted = new Set();

    const blockTags = new Set([
      'DIV', 'P', 'BR', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'BLOCKQUOTE', 'PRE', 'OL', 'UL', 'TR', 'SECTION', 'ARTICLE',
      'HEADER', 'FOOTER', 'ASIDE', 'NAV', 'MAIN', 'FIGURE',
    ]);

    /**
     * Recursively walk the DOM, building a flat text + nodeMap.
     * Insert synthetic '\n' entries for block boundaries and <br> tags.
     */
    const walk = (node) => {
      if (node === root) {
        for (const child of node.childNodes) walk(child);
        return;
      }

      // Skip our overlay container
      if (node.nodeType === Node.ELEMENT_NODE &&
          node.classList?.contains('spelling-tab-ce-container')) {
        return;
      }

      if (node.nodeType === Node.TEXT_NODE) {
        const len = node.textContent.length;
        if (len > 0) {
          nodeMap.push({ node, start: offset, end: offset + len, synthetic: false });
          offset += len;
        }
        return;
      }

      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName;

        // <br> always inserts a newline
        if (tag === 'BR') {
          nodeMap.push({ node: null, start: offset, end: offset + 1, synthetic: true, char: '\n' });
          offset += 1;
          return;
        }

        // For block-level elements, insert a newline BEFORE its content
        // (but only if we're not at the very start and haven't already inserted one)
        if (blockTags.has(tag) && offset > 0 && !blockBreakInserted.has(node)) {
          blockBreakInserted.add(node);
          // Only add newline if the previous character isn't already a newline
          const prevEntry = nodeMap[nodeMap.length - 1];
          const prevIsNewline = prevEntry && prevEntry.synthetic && prevEntry.char === '\n';
          if (!prevIsNewline) {
            nodeMap.push({ node: null, start: offset, end: offset + 1, synthetic: true, char: '\n' });
            offset += 1;
          }
        }

        // Recurse into children
        for (const child of node.childNodes) walk(child);
      }
    };

    walk(root);

    // Build the flat text string
    const parts = [];
    for (const entry of nodeMap) {
      if (entry.synthetic) {
        parts.push(entry.char);
      } else {
        parts.push(entry.node.textContent);
      }
    }
    const text = parts.join('');
    return { text, nodeMap };
  }

  renderUnderlines(element) {
    const state = this.tracked.get(element);
    if (!state) return;

    // Ensure container is still in DOM
    this.ensureContainer(element);

    const { container, lints, nodeMap } = state;
    container.innerHTML = '';

    if (!lints.length || !nodeMap?.length) return;

    const elementRect = element.getBoundingClientRect();

    lints.forEach((lint, lintIndex) => {
      try {
        const range = document.createRange();
        const startInfo = this.findNodeAtOffset(nodeMap, lint.span.start);
        const endInfo = this.findNodeAtOffset(nodeMap, lint.span.end);
        if (!startInfo || !endInfo) return;

        range.setStart(startInfo.node, lint.span.start - startInfo.start);
        range.setEnd(endInfo.node, Math.min(lint.span.end - endInfo.start, endInfo.node.textContent.length));

        const rects = range.getClientRects();
        for (const rect of rects) {
          const underline = document.createElement('div');
          const cat = lint.category || (lint.lintKind === 'Spelling' ? 'spelling' : 'grammar');
          underline.className = 'spelling-tab-underline-' + cat;
          underline.style.left = (rect.left - elementRect.left + element.scrollLeft) + 'px';
          underline.style.top = (rect.bottom - elementRect.top + element.scrollTop - 2) + 'px';
          underline.style.width = rect.width + 'px';
          underline.dataset.lintIndex = String(lintIndex);

          underline.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.suggestionPopup.show(lint, element, underline);
          });

          container.appendChild(underline);
        }
      } catch (err) {
        // Range operations can fail if DOM changed; skip this lint
      }
    });
  }

  findNodeAtOffset(nodeMap, offset) {
    // Skip synthetic entries (newlines from block boundaries) — we can't create
    // DOM ranges inside them. Find the nearest real text node instead.
    for (const entry of nodeMap) {
      if (entry.synthetic) continue;
      if (offset >= entry.start && offset <= entry.end) return entry;
    }
    // Fallback: if offset lands exactly on a synthetic newline, use the next real node
    for (const entry of nodeMap) {
      if (entry.synthetic) continue;
      if (entry.start >= offset) return entry;
    }
    return null;
  }

  applyAllFixes(element) {
    const state = this.tracked.get(element);
    if (!state || state.lints.length === 0) return false;

    const fixable = state.lints.filter(l => l.suggestions.length > 0);
    if (fixable.length === 0) return false;

    // Apply fixes in reverse order (last to first) so span offsets stay valid
    const sorted = [...fixable].sort((a, b) => b.span.start - a.span.start);
    for (const lint of sorted) {
      this._applyRangedFix(element, state, lint, lint.suggestions[0]);
    }

    this.linterClient.clearCache();
    this.scheduleCheck(element);
    return true;
  }

  applySingleFix(element, lint, suggestion) {
    const state = this.tracked.get(element);
    if (!state) return;

    this._applyRangedFix(element, state, lint, suggestion);
    this.linterClient.clearCache();
    this.scheduleCheck(element);
  }

  /**
   * Apply a single fix by creating a DOM Range over the exact span
   * and using execCommand('insertText') to replace just that range.
   * This preserves all surrounding HTML structure (line breaks, paragraphs, etc.)
   */
  _applyRangedFix(element, state, lint, suggestion) {
    const { nodeMap } = state;
    if (!nodeMap || nodeMap.length === 0) return;

    try {
      const startInfo = this.findNodeAtOffset(nodeMap, lint.span.start);
      const endInfo = this.findNodeAtOffset(nodeMap, lint.span.end);
      if (!startInfo || !endInfo) return;

      element.focus();

      const range = document.createRange();
      const startOffset = lint.span.start - startInfo.start;
      const endOffset = Math.min(lint.span.end - endInfo.start, endInfo.node.textContent.length);

      range.setStart(startInfo.node, startOffset);
      range.setEnd(endInfo.node, endOffset);

      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);

      document.execCommand('insertText', false, suggestion.text);

      // After exec, re-ensure our container
      this.ensureContainer(element);

      // Rebuild the text map since the DOM changed
      const { text, nodeMap: newMap } = this.buildTextMap(element);
      state.text = text;
      state.nodeMap = newMap;
    } catch (err) {
      // Fallback: if ranged fix fails, use the old whole-content replacement
      console.warn('Spelling Tab: ranged fix failed, falling back', err);
      this._replaceContentFallback(element, state, lint, suggestion);
    }
  }

  /**
   * Fallback: replace all content. Only used if ranged fix fails.
   */
  _replaceContentFallback(element, state, lint, suggestion) {
    let text = state.text;
    text = text.substring(0, lint.span.start) + suggestion.text + text.substring(lint.span.end);

    // Remove our container before selecting all content
    const container = state?.container;
    if (container && container.parentNode === element) {
      element.removeChild(container);
    }

    element.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('insertText', false, text);

    // Re-append our container
    this.ensureContainer(element);

    state.text = text;
    const { nodeMap: newMap } = this.buildTextMap(element);
    state.nodeMap = newMap;
  }
}
