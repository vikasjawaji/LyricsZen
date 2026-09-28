/**
 * lyrics-sync.js
 *
 * Maps the current playback time to the active lyric line index for
 * timestamp-synced lyrics. Uses a forward-advancing cursor for the
 * common case (time moving forward during normal playback) and falls
 * back to a binary search on seeks/song changes, so it stays cheap
 * even on frequent `timeupdate` events.
 */
(function () {
  'use strict';

  class LyricsSync {
    constructor() {
      this._lines = [];
      this._cursor = -1;
    }

    setLines(lines) {
      this._lines = Array.isArray(lines) ? lines.slice().sort((a, b) => a.time - b.time) : [];
      this._cursor = -1;
    }

    reset() {
      this._cursor = -1;
    }

    /**
     * @param {number} currentTime seconds
     * @returns {number} active line index, or -1 if none/no lines
     */
    getActiveIndex(currentTime) {
      const lines = this._lines;
      if (!lines.length || !Number.isFinite(currentTime)) return -1;

      // Before the first line begins
      if (currentTime < lines[0].time) {
        this._cursor = -1;
        return -1;
      }

      // Fast path: check current cursor
      const c = this._cursor;
      if (c >= 0 && c < lines.length && currentTime >= lines[c].time) {
        // Still on this same line?
        if (c === lines.length - 1 || currentTime < lines[c + 1].time) {
          return c;
        }
        // Stepped to immediate next line?
        if (c + 1 < lines.length && currentTime >= lines[c + 1].time) {
          if (c + 2 >= lines.length || currentTime < lines[c + 2].time) {
            this._cursor = c + 1;
            return this._cursor;
          }
        }
      }

      // Fallback: binary search for seeks, skips, or track changes
      this._cursor = this._binarySearch(currentTime);
      return this._cursor;
    }

    _binarySearch(currentTime) {
      const lines = this._lines;
      let lo = 0;
      let hi = lines.length - 1;
      let ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lines[mid].time <= currentTime) {
          ans = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return ans;
    }
  }

  window.YTMLyrics = window.YTMLyrics || {};
  window.YTMLyrics.LyricsSync = LyricsSync;
})();
