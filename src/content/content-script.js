import { LinterClient } from './linter-client.js';
import { SuggestionPopup } from './suggestion-popup.js';
import { OverlayManager } from './overlay-manager.js';
import { ContentEditableHandler } from './contenteditable-handler.js';
import { TabHint } from './fix-pill.js';
import { ElementDetector, CE_SELECTOR } from './element-detector.js';

const linterClient = new LinterClient();
const suggestionPopup = new SuggestionPopup();
const overlayManager = new OverlayManager(linterClient, suggestionPopup);
const ceHandler = new ContentEditableHandler(linterClient, suggestionPopup);
const tabHint = new TabHint();
const detector = new ElementDetector(overlayManager, ceHandler);

// ── Extension enabled state ──────────────────────────────────────────
let extensionEnabled = true;

// Query initial state
chrome.runtime.sendMessage({ type: 'get-enabled' }).then(r => {
  if (r && r.enabled === false) extensionEnabled = false;
}).catch(() => {});

// Listen for toggle changes from popup
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'enabled-changed') {
    extensionEnabled = message.enabled;
    if (!extensionEnabled) tabHint.hide();
  }
});

// Track which elements the user has actually typed in.
const userHasTypedIn = new WeakSet();

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el) userHasTypedIn.add(el);
  if (el) {
    const ceParent = el.closest?.(CE_SELECTOR);
    if (ceParent) userHasTypedIn.add(ceParent);
  }
  // Hide the "Tab to fix" hint while user is actively typing.
  // It will reappear once linting finishes (after the 300ms debounce).
  tabHint.hide();
}, true);

// Wire up suggestion popup apply callback
suggestionPopup.onApply = (element, lint, suggestion) => {
  tabHint.hide();
  if (element.matches(CE_SELECTOR)) {
    ceHandler.applySingleFix(element, lint, suggestion);
  } else {
    overlayManager.applySingleFix(element, lint, suggestion);
  }
};

// When lints change in overlay (textarea/input)
overlayManager.onLintsChanged = (element, lints) => {
  const fixable = lints.filter(l => l.suggestions.length > 0);

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
      active.closest?.(CE_SELECTOR);
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
    const ceAncestor = active.closest?.(CE_SELECTOR);
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

// Tab key handler — intercept in capture phase before browser focus navigation.
// Only prevent default if applyFixAll actually fixes something in the current paragraph.
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

  // Try to apply fixes — only consume Tab if something was actually fixed
  tabHint.hide();
  let fixed;
  if (target.type === 'overlay') {
    fixed = overlayManager.applyAllFixes(target.element);
  } else {
    fixed = ceHandler.applyAllFixes(target.element);
  }
  if (fixed) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

// ── Sentence-level AI suggestion (Grammarly-style) ───────────────────────

// Listen for sentence clicks from overlay-manager / contenteditable-handler
document.addEventListener('spelling-tab-sentence-click', async (e) => {
  const { sentence, anchorEl, element, cachedImproved } = e.detail;
  if (!sentence || !anchorEl || !element) return;

  const tracked = findTrackedElementFromNode(element);
  if (!tracked) return;

  // Use cached AI result if available (already checked in background)
  let improved = cachedImproved;

  if (!improved) {
    // Fallback: call AI now (shouldn't happen often since we pre-check)
    anchorEl.style.setProperty('background', 'rgba(139, 92, 246, 0.2)', 'important');
    anchorEl.style.setProperty('cursor', 'wait', 'important');

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'ai-improve',
        text: sentence.text,
      });
      if (result?.available && result.improved && result.improved !== sentence.text) {
        improved = result.improved;
      }
    } catch (err) {
      // silently fail
    }

    anchorEl.style.removeProperty('background');
    anchorEl.style.removeProperty('cursor');
  }

  if (improved) {
    const { spanStart, spanEnd } = findSpanInField(tracked, sentence.text);
    suggestionPopup.show({
      span: { start: spanStart, end: spanEnd },
      message: 'Writing suggestion',
      lintKind: 'Enhancement',
      lintKindPretty: 'AI Improvement',
      category: 'style',
      problemText: sentence.text,
      suggestions: [{ text: improved, kind: 'ReplaceWith' }],
      _aiDiff: true, // triggers diff rendering in popup
    }, tracked.element, anchorEl);
  }
});

// ── AI toolbar on text selection (Improve + Rephrase tones) ──────────────

let aiToolbar = null;
let lastUsedTone = null;

// Load last used tone from storage
chrome.storage.local.get('lastAITone', (result) => {
  if (result.lastAITone) lastUsedTone = result.lastAITone;
});

/**
 * Get the current text selection, supporting Shadow DOM.
 * `window.getSelection()` may not return selections inside shadow roots
 * on all browsers, so we also try to get it from the active shadow root.
 */
