// popup-boot.js — runs in <head>, before the popup body is parsed.
(function () {
  // Paint the first frame in the saved theme instead of dark-then-light.
  // popup.js mirrors popupTheme into localStorage, which (unlike chrome.storage) is synchronous.
  try {
    let theme = localStorage.getItem('rcbPopupTheme');
    if (theme === 'system') {
      theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    if (theme === 'dark' || theme === 'light') {
      document.documentElement.setAttribute('data-theme', theme);
    }
  } catch (err) {
    // No cached theme: popup.js applies the stored one once storage loads.
  }

  // Start the storage read now so it overlaps parsing the rest of the page. popup.js consumes it.
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local || !self.RCB) {
    return;
  }
  const keys = RCB.STORAGE_FIELDS.concat([
    'filteringEnabled',
    'showChatControls',
    'recentAdds',
    'blockListSort',
    'popupTheme'
  ]);
  RCB.popupInitialRead = new Promise(function (resolve) {
    chrome.storage.local.get(keys, function (result) {
      resolve({ result: result, failed: !!chrome.runtime.lastError });
    });
  });
})();
