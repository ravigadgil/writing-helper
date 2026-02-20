export class TabFixAll {
  constructor(overlayManager, ceHandler) {
    this.overlayManager = overlayManager;
    this.ceHandler = ceHandler;
  }

  start() {
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;

      const active = document.activeElement;
      if (!active) return;

      // Check textarea/input overlays
      if (this.overlayManager.overlays.has(active)) {
        const state = this.overlayManager.overlays.get(active);
        if (state.lints.length > 0 && state.lints.some(l => l.suggestions.length > 0)) {
          e.preventDefault();
          this.overlayManager.applyAllFixes(active);
          return;
        }
      }

      // Check contenteditable elements
      // Walk up from active element AND check closest contenteditable
      const found = this.findTrackedContentEditable(active);
      if (found) {
        const state = this.ceHandler.tracked.get(found);
        if (state.lints.length > 0 && state.lints.some(l => l.suggestions.length > 0)) {
          e.preventDefault();
          this.ceHandler.applyAllFixes(found);
          return;
        }
      }

      // No fixes to apply — let Tab behave normally
    });
  }

  findTrackedContentEditable(element) {
    // Strategy 1: Walk up from active element
    let el = element;
    while (el) {
      if (this.ceHandler.tracked.has(el)) return el;
      el = el.parentElement;
    }

    // Strategy 2: Check if active element is inside a contenteditable
    // (handles cases where activeElement is a child node, not the CE root)
    const ceAncestor = element.closest('[contenteditable="true"], [contenteditable=""]');
    if (ceAncestor && this.ceHandler.tracked.has(ceAncestor)) {
      return ceAncestor;
    }

    // Strategy 3: Check selection — the cursor might be in a contenteditable
    // even if activeElement doesn't reflect it
    const sel = window.getSelection();
    if (sel && sel.anchorNode) {
      let node = sel.anchorNode.nodeType === Node.TEXT_NODE
        ? sel.anchorNode.parentElement
        : sel.anchorNode;
      while (node) {
        if (this.ceHandler.tracked.has(node)) return node;
        node = node.parentElement;
      }
    }

    return null;
  }
}
