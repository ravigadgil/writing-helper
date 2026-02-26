import { CE_SELECTOR } from './element-detector.js';

/**
 * Tiny "Tab to fix" hint that appears right after the user's blinking cursor.
 * Only shown when there are fixable errors and the user has typed.
 *
 * Caret position is captured at input time (before the async lint delay)
 * so it's always accurate to where the user just typed.
 *
 * NOT added to DOM until first needed.
 */
export class TabHint {
  constructor() {
    this.hintEl = null;
    this.visible = false;
    this._activeElement = null;
    this._inDOM = false;
    // Stored caret position — captured on every input event
    this._caretPos = null;
    this._listenForCaret();
  }

  /**
   * Listen for input/click/keyup to capture caret position in real time.
   * We store it so that when onLintsChanged fires 300ms later,
   * we can use the correct position.
   */
  _listenForCaret() {
    const capture = () => {
      this._caretPos = this._readCaretNow();
    };
    // Capture caret on every keystroke and click (covers typing + click-to-reposition)
    document.addEventListener('input', capture, true);
    document.addEventListener('keyup', capture, true);
    document.addEventListener('mouseup', capture, true);
  }

  /**
   * Read the current caret position from the DOM right now.
   */
  _readCaretNow() {
    const active = document.activeElement;
    if (!active) return null;

    // ContentEditable
    if (active.matches?.(CE_SELECTOR) ||
        active.closest?.(CE_SELECTOR)) {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
      const range = sel.getRangeAt(0).cloneRange();
      range.collapse(true);
      const rects = range.getClientRects();
      if (rects.length > 0) {
        const r = rects[0];
        return { left: r.right, top: r.top, bottom: r.bottom };
      }
      // Fallback for empty lines: use a temporary zero-width span
      try {
        const span = document.createElement('span');
        span.textContent = '\u200B';
        range.insertNode(span);
        const rect = span.getBoundingClientRect();
        const pos = { left: rect.right, top: rect.top, bottom: rect.bottom };
        // Remember parent and offset before removing
        const parent = span.parentNode;
        const offset = Array.from(parent.childNodes).indexOf(span);
        span.remove();
        // Restore selection with a fresh range
        try {
          const newRange = document.createRange();
          newRange.setStart(parent, Math.min(offset, parent.childNodes.length));
          newRange.collapse(true);
          sel.removeAllRanges();
          sel.addRange(newRange);
        } catch (_) {
          // Silently ignore if restore fails
        }
        return pos;
      } catch (e) {
        return null;
      }
    }

    // Textarea / input — no reliable way to get pixel position without heavy mirror work.
    // For now, return null and we'll skip showing the hint for textarea (underlines + popup still work).
    return null;
  }

  _ensureElement() {
    if (this.hintEl) return;
    this.hintEl = document.createElement('div');
    this.hintEl.className = 'spelling-tab-hint';
    this.hintEl.style.setProperty('display', 'none', 'important');
    this.hintEl.style.setProperty('position', 'fixed', 'important');
    this.hintEl.style.setProperty('z-index', '100002', 'important');
    this.hintEl.style.setProperty('pointer-events', 'none', 'important');
    this.hintEl.innerHTML =
      '<span class="spelling-tab-hint-key">Tab</span> <span class="spelling-tab-hint-text">to fix</span>';
  }

  _addToDOM() {
    if (this._inDOM) return;
    this._ensureElement();
    document.body.appendChild(this.hintEl);
    this._inDOM = true;
  }

  /**
   * Show hint using the last captured caret position.
   */
  showAtCaret(element) {
    this._activeElement = element;

    const pos = this._caretPos;
    if (!pos || pos.bottom === 0) {
      this.hide();
      return;
    }

    this._addToDOM();

    const hintWidth = 70;
    const hintHeight = 20;

    // Position below the caret, aligned to caret left edge
    let left = pos.left;
    let top = pos.bottom + 4;

    // If it would go off the bottom, put it above the caret instead
    if (top + hintHeight > window.innerHeight - 4) {
      top = pos.top - hintHeight - 4;
    }

    // If it would go off right side, shift left
    if (left + hintWidth > window.innerWidth - 8) {
      left = window.innerWidth - hintWidth - 8;
    }

    // Clamp to screen
    if (left < 4) left = 4;
    if (top < 4) top = 4;

    this.hintEl.style.setProperty('left', left + 'px', 'important');
    this.hintEl.style.setProperty('top', top + 'px', 'important');
    this.hintEl.style.setProperty('display', 'flex', 'important');
    this.hintEl.style.setProperty('position', 'fixed', 'important');
    this.visible = true;
  }

  hide() {
    if (this.hintEl) {
      this.hintEl.style.setProperty('display', 'none', 'important');
      this.hintEl.style.setProperty('position', 'fixed', 'important');
    }
    this.visible = false;
    this._activeElement = null;
  }

  reposition() {
    if (!this.visible || !this._activeElement) return;
    // Re-read caret and reposition
    this._caretPos = this._readCaretNow();
    if (this._caretPos) {
      this.showAtCaret(this._activeElement);
    } else {
      this.hide();
    }
  }
}
