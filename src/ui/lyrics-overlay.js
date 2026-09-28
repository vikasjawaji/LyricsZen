/**
 * lyrics-overlay.js
 *
 * Builds and manages the full-screen Lyrics Mode UI inside a Shadow DOM
 * root, so its styling never leaks into (or is affected by) YouTube
 * Music's own CSS. The overlay covers the underlying YTM UI; it never
 * removes, hides via `display:none`, or otherwise mutates YTM's own
 * elements, so exiting Lyrics Mode is just unmounting this one host
 * element — fully reversible.
 *
 * Also owns the lyrics-display settings panel (font, text size, color),
 * applied as CSS custom properties on the root element and persisted in
 * chrome.storage.local so they carry over between sessions.
 */
(function () {
  'use strict';

  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  const PROGRESS_SCALE = 1000;
  const SETTINGS_KEY = 'ytmLyricsDisplaySettings';

  const FONT_FAMILIES = {
    serif: { label: 'Serif', stack: 'Georgia, "Iowan Old Style", "Palatino Linotype", serif' },
    sans: { label: 'Sans', stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' },
    rounded: { label: 'Rounded', stack: 'ui-rounded, "SF Pro Rounded", "Segoe UI Variable", -apple-system, sans-serif' },
    mono: { label: 'Mono', stack: 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace' },
    display: { label: 'Display', stack: 'Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif' },
    humanist: { label: 'Humanist', stack: 'Candara, Optima, "Segoe UI", sans-serif' },
    casual: { label: 'Casual', stack: '"Comic Sans MS", "Bradley Hand", cursive' },
  };

  // Bright white is the default per product requirements; the rest give
  // users the usual lyrics-app palette to pick from.
  const COLORS = {
    white: { label: 'White', hex: '#ffffff' },
    warm: { label: 'Warm', hex: '#f2ead9' },
    yellow: { label: 'Yellow', hex: '#ffd400' },
    blue: { label: 'Blue', hex: '#4da6ff' },
    green: { label: 'Green', hex: '#7ee787' },
    pink: { label: 'Pink', hex: '#ff8fc8' },
  };

  const SIZE_MIN = 16;
  const SIZE_MAX = 96;
  const SIZE_STEP = 1;

  const VISUALIZERS = {
    bars: 'Bars',
    dots: 'Dots',
    twinkle: 'Twinkle',
    wave: 'Wave',
    pulse: 'Pulse',
  };
  const DEFAULT_SETTINGS = { fontFamily: 'serif', fontSize: 28, color: 'white', partyMode: false, visualizer: 'bars', rgbVisualizer: false, lyricOffset: 0 };

  function clampSize(n) {
    return Math.max(SIZE_MIN, Math.min(SIZE_MAX, n));
  }

  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return '255, 255, 255';
    return [1, 2, 3].map((i) => parseInt(m[i], 16)).join(', ');
  }

  function loadSettings() {
    return new Promise((resolve) => {
      try {
        if (!chrome.storage || !chrome.storage.local) {
          resolve({ ...DEFAULT_SETTINGS });
          return;
        }
        chrome.storage.local.get([SETTINGS_KEY], (result) => {
          if (chrome.runtime.lastError) {
            resolve({ ...DEFAULT_SETTINGS });
            return;
          }
          const stored = (result && result[SETTINGS_KEY]) || {};
          const legacyVisualizerOff = stored.visualizer === 'off';
          resolve({
            fontFamily: FONT_FAMILIES[stored.fontFamily] ? stored.fontFamily : DEFAULT_SETTINGS.fontFamily,
            fontSize: Number.isFinite(stored.fontSize) ? clampSize(stored.fontSize) : DEFAULT_SETTINGS.fontSize,
            color: COLORS[stored.color] ? stored.color : DEFAULT_SETTINGS.color,
            partyMode: legacyVisualizerOff ? false : (typeof stored.partyMode === 'boolean' ? stored.partyMode : DEFAULT_SETTINGS.partyMode),
            visualizer: VISUALIZERS[stored.visualizer] ? stored.visualizer : DEFAULT_SETTINGS.visualizer,
            rgbVisualizer: typeof stored.rgbVisualizer === 'boolean' ? stored.rgbVisualizer : DEFAULT_SETTINGS.rgbVisualizer,
            lyricOffset: Number.isFinite(stored.lyricOffset) ? Math.max(-5, Math.min(5, stored.lyricOffset)) : DEFAULT_SETTINGS.lyricOffset,
          });
        });
      } catch (err) {
        resolve({ ...DEFAULT_SETTINGS });
      }
    });
  }

  function saveSettings(settings) {
    try {
      if (!chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.set({ [SETTINGS_KEY]: settings }, () => void chrome.runtime.lastError);
    } catch (err) {
      // Non-fatal — settings just won't persist this session.
    }
  }

  class LyricsOverlay {
    constructor() {
      this._host = null;
      this._shadow = null;
      this._els = {};
      this._lineEls = [];
      this._callbacks = {};
      this._activeIndex = null;
      this._duration = 0;
      this._seeking = false;
      this._queueOpen = false;
      this._reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this._onKeyDown = null;
      this._onResize = null;
      this._settings = { ...DEFAULT_SETTINGS };
    }

    on(event, cb) {
      this._callbacks[event] = cb;
    }

    _call(event, payload) {
      if (this._callbacks[event]) this._callbacks[event](payload);
    }

    async _loadCss() {
      try {
        const res = await fetch(chrome.runtime.getURL('src/ui/lyrics.css'));
        return await res.text();
      } catch (err) {
        console.error('[YTM Lyrics] failed to load stylesheet', err);
        return '';
      }
    }

    async mount() {
      if (this._host) return;

      const [css, settings] = await Promise.all([this._loadCss(), loadSettings()]);
      this._settings = settings;

      const host = document.createElement('div');
      host.id = 'ytm-lyrics-mode-host';
      document.documentElement.appendChild(host);

      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = css;
      shadow.appendChild(style);
      shadow.appendChild(this._buildDom());

      this._host = host;
      this._shadow = shadow;

      this._applySettings();
      this._syncSettingsControls();

      this._onResize = () => {
        if (this._activeIndex != null && this._activeIndex >= 0) {
          this._scrollToActiveLine(false);
        }
      };
      window.addEventListener('resize', this._onResize);

      // Fade in on the next frame so the transition actually runs.
      requestAnimationFrame(() => {
        if (this._els.root) this._els.root.classList.add('is-visible');
      });

      this._els.scroll && this._els.scroll.focus({ preventScroll: true });
    }

    unmount() {
      if (this._onResize) {
        window.removeEventListener('resize', this._onResize);
        this._onResize = null;
      }
      if (this._onKeyDown) {
        window.removeEventListener('keydown', this._onKeyDown, true);
        document.removeEventListener('keydown', this._onKeyDown, true);
        this._onKeyDown = null;
      }
      if (this._host) this._host.remove();
      this._host = null;
      this._shadow = null;
      this._els = {};
      this._lineEls = [];
      this._activeIndex = null;
      this._duration = 0;
      this._seeking = false;
    }

    _buildDom() {
      const root = document.createElement('div');
      root.className = 'ytm-lyrics-root';
      root.innerHTML = `
        <div class="ytm-lyrics-edge-visualizer" id="ytm-lyrics-edge-visualizer" aria-hidden="true">
          ${['top', 'right', 'bottom', 'left'].map((side) => `<div class="ytm-lyrics-edge ytm-lyrics-edge-${side}">${Array.from({ length: 28 }, (_, i) => `<i style="--i:${i}"></i>`).join('')}</div>`).join('')}
        </div>
        <div class="ytm-lyrics-toolbar">
          <button class="ytm-lyrics-icon-btn" id="ytm-lyrics-queue-toggle" type="button" aria-label="Open next in line" title="Next in line" aria-expanded="false">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 6h11M4 12h11M4 18h11M18 5v14m-3-3 3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button class="ytm-lyrics-icon-btn" id="ytm-lyrics-settings-toggle" type="button" aria-label="Display settings" title="Display settings" aria-expanded="false">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M12 15.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7z" stroke="currentColor" stroke-width="1.6" fill="none"/>
              <path d="M19.4 13.5a1.7 1.7 0 00.34 1.87l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.7 1.7 0 00-1.87-.34 1.7 1.7 0 00-1 1.55V19.6a2 2 0 11-4 0v-.09a1.7 1.7 0 00-1-1.56 1.7 1.7 0 00-1.87.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.7 1.7 0 00.34-1.87 1.7 1.7 0 00-1.55-1H4.4a2 2 0 110-4h.09a1.7 1.7 0 001.56-1 1.7 1.7 0 00-.34-1.87l-.06-.06a2 2 0 112.83-2.83l.06.06a1.7 1.7 0 001.87.34H10.5a1.7 1.7 0 001-1.55V4.4a2 2 0 114 0v.09a1.7 1.7 0 001 1.55 1.7 1.7 0 001.87-.34l.06-.06a2 2 0 112.83 2.83l-.06.06a1.7 1.7 0 00-.34 1.87v.09a1.7 1.7 0 001.55 1h.09a2 2 0 110 4h-.09a1.7 1.7 0 00-1.55 1z" stroke="currentColor" stroke-width="1.2" fill="none"/>
            </svg>
          </button>
          <button class="ytm-lyrics-icon-btn ytm-lyrics-exit" type="button" aria-label="Exit Lyrics Mode" title="Exit Lyrics Mode (Esc)">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M5 5L19 19M19 5L5 19" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
            </svg>
          </button>
        </div>

        <div class="ytm-lyrics-settings" id="ytm-lyrics-settings" hidden>
          <div class="ytm-lyrics-settings-head">
            <span>Display Settings</span>
            <button class="ytm-lyrics-icon-btn ytm-lyrics-settings-close" id="ytm-lyrics-settings-close" type="button" aria-label="Close settings" title="Close settings">
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <path d="M5 5L19 19M19 5L5 19" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
              </svg>
            </button>
          </div>
          <div class="ytm-lyrics-settings-row">
            <span class="ytm-lyrics-settings-label">Font</span>
            <div class="ytm-lyrics-font-options" id="ytm-lyrics-font-options" role="group" aria-label="Font"></div>
          </div>
          <div class="ytm-lyrics-settings-row">
            <span class="ytm-lyrics-settings-label">Text size</span>
            <div class="ytm-lyrics-size-control">
              <button type="button" class="ytm-lyrics-icon-btn ytm-lyrics-size-btn" id="ytm-lyrics-size-dec" aria-label="Decrease text size">−</button>
              <input class="ytm-lyrics-size-slider" id="ytm-lyrics-size-slider" type="range" min="${SIZE_MIN}" max="${SIZE_MAX}" value="28" aria-label="Lyrics text size">
              <span class="ytm-lyrics-size-value" id="ytm-lyrics-size-value">28px</span>
              <button type="button" class="ytm-lyrics-icon-btn ytm-lyrics-size-btn" id="ytm-lyrics-size-inc" aria-label="Increase text size">+</button>
            </div>
          </div>
          <div class="ytm-lyrics-settings-row">
            <span class="ytm-lyrics-settings-label">Color</span>
            <div class="ytm-lyrics-color-options" id="ytm-lyrics-color-options" role="group" aria-label="Text color"></div>
          </div>
          <section class="ytm-lyrics-party-settings">
            <div class="ytm-lyrics-settings-row ytm-lyrics-party-row">
              <div>
                <span class="ytm-lyrics-settings-label">Party visualizer</span>
                <span class="ytm-lyrics-setting-help">Outline lights around the screen</span>
              </div>
              <button type="button" class="ytm-lyrics-switch" id="ytm-lyrics-party-toggle" role="switch" aria-checked="false"><span></span></button>
            </div>
            <div class="ytm-lyrics-settings-row">
              <span class="ytm-lyrics-settings-label">Style</span>
              <div class="ytm-lyrics-visualizer-options" id="ytm-lyrics-visualizer-options" role="group" aria-label="Visualizer style"></div>
            </div>
            <div class="ytm-lyrics-settings-row ytm-lyrics-party-row">
              <div><span class="ytm-lyrics-settings-label">RGB lights</span><span class="ytm-lyrics-setting-help">Cycle visualizer colors</span></div>
              <button type="button" class="ytm-lyrics-switch" id="ytm-lyrics-rgb-toggle" role="switch" aria-checked="false"><span></span></button>
            </div>
          </section>
          <div class="ytm-lyrics-settings-row">
            <span class="ytm-lyrics-settings-label">Lyrics timing</span>
            <div class="ytm-lyrics-timing-control"><button class="ytm-lyrics-icon-btn ytm-lyrics-size-btn" id="ytm-lyrics-timing-dec" type="button" aria-label="Make lyrics earlier">−</button><input id="ytm-lyrics-timing-input" type="number" min="-5" max="5" step="0.1" value="0" aria-label="Lyrics timing offset"><span class="ytm-lyrics-timing-unit">seconds</span><button class="ytm-lyrics-icon-btn ytm-lyrics-size-btn" id="ytm-lyrics-timing-inc" type="button" aria-label="Make lyrics later">+</button><button class="ytm-lyrics-timing-reset" id="ytm-lyrics-timing-reset" type="button">Reset</button></div>
            <span class="ytm-lyrics-setting-help">Move right if lyrics appear late; left if they appear early.</span>
          </div>
          <div class="ytm-lyrics-settings-footer">
            <button type="button" class="ytm-lyrics-reset" id="ytm-lyrics-reset">Reset to default</button>
            <button type="button" class="ytm-lyrics-done-btn" id="ytm-lyrics-settings-done">Done</button>
          </div>
        </div>

        <aside class="ytm-lyrics-queue" id="ytm-lyrics-queue" aria-label="Next in line" hidden>
          <div class="ytm-lyrics-queue-head"><span>Next in line</span><button class="ytm-lyrics-icon-btn" id="ytm-lyrics-queue-close" type="button" aria-label="Close next in line">×</button></div>
          <div class="ytm-lyrics-queue-list" id="ytm-lyrics-queue-list"><p>Nothing is queued yet.</p></div>
        </aside>

        <div class="ytm-lyrics-meta">
          <div class="ytm-lyrics-title" id="ytm-lyrics-title">Loading…</div>
          <div class="ytm-lyrics-artist" id="ytm-lyrics-artist"></div>
        </div>
        <div class="ytm-lyrics-scroll" id="ytm-lyrics-scroll" tabindex="-1" aria-label="Lyrics">
          <div class="ytm-lyrics-lines" id="ytm-lyrics-lines"></div>
        </div>
        <div class="ytm-lyrics-transport">
          <div class="ytm-lyrics-transport-actions">
            <button class="ytm-lyrics-control-btn" id="ytm-lyrics-prev" type="button" aria-label="Previous track" title="Previous track">
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <rect x="5" y="5" width="2.5" height="14" rx="1.25" fill="currentColor"/>
                <path d="M18 6.2a1 1 0 0 0-1.5-.86l-8.5 5.1a1 1 0 0 0 0 1.72l8.5 5.1a1 1 0 0 0 1.5-.86V6.2z" fill="currentColor"/>
              </svg>
            </button>
            <button class="ytm-lyrics-playpause" id="ytm-lyrics-playpause" type="button" aria-label="Play" title="Play (Space)">
              <svg class="icon-play" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                <path d="M8.5 6.2a1 1 0 0 1 1.52-.85l9.2 5.52a1 1 0 0 1 0 1.72l-9.2 5.52A1 1 0 0 1 8.5 17.26V6.2z" fill="currentColor"/>
              </svg>
              <svg class="icon-pause" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" style="display: none;">
                <rect x="6.5" y="5.5" width="3.5" height="13" rx="1.75" fill="currentColor"/>
                <rect x="14" y="5.5" width="3.5" height="13" rx="1.75" fill="currentColor"/>
              </svg>
            </button>
            <button class="ytm-lyrics-control-btn" id="ytm-lyrics-next" type="button" aria-label="Next track" title="Next track">
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path d="M6 6.2a1 1 0 0 1 1.5-.86l8.5 5.1a1 1 0 0 1 0 1.72l-8.5 5.1a1 1 0 0 1-1.5-.86V6.2z" fill="currentColor"/>
                <rect x="16.5" y="5" width="2.5" height="14" rx="1.25" fill="currentColor"/>
              </svg>
            </button>
          </div>
          <div class="ytm-lyrics-seek-row">
            <span class="ytm-lyrics-time" id="ytm-lyrics-elapsed">0:00</span>
            <input class="ytm-lyrics-progress" id="ytm-lyrics-progress" type="range" min="0" max="${PROGRESS_SCALE}" value="0" aria-label="Seek">
            <span class="ytm-lyrics-time" id="ytm-lyrics-total">0:00</span>
          </div>
        </div>
        <button class="ytm-lyrics-floater-exit" id="ytm-lyrics-floater-exit" type="button" aria-label="Exit LyricsZen" title="Exit LyricsZen (Esc)">
          <span class="ytm-lyrics-floater-mark">✕</span> Exit LyricsZen
        </button>
      `;

      this._els = {
        root,
        exit: root.querySelector('.ytm-lyrics-exit'),
        exitFloater: root.querySelector('#ytm-lyrics-floater-exit'),
        title: root.querySelector('#ytm-lyrics-title'),
        artist: root.querySelector('#ytm-lyrics-artist'),
        scroll: root.querySelector('#ytm-lyrics-scroll'),
        lines: root.querySelector('#ytm-lyrics-lines'),
        playpause: root.querySelector('#ytm-lyrics-playpause'),
        iconPlay: root.querySelector('.icon-play'),
        iconPause: root.querySelector('.icon-pause'),
        elapsed: root.querySelector('#ytm-lyrics-elapsed'),
        total: root.querySelector('#ytm-lyrics-total'),
        progress: root.querySelector('#ytm-lyrics-progress'),
        previous: root.querySelector('#ytm-lyrics-prev'),
        next: root.querySelector('#ytm-lyrics-next'),
        queueToggle: root.querySelector('#ytm-lyrics-queue-toggle'),
        queue: root.querySelector('#ytm-lyrics-queue'),
        queueList: root.querySelector('#ytm-lyrics-queue-list'),
        queueClose: root.querySelector('#ytm-lyrics-queue-close'),
        settingsToggle: root.querySelector('#ytm-lyrics-settings-toggle'),
        settingsPanel: root.querySelector('#ytm-lyrics-settings'),
        settingsClose: root.querySelector('#ytm-lyrics-settings-close'),
        settingsDone: root.querySelector('#ytm-lyrics-settings-done'),
        fontOptions: root.querySelector('#ytm-lyrics-font-options'),
        colorOptions: root.querySelector('#ytm-lyrics-color-options'),
        sizeValue: root.querySelector('#ytm-lyrics-size-value'),
        sizeSlider: root.querySelector('#ytm-lyrics-size-slider'),
        sizeDec: root.querySelector('#ytm-lyrics-size-dec'),
        sizeInc: root.querySelector('#ytm-lyrics-size-inc'),
        partyToggle: root.querySelector('#ytm-lyrics-party-toggle'),
        rgbToggle: root.querySelector('#ytm-lyrics-rgb-toggle'),
        visualizerEdge: root.querySelector('#ytm-lyrics-edge-visualizer'),
        visualizerOptions: root.querySelector('#ytm-lyrics-visualizer-options'),
        timingInput: root.querySelector('#ytm-lyrics-timing-input'),
        timingDec: root.querySelector('#ytm-lyrics-timing-dec'),
        timingInc: root.querySelector('#ytm-lyrics-timing-inc'),
        timingReset: root.querySelector('#ytm-lyrics-timing-reset'),
        reset: root.querySelector('#ytm-lyrics-reset'),
      };

      this._buildFontOptions();
      this._buildColorOptions();
      this._buildVisualizerOptions();

      this._els.exit.addEventListener('click', () => this._call('exit'));
      if (this._els.exitFloater) {
        this._els.exitFloater.addEventListener('click', () => this._call('exit'));
      }
      this._els.playpause.addEventListener('click', () => {
        const isPlaying = this._els.playpause.classList.contains('is-playing');
        this.setPlaying(!isPlaying);
        this._call('togglePlay');
      });
      this._els.previous.addEventListener('click', () => this._call('previous'));
      this._els.next.addEventListener('click', () => this._call('next'));
      this._els.queueToggle.addEventListener('click', () => this._toggleQueue());
      this._els.queueClose.addEventListener('click', () => this._closeQueue());

      this._els.settingsToggle.addEventListener('click', () => this._toggleSettings());
      if (this._els.settingsClose) {
        this._els.settingsClose.addEventListener('click', () => this._closeSettings());
      }
      if (this._els.settingsDone) {
        this._els.settingsDone.addEventListener('click', () => this._closeSettings());
      }
      this._els.sizeDec.addEventListener('click', () => this._changeSize(-SIZE_STEP));
      this._els.sizeInc.addEventListener('click', () => this._changeSize(SIZE_STEP));
      this._els.sizeSlider.addEventListener('input', (event) => this._setSize(Number(event.target.value)));
      this._els.partyToggle.addEventListener('click', () => this._togglePartyMode());
      this._els.rgbToggle.addEventListener('click', () => this._toggleRgbVisualizer());
      this._els.timingInput.addEventListener('change', (event) => this._setLyricOffset(Number(event.target.value)));
      this._els.timingDec.addEventListener('click', () => this._setLyricOffset(this._settings.lyricOffset - 0.1));
      this._els.timingInc.addEventListener('click', () => this._setLyricOffset(this._settings.lyricOffset + 0.1));
      this._els.timingReset.addEventListener('click', () => this._setLyricOffset(0));
      this._els.reset.addEventListener('click', () => this._resetSettings());

      root.addEventListener('click', (e) => {
        if (!this._isSettingsOpen()) return;
        const panel = this._els.settingsPanel;
        const toggle = this._els.settingsToggle;
        if (panel.contains(e.target) || toggle.contains(e.target)) return;
        this._closeSettings();
      });

      this._els.progress.addEventListener('input', (e) => {
        this._seeking = true;
        const val = Number(e.target.value);
        const seconds = this.progressValueToSeconds(val);
        const ratio = (val / PROGRESS_SCALE) * 100;
        this._els.progress.style.setProperty('--progress-pct', `${ratio.toFixed(2)}%`);
        this._els.elapsed.textContent = formatTime(seconds);
      });
      this._els.progress.addEventListener('change', (e) => {
        this._seeking = false;
        this._call('seekProgress', Number(e.target.value));
      });

      this._onKeyDown = (e) => {
        const isMac = navigator.platform && navigator.platform.toUpperCase().includes('MAC');
        const modifier = isMac ? e.metaKey : e.ctrlKey;
        if (modifier && e.shiftKey && (e.key === 'L' || e.key === 'l' || e.code === 'KeyL')) {
          e.preventDefault();
          e.stopPropagation();
          if (this._host) this._call('exit');
          return;
        }
        if (e.key === 'Escape') {
          if (this._isSettingsOpen()) {
            this._closeSettings();
            return;
          }
          if (this._queueOpen) {
            this._closeQueue();
            return;
          }
          if (this._host) this._call('exit');
          return;
        }
        const tag = (e.target && e.target.tagName) || '';
        const isTextInput = tag === 'TEXTAREA' || (tag === 'INPUT' && !['button', 'submit', 'checkbox', 'radio'].includes(e.target.type)) || (e.target && e.target.isContentEditable);
        if (e.code === 'Space' || e.key === ' ') {
          if (!isTextInput) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            if (e.repeat) return;
            const now = Date.now();
            if (now - (this._lastSpaceTime || 0) < 220) return;
            this._lastSpaceTime = now;
            if (e.target && typeof e.target.blur === 'function') {
              e.target.blur();
            }
            const isPlaying = this._els.playpause && this._els.playpause.classList.contains('is-playing');
            this.setPlaying(!isPlaying);
            this._call('togglePlay');
            return;
          }
        }
        if (!isTextInput && !e.ctrlKey && !e.metaKey && !e.altKey) {
          if (e.key === 'ArrowLeft' || e.code === 'ArrowLeft' || e.key === 'j' || e.key === 'J') {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            this._call('skipTime', -15);
            return;
          }
          if (e.key === 'ArrowRight' || e.code === 'ArrowRight' || e.key === 'l' || e.key === 'L') {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            this._call('skipTime', 15);
            return;
          }
        }
      };
      window.addEventListener('keydown', this._onKeyDown, true);

      return root;
    }

    _buildFontOptions() {
      const container = this._els.fontOptions;
      container.innerHTML = '';
      Object.keys(FONT_FAMILIES).forEach((key) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ytm-lyrics-font-swatch';
        btn.dataset.font = key;
        btn.style.fontFamily = FONT_FAMILIES[key].stack;
        btn.textContent = 'Ag';
        btn.title = FONT_FAMILIES[key].label;
        btn.setAttribute('aria-pressed', 'false');
        btn.addEventListener('click', () => this._setFontFamily(key));
        container.appendChild(btn);
      });
    }

    _buildColorOptions() {
      const container = this._els.colorOptions;
      container.innerHTML = '';
      Object.keys(COLORS).forEach((key) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ytm-lyrics-color-swatch';
        btn.dataset.color = key;
        btn.style.setProperty('--swatch-color', COLORS[key].hex);
        btn.title = COLORS[key].label;
        btn.setAttribute('aria-label', COLORS[key].label);
        btn.setAttribute('aria-pressed', 'false');
        btn.addEventListener('click', () => this._setColor(key));
        container.appendChild(btn);
      });
    }

    _buildVisualizerOptions() {
      const container = this._els.visualizerOptions;
      Object.keys(VISUALIZERS).forEach((key) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ytm-lyrics-visualizer-option';
        btn.dataset.visualizer = key;
        btn.textContent = VISUALIZERS[key];
        btn.setAttribute('aria-pressed', 'false');
        btn.addEventListener('click', () => this._setVisualizer(key));
        container.appendChild(btn);
      });
    }

    _isSettingsOpen() {
      return this._els.settingsPanel && !this._els.settingsPanel.hidden;
    }

    _toggleSettings() {
      if (this._isSettingsOpen()) this._closeSettings();
      else this._openSettings();
    }

    _openSettings() {
      this._els.settingsPanel.hidden = false;
      this._els.settingsToggle.setAttribute('aria-expanded', 'true');
    }

    _closeSettings() {
      this._els.settingsPanel.hidden = true;
      this._els.settingsToggle.setAttribute('aria-expanded', 'false');
    }

    _toggleQueue() {
      if (this._queueOpen) this._closeQueue();
      else {
        this._queueOpen = true;
        this._els.queue.hidden = false;
        this._els.queueToggle.setAttribute('aria-expanded', 'true');
        this._call('requestQueue');
      }
    }

    _closeQueue() {
      this._queueOpen = false;
      this._els.queue.hidden = true;
      this._els.queueToggle.setAttribute('aria-expanded', 'false');
    }

    _togglePartyMode() {
      this._settings.partyMode = !this._settings.partyMode;
      this._applySettings();
      this._syncSettingsControls();
      saveSettings(this._settings);
    }

    _toggleRgbVisualizer() {
      this._settings.rgbVisualizer = !this._settings.rgbVisualizer;
      this._applySettings();
      this._syncSettingsControls();
      saveSettings(this._settings);
    }

    _setVisualizer(key) {
      if (!VISUALIZERS[key]) return;
      this._settings.visualizer = key;
      this._settings.partyMode = true;
      this._applySettings();
      this._syncSettingsControls();
      saveSettings(this._settings);
    }

    _setLyricOffset(offset) {
      this._settings.lyricOffset = Math.max(-5, Math.min(5, offset));
      this._syncSettingsControls();
      saveSettings(this._settings);
      this._call('lyricsOffsetChange', this._settings.lyricOffset);
    }

    _setFontFamily(key) {
      if (!FONT_FAMILIES[key]) return;
      this._settings.fontFamily = key;
      this._applySettings();
      this._syncSettingsControls();
      saveSettings(this._settings);
      this._scrollToActiveLine(false);
    }

    _setColor(key) {
      if (!COLORS[key]) return;
      this._settings.color = key;
      this._applySettings();
      this._syncSettingsControls();
      saveSettings(this._settings);
    }

    _changeSize(delta) {
      this._setSize(this._settings.fontSize + delta);
    }

    _setSize(size) {
      this._settings.fontSize = clampSize(size);
      this._applySettings();
      this._syncSettingsControls();
      saveSettings(this._settings);
      this._scrollToActiveLine(false);
    }

    _resetSettings() {
      this._settings = { ...DEFAULT_SETTINGS };
      this._applySettings();
      this._syncSettingsControls();
      saveSettings(this._settings);
      this._scrollToActiveLine(false);
    }

    _applySettings() {
      const root = this._els.root;
      if (!root) return;
      root.style.setProperty('--ytm-lyrics-font-family', FONT_FAMILIES[this._settings.fontFamily].stack);
      root.style.setProperty('--ytm-lyrics-font-size', `${this._settings.fontSize}px`);
      root.style.setProperty('--ytm-lyrics-color-rgb', hexToRgb(COLORS[this._settings.color].hex));
      root.classList.toggle('party-mode', this._settings.partyMode);
      root.classList.toggle('rgb-visualizer', this._settings.rgbVisualizer);
      root.classList.remove(...Object.keys(VISUALIZERS).map((key) => `visualizer-${key}`));
      root.classList.add(`visualizer-${this._settings.visualizer}`);
    }

    _syncSettingsControls() {
      if (this._els.sizeValue) this._els.sizeValue.textContent = `${this._settings.fontSize}px`;
      if (this._els.sizeSlider) this._els.sizeSlider.value = String(this._settings.fontSize);
      if (this._els.sizeDec) this._els.sizeDec.disabled = this._settings.fontSize <= SIZE_MIN;
      if (this._els.sizeInc) this._els.sizeInc.disabled = this._settings.fontSize >= SIZE_MAX;
      if (this._els.partyToggle) this._els.partyToggle.setAttribute('aria-checked', String(this._settings.partyMode));
      if (this._els.rgbToggle) this._els.rgbToggle.setAttribute('aria-checked', String(this._settings.rgbVisualizer));
      if (this._els.timingInput) this._els.timingInput.value = this._settings.lyricOffset.toFixed(1);

      if (this._els.fontOptions) {
        this._els.fontOptions.querySelectorAll('.ytm-lyrics-font-swatch').forEach((btn) => {
          const isActive = btn.dataset.font === this._settings.fontFamily;
          btn.classList.toggle('is-active', isActive);
          btn.setAttribute('aria-pressed', String(isActive));
        });
      }
      if (this._els.colorOptions) {
        this._els.colorOptions.querySelectorAll('.ytm-lyrics-color-swatch').forEach((btn) => {
          const isActive = btn.dataset.color === this._settings.color;
          btn.classList.toggle('is-active', isActive);
          btn.setAttribute('aria-pressed', String(isActive));
        });
      }
      if (this._els.visualizerOptions) {
        this._els.visualizerOptions.querySelectorAll('.ytm-lyrics-visualizer-option').forEach((btn) => {
          const isActive = btn.dataset.visualizer === this._settings.visualizer;
          btn.classList.toggle('is-active', isActive);
          btn.setAttribute('aria-pressed', String(isActive));
        });
      }
    }

    setMeta({ title, artist } = {}) {
      if (!this._els.title) return;
      this._els.title.textContent = title || 'Unknown title';
      this._els.artist.textContent = artist || 'Unknown artist';
    }

    setPlaying(isPlaying) {
      if (!this._els.playpause) return;
      const playing = !!isPlaying;
      this._els.playpause.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      this._els.playpause.setAttribute('title', playing ? 'Pause (Space)' : 'Play (Space)');
      this._els.playpause.classList.toggle('is-playing', playing);
      if (this._els.iconPlay) {
        this._els.iconPlay.hidden = playing;
        this._els.iconPlay.style.display = playing ? 'none' : 'block';
      }
      if (this._els.iconPause) {
        this._els.iconPause.hidden = !playing;
        this._els.iconPause.style.display = playing ? 'block' : 'none';
      }
    }

    setDuration(seconds) {
      this._duration = seconds || 0;
      if (this._els.total) this._els.total.textContent = formatTime(this._duration);
    }

    setProgress(currentTime) {
      if (this._seeking || !this._els.progress) return;
      const pct = this._duration > 0 ? Math.min(PROGRESS_SCALE, Math.round((currentTime / this._duration) * PROGRESS_SCALE)) : 0;
      this._els.progress.value = String(pct);
      const ratio = this._duration > 0 ? Math.min(100, Math.max(0, (currentTime / this._duration) * 100)) : 0;
      this._els.progress.style.setProperty('--progress-pct', `${ratio.toFixed(2)}%`);
      this._els.elapsed.textContent = formatTime(currentTime);
    }

    progressValueToSeconds(value) {
      return this._duration > 0 ? (value / PROGRESS_SCALE) * this._duration : 0;
    }

    getLyricOffset() {
      return this._settings.lyricOffset;
    }

    resetLyricOffset() {
      this._settings.lyricOffset = 0;
      this._applySettings();
      this._syncSettingsControls();
      saveSettings(this._settings);
      this._call('lyricsOffsetChange', 0);
    }

    setVisualizerEnergy(energy) {
      if (!this._els.root) return;
      const level = Math.max(0, Math.min(1, energy));
      this._els.root.style.setProperty('--ytm-beat-scale', String(1.4 + level * 3.4));
    }

    renderQueue(items) {
      const list = this._els.queueList;
      if (!list) return;
      list.innerHTML = '';
      if (!items || !items.length) {
        list.innerHTML = '<p>Open YouTube Music\'s queue to see what is next.</p>';
        return;
      }
      items.forEach((item) => {
        const row = document.createElement('div');
        row.className = `ytm-lyrics-queue-item${item.active ? ' is-active' : ''}`;
        row.innerHTML = `<span class="ytm-lyrics-queue-index">${item.active ? '♪' : item.index + 1}</span><div><strong></strong><small></small></div>`;
        row.querySelector('strong').textContent = item.title;
        row.querySelector('small').textContent = item.artist;
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.addEventListener('click', () => this._call('playQueueItem', item.index));
        row.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            this._call('playQueueItem', item.index);
          }
        });
        list.appendChild(row);
      });
    }

    renderLyrics(state) {
      const container = this._els.lines;
      if (!container) return;
      container.innerHTML = '';
      container.classList.remove('is-plain', 'is-empty');
      this._lineEls = [];
      this._activeIndex = null;

      if (!state || state.status === 'unavailable') {
        container.classList.add('is-empty');
        const p = document.createElement('div');
        p.className = 'ytm-lyrics-empty';
        p.textContent = 'Lyrics unavailable for this song.';
        container.appendChild(p);
        if (this._els.scroll) this._els.scroll.scrollTop = 0;
        return;
      }

      if (state.status === 'plain') {
        container.classList.add('is-plain');
        const wrap = document.createElement('div');
        wrap.className = 'ytm-lyrics-plain';
        state.text.split('\n').forEach((line) => {
          const p = document.createElement('p');
          p.textContent = line.trim().length ? line : '\u00A0';
          wrap.appendChild(p);
        });
        container.appendChild(wrap);
        if (this._els.scroll) this._els.scroll.scrollTop = 0;
        return;
      }

      // synced
      if (this._els.scroll) this._els.scroll.scrollTop = 0;
      state.lines.forEach((line, i) => {
        const p = document.createElement('p');
        p.className = 'ytm-lyrics-line';
        p.textContent = line.text && line.text.trim().length ? line.text : '\u266A';
        p.dataset.index = String(i);
        p.setAttribute('role', 'button');
        p.tabIndex = 0;
        p.addEventListener('click', () => this._call('seekToTime', line.time));
        p.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            this._call('seekToTime', line.time);
          }
        });
        container.appendChild(p);
        this._lineEls.push(p);
      });
    }

    _scrollToActiveLine(smooth = true) {
      if (this._activeIndex == null || this._activeIndex < 0) return;
      const el = this._lineEls[this._activeIndex];
      const container = this._els.scroll;
      if (!el || !container) return;

      const containerRect = container.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      if (containerRect.height === 0) return;

      const currentScrollTop = container.scrollTop;
      const elCenterRelativeToContainer = (elRect.top - containerRect.top) + (elRect.height / 2);
      const containerCenter = containerRect.height / 2;
      const diff = elCenterRelativeToContainer - containerCenter;
      const targetScrollTop = currentScrollTop + diff;

      const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
      const clampedTarget = Math.max(0, Math.min(maxScroll, targetScrollTop));

      container.scrollTo({
        top: clampedTarget,
        behavior: smooth && !this._reducedMotion ? 'smooth' : 'auto',
      });
    }

    setActiveLine(index) {
      if (!this._lineEls.length) return;
      if (this._activeIndex === index) return;

      if (this._activeIndex != null && this._lineEls[this._activeIndex]) {
        this._lineEls[this._activeIndex].classList.remove('is-active');
      }

      this._activeIndex = index;
      const el = index != null && index >= 0 ? this._lineEls[index] : null;
      if (el) {
        el.classList.add('is-active');
        this._lineEls.forEach((line, lineIndex) => {
          line.classList.toggle('is-near', Math.abs(lineIndex - index) === 1);
          line.classList.toggle('is-far', Math.abs(lineIndex - index) > 1);
        });
        this._scrollToActiveLine(true);
      }
    }
  }

  window.YTMLyrics = window.YTMLyrics || {};
  window.YTMLyrics.LyricsOverlay = LyricsOverlay;
})();
