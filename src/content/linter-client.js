export class LinterClient {
  constructor() {
    this.cache = new Map();
  }

  async lint(text) {
    if (!text || text.trim().length < 2) return [];

    if (this.cache.has(text)) return this.cache.get(text);

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'lint',
        text,
      });
      const lints = response?.lints || [];
      this.cache.set(text, lints);

      // Keep cache bounded
      if (this.cache.size > 50) {
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
      }

      return lints;
    } catch (err) {
      console.error('Writing Helper: lint request failed', err);
      return [];
    }
  }

  clearCache() {
    this.cache.clear();
  }
}
