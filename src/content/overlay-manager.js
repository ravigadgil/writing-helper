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

  renderOverlay(element, text, lints) {
    const state = this.overlays.get(element);
    if (!state) return;
    const overlay = state.overlay;
    overlay.innerHTML = '';

    if (lints.length === 0) return;

    const sorted = [...lints].sort((a, b) => a.span.start - b.span.start);

    let lastIndex = 0;
    sorted.forEach((lint, i) => {
      if (lint.span.start > lastIndex) {
        overlay.appendChild(
          document.createTextNode(text.substring(lastIndex, lint.span.start))
        );
      }

      const mark = document.createElement('mark');
      const cat = lint.isAI ? 'ai' : (lint.category || (lint.lintKind === 'Spelling' ? 'spelling' : 'grammar'));
      mark.className = 'spelling-tab-error-' + cat;
      mark.textContent = text.substring(lint.span.start, lint.span.end);
      mark.style.pointerEvents = 'auto';
      mark.style.cursor = 'pointer';
      mark.dataset.lintIndex = String(i);

      mark.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.suggestionPopup.show(lint, element, mark);
      });

      overlay.appendChild(mark);
      lastIndex = lint.span.end;
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
