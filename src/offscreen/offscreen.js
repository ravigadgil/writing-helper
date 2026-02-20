/**
 * Offscreen document — the AI hub for Spelling Tab.
 *
 * Chrome's Proofreader, Rewriter, Writer, and Prompt APIs require a DOM context
 * (they don't work in service workers). This offscreen document acts as a hidden
 * page that the service worker can communicate with to run AI operations.
 *
 * All AI calls are wrapped in try/catch and return { available: false } on failure,
 * ensuring the extension degrades gracefully when AI is unavailable.
 */

// ── AI Capability Detection ────────────────────────────────────────────────

let _capabilities = null;

async function getAICapabilities() {
  if (_capabilities) return _capabilities;

  _capabilities = {
    proofreader: false,
    rewriter: false,
    writer: false,
    promptApi: false,
  };

  // Check Proofreader API
  if (typeof Proofreader !== 'undefined') {
    try {
      const avail = await Proofreader.availability();
      _capabilities.proofreader = (avail === 'available' || avail === 'downloadable' || avail === 'downloading');
    } catch (e) { /* unavailable */ }
  }

  // Check Rewriter API
  if (typeof Rewriter !== 'undefined') {
    try {
      const avail = await Rewriter.availability();
      _capabilities.rewriter = (avail === 'available' || avail === 'downloadable' || avail === 'downloading');
    } catch (e) { /* unavailable */ }
  }

  // Check Writer API
  if (typeof Writer !== 'undefined') {
    try {
      const avail = await Writer.availability();
      _capabilities.writer = (avail === 'available' || avail === 'downloadable' || avail === 'downloading');
    } catch (e) { /* unavailable */ }
  }

  // Check Prompt API (LanguageModel)
  if (typeof LanguageModel !== 'undefined') {
    try {
      const avail = await LanguageModel.availability();
      _capabilities.promptApi = (avail === 'available' || avail === 'downloadable' || avail === 'downloading');
    } catch (e) { /* unavailable */ }
  }

  return _capabilities;
}

// ── Proofreader ────────────────────────────────────────────────────────────

let proofreaderInstance = null;

async function getProofreader() {
  if (proofreaderInstance) return proofreaderInstance;
  proofreaderInstance = await Proofreader.create({
    expectedInputLanguages: ['en'],
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => {
        console.log(`[Spelling Tab AI] Proofreader model download: ${Math.round(e.loaded * 100)}%`);
      });
    },
  });
  return proofreaderInstance;
}

function mapCorrectionCategory(correction) {
  // The Proofreader API returns correction types that we map to our 3-category system
  const types = correction.types || [];
  for (const t of types) {
    if (t === 'spelling') return { kind: 'Spelling', pretty: 'AI Spelling', category: 'spelling' };
    if (t === 'punctuation') return { kind: 'Punctuation', pretty: 'AI Punctuation', category: 'grammar' };
    if (t === 'capitalization') return { kind: 'Capitalization', pretty: 'AI Capitalization', category: 'grammar' };
  }
  return { kind: 'Grammar', pretty: 'AI Grammar', category: 'grammar' };
}

async function handleProofread(text) {
  const caps = await getAICapabilities();
  if (!caps.proofreader) return { available: false, corrections: [] };

  try {
    const proofreader = await getProofreader();
    const result = await proofreader.proofread(text);

    const aiLints = [];
    for (const c of result.corrections) {
      const { kind, pretty, category } = mapCorrectionCategory(c);
      const problemText = text.substring(c.startIndex, c.endIndex);
      const correction = c.correction || result.correctedInput.substring(c.startIndex, c.startIndex + (c.correction?.length || 0));

      aiLints.push({
        span: { start: c.startIndex, end: c.endIndex },
        message: c.explanation || `AI suggests: "${correction}"`,
        lintKind: kind,
        lintKindPretty: pretty,
        category: category,
        problemText: problemText,
        suggestions: correction ? [{ text: correction, kind: 'ReplaceWith' }] : [],
        isAI: true,
        source: 'proofreader',
      });
    }

    return { available: true, corrections: aiLints };
  } catch (err) {
    console.error('[Spelling Tab AI] Proofread error:', err);
    return { available: false, corrections: [] };
  }
}

// ── Rewriter ───────────────────────────────────────────────────────────────

const rewriterCache = new Map(); // key -> Rewriter instance

async function getRewriter(tone = 'as-is', length = 'as-is') {
  const key = `${tone}-${length}`;
  if (rewriterCache.has(key)) return rewriterCache.get(key);

  const rewriter = await Rewriter.create({
    tone,
    length,
    format: 'plain-text',
    expectedInputLanguages: ['en'],
    outputLanguage: 'en',
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => {
        console.log(`[Spelling Tab AI] Rewriter model download: ${Math.round(e.loaded * 100)}%`);
      });
    },
  });
  rewriterCache.set(key, rewriter);
  return rewriter;
}

async function handleRewrite(text, context, tone, length) {
  const caps = await getAICapabilities();
  if (!caps.rewriter) return { available: false, rewritten: null };

  try {
    const rewriter = await getRewriter(tone || 'as-is', length || 'as-is');
    const rewritten = await rewriter.rewrite(text, { context: context || '' });
    return { available: true, rewritten: rewritten.trim() };
  } catch (err) {
    console.error('[Spelling Tab AI] Rewrite error:', err);
    return { available: false, rewritten: null };
  }
}

// ── Improve (Rewriter → Prompt API fallback) ──────────────────────────────

async function handleImprove(text) {
  const caps = await getAICapabilities();

  // Try Rewriter first (purpose-built for this)
  if (caps.rewriter) {
    try {
      const rewriter = await getRewriter('as-is', 'as-is');
      const improved = await rewriter.rewrite(text, {
        context: 'Improve the grammar, clarity, and style of this text while preserving the meaning.',
      });
      if (improved && improved.trim()) {
        return { available: true, improved: improved.trim() };
      }
    } catch (e) { /* fall through to Prompt API */ }
  }

  // Fallback to Prompt API
  if (caps.promptApi) {
    try {
      const session = await LanguageModel.create({
        initialPrompts: [{
          role: 'system',
          content: 'You are a concise writing assistant. Improve the grammar, clarity, and style of the given text. Return ONLY the improved text with no explanations, preambles, or quotes.',
        }],
      });
      const improved = await session.prompt(text);
      session.destroy();
      if (improved && improved.trim()) {
        return { available: true, improved: improved.trim() };
      }
    } catch (e) { /* unavailable */ }
  }

  return { available: false, improved: null };
}

// ── Message Router ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only handle messages intended for the offscreen document
  if (message.target !== 'offscreen') return false;

  handleMessage(message).then(sendResponse);
  return true; // keep channel open for async
});

async function handleMessage(message) {
  switch (message.type) {
    case 'ai-proofread':
      return handleProofread(message.text);

    case 'ai-rewrite':
      return handleRewrite(message.text, message.context, message.tone, message.length);

    case 'ai-improve':
      return handleImprove(message.text);

    case 'get-ai-capabilities':
      return getAICapabilities();

    default:
      return {};
  }
}

console.log('[Spelling Tab AI] Offscreen document loaded');
