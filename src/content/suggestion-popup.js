export class SuggestionPopup {
  constructor() {
    this.popupEl = null;
    this.currentLint = null;
    this.currentElement = null;
    this.onApply = null; // callback set by caller
    this.createPopupElement();
  }

  createPopupElement() {
    this.popupEl = document.createElement('div');
    this.popupEl.className = 'spelling-tab-popup';
    this.popupEl.style.display = 'none';
    document.body.appendChild(this.popupEl);

    // Close on click outside
    document.addEventListener('click', (e) => {
      if (this.popupEl.style.display !== 'none' && !this.popupEl.contains(e.target)) {
        this.hide();
      }
    });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hide();
    });
  }

  show(lint, targetElement, anchorElement) {
    this.currentLint = lint;
    this.currentElement = targetElement;
    this.popupEl.innerHTML = '';

    // Category label
    const cat = lint.category || 'grammar';
    const label = lint.lintKindPretty || lint.lintKind || 'Issue';
    const catEl = document.createElement('div');
    catEl.className = 'spelling-tab-popup-category spelling-tab-popup-cat-' + cat;
    catEl.textContent = label;
    this.popupEl.appendChild(catEl);

    // Error message
    const msg = document.createElement('div');
    msg.className = 'spelling-tab-popup-message';
    msg.textContent = lint.message;
    this.popupEl.appendChild(msg);

    // Problem text
    const problem = document.createElement('div');
    problem.className = 'spelling-tab-popup-problem';
    problem.textContent = `"${lint.problemText}"`;
    this.popupEl.appendChild(problem);

    // Suggestions
    if (lint.suggestions.length === 0) {
      const noSugg = document.createElement('div');
      noSugg.className = 'spelling-tab-popup-no-suggestion';
      noSugg.textContent = 'No suggestions available';
      this.popupEl.appendChild(noSugg);
    } else {
      lint.suggestions.forEach(suggestion => {
        const btn = document.createElement('button');
        btn.className = 'spelling-tab-popup-suggestion';
        btn.textContent = suggestion.text || '(remove)';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.onApply) {
            this.onApply(targetElement, lint, suggestion);
          }
          this.hide();
        });
        this.popupEl.appendChild(btn);
      });
    }

    // Position near the anchor
    const rect = anchorElement.getBoundingClientRect();
    this.popupEl.style.left = rect.left + 'px';
    this.popupEl.style.top = (rect.bottom + 4) + 'px';
    this.popupEl.style.display = 'block';

    // Ensure popup stays within viewport
    requestAnimationFrame(() => {
      const popupRect = this.popupEl.getBoundingClientRect();
      if (popupRect.right > window.innerWidth) {
        this.popupEl.style.left = (window.innerWidth - popupRect.width - 8) + 'px';
      }
      if (popupRect.bottom > window.innerHeight) {
        this.popupEl.style.top = (rect.top - popupRect.height - 4) + 'px';
      }
    });
  }

  hide() {
    this.popupEl.style.display = 'none';
    this.currentLint = null;
    this.currentElement = null;
  }
}
