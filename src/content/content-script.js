import { LinterClient } from './linter-client.js';
import { SuggestionPopup } from './suggestion-popup.js';
import { OverlayManager } from './overlay-manager.js';
import { ContentEditableHandler } from './contenteditable-handler.js';
import { TabHint } from './fix-pill.js';
import { ElementDetector } from './element-detector.js';

const linterClient = new LinterClient();
const suggestionPopup = new SuggestionPopup();
const overlayManager = new OverlayManager(linterClient, suggestionPopup);
const ceHandler = new ContentEditableHandler(linterClient, suggestionPopup);
const tabHint = new TabHint();
const detector = new ElementDetector(overlayManager, ceHandler);

// Track which elements the user has actually typed in.
const userHasTypedIn = new WeakSet();
// Track which elements currently have fixable lints
const hasFixableLints = new WeakSet();

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el) userHasTypedIn.add(el);
  if (el) {
    const ceParent = el.closest?.('[contenteditable="true"], [contenteditable=""]');
    if (ceParent) userHasTypedIn.add(ceParent);
  }
}, true);

// Wire up suggestion popup apply callback
suggestionPopup.onApply = (element, lint, suggestion) => {
  tabHint.hide();
  if (element.matches('[contenteditable="true"], [contenteditable=""]')) {
    ceHandler.applySingleFix(element, lint, suggestion);
  } else {
    overlayManager.applySingleFix(element, lint, suggestion);
  }
};

// When lints change in overlay (textarea/input)
overlayManager.onLintsChanged = (element, lints) => {
  const fixable = lints.filter(l => l.suggestions.length > 0);
  if (fixable.length > 0) {
    hasFixableLints.add(element);
  } else {
    hasFixableLints.delete(element);
  }

  if (document.activeElement !== element) return;
  if (!userHasTypedIn.has(element)) return;

  if (fixable.length > 0) {
    requestAnimationFrame(() => tabHint.showAtCaret(element));
  } else {
    tabHint.hide();
  }
};

// When lints change in contenteditable
ceHandler.onLintsChanged = (element, lints) => {
  const fixable = lints.filter(l => l.suggestions.length > 0);
  if (fixable.length > 0) {
    hasFixableLints.add(element);
  } else {
    hasFixableLints.delete(element);
  }

  const active = document.activeElement;
  const isFocused = active === element || element.contains(active);
  if (!isFocused) return;
  if (!userHasTypedIn.has(element)) return;

  if (fixable.length > 0) {
    requestAnimationFrame(() => tabHint.showAtCaret(element));
  } else {
    tabHint.hide();
  }
};

// Hide hint when focus leaves a tracked element
document.addEventListener('focusout', () => {
  setTimeout(() => {
    const active = document.activeElement;
    if (!active || active === document.body) {
      tabHint.hide();
      return;
    }
    const isTrackedOverlay = overlayManager.overlays.has(active);
    const isTrackedCE = ceHandler.tracked.has(active) ||
      active.closest?.('[contenteditable="true"], [contenteditable=""]');
    if (!isTrackedOverlay && !isTrackedCE) {
      tabHint.hide();
    }
  }, 100);
});

// Reposition hint on scroll/resize
window.addEventListener('scroll', () => tabHint.reposition(), { passive: true });
window.addEventListener('resize', () => tabHint.reposition(), { passive: true });

// Listen for messages from popup to apply fixes
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'fix-all') {
    applyFixAll();
    sendResponse({ ok: true });
  } else if (message.type === 'fix-single') {
    applyFixByIndex(message.lintIndex, message.suggestionIndex || 0);
    sendResponse({ ok: true });
  }
  return false;
});

function getActiveTrackedElement() {
  const active = document.activeElement;

  if (active && overlayManager.overlays.has(active)) {
    return { type: 'overlay', element: active };
  }

  if (active) {
    let el = active;
    while (el) {
      if (ceHandler.tracked.has(el)) return { type: 'ce', element: el };
      el = el.parentElement;
    }
    const ceAncestor = active.closest?.('[contenteditable="true"], [contenteditable=""]');
    if (ceAncestor && ceHandler.tracked.has(ceAncestor)) {
      return { type: 'ce', element: ceAncestor };
    }
  }

  // Fallback: find any tracked element with lints
  for (const [element, state] of overlayManager.overlays) {
    if (state.lints.length > 0) return { type: 'overlay', element };
  }
  for (const [element, state] of ceHandler.tracked) {
    if (state.lints.length > 0) return { type: 'ce', element };
  }

  return null;
}

function applyFixAll() {
  tabHint.hide();
  const target = getActiveTrackedElement();
  if (!target) return;
  if (target.type === 'overlay') {
    overlayManager.applyAllFixes(target.element);
  } else {
    ceHandler.applyAllFixes(target.element);
  }
}

function applyFixByIndex(lintIndex, suggestionIndex = 0) {
  const target = getActiveTrackedElement();
  if (!target) return;

  let state, handler;
  if (target.type === 'overlay') {
    state = overlayManager.overlays.get(target.element);
    handler = overlayManager;
  } else {
    state = ceHandler.tracked.get(target.element);
    handler = ceHandler;
  }

  if (!state || !state.lints[lintIndex]) return;
  const lint = state.lints[lintIndex];
  if (lint.suggestions.length === 0) return;
  const suggestion = lint.suggestions[suggestionIndex] || lint.suggestions[0];
  tabHint.hide();
  handler.applySingleFix(target.element, lint, suggestion);
}

// Tab key handler — intercept in capture phase before browser focus navigation
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;

  const target = getActiveTrackedElement();
  if (!target) return;

  let state;
  if (target.type === 'overlay') {
    state = overlayManager.overlays.get(target.element);
  } else {
    state = ceHandler.tracked.get(target.element);
  }

  if (!state || state.lints.length === 0) return;
  if (!state.lints.some(l => l.suggestions.length > 0)) return;

  e.preventDefault();
  e.stopPropagation();
  applyFixAll();
}, true);

detector.start();
