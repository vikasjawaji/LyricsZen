(function () {
  'use strict';

  const statusEl = document.getElementById('status');
  const btn = document.getElementById('action-btn');
  const shortcutEl = document.getElementById('shortcut-key');

  const isMac = navigator.platform.toUpperCase().includes('MAC');
  shortcutEl.textContent = isMac ? 'Cmd+Shift+L' : 'Ctrl+Shift+L';

  function render(kind, isActive) {
    if (kind === 'unsupported') {
      statusEl.textContent = 'Open music.youtube.com to use LyricsZen.';
      btn.disabled = true;
      btn.textContent = 'Unavailable here';
      return;
    }
    if (kind === 'error') {
      statusEl.textContent = 'Could not reach the page. Try reloading music.youtube.com.';
      btn.disabled = true;
      btn.textContent = 'Unavailable';
      return;
    }
    statusEl.textContent = isActive ? 'LyricsZen is on.' : 'LyricsZen is off.';
    btn.disabled = false;
    btn.textContent = isActive ? 'Exit LyricsZen' : 'Open LyricsZen';
  }

  function withActiveTab(cb) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => cb(tabs && tabs[0]));
  }

  function sendToggle() {
    withActiveTab((tab) => {
      if (!tab || !tab.id) return;
      chrome.tabs.sendMessage(tab.id, { type: 'YTM_LYRICS_TOGGLE' }, (resp) => {
        if (chrome.runtime.lastError) {
          render('error');
          return;
        }
        render('ok', !!(resp && resp.active));
      });
    });
  }

  btn.addEventListener('click', sendToggle);

  withActiveTab((tab) => {
    if (!tab || !tab.url || !tab.url.startsWith('https://music.youtube.com')) {
      render('unsupported');
      return;
    }
    if (!tab.id) {
      render('error');
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: 'YTM_LYRICS_GET_STATE' }, (resp) => {
      if (chrome.runtime.lastError) {
        render('error');
        return;
      }
      render('ok', !!(resp && resp.active));
    });
  });
})();
