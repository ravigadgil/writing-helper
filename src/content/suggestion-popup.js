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

    // Use diff view for AI sentence suggestions
    if (lint._aiDiff) {
      this._renderDiffPopup(lint, targetElement);
    } else {
      this._renderStandardPopup(lint, targetElement);
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

  _renderStandardPopup(lint, targetElement) {
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
  }

  /**
   * Render a Grammarly-style diff popup showing old→new word changes.
   */
  _renderDiffPopup(lint, targetElement) {
    // Header
    const header = document.createElement('div');
    header.className = 'spelling-tab-diff-header';
    header.textContent = '✨ Writing suggestion';
    this.popupEl.appendChild(header);

    // Subtitle
    const sub = document.createElement('div');
    sub.className = 'spelling-tab-diff-subtitle';
    sub.textContent = 'Improve your text';
    this.popupEl.appendChild(sub);

    // Diff body — word-level comparison
    const diffBody = document.createElement('div');
    diffBody.className = 'spelling-tab-diff-body';

    const oldWords = lint.problemText.split(/\s+/);
    const newWords = lint.suggestions[0].text.split(/\s+/);
    const diff = this._computeWordDiff(oldWords, newWords);

    diff.forEach(({ type, word }) => {
      const span = document.createElement('span');
      span.textContent = word + ' ';
      if (type === 'removed') {
        span.className = 'spelling-tab-diff-removed';
      } else if (type === 'added') {
        span.className = 'spelling-tab-diff-added';
      }
      diffBody.appendChild(span);
    });

    this.popupEl.appendChild(diffBody);

    // Accept button
    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'spelling-tab-diff-accept';
    acceptBtn.textContent = 'Accept suggestion';
    acceptBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.onApply) {
        this.onApply(targetElement, lint, lint.suggestions[0]);
      }
      this.hide();
    });
    this.popupEl.appendChild(acceptBtn);

    // Dismiss button
    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'spelling-tab-diff-dismiss';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.hide();
    });
    this.popupEl.appendChild(dismissBtn);
  }

  /**
   * Simple word-level diff using longest common subsequence.
   */
  _computeWordDiff(oldWords, newWords) {
    const m = oldWords.length;
    const n = newWords.length;

    // Build LCS table
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (oldWords[i - 1].toLowerCase() === newWords[j - 1].toLowerCase()) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }

    // Backtrack to produce diff
    const result = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && oldWords[i - 1].toLowerCase() === newWords[j - 1].toLowerCase()) {
        result.unshift({ type: 'same', word: newWords[j - 1] });
        i--; j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        result.unshift({ type: 'added', word: newWords[j - 1] });
        j--;
      } else {
        result.unshift({ type: 'removed', word: oldWords[i - 1] });
        i--;
      }
    }

    return result;
  }

  hide() {
    this.popupEl.style.display = 'none';
    this.currentLint = null;
    this.currentElement = null;
  }
}
