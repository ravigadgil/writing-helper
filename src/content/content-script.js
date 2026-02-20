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

// Listen for messages from popup and service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'fix-all') {
    applyFixAll();
    sendResponse({ ok: true });
  } else if (message.type === 'fix-single') {
    applyFixByIndex(message.lintIndex, message.suggestionIndex || 0);
    sendResponse({ ok: true });
  } else if (message.type === 'ai-lints-update') {
    handleAILintsUpdate(message);
    sendResponse({ ok: true });
  }
  return false;
});

// ── AI Lint Updates (Phase 2 — async merge) ──────────────────────────────

function handleAILintsUpdate(message) {
  const { lints, text } = message;

  // Find the tracked element that currently has this text
  // Check textarea/input overlays
  for (const [element, state] of overlayManager.overlays) {
    if (element.value === text) {
      state.lints = lints;
      linterClient.updateCacheForText(text, lints);
      overlayManager.renderOverlay(element, text, lints);
      if (overlayManager.onLintsChanged) overlayManager.onLintsChanged(element, lints);
      return;
    }
  }

  // Check contenteditable elements
  for (const [element, state] of ceHandler.tracked) {
    if (state.text === text) {
      state.lints = lints;
      linterClient.updateCacheForText(text, lints);
      ceHandler.renderUnderlines(element);
      if (ceHandler.onLintsChanged) ceHandler.onLintsChanged(element, lints);
      return;
    }
  }
}

// ── AI Improve — Floating Button on Text Selection ───────────────────────

let aiImproveBtn = null;

function createAIImproveBtn() {
  if (aiImproveBtn) return aiImproveBtn;
  aiImproveBtn = document.createElement('button');
  aiImproveBtn.className = 'spelling-tab-ai-improve-btn';
  aiImproveBtn.textContent = 'Improve with AI';
  aiImproveBtn.style.setProperty('display', 'none', 'important');
  document.body.appendChild(aiImproveBtn);
  return aiImproveBtn;
}

function hideAIImproveBtn() {
  if (aiImproveBtn) aiImproveBtn.style.setProperty('display', 'none', 'important');
}

document.addEventListener('mouseup', (e) => {
  // Don't show if clicking the button itself
  if (e.target === aiImproveBtn) return;

  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.toString().trim().length < 10) {
    hideAIImproveBtn();
    return;
  }

  // Check if selection is inside a tracked element
  const anchor = sel.anchorNode;
  const el = anchor?.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor;
  if (!el) { hideAIImproveBtn(); return; }

  const trackedInfo = findTrackedElementFromNode(el);
  if (!trackedInfo) { hideAIImproveBtn(); return; }

  const selectedText = sel.toString().trim();
  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();

  const btn = createAIImproveBtn();
  btn.style.setProperty('left', rect.left + 'px', 'important');
  btn.style.setProperty('top', (rect.top - 34 + window.scrollY) + 'px', 'important');
  btn.style.setProperty('display', 'block', 'important');
  btn.disabled = false;
  btn.textContent = 'Improve with AI';

  btn.onclick = async () => {
    btn.textContent = 'Improving...';
    btn.disabled = true;

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'ai-improve',
        text: selectedText,
      });

      if (result?.available && result.improved && result.improved !== selectedText) {
        // Show result in suggestion popup
        const improveLint = {
          span: { start: 0, end: selectedText.length },
          message: 'AI-improved version',
          lintKind: 'Enhancement',
          lintKindPretty: 'AI Improvement',
          category: 'style',
          problemText: selectedText,
          suggestions: [{ text: result.improved, kind: 'ReplaceWith' }],
          isAI: true,
        };
        suggestionPopup.show(improveLint, trackedInfo.element, btn);
      } else {
        btn.textContent = 'AI unavailable';
        setTimeout(hideAIImproveBtn, 1500);
      }
    } catch (err) {
      btn.textContent = 'AI unavailable';
      setTimeout(hideAIImproveBtn, 1500);
    }
  };
});

function findTrackedElementFromNode(node) {
  // Check overlay-tracked textarea/input
  let el = node;
  while (el) {
    if (overlayManager.overlays.has(el)) return { type: 'overlay', element: el };
    el = el.parentElement;
  }

  // Check contenteditable
  el = node;
  while (el) {
    if (ceHandler.tracked.has(el)) return { type: 'ce', element: el };
    const ceAncestor = el.closest?.('[contenteditable="true"], [contenteditable=""]');
    if (ceAncestor && ceHandler.tracked.has(ceAncestor)) return { type: 'ce', element: ceAncestor };
    el = el.parentElement;
  }

  return null;
}

// Hide improve button on scroll or click elsewhere
document.addEventListener('mousedown', (e) => {
  if (e.target !== aiImproveBtn) hideAIImproveBtn();
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