function getSelectionSafe() {
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return sel;

  // Fallback: try to get selection from the active element's shadow root
  const active = document.activeElement;
  if (active?.shadowRoot && typeof active.shadowRoot.getSelection === 'function') {
    try {
      const shadowSel = active.shadowRoot.getSelection();
      if (shadowSel && !shadowSel.isCollapsed) return shadowSel;
    } catch (_) {}
  }

  return sel;
}

function createAIToolbar() {
  if (aiToolbar) return aiToolbar;
  aiToolbar = document.createElement('div');
  aiToolbar.className = 'spelling-tab-ai-toolbar';
  aiToolbar.style.setProperty('display', 'none', 'important');
  document.body.appendChild(aiToolbar);
  return aiToolbar;
}

function hideAIToolbar() {
  if (aiToolbar) aiToolbar.style.setProperty('display', 'none', 'important');
}

function findTrackedElementFromNode(node) {
  // Walk up from node to find a tracked element
  let el = node;
  while (el) {
    if (overlayManager.overlays.has(el)) return { type: 'overlay', element: el };
    if (ceHandler.tracked.has(el)) return { type: 'ce', element: el };
    el = el.parentElement;
  }

  // Try closest() within the same tree (works within shadow roots)
  if (node instanceof HTMLElement || node?.parentElement) {
    const startEl = node instanceof HTMLElement ? node : node.parentElement;
    if (startEl) {
      const ceAncestor = startEl.closest?.(CE_SELECTOR);
      if (ceAncestor && ceHandler.tracked.has(ceAncestor)) {
        return { type: 'ce', element: ceAncestor };
      }
    }
  }

  // Fallback: check the active element's shadow root host chain
  const active = document.activeElement;
  if (active?.shadowRoot) {
    // The active element is a shadow host — check elements tracked inside it
    for (const [trackedEl] of ceHandler.tracked) {
      if (active.shadowRoot.contains(trackedEl)) {
        return { type: 'ce', element: trackedEl };
      }
    }
  }

  return null;
}

function findSpanInField(tracked, selectedText) {
  let spanStart = 0;
  let spanEnd = selectedText.length;

  if (tracked.type === 'overlay') {
    const fullText = tracked.element.value || '';
    const idx = fullText.indexOf(selectedText);
    if (idx !== -1) { spanStart = idx; spanEnd = idx + selectedText.length; }
  } else {
    const state = ceHandler.tracked.get(tracked.element);
    if (state) {
      const fullText = state.text || '';
      const idx = fullText.indexOf(selectedText);
      if (idx !== -1) { spanStart = idx; spanEnd = idx + selectedText.length; }
    }
  }

  return { spanStart, spanEnd };
}

async function handleAIAction(actionType, tone, selectedText, tracked, anchorEl) {
  try {
    let result;
    let label;
    let resultText;

    if (actionType === 'improve') {
      result = await chrome.runtime.sendMessage({ type: 'ai-improve', text: selectedText });
      resultText = result?.improved;
      label = 'AI-improved version';
    } else {
      result = await chrome.runtime.sendMessage({ type: 'ai-rephrase', text: selectedText, tone });
      resultText = result?.rephrased;
      const toneLabels = { friendly: 'Friendly', professional: 'Professional', casual: 'Casual' };
      label = `${toneLabels[tone] || 'AI'} rephrase`;
    }

    if (result?.available && resultText && resultText !== selectedText) {
      const { spanStart, spanEnd } = findSpanInField(tracked, selectedText);
      suggestionPopup.show({
        span: { start: spanStart, end: spanEnd },
        message: label,
        lintKind: 'Enhancement',
        lintKindPretty: 'AI Improvement',
        category: 'style',
        problemText: selectedText,
        suggestions: [{ text: resultText, kind: 'ReplaceWith' }],
      }, tracked.element, anchorEl);
      hideAIToolbar();
      return true;
    }
  } catch (err) {
    // fall through
  }
  return false;
}

/**
 * Show the AI toolbar for a given selection, tracked element, and bounding rect.
 */
