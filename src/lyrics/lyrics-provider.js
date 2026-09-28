/**
 * lyrics-provider.js
 *
 * Defines the contract a lyrics source must implement, plus a real
 * implementation backed by LRCLIB (https://lrclib.net) — a free, open,
 * CORS-enabled lyrics database with no API key required. This is the
 * same underlying source Better Lyrics (betterlyrics.org) itself falls
 * back to; their own production API (better-lyrics/api on GitHub) is
 * intentionally gated behind private credentials to prevent third-party
 * abuse, so it isn't something an unrelated extension can legitimately
 * call. LRCLIB is built for exactly this kind of direct client use.
 *
 * `LrcLibLyricsProvider` below:
 *   1. Tries an exact match via /api/get (title + artist + duration).
 *   2. Falls back to /api/search and picks the closest duration match.
 *   3. Parses LRC-formatted synced lyrics into {time, text} lines, or
 *      falls back to plain unsynced text.
 *   4. Returns null (never throws to the caller) when nothing is found,
 *      which the UI renders as "Lyrics unavailable for this song."
 */
(function () {
  'use strict';

  const LRCLIB_BASE = 'https://lrclib.net/api';
  const FETCH_TIMEOUT_MS = 8000;
  const DURATION_TOLERANCE_SEC = 3;

  /**
   * @abstract
   */
  class LyricsProvider {
    /**
     * @param {{title: string, artist: string, videoId: string|null, duration: number}} meta
     * @returns {Promise<null | {lines: {time:number, text:string}[]} | {text: string}>}
     *   - Return `null` (or reject) if no lyrics are available.
     *   - Return `{ lines: [{ time: seconds, text: string }, ...] }` for
     *     timestamp-synced lyrics (times must be ascending, seconds from
     *     song start).
     *   - Return `{ text: "full lyrics with\nnewlines" }` for plain,
     *     unsynced lyrics.
     */
    // eslint-disable-next-line no-unused-vars
    async fetchLyrics(meta) {
      throw new Error('LyricsProvider.fetchLyrics must be implemented by a subclass');
    }
  }

  class UnavailableLyricsProvider extends LyricsProvider {
    async fetchLyrics() {
      return null;
    }
  }

  /**
   * Strips common "clutter" YouTube Music titles carry (feat./ft.,
   * "(Official Video)", "[Lyrics]", "(Visualizer)", etc.) so title/artist match LRCLIB's
   * cleaner metadata more reliably.
   */
  function cleanTitle(title, artist) {
    if (!title) return '';
    let cleaned = title
      .replace(/\((?:official\s*)?(?:music\s*)?video\)/gi, '')
      .replace(/\[(?:official\s*)?(?:music\s*)?video\]/gi, '')
      .replace(/\((?:official\s*)?(?:lyric|lyrics)\s*video\)/gi, '')
      .replace(/\[(?:official\s*)?(?:lyric|lyrics)\s*video\]/gi, '')
      .replace(/\((?:official\s*)?audio\)/gi, '')
      .replace(/\[(?:official\s*)?audio\]/gi, '')
      .replace(/\((?:official\s*)?visualizer\)/gi, '')
      .replace(/\[(?:official\s*)?visualizer\]/gi, '')
      .replace(/\((?:lyrics?)\)/gi, '')
      .replace(/\[(?:lyrics?)\]/gi, '')
      .replace(/\((?:hd|4k)\)/gi, '')
      .replace(/\[(?:hd|4k)\]/gi, '')
      .replace(/\(remastered(?:\s*\d+)?\)/gi, '')
      .replace(/\[remastered(?:\s*\d+)?\]/gi, '')
      .replace(/\b(?:ft|feat)\.?\s+[^()[\]]+/gi, '')
      .replace(/\(\s*\)/g, '')
      .replace(/\[\s*\]/g, '')
      .replace(/\|.*$/g, '')
      .replace(/^["']|["']$/g, '')
      .replace(/[-–—]\s*$/, '')
      .trim();

    if (artist && cleaned.includes(' - ')) {
      const parts = cleaned.split(' - ');
      if (parts.length === 2 && parts[0].toLowerCase().trim() === artist.toLowerCase().trim()) {
        cleaned = parts[1].trim();
      }
    }
    return cleaned;
  }

  function cleanArtist(artist) {
    if (!artist) return '';
    return artist
      .replace(/\s*-\s*Topic$/i, '')
      .replace(/\s*VEVO$/i, '')
      .replace(/\s*Official$/i, '')
      .replace(/\s*Channel$/i, '')
      .trim();
  }

  function getPrimaryArtist(artist) {
    if (!artist) return '';
    const cleaned = cleanArtist(artist);
    const primary = cleaned.split(/[,&/]|(?:\s+feat\.?\s+)|(?:\s+ft\.?\s+)|(?:\s+x\s+)|(?:\s+with\s+)/i)[0];
    return (primary && primary.trim()) || cleaned;
  }

  /**
   * Parses an LRC-format string into ascending {time, text} lines.
   * Ignores metadata tags ([ar:], [ti:], [al:], [length:], [offset:], ...)
   * and blank lines. Handles multiple timestamps stacked on one line
   * (e.g. "[00:12.34][00:45.10]Text").
   */
  function parseLrc(lrcText) {
    const lines = [];
    const timeTag = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

    for (const rawLine of lrcText.split(/\r?\n/)) {
      const tags = [...rawLine.matchAll(timeTag)];
      if (tags.length === 0) continue;

      const text = rawLine.replace(timeTag, '').trim();
      if (!text) continue;

      for (const tag of tags) {
        const minutes = parseInt(tag[1], 10);
        const seconds = parseInt(tag[2], 10);
        const fracRaw = tag[3] || '0';
        // Normalize 2- or 3-digit fractional seconds to a decimal fraction.
        const frac = parseInt(fracRaw, 10) / Math.pow(10, fracRaw.length);
        const time = minutes * 60 + seconds + frac;
        lines.push({ time, text });
      }
    }

    lines.sort((a, b) => a.time - b.time);
    return lines;
  }

  async function fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'Lrclib-Client': 'LyricsZen-v1.0.0 (https://chrome.google.com/webstore)'
        },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`LRCLIB request failed: ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function toSyncedResult(record) {
    if (!record) return null;
    if (typeof record.syncedLyrics === 'string' && record.syncedLyrics.trim().length > 0) {
      const lines = parseLrc(record.syncedLyrics);
      if (lines.length > 0) return { lines };
    }
    return null;
  }

  function toPlainResult(record) {
    if (!record) return null;
    if (typeof record.plainLyrics === 'string' && record.plainLyrics.trim().length > 0) {
      return { text: record.plainLyrics.trim() };
    }
    return null;
  }

  function pickBestSyncedCandidate(candidates, targetDuration) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    const synced = candidates.filter((c) => typeof c.syncedLyrics === 'string' && c.syncedLyrics.trim().length > 0);
    if (synced.length === 0) return null;

    if (!targetDuration) return synced[0];
    let best = synced[0];
    let bestDiff = Math.abs((best.duration || 0) - targetDuration);
    for (let i = 1; i < synced.length; i++) {
      const diff = Math.abs((synced[i].duration || 0) - targetDuration);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = synced[i];
      }
    }
    return best;
  }

  function pickBestPlainCandidate(candidates, targetDuration) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    const plain = candidates.filter((c) => typeof c.plainLyrics === 'string' && c.plainLyrics.trim().length > 0);
    if (plain.length === 0) return null;

    if (!targetDuration) return plain[0];
    let best = plain[0];
    let bestDiff = Math.abs((best.duration || 0) - targetDuration);
    for (let i = 1; i < plain.length; i++) {
      const diff = Math.abs((plain[i].duration || 0) - targetDuration);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = plain[i];
      }
    }
    return best;
  }

  class LrcLibLyricsProvider extends LyricsProvider {
    /**
     * Reads time-synced lyrics provided directly by YouTube Music / YouTube video.
     * Checks:
     *  1. DOM timed line elements inside the Lyrics tab (e.g. ytmusic-timed-lyrics-line-renderer, [data-start-time]).
     *  2. Internal component data (timedLyricsData / timedLyricsRenderer).
     *  3. HTML5 <video> textTracks with active cues.
     * Returns { lines: [{ time, text }] } if found, or null.
     */
    _readYouTubeTimedLyrics() {
      try {
        const selectors = [
          'ytmusic-tab-renderer[page-type="MUSIC_PAGE_TYPE_TRACK_LYRICS"]',
          'ytmusic-tab-renderer[tab-id="MUSIC_PAGE_TYPE_TRACK_LYRICS"]',
          'ytmusic-player-page ytmusic-tab-renderer:nth-child(2)',
          'ytmusic-player-page #lyrics',
          'ytmusic-description-shelf-renderer[page-type="MUSIC_PAGE_TYPE_TRACK_LYRICS"]',
          'ytmusic-lyrics-shelf-renderer',
          'ytmusic-immersive-lyrics-renderer'
        ];

        for (const sel of selectors) {
          const container = document.querySelector(sel);
          if (!container) continue;

          // 1. Check DOM timed line elements
          const timedEls = container.querySelectorAll(
            'ytmusic-timed-lyrics-line-renderer, .ytmusic-lyrics-line, [data-start-time], [data-time], .lyrics-line[data-start-time], .line[data-start-time]'
          );
          if (timedEls.length > 3) {
            const lines = [];
            timedEls.forEach((el) => {
              const rawTime = el.getAttribute('data-start-time') || el.dataset.time || el.getAttribute('start-time') || '0';
              let t = parseFloat(rawTime);
              if (t > 1000) t = t / 1000; // Convert milliseconds to seconds if needed
              const text = el.textContent.trim();
              if (text) lines.push({ time: t, text });
            });
            if (lines.length > 3) {
              lines.sort((a, b) => a.time - b.time);
              return { lines, source: 'youtube-timed' };
            }
          }

          // 2. Check Polymer/Lit component internal data property for timedLyricsData
          try {
            const dataObj = container.data || container.__data;
            const timedData = this._findTimedLyricsInObject(dataObj);
            if (timedData && timedData.length > 3) {
              return { lines: timedData, source: 'youtube-timed' };
            }
          } catch (e) {
            // Safe no-op
          }
        }

        // 3. Check HTML5 <video> textTracks (captions / timed lyrics)
        const trackResult = this._readVideoTextTracks();
        if (trackResult) return trackResult;
      } catch (e) {
        console.warn('[LyricsZen] Error reading YouTube Music timed lyrics:', e);
      }
      return null;
    }

    /**
     * Recursively traverses an object/array to extract YouTube's timedLyricsData structure.
     */
    _findTimedLyricsInObject(obj, depth = 0) {
      if (!obj || typeof obj !== 'object' || depth > 5) return null;
      if (obj.timedLyricsData || obj.timedLyricsRenderer) {
        const root = obj.timedLyricsData || obj.timedLyricsRenderer;
        const linesArr = root.lyricsData || root.lines || root.lyrics;
        if (Array.isArray(linesArr)) {
          const parsed = this._parseYouTubeTimedLinesArray(linesArr);
          if (parsed) return parsed;
        }
      }
      if (Array.isArray(obj)) {
        const parsed = this._parseYouTubeTimedLinesArray(obj);
        if (parsed) return parsed;
        for (const item of obj) {
          const res = this._findTimedLyricsInObject(item, depth + 1);
          if (res) return res;
        }
        return null;
      }
      for (const key of Object.keys(obj)) {
        const res = this._findTimedLyricsInObject(obj[key], depth + 1);
        if (res) return res;
      }
      return null;
    }

    _parseYouTubeTimedLinesArray(arr) {
      if (!Array.isArray(arr) || arr.length === 0) return null;
      const lines = [];
      for (const item of arr) {
        if (!item) continue;
        let text = item.lyricLine || item.line || item.text || '';
        if (typeof text === 'object' && text.runs) {
          text = text.runs.map((r) => r.text).join('');
        }
        let timeMs = 0;
        if (item.cueRange) {
          timeMs = parseInt(item.cueRange.startTimeMilliseconds || item.cueRange.startTimeMs || '0', 10);
        } else if (item.startTimeMs != null) {
          timeMs = parseInt(item.startTimeMs, 10);
        } else if (item.startTime != null) {
          timeMs = parseFloat(item.startTime) * 1000;
        }
        if (text && typeof text === 'string') {
          const clean = text.trim();
          if (clean) lines.push({ time: timeMs / 1000, text: clean });
        }
      }
      return lines.length > 3 ? lines : null;
    }

    _readVideoTextTracks() {
      try {
        const video = document.querySelector('video');
        if (!video || !video.textTracks || video.textTracks.length === 0) return null;
        for (let i = 0; i < video.textTracks.length; i++) {
          const track = video.textTracks[i];
          if (!track || !track.cues || track.cues.length === 0) continue;
          const lines = [];
          for (let j = 0; j < track.cues.length; j++) {
            const cue = track.cues[j];
            if (!cue || typeof cue.text !== 'string') continue;
            const text = cue.text.replace(/<[^>]+>/g, '').trim();
            if (text) {
              lines.push({ time: cue.startTime, text });
            }
          }
          if (lines.length > 3) {
            lines.sort((a, b) => a.time - b.time);
            return { lines, source: 'youtube-text-track' };
          }
        }
      } catch (e) {
        // Safe no-op
      }
      return null;
    }

    /**
     * Reads static/plain lyrics from YouTube Music's native lyrics card.
     * Strips attribution footers (e.g. "Source: LyricFind", "Writer(s):", "Musixmatch").
     */
    _readYouTubeStaticLyrics() {
      try {
        const selectors = [
          'ytmusic-tab-renderer[page-type="MUSIC_PAGE_TYPE_TRACK_LYRICS"]',
          'ytmusic-tab-renderer[tab-id="MUSIC_PAGE_TYPE_TRACK_LYRICS"]',
          'ytmusic-player-page ytmusic-tab-renderer:nth-child(2)',
          'ytmusic-player-page #lyrics',
          'ytmusic-description-shelf-renderer[page-type="MUSIC_PAGE_TYPE_TRACK_LYRICS"]',
          'ytmusic-lyrics-shelf-renderer',
          'ytmusic-immersive-lyrics-renderer'
        ];

        for (const sel of selectors) {
          const container = document.querySelector(sel);
          if (!container) continue;

          const rawText = container.textContent || '';
          if (/lyrics (not|aren't) available/i.test(rawText)) {
            continue;
          }

          const descEl = container.querySelector('.description, #description, yt-formatted-string.description, .non-expandable') || container;
          const paragraphs = Array.from(descEl.querySelectorAll('p, yt-formatted-string, span.yt-formatted-string'));
          let rawLines = [];
          if (paragraphs.length >= 3) {
            rawLines = paragraphs.map((p) => p.textContent.trim());
          } else {
            const inner = (descEl.innerText || descEl.textContent || '').trim();
            rawLines = inner.split(/\r?\n/).map((l) => l.trim());
          }

          const filtered = rawLines.filter((line) => {
            if (!line || line.length === 0) return false;
            if (/^(Source|Writer\(s\)|Songwriter\(s\)|Lyrics powered by|Lyrics licensed & provided by|Provided by):/i.test(line)) return false;
            if (/^(Musixmatch|LyricFind)$/i.test(line)) return false;
            if (/lyrics (not|aren't) available/i.test(line)) return false;
            return true;
          });

          if (filtered.length >= 3) {
            const fullText = filtered.join('\n');
            if (fullText.length > 30) {
              return { text: fullText, source: 'youtube-static' };
            }
          }
        }
      } catch (e) {
        console.warn('[LyricsZen] Error reading YouTube Music static lyrics:', e);
      }
      return null;
    }

    /**
     * Checks if YouTube Music's native "Lyrics" tab exists and triggers it if not yet open.
     * Polls the DOM until either timed lyrics or static lyrics render, or timeout expires.
     */
    async _tryTriggerYouTubeLyricsTab(timeoutMs = 700) {
      // First check if already rendered in DOM
      const immediateTimed = this._readYouTubeTimedLyrics();
      if (immediateTimed) return { timed: true, data: immediateTimed };

      // Find the YouTube Music "Lyrics" tab button in the middle shelf
      try {
        const tabs = Array.from(document.querySelectorAll('ytmusic-tab-header-renderer, tp-yt-paper-tab, [role="tab"]'));
        const lyricsTab = tabs.find((t) => {
          const txt = (t.textContent || '').trim().toLowerCase();
          const pageType = t.getAttribute('tab-id') || t.getAttribute('page-type') || '';
          return pageType.includes('LYRICS') || txt === 'lyrics';
        });

        if (lyricsTab) {
          if (lyricsTab.hasAttribute('disabled') || lyricsTab.getAttribute('aria-disabled') === 'true') {
            return null; // YouTube has no lyrics for this song
          }

          const isSelected = lyricsTab.classList.contains('iron-selected') ||
                             lyricsTab.hasAttribute('selected') ||
                             lyricsTab.getAttribute('aria-selected') === 'true';
          if (!isSelected) {
            lyricsTab.click();
          }
        } else {
          return null;
        }
      } catch (e) {
        // Safe no-op
      }

      // Poll for rendered lyrics (timed lyrics prioritized)
      let foundStatic = null;
      const start = Date.now();
      const interval = 50;
      while (Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, interval));

        const timed = this._readYouTubeTimedLyrics();
        if (timed) return { timed: true, data: timed };

        if (!foundStatic) {
          const staticRes = this._readYouTubeStaticLyrics();
          if (staticRes) foundStatic = staticRes;
        }
      }

      if (foundStatic) {
        return { static: true, data: foundStatic };
      }
      return null;
    }

    /**
     * Fetches plain lyrics from Lyrics.ovh (free, open REST API).
     */
    async _fetchLyricsOvh(artist, title) {
      if (!artist || !title) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4500);
      try {
        const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (!data || typeof data.lyrics !== 'string') return null;

        let lyrics = data.lyrics.trim();
        lyrics = lyrics.replace(/^Paroles\s+de\s+la\s+chanson\s+[^\n]+\s+par\s+[^\n]+\r?\n+/i, '').trim();

        const lines = lyrics.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        if (lines.length >= 3 && lyrics.length > 30) {
          return { text: lines.join('\n'), source: 'lyrics.ovh' };
        }
        return null;
      } catch (err) {
        return null;
      } finally {
        clearTimeout(timer);
      }
    }

    /**
     * Inspects YouTube Music's video description shelf for lyrics embedded in the upload.
     */
    _readYouTubeVideoDescriptionLyrics() {
      try {
        const shelves = document.querySelectorAll('ytmusic-description-shelf-renderer, ytmusic-player-page #description');
        for (const shelf of shelves) {
          if (shelf.getAttribute('page-type') === 'MUSIC_PAGE_TYPE_TRACK_LYRICS') continue;
          const text = (shelf.innerText || shelf.textContent || '').trim();
          if (!text) continue;

          // Look for lyrics blocks: "Lyrics:", "LYRICS:", "[Lyrics]", "Paroles:", "Letra:"
          const match = text.match(/(?:lyrics|paroles|letra)\s*:\s*\n([\s\S]+?)(?:\n\s*\n\s*(?:follow|stream|connect|listen|written|produced|directed|credits|copyright|subscribe|official)|$)/i);
          if (match && match[1]) {
            const rawLines = match[1].split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
            if (rawLines.length >= 4) {
              return { text: rawLines.join('\n'), source: 'youtube-description' };
            }
          }
        }
      } catch (e) {
        // Safe no-op
      }
      return null;
    }

    async fetchLyrics(meta) {
      const rawTitle = meta.title || '';
      const rawArtist = meta.artist || '';
      const artist = cleanArtist(rawArtist);
      const title = cleanTitle(rawTitle, artist);
      const primaryArtist = getPrimaryArtist(artist);

      if (!title) return null;

      let ytStaticCandidate = null;

      // =========================================================================
      // 1. FIRST: LOOK FOR YOUTUBE PROVIDED TIME-SYNCED LYRICS
      // =========================================================================
      const earlyYtTimed = this._readYouTubeTimedLyrics();
      if (earlyYtTimed) {
        return earlyYtTimed; // YouTube time-synced lyrics prioritized first!
      }

      // Check if YouTube Music lyrics tab can be triggered for timed lyrics
      const ytTabResult = await this._tryTriggerYouTubeLyricsTab(700);
      if (ytTabResult && ytTabResult.timed) {
        return ytTabResult.data; // YouTube time-synced lyrics found after tab trigger!
      }
      if (ytTabResult && ytTabResult.static) {
        ytStaticCandidate = ytTabResult.data; // Hold as static fallback; do NOT return yet!
      } else {
        const earlyYtStatic = this._readYouTubeStaticLyrics();
        if (earlyYtStatic) ytStaticCandidate = earlyYtStatic;
      }

      // =========================================================================
      // 2. SECOND: IF YT TIME-SYNCED NOT AVAILABLE -> SEARCH OUR SOURCES (LRCLIB)
      // =========================================================================
      let lrclibPlainCandidate = null;
      function recordLrclibPlain(cand) {
        if (!lrclibPlainCandidate && cand) {
          const res = toPlainResult(cand);
          if (res) lrclibPlainCandidate = res;
        }
      }

      // Tier 1: Exact match with track_name + artist_name + duration
      try {
        const params = new URLSearchParams({ track_name: title, artist_name: artist });
        if (meta.duration) params.set('duration', String(Math.round(meta.duration)));
        const exact = await fetchJson(`${LRCLIB_BASE}/get?${params.toString()}`);
        const synced = toSyncedResult(exact);
        if (synced) return synced; // Time-synced lyrics from our sources!
        recordLrclibPlain(exact);
      } catch (err) {
        console.warn('[LyricsZen] LRCLIB exact lookup failed', err);
      }

      // Tier 2: Field search with track_name + artist_name
      try {
        const params = new URLSearchParams({ track_name: title, artist_name: artist });
        const candidates = await fetchJson(`${LRCLIB_BASE}/search?${params.toString()}`);
        const syncedCand = pickBestSyncedCandidate(candidates, meta.duration);
        const synced = toSyncedResult(syncedCand);
        if (synced) return synced; // Time-synced lyrics from our sources!
        recordLrclibPlain(pickBestPlainCandidate(candidates, meta.duration));
      } catch (err) {
        console.warn('[LyricsZen] LRCLIB field search failed', err);
      }

      // Tier 3: Full-text search fallback (e.g. GET /api/search?q=believer+imagine+dragons)
      try {
        const queryStr = `${title} ${primaryArtist}`.trim();
        const candidates = await fetchJson(`${LRCLIB_BASE}/search?q=${encodeURIComponent(queryStr)}`);
        const syncedCand = pickBestSyncedCandidate(candidates, meta.duration);
        const synced = toSyncedResult(syncedCand);
        if (synced) return synced; // Time-synced lyrics from our sources!
        recordLrclibPlain(pickBestPlainCandidate(candidates, meta.duration));
      } catch (err) {
        console.warn('[LyricsZen] LRCLIB full-text search query failed', err);
      }

      // Tier 4: Full-text search with title only
      try {
        const candidates = await fetchJson(`${LRCLIB_BASE}/search?q=${encodeURIComponent(title)}`);
        const syncedCand = pickBestSyncedCandidate(candidates, meta.duration);
        const synced = toSyncedResult(syncedCand);
        if (synced) return synced; // Time-synced lyrics from our sources!
        recordLrclibPlain(pickBestPlainCandidate(candidates, meta.duration));
      } catch (err) {
        console.warn('[LyricsZen] LRCLIB title search query failed', err);
      }

      // =========================================================================
      // 3. THIRD: NO TIME-SYNCED LYRICS FOUND -> DISPLAY STATIC LYRICS WHEREVER AVAILABLE
      // =========================================================================

      // Static Fallback A: YouTube Music native static lyrics card
      if (ytStaticCandidate) {
        return ytStaticCandidate;
      }

      // Static Fallback B: LRCLIB static plain lyrics from our search tiers
      if (lrclibPlainCandidate) {
        return lrclibPlainCandidate;
      }

      // Static Fallback C: Lyrics.ovh open REST API
      try {
        let ovh = await this._fetchLyricsOvh(primaryArtist, title);
        if (!ovh && primaryArtist !== artist) {
          ovh = await this._fetchLyricsOvh(artist, title);
        }
        if (ovh) return ovh;
      } catch (err) {
        console.warn('[LyricsZen] Lyrics.ovh lookup failed', err);
      }

      // Static Fallback D: YouTube video description shelf
      try {
        const descLyrics = this._readYouTubeVideoDescriptionLyrics();
        if (descLyrics) return descLyrics;
      } catch (err) {
        console.warn('[LyricsZen] Description shelf lyrics extraction failed', err);
      }

      return null;
    }
  }

  window.YTMLyrics = window.YTMLyrics || {};
  window.YTMLyrics.LyricsProvider = LyricsProvider;
  window.YTMLyrics.UnavailableLyricsProvider = UnavailableLyricsProvider;
  window.YTMLyrics.LrcLibLyricsProvider = LrcLibLyricsProvider;
  window.YTMLyrics.CompositeLyricsProvider = LrcLibLyricsProvider;

  window.YTMLyrics.activeLyricsProvider = new LrcLibLyricsProvider();
})();
