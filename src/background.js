/**
 * background.js
 *
 * Minimal service worker whose only job is relaying the
 * "toggle-lyrics-mode" keyboard command to the content script running
 * on the active tab. No storage, no analytics, no network requests.
 */
chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-lyrics-mode') return;

  function sendToggle(tabId) {
    if (!tabId) return;
    chrome.tabs.sendMessage(tabId, { type: 'YTM_LYRICS_TOGGLE' }, () => {
      void chrome.runtime.lastError;
    });
  }

  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (tab && tab.id) {
      sendToggle(tab.id);
      return;
    }
    chrome.tabs.query({ url: 'https://music.youtube.com/*' }, (ytTabs) => {
      const activeYtTab = ytTabs && (ytTabs.find((t) => t.active) || ytTabs[0]);
      if (activeYtTab && activeYtTab.id) {
        sendToggle(activeYtTab.id);
      }
    });
  });
});
