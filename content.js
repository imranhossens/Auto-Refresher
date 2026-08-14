// content.js
(async () => {
  try {
    // Only run in the top-level window, not in sub-frames or iframes
    if (window.self !== window.top) return;
    
    // Start cross-device activity tracking if enabled
    (async () => {
      try {
        const { syncEnabled = true, syncDomains = [] } = await chrome.storage.local.get(['syncEnabled', 'syncDomains']);
        if (!syncEnabled || syncDomains.length === 0) return;

        const hostname = window.location.hostname.toLowerCase();
        const matchedDomain = syncDomains.find(d => {
          const cleanD = d.trim().toLowerCase();
          return hostname === cleanD || hostname.endsWith('.' + cleanD);
        });

        if (!matchedDomain) return;

        const storageKey = `cross_device_active_${matchedDomain}`;
        let lastWriteTime = 0;

        const recordActivity = async () => {
          const now = Date.now();
          // Throttle writes to once a minute: enough resolution for an idle
          // timeout measured in minutes, while staying inside Chrome's sync
          // quota and the write limits on free hosted backends.
          if (now - lastWriteTime > 60000) {
            lastWriteTime = now;
            try {
              chrome.runtime.sendMessage({ type: 'recordSyncActivity', domain: matchedDomain });
            } catch (err) {
              console.error('[Auto Refresher] Failed to send activity message:', err);
            }
          }
        };

        const events = ['mousedown', 'keydown', 'scroll', 'touchstart'];
        events.forEach(evt => {
          window.addEventListener(evt, recordActivity, { passive: true });
        });

        window.addEventListener('focus', recordActivity);

        // A page load counts as user activity (manual F5, navigation, opening
        // the tab) — except when this extension's own job triggered the
        // reload, which background.js flags beforehand. Without that check the
        // job would mark itself active and block its own next refresh.
        let selfReload = false;
        try {
          selfReload = sessionStorage.getItem('__autoRefreshSelfReload') === '1';
          if (selfReload) sessionStorage.removeItem('__autoRefreshSelfReload');
        } catch (e) {
          // sessionStorage unavailable (sandboxed/opaque origin).
        }
        if (!selfReload) recordActivity();
      } catch (e) {
        // Ignore errors
      }
    })();

    // Auto reload timer logic
    function setupReloadTimer(seconds) {
      setTimeout(async () => {
        try {
          const check = await new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: 'getAutoReloadConfig' }, (res) => {
              if (chrome.runtime.lastError) {
                resolve({ enabled: false });
              } else {
                resolve(res || { enabled: false });
              }
            });
          });
          
          if (check && check.enabled) {
            if (check.delayOnly) {
              // Paused due to cross-device activity, try again in 30 seconds
              setupReloadTimer(30);
            } else {
              window.location.reload();
            }
          }
        } catch (err) {
          console.error('[Tab Reload Master] Error checking reload status:', err);
        }
      }, seconds * 1000);
    }

    // Request initial config
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'getAutoReloadConfig' }, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ enabled: false });
        } else {
          resolve(res || { enabled: false });
        }
      });
    });

    if (response && response.enabled && response.interval > 0) {
      if (response.delayOnly) {
        setupReloadTimer(30);
      } else {
        setupReloadTimer(response.interval);
      }
    }
  } catch (e) {
    // Gracefully handle context invalidation
  }
})();
