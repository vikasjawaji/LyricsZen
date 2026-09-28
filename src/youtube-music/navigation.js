/**
 * navigation.js
 *
 * YouTube Music is a single-page app. Route changes (including song
 * changes that happen via the UI rather than a fresh <video> element)
 * fire a `yt-navigate-finish` event on `document`. We subscribe to that
 * single native event instead of polling the DOM or running an
 * unbounded MutationObserver, so this stays cheap for the lifetime of
 * the tab.
 */
(function () {
  'use strict';

  const listeners = new Set();
  let initialized = false;

  function handleNavigate() {
    listeners.forEach((cb) => {
      try {
        cb();
      } catch (err) {
        console.error('[YTM Lyrics] navigation listener error', err);
      }
    });
  }

  function init() {
    if (initialized) return;
    initialized = true;
    document.addEventListener('yt-navigate-finish', handleNavigate);
    document.addEventListener('yt-page-data-updated', handleNavigate);
  }

  function onNavigate(cb) {
    listeners.add(cb);
  }

  function offNavigate(cb) {
    listeners.delete(cb);
  }

  window.YTMLyrics = window.YTMLyrics || {};
  window.YTMLyrics.Navigation = { init, onNavigate, offNavigate };
})();
