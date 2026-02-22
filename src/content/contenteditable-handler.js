export class ContentEditableHandler {
  constructor(linterClient, suggestionPopup) {
    this.linterClient = linterClient;
    this.suggestionPopup = suggestionPopup;
    this.tracked = new Map(); // element -> { container, debounceTimer, lints, text, nodeMap }
    this.onLintsChanged = null; // callback: (element, lints) => void
    // Cache AI sentence check results: sentenceText -> { improved: string|null }
    this._aiSentenceCache = new Map();
    this._aiSentenceChecking = new Set(); // sentences currently being checked
    this._styledShadowRoots = new WeakSet(); // shadow roots we've already injected CSS into
  }

  attach(element) {
    if (this.tracked.has(element)) return;

    // If element is inside a shadow root, inject our styles there
    this._ensureShadowStyles(element);

    const container = this._createStyledContainer();

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
   * Create the overlay container with inline fallback styles.
   * Inline styles ensure visibility even when CSS hasn't loaded in shadow DOM.
   */
  _createStyledContainer() {
    const container = document.createElement('div');
    container.className = 'spelling-tab-ce-container';
    container.style.cssText = [
      'position: absolute',
      'top: 0',
      'left: 0',
      'width: 100%',
      'height: 100%',
      'pointer-events: none',
      'overflow: hidden',
      'z-index: 10000',
    ].join(' !important;') + ' !important;';
    return container;
  }

  /**
   * If the element lives inside a Shadow DOM, inject our extension CSS
   * into that shadow root so underlines and overlays render correctly.
   * Content script CSS only applies to the main document — shadow roots
   * are isolated from external styles.
   *
   * Uses a <link> tag (loaded by the browser) instead of fetch() for reliability.
   * Also triggers a re-render once CSS loads so underlines pick up full styles.
   */
  _ensureShadowStyles(element) {
    const root = element.getRootNode();
    if (!(root instanceof ShadowRoot)) return;
    if (this._styledShadowRoots.has(root)) return;
    this._styledShadowRoots.add(root);

    const cssUrl = chrome.runtime.getURL('content/styles.css');

    // Primary: <link> tag (browser handles loading)
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = cssUrl;
    link.setAttribute('data-writing-helper', 'true');
    link.onload = () => {
      // Re-render underlines now that CSS is available
      if (this.tracked.has(element)) {
        this.renderUnderlines(element);
      }
    };
    root.appendChild(link);

    // Fallback: also try fetch + inline <style> (in case <link> doesn't work)
    fetch(cssUrl)
      .then(r => r.text())
      .then(cssText => {
        // Only inject if <link> didn't already load
        if (!root.querySelector('link[data-writing-helper]')?.sheet) {
          const style = document.createElement('style');
          style.setAttribute('data-writing-helper-fallback', 'true');
          style.textContent = cssText;
          root.appendChild(style);
          if (this.tracked.has(element)) {
            this.renderUnderlines(element);
          }
        }
      })
      .catch(() => {});
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
      const container = this._createStyledContainer();
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

    // Known inline HTML elements — everything else (including custom elements
    // like Reddit's <shreddit-*> Lit components) is treated as a block boundary.
    // This prevents word concatenation when sites use custom web components.
    const inlineTags = new Set([
      'A', 'ABBR', 'ACRONYM', 'B', 'BDI', 'BDO', 'BIG', 'CITE', 'CODE',
      'DATA', 'DEL', 'DFN', 'EM', 'FONT', 'I', 'IMG', 'INS', 'KBD',
      'LABEL', 'MARK', 'Q', 'RP', 'RT', 'RUBY', 'S', 'SAMP', 'SMALL',
      'SPAN', 'STRIKE', 'STRONG', 'SUB', 'SUP', 'TIME', 'TT', 'U',
      'VAR', 'WBR',
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

        // Treat any non-inline element as a block boundary (insert newline).
        // This handles standard block tags AND custom web components (e.g. <shreddit-*>).
        const isBlock = !inlineTags.has(tag);
        if (isBlock && offset > 0 && !blockBreakInserted.has(node)) {
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

  /**
   * Extract sentence boundaries from text.
   * Returns array of { start, end, text } for sentences with 5+ words.
   */
  extractSentences(text) {
    const sentences = [];
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

  renderUnderlines(element) {
    const state = this.tracked.get(element);
    if (!state) return;

    // Ensure container is still in DOM
    this.ensureContainer(element);

    const { container, lints, nodeMap, text } = state;
    container.innerHTML = '';

    if (!nodeMap?.length) return;

    const elementRect = element.getBoundingClientRect();

    // Underline color map — used for inline fallback styles in shadow DOM
    const UNDERLINE_COLORS = {
      spelling: '#e74c3c',
      grammar: '#3498db',
      style: '#f59e0b',
    };

    // ── Render lint underlines ──────────────────────────────────
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

          // Position (always inline)
          const left = (rect.left - elementRect.left + element.scrollLeft) + 'px';
          const top = (rect.bottom - elementRect.top + element.scrollTop - 2) + 'px';
          const width = rect.width + 'px';

          // Inline fallback styles — ensures visibility even without CSS (shadow DOM)
          const color = UNDERLINE_COLORS[cat] || UNDERLINE_COLORS.spelling;
          underline.style.cssText = [
            `position: absolute`,
            `left: ${left}`,
            `top: ${top}`,
            `width: ${width}`,
            `height: 2px`,
            `background: linear-gradient(45deg, transparent 25%, ${color} 25%, ${color} 50%, transparent 50%, transparent 75%, ${color} 75%)`,
            `background-size: 4px 2px`,
            `pointer-events: auto`,
            `cursor: pointer`,
          ].join(';');

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

    // ── Render sentence-level AI suggestion highlights ──────────
    // Only highlight the specific WORDS that AI wants to change, not full sentences.
    if (!text) return;
    const sentences = this.extractSentences(text);
    state.sentences = sentences;

    // Check sentences with AI in the background (non-blocking)
    this._checkSentencesWithAI(sentences, element);

    // Only render highlights for sentences that AI has confirmed
    const confirmedSentences = sentences.filter(s => this._aiSentenceCache.has(s.text));

    confirmedSentences.forEach((sentence) => {
      const cached = this._aiSentenceCache.get(sentence.text);
      if (!cached?.improved) return;

      // Find which words in the original sentence are changed by the AI
      const changedRanges = this._findChangedWordRanges(sentence.text, cached.improved, sentence.start);

      for (const cr of changedRanges) {
        try {
          const range = document.createRange();
          const startInfo = this.findNodeAtOffset(nodeMap, cr.start);
          const endInfo = this.findNodeAtOffset(nodeMap, cr.end);
          if (!startInfo || !endInfo) continue;

          range.setStart(startInfo.node, cr.start - startInfo.start);
          range.setEnd(endInfo.node, Math.min(cr.end - endInfo.start, endInfo.node.textContent.length));

          const rects = range.getClientRects();
          for (const rect of rects) {
            const highlight = document.createElement('div');
            highlight.className = 'spelling-tab-underline-sentence';

            // Inline fallback styles for shadow DOM
            const left = (rect.left - elementRect.left + element.scrollLeft) + 'px';
            const top = (rect.bottom - elementRect.top + element.scrollTop - 1) + 'px';
            const width = rect.width + 'px';
            highlight.style.cssText = [
              `position: absolute`,
              `left: ${left}`,
              `top: ${top}`,
              `width: ${width}`,
              `height: 2.5px`,
              `background: rgba(139, 92, 246, 0.5)`,
              `pointer-events: auto`,
              `cursor: pointer`,
              `border-radius: 1px`,
            ].join(';');

            highlight.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
              document.dispatchEvent(new CustomEvent('spelling-tab-sentence-click', {
                detail: { sentence, anchorEl: highlight, element, cachedImproved: cached.improved },
              }));
            });

            container.appendChild(highlight);
          }
        } catch (err) {
          // Range operations can fail if DOM changed; skip
        }
      }
    });
  }

  /**
   * Find character ranges in the original sentence where words differ from the improved version.
   * Returns array of { start, end } (absolute offsets in the full text).
   */
  _findChangedWordRanges(original, improved, sentenceOffset) {
    const origWords = original.match(/\S+/g) || [];
    const impWords = improved.match(/\S+/g) || [];
    const ranges = [];

    // Build LCS to find matching words
    const lcs = this._lcsWords(origWords, impWords);
    const lcsSet = new Set(lcs.map(m => m.origIdx));

    // Any original word NOT in the LCS is "changed" — highlight it
    let searchFrom = 0;
    for (let i = 0; i < origWords.length; i++) {
      if (lcsSet.has(i)) continue;

      // Find the position of this word in the original text
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
    // Backtrack
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

  /**
   * Check sentences with AI in the background.
   * Only checks sentences not already cached or in-flight.
   * When a result arrives, re-renders underlines to show/hide highlights.
   */
  async _checkSentencesWithAI(sentences, element) {
    // Debounce AI checks — wait 2s after last call to avoid flooding the Prompt API
    clearTimeout(this._aiDebounceTimer);
    this._aiDebounceTimer = setTimeout(() => {
      this._doCheckSentencesWithAI(sentences, element);
    }, 2000);
  }

  async _doCheckSentencesWithAI(sentences, element) {
    for (const sentence of sentences) {
      if (this._aiSentenceCache.has(sentence.text)) continue;
      if (this._aiSentenceChecking.has(sentence.text)) continue;

      this._aiSentenceChecking.add(sentence.text);

      // Cap cache size to prevent memory leak
      if (this._aiSentenceCache.size > 200) {
        const firstKey = this._aiSentenceCache.keys().next().value;
        this._aiSentenceCache.delete(firstKey);
      }

      // Fire and forget — re-render when result comes back
      chrome.runtime.sendMessage({ type: 'ai-improve', text: sentence.text })
        .then(result => {
          this._aiSentenceChecking.delete(sentence.text);
          if (result?.available && result.improved && result.improved !== sentence.text) {
            this._aiSentenceCache.set(sentence.text, { improved: result.improved });
            // Re-render to show the new highlight
            this.renderUnderlines(element);
          }
        })
        .catch(() => {
          this._aiSentenceChecking.delete(sentence.text);
        });
    }
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

  /**
   * Find the paragraph (newline-delimited block) boundaries around a given offset.
   */
  _getParagraphRange(text, cursorOffset) {
    let start = text.lastIndexOf('\n', cursorOffset - 1);
    start = start === -1 ? 0 : start + 1;
    let end = text.indexOf('\n', cursorOffset);
    if (end === -1) end = text.length;
    return { start, end };
  }

  /**
   * Get the cursor offset in the flat text map, or -1 if cursor is not in this element.
   */
  getCursorOffset(element) {
    const state = this.tracked.get(element);
    if (!state) return -1;

    // Try shadow root selection first (for shadow DOM elements)
    let sel = window.getSelection();
    if ((!sel || sel.rangeCount === 0) && element.getRootNode() instanceof ShadowRoot) {
      try {
        const shadowSel = element.getRootNode().getSelection?.();
        if (shadowSel && shadowSel.rangeCount > 0) sel = shadowSel;
      } catch (_) {}
    }
    if (!sel || sel.rangeCount === 0) return -1;

    const range = sel.getRangeAt(0);
    let cursorNode = range.startContainer;
    let cursorNodeOffset = range.startOffset;

    // If the cursor is at an element node (not a text node), resolve to the
    // actual text node child. This happens in Gmail when cursor sits at a <div>.
    if (cursorNode.nodeType === Node.ELEMENT_NODE) {
      const children = cursorNode.childNodes;
      if (cursorNodeOffset < children.length) {
        const child = children[cursorNodeOffset];
        if (child.nodeType === Node.TEXT_NODE) {
          cursorNode = child;
          cursorNodeOffset = 0;
        } else {
          // Cursor is before a block element — find the closest text node before it
          for (let k = cursorNodeOffset - 1; k >= 0; k--) {
            const prev = children[k];
            if (prev.nodeType === Node.TEXT_NODE) {
              cursorNode = prev;
              cursorNodeOffset = prev.textContent.length;
              break;
            }
            // Look for text node inside the previous element
            const lastText = this._lastTextNode(prev);
            if (lastText) {
              cursorNode = lastText;
              cursorNodeOffset = lastText.textContent.length;
              break;
            }
          }
        }
      } else if (children.length > 0) {
        // Cursor is at the end — use last text node
        const lastText = this._lastTextNode(cursorNode);
        if (lastText) {
          cursorNode = lastText;
          cursorNodeOffset = lastText.textContent.length;
        }
      }
    }

    // Find this node in our nodeMap
    for (const entry of state.nodeMap) {
      if (entry.synthetic) continue;
      if (entry.node === cursorNode) {
        return entry.start + Math.min(cursorNodeOffset, entry.node.textContent.length);
      }
    }
    return -1;
  }

  /**
   * Get the selection for an element, trying shadow root selection as fallback.
   */
  _getSelection(element) {
    let sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) return sel;
    // For shadow DOM: try the shadow root's getSelection (Chrome non-standard)
    const root = element.getRootNode();
    if (root instanceof ShadowRoot && typeof root.getSelection === 'function') {
      try {
        const shadowSel = root.getSelection();
        if (shadowSel && shadowSel.rangeCount > 0) return shadowSel;
      } catch (_) {}
    }
    return sel;
  }

  /**
   * Find the last text node descendant of a node (depth-first, right-to-left).
   */
  _lastTextNode(node) {
    if (node.nodeType === Node.TEXT_NODE) return node;
    for (let i = node.childNodes.length - 1; i >= 0; i--) {
      const result = this._lastTextNode(node.childNodes[i]);
      if (result) return result;
    }
    return null;
  }

  applyAllFixes(element) {
    const state = this.tracked.get(element);
    if (!state || state.lints.length === 0) return false;

    // Find which paragraph the cursor is in
    const cursorOffset = this.getCursorOffset(element);
    let paraRange = null;
    if (cursorOffset >= 0 && state.text) {
      paraRange = this._getParagraphRange(state.text, cursorOffset);
    }

    // Only fix lints within the cursor's paragraph (or all if cursor not found).
    // Also skip any lint that spans across a newline — applying those would merge paragraphs.
    const fixable = state.lints.filter(l => {
      if (l.suggestions.length === 0) return false;
      // Never auto-fix lints that cross paragraph boundaries
      const lintText = state.text.substring(l.span.start, l.span.end);
      if (lintText.includes('\n')) return false;
      if (paraRange) {
        return l.span.start >= paraRange.start && l.span.end <= paraRange.end;
      }
      return true;
    });
    if (fixable.length === 0) return false;

    // Collect the original problem text, replacement, and original span offset.
    // Sort in reverse order so that applying fixes from the end doesn't shift earlier offsets.
    const fixes = fixable
      .map(l => ({
        problem: state.text.substring(l.span.start, l.span.end),
        replacement: l.suggestions[0].text,
        originalStart: l.span.start,
        span: { ...l.span },
      }))
      .sort((a, b) => b.span.start - a.span.start); // reverse order

    for (const fix of fixes) {
      // Rebuild text map to get fresh DOM state
      const { text, nodeMap } = this.buildTextMap(element);
      state.text = text;
      state.nodeMap = nodeMap;

      // Search for the problem text near where we expect it (within the paragraph).
      // Use the original span start as a hint to find the right occurrence,
      // searching outward from that position to handle minor shifts from prior fixes.
      let idx = -1;
      const searchStart = Math.max(0, fix.originalStart - 50);
      const searchEnd = Math.min(text.length, fix.originalStart + fix.problem.length + 50);
      const nearbyText = text.substring(searchStart, searchEnd);
      const localIdx = nearbyText.indexOf(fix.problem);
      if (localIdx !== -1) {
        idx = searchStart + localIdx;
      } else {
        // Fallback: search entire text (may match wrong occurrence)
        idx = text.indexOf(fix.problem);
      }
      if (idx === -1) continue;

      const synthLint = { span: { start: idx, end: idx + fix.problem.length } };
      try {
        const startInfo = this.findNodeAtOffset(nodeMap, synthLint.span.start);
        const endInfo = this.findNodeAtOffset(nodeMap, synthLint.span.end);
        if (!startInfo || !endInfo) continue;

        element.focus();
        const range = document.createRange();
        range.setStart(startInfo.node, synthLint.span.start - startInfo.start);
        range.setEnd(endInfo.node, Math.min(synthLint.span.end - endInfo.start, endInfo.node.textContent.length));

        const sel = this._getSelection(element) || window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('insertText', false, fix.replacement);

        this.ensureContainer(element);
      } catch (err) {
        // Skip this fix if it fails
      }
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

      const sel = this._getSelection(element) || window.getSelection();
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
      console.warn('Writing Helper: ranged fix failed, falling back', err);
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
    const sel = this._getSelection(element) || window.getSelection();
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
