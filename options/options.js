document.addEventListener('DOMContentLoaded', async () => {
  // Elements
  const selectClickBehavior = document.getElementById('select-click-behavior');
  const behaviorWarning = document.getElementById('behavior-warning');
  const toggleBypassCache = document.getElementById('toggle-bypass-cache');
  const timersList = document.getElementById('timers-list');
  const emptyState = document.getElementById('empty-state');

  // Load and apply settings
  const settings = await chrome.storage.local.get(['bypassCache', 'clickBehavior', 'autoReloadTabs']);
  
  // 1. Bypass Cache
  toggleBypassCache.checked = settings.bypassCache || false;
  toggleBypassCache.addEventListener('change', async () => {
    await chrome.storage.local.set({ bypassCache: toggleBypassCache.checked });
  });

  // 2. Click Behavior
  const clickBehavior = settings.clickBehavior || 'popup';
  selectClickBehavior.value = clickBehavior;
  updateWarningState(clickBehavior);
  
  selectClickBehavior.addEventListener('change', async () => {
    const val = selectClickBehavior.value;
    await chrome.storage.local.set({ clickBehavior: val });
    updateWarningState(val);
    
    // Notify service worker to update the toolbar action behavior
    chrome.runtime.sendMessage({ type: 'settingsChanged' });
  });

  function updateWarningState(behavior) {
    if (behavior === 'popup') {
      behaviorWarning.classList.add('hidden');
    } else {
      behaviorWarning.classList.remove('hidden');
    }
  }

  // 3. Render Dashboard Timers List
  async function renderTimers() {
    // Clear list (except empty state row)
    const rows = timersList.querySelectorAll('tr:not(#empty-state)');
    rows.forEach(r => r.remove());
    
    const settings = await chrome.storage.local.get('autoReloadTabs');
    const autoReloadTabs = settings.autoReloadTabs || {};
    
    const activeTabIds = Object.keys(autoReloadTabs);
    
    if (activeTabIds.length === 0) {
      emptyState.classList.remove('hidden');
      return;
    }
    
    emptyState.classList.add('hidden');
    
    // Fetch all open tabs in all windows to match titles/urls
    const openTabs = await chrome.tabs.query({});
    const tabMap = new Map(openTabs.map(t => [t.id, t]));
    
    // Track if we need to clean up any stale tabs that were closed
    let storageChanged = false;
    
    for (const tabIdStr of activeTabIds) {
      const tabId = parseInt(tabIdStr, 10);
      const config = autoReloadTabs[tabIdStr];
      
      if (!config || !config.enabled) continue;
      
      const tab = tabMap.get(tabId);
      
      // If the tab doesn't exist anymore, it was closed. Clean up storage.
      if (!tab) {
        delete autoReloadTabs[tabIdStr];
        storageChanged = true;
        continue;
      }
      
      // Create Row elements
      const tr = document.createElement('tr');
      
      // Title cell
      const tdTitle = document.createElement('td');
      const divTitleGroup = document.createElement('div');
      divTitleGroup.className = 'tab-title-cell';
      
      const spanTabName = document.createElement('span');
      spanTabName.className = 'tab-name';
      spanTabName.textContent = tab.title || 'Untitled Tab';
      
      const spanTabUrl = document.createElement('span');
      spanTabUrl.className = 'tab-url';
      spanTabUrl.textContent = tab.url || config.url || 'No URL';
      
      divTitleGroup.appendChild(spanTabName);
      divTitleGroup.appendChild(spanTabUrl);
      tdTitle.appendChild(divTitleGroup);
      
      // Interval cell
      const tdInterval = document.createElement('td');
      tdInterval.textContent = formatInterval(config.interval);
      
      // Action cell
      const tdAction = document.createElement('td');
      const btnStop = document.createElement('button');
      btnStop.className = 'btn-danger';
      btnStop.textContent = 'Stop Timer';
      btnStop.addEventListener('click', async () => {
        delete autoReloadTabs[tabIdStr];
        await chrome.storage.local.set({ autoReloadTabs });
        renderTimers();
      });
      tdAction.appendChild(btnStop);
      
      tr.appendChild(tdTitle);
      tr.appendChild(tdInterval);
      tr.appendChild(tdAction);
      
      timersList.appendChild(tr);
    }
    
    if (storageChanged) {
      await chrome.storage.local.set({ autoReloadTabs });
    }
  }

  function formatInterval(seconds) {
    if (seconds % 60 === 0) {
      const mins = seconds / 60;
      return `Every ${mins} minute${mins > 1 ? 's' : ''}`;
    }
    return `Every ${seconds} second${seconds > 1 ? 's' : ''}`;
  }

  // 4. Keyboard Shortcuts Dashboard
  async function renderShortcuts() {
    const listContainer = document.getElementById('shortcuts-list');
    if (!listContainer) return;
    listContainer.innerHTML = '';
    
    try {
      const commands = await chrome.commands.getAll();
      if (!commands || commands.length === 0) {
        listContainer.innerHTML = '<p class="shortcut-unassigned">No shortcuts registered.</p>';
        return;
      }
      
      commands.forEach(cmd => {
        const item = document.createElement('div');
        item.className = 'shortcut-item';
        
        const info = document.createElement('div');
        info.className = 'shortcut-info';
        
        const action = document.createElement('span');
        action.className = 'shortcut-action';
        // Format name nicely (e.g. reload-all -> Reload All)
        let formattedName = cmd.name;
        if (cmd.name === '_execute_action') {
          formattedName = 'Open Extension Popup';
        } else {
          formattedName = cmd.name
            .split('-')
            .map(w => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ');
        }
        action.textContent = formattedName;
        
        const desc = document.createElement('span');
        desc.className = 'shortcut-desc';
        desc.textContent = cmd.description;
        
        info.appendChild(action);
        info.appendChild(desc);
        
        const keySpan = document.createElement('span');
        if (cmd.shortcut) {
          keySpan.className = 'shortcut-key';
          keySpan.textContent = cmd.shortcut;
        } else {
          keySpan.className = 'shortcut-unassigned';
          keySpan.textContent = 'Not configured';
        }
        
        item.appendChild(info);
        item.appendChild(keySpan);
        
        listContainer.appendChild(item);
      });
    } catch (e) {
      console.error("Error reading commands:", e);
    }
  }

  // Bind configure button click
  const btnConfigureShortcuts = document.getElementById('btn-configure-shortcuts');
  if (btnConfigureShortcuts) {
    btnConfigureShortcuts.addEventListener('click', () => {
      chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });
  }

  // Initial render
  await renderTimers();
  await renderShortcuts();
  
  // Listen for storage changes to keep options dashboard in sync with popup
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && (changes.autoReloadTabs || changes.clickBehavior)) {
      renderTimers();
      if (changes.clickBehavior) {
        selectClickBehavior.value = changes.clickBehavior.newValue;
        updateWarningState(changes.clickBehavior.newValue);
      }
    }
  });
});
