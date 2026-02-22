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

    if (element.matches('[contenteditable="true"], [contenteditable=""]')) {
      this.ceHandler.attach(element);
    } else {
      this.overlayManager.attach(element);
    }
  }

  // Only attach to elements when the user focuses them
  observeFocus() {
    document.addEventListener('focusin', (e) => {
      const el = e.target;
      if (!el) return;
      if (!this.isEnabled()) return;

      if (el.matches('textarea, input[type="text"], input:not([type])')) {
        if (!this.trackedElements.has(el)) this.track(el);
      } else if (el.matches('[contenteditable="true"], [contenteditable=""]')) {
        if (!this.trackedElements.has(el)) this.track(el);
      } else {
        // Check if focused element is inside an untracked contenteditable
        const ceParent = el.closest('[contenteditable="true"], [contenteditable=""]');
        if (ceParent && !this.trackedElements.has(ceParent)) {
          this.track(ceParent);
        }
      }
    });
  }
}
