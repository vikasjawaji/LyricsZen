/**
 * player.js
 *
 * Thin wrapper around YouTube Music's existing <video> element.
 * We never create a second audio/video element — we only read state
 * from and issue commands (play/pause/seek) to the one YTM already
 * has on the page. Listeners are attached only while Lyrics Mode is
 * active (see `ensureAttached` / `detach`), so the page is untouched
 * when the feature is off.
 */
(function () {
  'use strict';

  class Player {
    constructor() {
      this._video = null;
      this._lastVideoId = null;
      this._lastSongSignature = null;
      this._queueItems = [];
      this._boundHandlers = {};
      this._pollTimer = null;
      this._barObserver = null;
      this._timeTicker = null;
      this._listeners = {
        play: new Set(),
        pause: new Set(),
        timeupdate: new Set(),
        durationchange: new Set(),
        songchange: new Set(),
      };
    }

    _findVideo() {
      // YouTube Music renders audio playback through a standard HTML5
      // <video> element (as YouTube's player family does generally).
      return document.querySelector('video');
    }

    _startTimeTicker() {
      if (this._timeTicker) return;
      this._timeTicker = setInterval(() => {
        if (!this._video || this._video.paused || this._video.ended) {
          this._stopTimeTicker();
          return;
        }
        this._emit('timeupdate', this.getCurrentTime());
      }, 50);
    }

    _stopTimeTicker() {
      if (this._timeTicker) {
        clearInterval(this._timeTicker);
        this._timeTicker = null;
      }
    }

    /**
     * Attaches listeners to the current video element if we haven't
     * already, re-attaching if YTM has swapped in a new element.
     * Returns true if attachment changed (new element found/attached).
     */
    ensureAttached() {
      const video = this._findVideo();
      this._setupObserverAndPoll();

      if (!video) return false;
      if (this._video === video) {
        this._handleSongChange();
        if (!video.paused && !video.ended) this._startTimeTicker();
        return false;
      }

      this._detachInternal();
      this._video = video;

      this._boundHandlers = {
        play: () => {
          this._startTimeTicker();
          this._emit('play');
        },
        playing: () => {
          this._startTimeTicker();
          this._handleSongChange();
          this._emit('play');
        },
        pause: () => {
          this._stopTimeTicker();
          this._emit('pause');
        },
        ended: () => {
          this._stopTimeTicker();
          this._emit('pause');
        },
        timeupdate: () => {
          this._handleSongChange();
          this._emit('timeupdate', this.getCurrentTime());
        },
        durationchange: () => this._emit('durationchange', this.getDuration()),
        loadedmetadata: () => {
          this._handleSongChange();
          this._scheduleSongChangeChecks();
        },
        loadeddata: () => {
          this._handleSongChange();
          this._scheduleSongChangeChecks();
        },
        emptied: () => {
          this._handleSongChange();
          this._scheduleSongChangeChecks();
        },
      };

      video.addEventListener('play', this._boundHandlers.play);
      video.addEventListener('playing', this._boundHandlers.playing);
      video.addEventListener('pause', this._boundHandlers.pause);
      video.addEventListener('ended', this._boundHandlers.ended);
      video.addEventListener('timeupdate', this._boundHandlers.timeupdate);
      video.addEventListener('durationchange', this._boundHandlers.durationchange);
      video.addEventListener('loadedmetadata', this._boundHandlers.loadedmetadata);
      video.addEventListener('loadeddata', this._boundHandlers.loadeddata);
      video.addEventListener('emptied', this._boundHandlers.emptied);

      if (video.readyState >= 1) this._handleSongChange();
      if (!video.paused && !video.ended) this._startTimeTicker();

      return true;
    }

    _setupObserverAndPoll() {
      if (!this._pollTimer) {
        this._pollTimer = setInterval(() => this._handleSongChange(), 400);
      }
      if (!this._barObserver) {
        try {
          this._barObserver = new MutationObserver(() => this._handleSongChange());
          const bar = document.querySelector('ytmusic-player-bar') || document.body;
          if (bar) {
            this._barObserver.observe(bar, {
              childList: true,
              subtree: true,
              characterData: true,
            });
          }
        } catch (e) {
          // Safe no-op
        }
      }
    }

    _cleanupObserverAndPoll() {
      if (this._pollTimer) {
        clearInterval(this._pollTimer);
        this._pollTimer = null;
      }
      if (this._barObserver) {
        this._barObserver.disconnect();
        this._barObserver = null;
      }
    }

    /** Fully detaches listeners from the video element (used when Lyrics Mode turns off). */
    detach() {
      this._detachInternal();
      this._cleanupObserverAndPoll();
      this._lastVideoId = null;
      this._lastSongSignature = null;
    }

    _detachInternal() {
      this._stopTimeTicker();
      if (!this._video) return;
      const v = this._video;
      const h = this._boundHandlers;
      if (h.play) v.removeEventListener('play', h.play);
      if (h.playing) v.removeEventListener('playing', h.playing);
      if (h.pause) v.removeEventListener('pause', h.pause);
      if (h.ended) v.removeEventListener('ended', h.ended);
      if (h.timeupdate) v.removeEventListener('timeupdate', h.timeupdate);
      if (h.durationchange) v.removeEventListener('durationchange', h.durationchange);
      if (h.loadedmetadata) v.removeEventListener('loadedmetadata', h.loadedmetadata);
      if (h.loadeddata) v.removeEventListener('loadeddata', h.loadeddata);
      if (h.emptied) v.removeEventListener('emptied', h.emptied);
      this._video = null;
      this._boundHandlers = {};
    }

    _scheduleSongChangeChecks() {
      [50, 150, 350, 700, 1200, 2000].forEach((delay) => {
        setTimeout(() => this._handleSongChange(), delay);
      });
    }

    checkSongChange() {
      return this._handleSongChange();
    }

    _handleSongChange() {
      const meta = this.getMetadata();
      if (!meta.title || meta.title === 'Unknown title') return;
      const signature = `${meta.title.toLowerCase().trim()}::${meta.artist.toLowerCase().trim()}`;
      if (signature === this._lastSongSignature) return;
      this._lastVideoId = meta.videoId;
      this._lastSongSignature = signature;
      this._emit('songchange', meta);
    }

    getVideoId() {
      try {
        return new URLSearchParams(window.location.search).get('v');
      } catch (err) {
        return null;
      }
    }

    getMetadata() {
      let title = '';
      let artist = '';

      // 1. Check navigator.mediaSession (instant on song advance/change in YouTube Music)
      if (navigator.mediaSession && navigator.mediaSession.metadata) {
        const msTitle = (navigator.mediaSession.metadata.title || '').trim();
        const msArtist = (navigator.mediaSession.metadata.artist || '').trim();
        if (msTitle) title = msTitle;
        if (msArtist) artist = msArtist;
      }

      // 2. Check DOM player bar elements
      if (!title || title === 'Unknown title') {
        const titleEl = document.querySelector(
          'ytmusic-player-bar .title, ytmusic-player-bar yt-formatted-string.title, .ytmusic-player-bar .title, ytmusic-player-bar .middle-controls .title'
        );
        if (titleEl && titleEl.textContent) {
          title = titleEl.textContent.trim();
        }
      }

      if (!artist || artist === 'Unknown artist') {
        const bylineEl = document.querySelector(
          'ytmusic-player-bar .byline, ytmusic-player-bar yt-formatted-string.byline, .ytmusic-player-bar .byline, ytmusic-player-bar .subtitle'
        );
        if (bylineEl && bylineEl.textContent) {
          const first = bylineEl.textContent.split('•')[0].trim();
          if (first) artist = first;
        }
      }

      // 3. Fallback to document.title ("Song Title • Artist - YouTube Music")
      if (!title || title === 'Unknown title') {
        const docTitle = document.title || '';
        if (docTitle.includes(' - YouTube Music')) {
          const parts = docTitle.replace(' - YouTube Music', '').split(' • ');
          if (parts[0]) title = parts[0].trim();
          if (parts[1] && (!artist || artist === 'Unknown artist')) artist = parts[1].trim();
        }
      }

      return {
        title: title || 'Unknown title',
        artist: artist || 'Unknown artist',
        videoId: this.getVideoId(),
      };
    }

    isPlaying() {
      return !!(this._video && !this._video.paused && !this._video.ended);
    }

    getCurrentTime() {
      return this._video ? this._video.currentTime || 0 : 0;
    }

    getDuration() {
      return this._video && isFinite(this._video.duration) ? this._video.duration : 0;
    }

    play() {
      if (this._video) this._video.play().catch(() => {});
    }

    pause() {
      if (this._video) this._video.pause();
    }

    togglePlay() {
      this.ensureAttached();
      if (this._video) {
        if (this._video.paused || this._video.ended) {
          this.play();
        } else {
          this.pause();
        }
        return;
      }
      const clicked = this._clickControl([
        'ytmusic-player-bar #play-pause-button',
        '#play-pause-button',
      ]);
      if (clicked) {
        this._scheduleSongChangeChecks();
        return;
      }
      if (this.isPlaying()) this.pause();
      else this.play();
    }

    // These controls deliberately delegate to YouTube Music's own buttons.
    // That keeps queue, autoplay and account-specific playback behaviour in
    // YouTube Music rather than attempting to recreate it in the extension.
    _clickControl(selectors) {
      const button = selectors
        .map((selector) => document.querySelector(selector))
        .find((el) => el && !el.disabled);
      if (!button) return false;
      button.click();
      return true;
    }

    previous() {
      const clicked = this._clickControl([
        'ytmusic-player-bar #previous-button',
        'ytmusic-player-bar button[title*="Previous"]',
        'ytmusic-player-bar button[aria-label*="Previous"]',
      ]);
      if (clicked) this._scheduleSongChangeChecks();
      return clicked;
    }

    next() {
      const clicked = this._clickControl([
        'ytmusic-player-bar #next-button',
        'ytmusic-player-bar button[title*="Next"]',
        'ytmusic-player-bar button[aria-label*="Next"]',
      ]);
      if (clicked) this._scheduleSongChangeChecks();
      return clicked;
    }

    getQueue() {
      const items = Array.from(document.querySelectorAll(
        'ytmusic-player-queue-item, ytmusic-player-queue-item-renderer, #queue ytmusic-responsive-list-item-renderer'
      ));
      this._queueItems = items;
      return items.slice(0, 25).map((item, index) => {
        const title = item.querySelector('.title, [class*="title"]');
        const artist = item.querySelector('.byline, .secondary, [class*="byline"]');
        return {
          index,
          title: (title && title.textContent.trim()) || `Track ${index + 1}`,
          artist: (artist && artist.textContent.trim()) || '',
          active: item.hasAttribute('selected') || item.classList.contains('playing'),
        };
      });
    }

    playQueueItem(index) {
      const item = this._queueItems[index] || Array.from(document.querySelectorAll(
        'ytmusic-player-queue-item, ytmusic-player-queue-item-renderer, #queue ytmusic-responsive-list-item-renderer'
      ))[index];
      if (!item) return false;
      const target = item.querySelector('#content, .content, .song-info, .main-content') || item;
      ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach((type) => {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      });
      return true;
    }

    seekTo(seconds) {
      if (!this._video || !isFinite(seconds)) return;
      const duration = this.getDuration();
      const clamped = duration ? Math.max(0, Math.min(seconds, duration)) : Math.max(0, seconds);
      this._video.currentTime = clamped;
      this._emit('timeupdate', this.getCurrentTime());
    }

    seekRelative(seconds) {
      if (!isFinite(seconds) || seconds === 0) return;
      this.seekTo(this.getCurrentTime() + seconds);
    }

    on(event, cb) {
      if (this._listeners[event]) this._listeners[event].add(cb);
    }

    off(event, cb) {
      if (this._listeners[event]) this._listeners[event].delete(cb);
    }

    _emit(event, payload) {
      if (!this._listeners[event]) return;
      this._listeners[event].forEach((cb) => {
        try {
          cb(payload);
        } catch (err) {
          console.error('[YTM Lyrics] player listener error', err);
        }
      });
    }
  }

  window.YTMLyrics = window.YTMLyrics || {};
  window.YTMLyrics.Player = Player;
})();