function showAIToolbarForSelection(selectedText, tracked, rect) {
  const toolbar = createAIToolbar();
  toolbar.innerHTML = '';

  const toneOptions = [
    { label: '😊 Friendly', action: 'rephrase', tone: 'friendly' },
    { label: '💼 Professional', action: 'rephrase', tone: 'professional' },
    { label: '💬 Casual', action: 'rephrase', tone: 'casual' },
  ];

  // Reorder: put last-used tone first among the tone options
  if (lastUsedTone) {
    const idx = toneOptions.findIndex(t => t.tone === lastUsedTone);
    if (idx > 0) {
      const [fav] = toneOptions.splice(idx, 1);
      toneOptions.unshift(fav);
    }
  }

  const buttons = [
    { label: '✨ Improve', action: 'improve', tone: null },
    ...toneOptions,
  ];

  buttons.forEach(({ label, action, tone }) => {
    const btn = document.createElement('button');
    btn.className = 'spelling-tab-ai-btn';
    btn.textContent = label;

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Save last used tone
      if (tone) {
        lastUsedTone = tone;
        chrome.storage.local.set({ lastAITone: tone });
      }

      // Disable all buttons and show spinner on clicked one
      const allBtns = toolbar.querySelectorAll('.spelling-tab-ai-btn');
      allBtns.forEach(b => { b.disabled = true; });
      btn.classList.add('spelling-tab-ai-loading');
      btn.textContent = 'Working...';

      const success = await handleAIAction(action, tone, selectedText, tracked, toolbar);
      if (!success) {
        btn.textContent = 'AI not available';
        setTimeout(hideAIToolbar, 1500);
      }
    });

    toolbar.appendChild(btn);
  });

  toolbar.style.setProperty('display', 'flex', 'important');
  toolbar.style.setProperty('left', rect.left + 'px', 'important');
  toolbar.style.setProperty('top', (rect.top - 38 + window.scrollY) + 'px', 'important');

  // Clamp toolbar within viewport
  requestAnimationFrame(() => {
    const tbRect = toolbar.getBoundingClientRect();
    if (tbRect.right > window.innerWidth) {
      toolbar.style.setProperty('left', Math.max(4, window.innerWidth - tbRect.width - 8) + 'px', 'important');
    }
    if (tbRect.top < 0) {
      toolbar.style.setProperty('top', (rect.bottom + 4 + window.scrollY) + 'px', 'important');
    }
  });
}

/**
 * Try to get selection and show AI toolbar.
 * Works for both main document and shadow DOM selections.
 */
function tryShowAIToolbar(sel) {
  if (!sel || sel.isCollapsed || sel.toString().trim().length < 10) {
    hideAIToolbar();
    return;
  }

  const anchor = sel.anchorNode;
  const el = anchor?.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor;
  if (!el) { hideAIToolbar(); return; }

  const tracked = findTrackedElementFromNode(el);
  if (!tracked) { hideAIToolbar(); return; }

  const selectedText = sel.toString().trim();
  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();

  showAIToolbarForSelection(selectedText, tracked, rect);
}

document.addEventListener('mouseup', (e) => {
  if (aiToolbar && aiToolbar.contains(e.target)) return;
  tryShowAIToolbar(getSelectionSafe());
});

document.addEventListener('mousedown', (e) => {
  if (aiToolbar && !aiToolbar.contains(e.target)) hideAIToolbar();
});

// ── Shadow DOM: install mouseup listeners on tracked contenteditable elements ──
// window.getSelection() may not return selections inside shadow roots.
// By listening for mouseup directly on the element, we can get the selection
// from the element's root node, which works reliably in shadow DOM.
const _shadowMouseupElements = new WeakSet();

// Hook into ceHandler to install mouseup listeners when elements are attached
const _origCeAttach = ceHandler.attach.bind(ceHandler);
ceHandler.attach = function(element) {
  _origCeAttach(element);
  // If this element is inside a shadow root, add a direct mouseup listener
  const root = element.getRootNode();
  if (root instanceof ShadowRoot && !_shadowMouseupElements.has(element)) {
    _shadowMouseupElements.add(element);
    element.addEventListener('mouseup', () => {
      // Short delay to let the selection finalize
      setTimeout(() => {
        // Try getting selection from the shadow root first
        let sel = window.getSelection();
        if (!sel || sel.isCollapsed) {
          // Try shadow root's getSelection (non-standard, Chrome only)
          if (typeof root.getSelection === 'function') {
            try { sel = root.getSelection(); } catch (_) {}
          }
        }
        tryShowAIToolbar(sel);
      }, 10);
    });
  }
};

// ── Keyboard shortcut: Ctrl+Shift+I to improve selected text with AI ─────

document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey && e.shiftKey && e.key === 'I')) return;

  const sel = getSelectionSafe();
  if (!sel || sel.isCollapsed || sel.toString().trim().length < 10) return;

  const anchor = sel.anchorNode;
  const el = anchor?.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor;
  if (!el) return;

  const tracked = findTrackedElementFromNode(el);
  if (!tracked) return;

  e.preventDefault();
  e.stopPropagation();

  const selectedText = sel.toString().trim();

  // Show toolbar in "loading improve" state
  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  const toolbar = createAIToolbar();
  toolbar.innerHTML = '';

  const loadingBtn = document.createElement('button');
  loadingBtn.className = 'spelling-tab-ai-btn spelling-tab-ai-loading';
  loadingBtn.textContent = 'Improving...';
  loadingBtn.disabled = true;
  toolbar.appendChild(loadingBtn);

  toolbar.style.setProperty('display', 'flex', 'important');
  toolbar.style.setProperty('left', rect.left + 'px', 'important');
  toolbar.style.setProperty('top', (rect.top - 38 + window.scrollY) + 'px', 'important');

  handleAIAction('improve', null, selectedText, tracked, toolbar).then(success => {
    if (!success) {
      loadingBtn.classList.remove('spelling-tab-ai-loading');
      loadingBtn.textContent = 'AI not available';
      setTimeout(hideAIToolbar, 1500);
    }
  });
});

detector.isEnabled = () => extensionEnabled;
detector.start();
