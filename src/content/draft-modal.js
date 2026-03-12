export class DraftModal {
  constructor() {
    this.modalEl = null;
    this.targetElement = null;
    this.targetType = null; // 'overlay' or 'ce'
    this.selectedTone = 'neutral';
    this.draftedText = null;
    this.isGenerating = false;
    this._savedSelStart = null;
    this._savedSelEnd = null;
    this._built = false;
  }

  /**
   * Lazily build the modal DOM on first use (not at construction time).
   * This avoids the modal appearing before any user interaction.
   */
  _ensureBuilt() {
    if (this._built) return;
    this._built = true;
    this._createModal();
  }

  _createModal() {
    this.modalEl = document.createElement('div');
    this.modalEl.className = 'spelling-tab-draft-modal';
    this.modalEl.style.setProperty('display', 'none', 'important');

    const container = document.createElement('div');
    container.className = 'spelling-tab-draft-container';

    // Header
    const header = document.createElement('div');
    header.className = 'spelling-tab-draft-header';
    const title = document.createElement('span');
    title.textContent = '\u2728 AI Draft';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'spelling-tab-draft-close-x';
    closeBtn.textContent = '\u2715';
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); this.hide(); });
    header.appendChild(title);
    header.appendChild(closeBtn);
    container.appendChild(header);

    // Prompt textarea
    this.promptEl = document.createElement('textarea');
    this.promptEl.className = 'spelling-tab-draft-prompt';
    this.promptEl.placeholder = 'What do you want to write?';
    this.promptEl.rows = 3;
    container.appendChild(this.promptEl);

    // Tone buttons
    const tonesRow = document.createElement('div');
    tonesRow.className = 'spelling-tab-draft-tones';
    const tones = [
      { key: 'neutral', label: 'Neutral' },
      { key: 'friendly', label: '\ud83d\ude0a Friendly' },
      { key: 'professional', label: '\ud83d\udcbc Professional' },
      { key: 'casual', label: '\ud83d\udcac Casual' },
    ];
    this._toneButtons = [];
    tones.forEach(({ key, label }) => {
      const btn = document.createElement('button');
      btn.className = 'spelling-tab-draft-tone-btn';
      if (key === this.selectedTone) btn.classList.add('active');
      btn.textContent = label;
      btn.dataset.tone = key;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._selectTone(key);
      });
      tonesRow.appendChild(btn);
      this._toneButtons.push(btn);
    });
    container.appendChild(tonesRow);

    // Generate button
    this.generateBtn = document.createElement('button');
    this.generateBtn.className = 'spelling-tab-draft-generate';
    this.generateBtn.textContent = 'Generate';
    this.generateBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._onGenerate();
    });
    container.appendChild(this.generateBtn);

    // Loading indicator
    this.loadingEl = document.createElement('div');
    this.loadingEl.className = 'spelling-tab-draft-loading';
    this.loadingEl.style.setProperty('display', 'none', 'important');
    const spinner = document.createElement('span');
    spinner.className = 'spelling-tab-draft-spinner';
    this.loadingEl.appendChild(spinner);
    const loadingText = document.createElement('span');
    loadingText.textContent = ' Generating...';
    this.loadingEl.appendChild(loadingText);
    container.appendChild(this.loadingEl);

    // Result area
    this.resultArea = document.createElement('div');
    this.resultArea.className = 'spelling-tab-draft-result';
    this.resultArea.style.setProperty('display', 'none', 'important');

    this.resultText = document.createElement('div');
    this.resultText.className = 'spelling-tab-draft-result-text';
    this.resultArea.appendChild(this.resultText);

    const actions = document.createElement('div');
    actions.className = 'spelling-tab-draft-actions';

    this.insertBtn = document.createElement('button');
    this.insertBtn.className = 'spelling-tab-draft-insert';
    this.insertBtn.textContent = 'Insert';
    this.insertBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._onInsert();
    });
    actions.appendChild(this.insertBtn);

    const retryBtn = document.createElement('button');
    retryBtn.className = 'spelling-tab-draft-retry';
    retryBtn.textContent = 'Try Again';
    retryBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._onGenerate();
    });
    actions.appendChild(retryBtn);

    const closeBtn2 = document.createElement('button');
    closeBtn2.className = 'spelling-tab-draft-close-btn';
    closeBtn2.textContent = 'Close';
    closeBtn2.addEventListener('click', (e) => {
      e.stopPropagation();
      this.hide();
    });
    actions.appendChild(closeBtn2);

    this.resultArea.appendChild(actions);
    container.appendChild(this.resultArea);

    // Error area
    this.errorEl = document.createElement('div');
    this.errorEl.className = 'spelling-tab-draft-error';
    this.errorEl.style.setProperty('display', 'none', 'important');
    container.appendChild(this.errorEl);

    this.modalEl.appendChild(container);

    // Close on backdrop click
    this.modalEl.addEventListener('click', (e) => {
      if (e.target === this.modalEl) this.hide();
    });

    // Close on Escape, Ctrl+Enter to generate
    this.modalEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.hide();
      }
      // Ctrl+Enter or Cmd+Enter to generate
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        this._onGenerate();
      }
    });

    document.body.appendChild(this.modalEl);
  }

  show(element, type) {
    this._ensureBuilt();
    this.targetElement = element;
    this.targetType = type;
    this.draftedText = null;

    // Save cursor position for textarea/input
    if (type === 'overlay') {
      this._savedSelStart = element.selectionStart ?? element.value.length;
      this._savedSelEnd = element.selectionEnd ?? element.value.length;
    }

    // Reset UI
    this.promptEl.value = '';
    this.resultArea.style.setProperty('display', 'none', 'important');
    this.resultText.textContent = '';
    this.loadingEl.style.setProperty('display', 'none', 'important');
    this.errorEl.style.setProperty('display', 'none', 'important');
    this.generateBtn.disabled = false;
    this.generateBtn.textContent = 'Generate';

    this.modalEl.style.setProperty('display', 'flex', 'important');

    // Focus prompt after a tick so the modal is visible
    requestAnimationFrame(() => this.promptEl.focus());
  }

  hide() {
    if (this.modalEl) {
      this.modalEl.style.setProperty('display', 'none', 'important');
    }
    // Reset generating state so reopening works cleanly
    this.isGenerating = false;
    // Restore focus to the target element
    if (this.targetElement) {
      try {
        if (this.targetElement.isConnected) {
          this.targetElement.focus();
          if (this.targetType === 'overlay' && this._savedSelStart != null) {
            this.targetElement.selectionStart = this._savedSelStart;
            this.targetElement.selectionEnd = this._savedSelEnd;
          }
        }
      } catch (_) {}
    }
    this.targetElement = null;
    this.targetType = null;
  }

  isVisible() {
    if (!this.modalEl) return false;
    return this.modalEl.style.getPropertyValue('display') !== 'none';
  }

  _selectTone(tone) {
    this.selectedTone = tone;
    this._toneButtons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tone === tone);
    });
  }

  async _onGenerate() {
    const prompt = this.promptEl.value.trim();
    if (!prompt) {
      this.promptEl.focus();
      return;
    }

    if (this.isGenerating) return;
    this.isGenerating = true;

    // Show loading, hide result/error
    this.loadingEl.style.setProperty('display', 'flex', 'important');
    this.resultArea.style.setProperty('display', 'none', 'important');
    this.errorEl.style.setProperty('display', 'none', 'important');
    this.generateBtn.disabled = true;
    this.generateBtn.textContent = 'Generating...';

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'ai-draft',
        prompt,
        tone: this.selectedTone,
      });

      if (result?.available && result.drafted) {
        this.draftedText = result.drafted;
        this.resultText.textContent = result.drafted;
        this.resultArea.style.setProperty('display', 'block', 'important');
        this.loadingEl.style.setProperty('display', 'none', 'important');
      } else {
        this._showError('AI is not available. Make sure Chrome\'s built-in AI (Gemini Nano) is enabled.');
      }
    } catch (err) {
      this._showError('Failed to generate draft. Please try again.');
    } finally {
      this.isGenerating = false;
      this.generateBtn.disabled = false;
      this.generateBtn.textContent = 'Generate';
      this.loadingEl.style.setProperty('display', 'none', 'important');
    }
  }

  _showError(msg) {
    this.errorEl.textContent = msg;
    this.errorEl.style.setProperty('display', 'block', 'important');
    this.loadingEl.style.setProperty('display', 'none', 'important');
  }

  _onInsert() {
    if (!this.draftedText || !this.targetElement) return;

    // Guard: element may have been removed from DOM since modal opened
    if (!this.targetElement.isConnected) {
      this._showError('The text field is no longer available. Copy the text manually.');
      return;
    }

    if (this.targetType === 'overlay') {
      this._insertIntoTextarea(this.targetElement, this.draftedText);
    } else {
      this._insertIntoContentEditable(this.targetElement, this.draftedText);
    }

    this.hide();
  }

  _insertIntoTextarea(element, text) {
    const start = this._savedSelStart ?? element.value.length;
    const end = this._savedSelEnd ?? start;
    const before = element.value.substring(0, start);
    const after = element.value.substring(end);
    element.value = before + text + after;
    element.selectionStart = element.selectionEnd = start + text.length;
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }

  _insertIntoContentEditable(element, text) {
    element.focus();
    document.execCommand('insertText', false, text);
  }
}
