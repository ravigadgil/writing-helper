const toggle = document.getElementById('toggle');
const loading = document.getElementById('loading');
const noIssues = document.getElementById('no-issues');
const issuesList = document.getElementById('issues-list');
const fixAllBtn = document.getElementById('fix-all-btn');

function getBadgeInfo(lint) {
  const cat = lint.category || 'grammar';
  const pretty = lint.lintKindPretty || lint.lintKind || 'Issue';
  switch (cat) {
    case 'spelling':
      return { cls: 'badge-spelling', label: pretty };
    case 'style':
      return { cls: 'badge-style', label: pretty };
    default:
      return { cls: 'badge-grammar', label: pretty };
  }
}

// Load enabled state
chrome.runtime.sendMessage({ type: 'get-enabled' }, (response) => {
  if (response) toggle.checked = response.enabled;
});

toggle.addEventListener('change', () => {
  chrome.runtime.sendMessage({ type: 'set-enabled', enabled: toggle.checked });
});

// Load issues for current tab
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (!tabs[0]) return;
  const tabId = tabs[0].id;

  chrome.runtime.sendMessage({ type: 'get-lints', tabId }, (response) => {
    loading.style.display = 'none';
    const lints = response?.lints || [];

    if (lints.length === 0) {
      noIssues.style.display = 'block';
      return;
    }

    fixAllBtn.style.display = 'block';
    fixAllBtn.textContent = `Fix All (${lints.length})`;

    lints.forEach((lint, index) => {
      const item = document.createElement('div');
      item.className = 'issue-item';

      const badgeInfo = getBadgeInfo(lint);

      const badge = document.createElement('span');
      badge.className = 'issue-badge ' + badgeInfo.cls;
      badge.textContent = badgeInfo.label;

      const info = document.createElement('div');
      info.className = 'issue-info';

      // Problem text with strikethrough
      const problemRow = document.createElement('div');
      problemRow.className = 'issue-problem';

      const errorText = document.createElement('span');
      errorText.className = 'issue-error-text';
      errorText.textContent = lint.problemText;
      problemRow.appendChild(errorText);

      // Message
      const msg = document.createElement('div');
      msg.className = 'issue-message';
      msg.textContent = lint.message;

      info.appendChild(problemRow);
      info.appendChild(msg);

      // Show ALL suggestions as clickable fix buttons
      if (lint.suggestions.length > 0) {
        const suggestionsRow = document.createElement('div');
        suggestionsRow.className = 'issue-suggestions';

        lint.suggestions.forEach((suggestion, suggIdx) => {
          const fixBtn = document.createElement('button');
          fixBtn.className = 'issue-fix-btn';
          fixBtn.textContent = suggestion.text || '(remove)';
          fixBtn.addEventListener('click', () => {
            chrome.tabs.sendMessage(tabId, {
              type: 'fix-single',
              lintIndex: index,
              suggestionIndex: suggIdx,
            });
            setTimeout(() => window.close(), 200);
          });
          suggestionsRow.appendChild(fixBtn);
        });

        info.appendChild(suggestionsRow);
      }

      item.appendChild(badge);
      item.appendChild(info);
      issuesList.appendChild(item);
    });

    // Fix All button
    fixAllBtn.addEventListener('click', () => {
      chrome.tabs.sendMessage(tabId, { type: 'fix-all' });
      setTimeout(() => window.close(), 200);
    });
  });
});
