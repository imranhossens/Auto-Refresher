// content.js
(async () => {
  try {
    // Only run in the top-level window, not in sub-frames or iframes
    if (window.self !== window.top) return;
    
    // Request current auto-reload configuration from the service worker
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'getAutoReloadConfig' }, (res) => {
        // Handle runtime disconnects or errors gracefully
        if (chrome.runtime.lastError) {
          resolve({ enabled: false });
        } else {
          resolve(res || { enabled: false });
        }
      });
    });
    
    // If auto-reload is enabled and has a valid interval
    if (response && response.enabled && response.interval > 0) {
      setTimeout(async () => {
        try {
          // Double-check if the reload config is still active before performing the reload
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
            window.location.reload();
          }
        } catch (err) {
          console.error('[Tab Reload Master] Error checking reload status:', err);
        }
      }, response.interval * 1000);
    }
  } catch (e) {
    // Gracefully handle case where extension context is invalidated (e.g. extension updated/reloaded)
  }
})();
