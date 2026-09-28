/**
 * content.js
 *
 * Wires the player, lyrics engine/sync, and overlay UI together, and
 * owns the Lyrics Mode on/off lifecycle. Runs once per page load;
 * reacts to SPA navigation and song changes via events (no polling).
 */
(function () {
  'use strict';

  const NS = window.YTMLyrics;
  if (!NS || !NS.Player || !NS.LyricsSync || !NS.LyricsEngine || !NS.LyricsOverlay || !NS.Navigation) {
    console.error('[YTM Lyrics] required modules failed to load; aborting init');
    return;
  }

  // Inject one small global stylesheet for lyrics mode and the persistent launcher floater
  if (!document.getElementById('ytm-lyrics-mode-global-style')) {
    const globalStyle = document.createElement('style');
    globalStyle.id = 'ytm-lyrics-mode-global-style';
    globalStyle.textContent = `
      html.ytm-lyrics-mode-active { overflow: hidden !important; }
      #ytm-lyrics-launcher {
        position: fixed;
        right: 24px;
        bottom: 94px;
        z-index: 2147483648 !important;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 11px 16px;
        border: 1px solid rgba(255,255,255,.25);
        border-radius: 999px;
        background: rgba(20,19,24,.92);
        color: #fff;
        box-shadow: 0 10px 26px rgba(0,0,0,.35);
        font: 600 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        cursor: pointer;
        backdrop-filter: blur(12px);
        transition: bottom .2s ease, background .15s ease, border-color .15s ease, box-shadow .15s ease;
      }
      #ytm-lyrics-launcher:hover {
        border-color: #d4a2ff;
        background: rgba(71,45,93,.95);
      }
      #ytm-lyrics-launcher .ytm-lyrics-launcher-mark {
        color: #e2b8ff;
        font-size: 17px;
        line-height: 1;
      }
      /* In Lyrics Mode: floater remains visible at bottom right as the Close/Exit button */
      #ytm-lyrics-launcher.is-in-lyrics-mode {
        bottom: 26px;
        background: rgba(26, 23, 33, 0.94);
        border-color: rgba(255, 255, 255, 0.32);
        box-shadow: 0 8px 24px rgba(0,0,0,0.55);
      }
      #ytm-lyrics-launcher.is-in-lyrics-mode:hover {
        background: rgba(215, 45, 75, 0.95);
        border-color: rgba(255, 120, 140, 0.85);
        color: #fff;
      }
      #ytm-lyrics-launcher.is-in-lyrics-mode .ytm-lyrics-launcher-mark {
        color: #ff99aa;
        font-size: 13px;
        font-weight: 700;
      }
    `;
    document.head.appendChild(globalStyle);
  }

  const player = new NS.Player();
  const sync = new NS.LyricsSync();
  const engine = new NS.LyricsEngine(NS.activeLyricsProvider);

  let overlay = null;
  let active = false;
  let currentMeta = null;
  let currentLyricsState = null;
  let lyricOffset = 0;
  let currentFetchToken = 0;
  // Guards against rapid toggle-on/toggle-off: if deactivate() runs while
  // an activate() call is still awaiting overlay.mount(), the in-flight
  // activation must detect that and clean itself up instead of finishing
  // (which would otherwise leave an orphaned overlay in the DOM).
  let activationToken = 0;

  function onPlay() {
    if (overlay) overlay.setPlaying(true);
  }
  function onPause() {
    if (overlay) overlay.setPlaying(false);
  }
  function onTime(t) {
    if (!overlay) return;
    overlay.setPlaying(player.isPlaying());
    overlay.setProgress(t);
    if (currentLyricsState && currentLyricsState.status === 'synced') {
      overlay.setActiveLine(sync.getActiveIndex(t + lyricOffset));
    }
  }
  function onDurationChange(d) {
    if (overlay) overlay.setDuration(d);
  }
  function onSongChange(meta) {
    syncMetaAndLyrics(meta);
  }

  async function syncMetaAndLyrics(meta) {
    if (!meta || !meta.title || meta.title === 'Unknown title') return;
    const fetchToken = ++currentFetchToken;
    currentMeta = meta;
    if (!overlay) return;

    lyricOffset = 0;
    overlay.resetLyricOffset();
    overlay.setActiveLine(-1);
    overlay.setMeta(meta);
    overlay.renderLyrics({ status: 'unavailable' });
    sync.reset();
    currentLyricsState = null;

    const result = await engine.getLyrics({ ...meta, duration: player.getDuration() });

    // A newer song may have started while this fetch was in flight.
    if (fetchToken !== currentFetchToken || !overlay) return;

    currentLyricsState = result;
    overlay.renderLyrics(result);
    if (result.status === 'synced') {
      sync.setLines(result.lines);
      const curTime = player.getCurrentTime();
      overlay.setActiveLine(sync.getActiveIndex(curTime + lyricOffset));
    }
  }

  async function activate() {
    if (active) return;
    active = true;
    updateLauncher(true);
    const myToken = ++activationToken;

    const localOverlay = new NS.LyricsOverlay();
    localOverlay.on('exit', deactivate);
    localOverlay.on('togglePlay', () => player.togglePlay());
    localOverlay.on('previous', () => player.previous());
    localOverlay.on('next', () => player.next());
    localOverlay.on('skipTime', (delta) => player.seekRelative(delta));
    localOverlay.on('requestQueue', () => localOverlay.renderQueue(player.getQueue()));
    localOverlay.on('playQueueItem', (index) => player.playQueueItem(index));
    localOverlay.on('lyricsOffsetChange', (offset) => { lyricOffset = offset; onTime(player.getCurrentTime()); });
    localOverlay.on('seekToTime', (seconds) => player.seekTo(seconds - lyricOffset));
    localOverlay.on('seekProgress', (value) => player.seekTo(localOverlay.progressValueToSeconds(value)));

    document.documentElement.classList.add('ytm-lyrics-mode-active');
    await localOverlay.mount();

    if (myToken !== activationToken || !active) {
      // We were deactivated (or superseded by a newer activation) while
      // mounting. Tear down what we just built and bail out silently.
      localOverlay.unmount();
      if (!active) {
        document.documentElement.classList.remove('ytm-lyrics-mode-active');
        updateLauncher(false);
      }
      return;
    }

    overlay = localOverlay;
    lyricOffset = overlay.getLyricOffset();

    player.on('play', onPlay);
    player.on('pause', onPause);
    player.on('timeupdate', onTime);
    player.on('durationchange', onDurationChange);
    player.on('songchange', onSongChange);
    player.ensureAttached();

    overlay.setPlaying(player.isPlaying());
    overlay.setDuration(player.getDuration());
    overlay.setProgress(player.getCurrentTime());
    syncMetaAndLyrics(player.getMetadata());
  }

  function deactivate() {
    if (!active) return;
    active = false;
    activationToken++; // invalidate any in-flight activate() call

    player.off('play', onPlay);
    player.off('pause', onPause);
    player.off('timeupdate', onTime);
    player.off('durationchange', onDurationChange);
    player.off('songchange', onSongChange);
    player.detach();

    document.documentElement.classList.remove('ytm-lyrics-mode-active');
    updateLauncher(false);
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }

    if (overlay) {
      overlay.unmount();
      overlay = null;
    }
    currentLyricsState = null;
    lyricOffset = 0;
  }

  let lastToggleTime = 0;
  function toggle() {
    const now = Date.now();
    if (now - lastToggleTime < 250) return;
    lastToggleTime = now;
    if (active) deactivate();
    else activate();
  }

  // In-page keyboard shortcut capture (works even if Chrome commands fail to bind)
  window.addEventListener('keydown', (e) => {
    const isMac = navigator.platform && navigator.platform.toUpperCase().includes('MAC');
    const modifier = isMac ? e.metaKey : e.ctrlKey;
    if (modifier && e.shiftKey && (e.key === 'L' || e.key === 'l' || e.code === 'KeyL')) {
      e.preventDefault();
      e.stopPropagation();
      toggle();
    }
  }, true);

  function updateLauncher(inLyricsMode) {
    const launcher = document.getElementById('ytm-lyrics-launcher');
    if (!launcher) return;
    launcher.hidden = false;
    if (inLyricsMode) {
      launcher.classList.add('is-in-lyrics-mode');
      launcher.setAttribute('aria-label', 'Exit LyricsZen');
      launcher.setAttribute('title', 'Exit LyricsZen (Esc)');
      launcher.innerHTML = '<span class="ytm-lyrics-launcher-mark">✕</span> Exit LyricsZen';
    } else {
      launcher.classList.remove('is-in-lyrics-mode');
      launcher.setAttribute('aria-label', 'Open LyricsZen');
      launcher.setAttribute('title', 'Open LyricsZen (Ctrl+Shift+L)');
      launcher.innerHTML = '<span class="ytm-lyrics-launcher-mark">♪</span> LyricsZen';
    }
  }

  function installLauncher() {
    if (document.getElementById('ytm-lyrics-launcher')) return;
    const launcher = document.createElement('button');
    launcher.id = 'ytm-lyrics-launcher';
    launcher.type = 'button';
    launcher.setAttribute('aria-label', 'Open LyricsZen');
    launcher.innerHTML = '<span class="ytm-lyrics-launcher-mark">♪</span> LyricsZen';
    launcher.addEventListener('click', toggle);
    document.body.appendChild(launcher);
  }

  installLauncher();

  // Re-check the video element and metadata on SPA navigation (covers
  // song changes, queue changes, and back/forward) while Lyrics Mode
  // is on.
  NS.Navigation.init();
  NS.Navigation.onNavigate(() => {
    if (!active) return;
    player.ensureAttached();
    player.checkSongChange();
    setTimeout(() => { if (active) player.checkSongChange(); }, 150);
    setTimeout(() => { if (active) player.checkSongChange(); }, 400);
    setTimeout(() => { if (active) player.checkSongChange(); }, 900);
    if (overlay) {
      overlay.setDuration(player.getDuration());
      overlay.setProgress(player.getCurrentTime());
      overlay.setPlaying(player.isPlaying());
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return undefined;
    if (msg.type === 'YTM_LYRICS_TOGGLE') {
      toggle();
      sendResponse({ active });
      return true;
    }
    if (msg.type === 'YTM_LYRICS_GET_STATE') {
      sendResponse({ active });
      return true;
    }
    return undefined;
  });
})();
