/**
 * lyrics-engine.js
 *
 * Orchestrates fetching lyrics from the active provider and caches
 * results per song for the lifetime of the tab, so switching back to a
 * previously-viewed song doesn't re-fetch.
 */
(function () {
  'use strict';

  class LyricsEngine {
    constructor(provider) {
      this._provider = provider;
      this._cache = new Map();
    }

    /**
     * @param {{title:string, artist:string, videoId:string|null, duration:number}} meta
     * @returns {Promise<{status:'synced', lines:Array}|{status:'plain', text:string}|{status:'unavailable'}>}
     */
    async getLyrics(meta) {
      const cleanKey = `${(meta.title || '').toLowerCase().trim()}::${(meta.artist || '').toLowerCase().trim()}`;
      if (cleanKey && this._cache.has(cleanKey)) {
        const cached = this._cache.get(cleanKey);
        if (cached && (cached.status === 'synced' || cached.status === 'plain')) {
          return cached;
        }
      }

      let result;
      try {
        const data = await this._provider.fetchLyrics(meta);
        if (!data) {
          result = { status: 'unavailable' };
        } else if (Array.isArray(data.lines) && data.lines.length > 0) {
          result = { status: 'synced', lines: data.lines };
        } else if (typeof data.text === 'string' && data.text.trim().length > 0) {
          result = { status: 'plain', text: data.text };
        } else {
          result = { status: 'unavailable' };
        }
      } catch (err) {
        console.error('[LyricsZen] lyrics provider error', err);
        result = { status: 'unavailable' };
      }

      if (cleanKey && (result.status === 'synced' || result.status === 'plain')) {
        this._cache.set(cleanKey, result);
      }
      return result;
    }

    clearCache() {
      this._cache.clear();
    }
  }

  window.YTMLyrics = window.YTMLyrics || {};
  window.YTMLyrics.LyricsEngine = LyricsEngine;
})();
