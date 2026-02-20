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

    // AI Rewrite section — only for grammar/style lints (not simple spelling typos)
    if (lint.category !== 'spelling' || lint.isAI) {
      this._addAIRewriteSection(lint, targetElement);
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

  /** Get the text content from a tracked element */
  _getElementText(element) {
    if (element.value !== undefined) return element.value;
    return element.textContent || '';
  }

  /** Extract the sentence containing the lint span */
  _extractSentence(text, start, end) {
    // Look backwards for sentence boundary
    let sentStart = start;
    while (sentStart > 0 && !/[.!?]/.test(text[sentStart - 1])) sentStart--;
    // Look forwards for sentence boundary
    let sentEnd = end;
    while (sentEnd < text.length && !/[.!?]/.test(text[sentEnd])) sentEnd++;
    if (sentEnd < text.length) sentEnd++; // include the punctuation
    return { text: text.substring(sentStart, sentEnd).trim(), start: sentStart, end: sentEnd };
  }

  /** Add the AI Rewrite section to the popup */
  _addAIRewriteSection(lint, targetElement) {
    const fullText = this._getElementText(targetElement);
    const sentence = this._extractSentence(fullText, lint.span.start, lint.span.end);
    if (!sentence.text || sentence.text.length < 10) return;

    // Divider
    const divider = document.createElement('div');
    divider.className = 'spelling-tab-popup-ai-divider';
    this.popupEl.appendChild(divider);

    // AI section container
    const aiSection = document.createElement('div');
    aiSection.className = 'spelling-tab-popup-ai-section';

    // Label
    const label = document.createElement('div');
    label.className = 'spelling-tab-popup-ai-label';
    label.textContent = 'AI Rewrite';
    aiSection.appendChild(label);

    // Rephrase button
    const rephraseBtn = document.createElement('button');
    rephraseBtn.className = 'spelling-tab-popup-ai-btn';
    rephraseBtn.textContent = 'Rephrase this sentence';
    rephraseBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      rephraseBtn.textContent = 'Thinking...';
      rephraseBtn.disabled = true;

      try {
        const result = await chrome.runtime.sendMessage({
          type: 'ai-rewrite',
          text: sentence.text,
          tone: 'as-is',
          length: 'as-is',
        });

        if (result?.available && result.rewritten && result.rewritten !== sentence.text) {
          rephraseBtn.remove();

          // Show rewritten text as clickable suggestion
          const btn = document.createElement('button');
          btn.className = 'spelling-tab-popup-suggestion spelling-tab-popup-ai-suggestion';
          btn.textContent = result.rewritten;
          btn.addEventListener('click', (e2) => {
            e2.stopPropagation();
            if (this.onApply) {
              this.onApply(targetElement, {
                ...lint,
                span: { start: sentence.start, end: sentence.end },
              }, { text: result.rewritten, kind: 'ReplaceWith' });
            }
            this.hide();
          });
          aiSection.insertBefore(btn, aiSection.querySelector('.spelling-tab-popup-ai-tones'));

          // Show tone variant buttons
          this._addToneButtons(aiSection, sentence, targetElement, lint);
        } else {
          rephraseBtn.textContent = 'AI unavailable';
        }
      } catch (err) {
        rephraseBtn.textContent = 'AI unavailable';
      }
    });
    aiSection.appendChild(rephraseBtn);

    this.popupEl.appendChild(aiSection);
  }

  /** Add Formal / Casual / Shorter tone buttons */
  _addToneButtons(container, sentence, targetElement, lint) {
    const toneRow = document.createElement('div');
    toneRow.className = 'spelling-tab-popup-ai-tones';

    const variants = [
      { label: 'Formal', tone: 'more-formal', length: 'as-is' },
      { label: 'Casual', tone: 'more-casual', length: 'as-is' },
      { label: 'Shorter', tone: 'as-is', length: 'shorter' },
    ];

    for (const v of variants) {
      const btn = document.createElement('button');
      btn.className = 'spelling-tab-popup-ai-tone-btn';
      btn.textContent = v.label;
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const origText = btn.textContent;
        btn.textContent = '...';
        btn.disabled = true;

        try {
          const result = await chrome.runtime.sendMessage({
            type: 'ai-rewrite',
            text: sentence.text,
            tone: v.tone,
            length: v.length,
          });

          if (result?.available && result.rewritten) {
            const suggBtn = document.createElement('button');
            suggBtn.className = 'spelling-tab-popup-suggestion spelling-tab-popup-ai-suggestion';
            suggBtn.textContent = result.rewritten;
            suggBtn.addEventListener('click', (e2) => {
              e2.stopPropagation();
              if (this.onApply) {
                this.onApply(targetElement, {
                  ...lint,
                  span: { start: sentence.start, end: sentence.end },
                }, { text: result.rewritten, kind: 'ReplaceWith' });
              }
              this.hide();
            });
            container.insertBefore(suggBtn, toneRow);
          }
        } catch (err) { /* ignore */ }

        btn.textContent = origText;
        btn.disabled = false;
      });
      toneRow.appendChild(btn);
    }

    container.appendChild(toneRow);
  }

  hide() {
    this.popupEl.style.display = 'none';
    this.currentLint = null;
    this.currentElement = null;
  }
}
