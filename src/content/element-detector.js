// Selector for all contenteditable variants (including plaintext-only)
const CE_SELECTOR = '[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]';

export class ElementDetector {
  constructor(overlayManager, ceHandler) {
    this.overlayManager = overlayManager;
    this.ceHandler = ceHandler;
    this.trackedElements = new WeakSet();
    this.isEnabled = () => true; // overridable check
  }

  start() {
    // Don't scan the page on load — only attach to elements when user focuses them.
    // This prevents layout shifts and unwanted linting on page load.
    this.observeFocus();
  }

  track(element) {
    if (this.trackedElements.has(element)) return;
    this.trackedElements.add(element);

    if (element.matches(CE_SELECTOR)) {
      this.ceHandler.attach(element);
    } else {
      this.overlayManager.attach(element);
    }
  }

  /**
   * Only attach to elements when the user focuses them.
   *
   * Uses `composedPath()` to see through Shadow DOM boundaries —
   * this is critical for sites like Reddit that use Web Components
   * (Lit / shreddit-*) where the real contenteditable lives inside
   * a shadow root and `e.target` is retargeted to the shadow host.
   */
  observeFocus() {
    document.addEventListener('focusin', (e) => {
      if (!this.isEnabled()) return;

      // Walk the composed path (pierces shadow DOM) to find the real element
      const path = e.composedPath();
      for (const node of path) {
        if (!(node instanceof HTMLElement)) continue;

        if (node.matches('textarea, input[type="text"], input:not([type])')) {
          if (!this.trackedElements.has(node)) this.track(node);
          return;
        }
        if (node.matches(CE_SELECTOR)) {
          if (!this.trackedElements.has(node)) this.track(node);
          return;
        }
      }

      // Fallback: check e.target and its ancestors (non-shadow-DOM case)
      const el = e.target;
      if (!el) return;

      if (el.matches('textarea, input[type="text"], input:not([type])')) {
        if (!this.trackedElements.has(el)) this.track(el);
      } else if (el.matches(CE_SELECTOR)) {
        if (!this.trackedElements.has(el)) this.track(el);
      } else {
        const ceParent = el.closest(CE_SELECTOR);
        if (ceParent && !this.trackedElements.has(ceParent)) {
          this.track(ceParent);
        }
      }
    });
  }
}

export { CE_SELECTOR };
