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

  // 5. Target Reload Links Manager Logic
  const optionsNewLink = document.getElementById('options-new-link');
  const optionsBtnAddLink = document.getElementById('options-btn-add-link');
  const targetLinksList = document.getElementById('target-links-list');
  const linksEmptyState = document.getElementById('links-empty-state');
  const btnToggleSeeMore = document.getElementById('btn-toggle-see-more');
  const seeMoreText = document.getElementById('see-more-text');

  const DEFAULT_VISIBLE_COUNT = 2;
  let isTargetLinksExpanded = false;

  if (btnToggleSeeMore) {
    btnToggleSeeMore.addEventListener('click', () => {
      isTargetLinksExpanded = !isTargetLinksExpanded;
      if (isTargetLinksExpanded) {
        btnToggleSeeMore.classList.add('expanded');
      } else {
        btnToggleSeeMore.classList.remove('expanded');
      }
      renderTargetLinks();
    });
  }

  async function getTargetLinks() {
    let { specificUrls, specificUrl } = await chrome.storage.local.get(['specificUrls', 'specificUrl']);
    if (!Array.isArray(specificUrls)) {
      specificUrls = specificUrl ? [specificUrl] : [];
      await chrome.storage.local.set({ specificUrls });
    }
    return specificUrls;
  }

  async function saveTargetLinks(links) {
    const uniqueLinks = Array.from(new Set(links.map(l => l.trim()).filter(Boolean)));
    await chrome.storage.local.set({ specificUrls: uniqueLinks });
    await renderTargetLinks();
  }

  async function renderTargetLinks() {
    if (!targetLinksList) return;
    const links = await getTargetLinks();
    
    // Clear existing dynamic rows
    const rows = targetLinksList.querySelectorAll('tr:not(#links-empty-state)');
    rows.forEach(r => r.remove());

    if (links.length === 0) {
      if (linksEmptyState) linksEmptyState.classList.remove('hidden');
      if (btnToggleSeeMore) btnToggleSeeMore.classList.add('hidden');
      return;
    }

    if (linksEmptyState) linksEmptyState.classList.add('hidden');

    // Handle See More button visibility & text
    if (links.length > DEFAULT_VISIBLE_COUNT) {
      if (btnToggleSeeMore) btnToggleSeeMore.classList.remove('hidden');
      if (seeMoreText) {
        if (isTargetLinksExpanded) {
          seeMoreText.textContent = 'Show Less';
        } else {
          const hiddenCount = links.length - DEFAULT_VISIBLE_COUNT;
          seeMoreText.textContent = `See More (${hiddenCount} more)`;
        }
      }
    } else {
      if (btnToggleSeeMore) btnToggleSeeMore.classList.add('hidden');
    }

    const openTabs = await chrome.tabs.query({});

    links.forEach((linkStr, index) => {
      // If collapsed, only render up to DEFAULT_VISIBLE_COUNT items
      if (!isTargetLinksExpanded && index >= DEFAULT_VISIBLE_COUNT) {
        return;
      }

      const tr = document.createElement('tr');

      // Link / Keyword cell
      const tdLink = document.createElement('td');
      const linkWrapper = document.createElement('div');
      linkWrapper.className = 'cell-content-wrapper';

      const linkSpan = document.createElement('span');
      linkSpan.style.fontFamily = 'monospace';
      linkSpan.style.fontSize = '12px';
      linkSpan.style.color = '#fff';
      linkSpan.style.maxWidth = '380px';
      linkSpan.style.overflow = 'hidden';
      linkSpan.style.textOverflow = 'ellipsis';
      linkSpan.style.whiteSpace = 'nowrap';
      linkSpan.style.display = 'block';
      linkSpan.title = linkStr;
      linkSpan.textContent = linkStr;
      linkWrapper.appendChild(linkSpan);
      tdLink.appendChild(linkWrapper);

      // Status cell
      const tdStatus = document.createElement('td');
      const statusWrapper = document.createElement('div');
      statusWrapper.className = 'cell-content-wrapper center';

      const query = linkStr.toLowerCase().trim();
      const matchingTabs = openTabs.filter(t => t.url && t.url.toLowerCase().includes(query));
      const dot = document.createElement('span');
      if (matchingTabs.length > 0) {
        dot.className = 'status-dot dot-green';
        dot.title = `Open (${matchingTabs.length} tab${matchingTabs.length > 1 ? 's' : ''})`;
      } else {
        dot.className = 'status-dot dot-red';
        dot.title = 'Not open';
      }
      statusWrapper.appendChild(dot);
      tdStatus.appendChild(statusWrapper);

      // Actions cell
      const tdActions = document.createElement('td');
      const actionsGroup = document.createElement('div');
      actionsGroup.className = 'actionsGroup cell-content-wrapper right';
      actionsGroup.style.gap = '6px';

      const btnEdit = document.createElement('button');
      btnEdit.className = 'btn-icon-action btn-icon-edit';
      btnEdit.title = 'Edit link';
      btnEdit.setAttribute('aria-label', 'Edit link');
      btnEdit.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`;
      
      // Inline Edit Handler
      btnEdit.addEventListener('click', (e) => {
        e.stopPropagation();
        
        // Enter edit mode in linkWrapper
        linkWrapper.innerHTML = '';
        const editInput = document.createElement('input');
        editInput.type = 'text';
        editInput.className = 'inline-edit-input';
        editInput.value = linkStr;
        linkWrapper.appendChild(editInput);
        editInput.focus();
        editInput.select();

        // Swap action buttons to Save & Cancel
        actionsGroup.innerHTML = '';
        
        const btnSave = document.createElement('button');
        btnSave.className = 'btn-icon-action btn-icon-save';
        btnSave.title = 'Save changes';
        btnSave.setAttribute('aria-label', 'Save changes');
        btnSave.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

        const btnCancel = document.createElement('button');
        btnCancel.className = 'btn-icon-action btn-icon-cancel';
        btnCancel.title = 'Cancel editing';
        btnCancel.setAttribute('aria-label', 'Cancel editing');
        btnCancel.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;

        const saveChanges = async () => {
          const newVal = editInput.value.trim();
          if (newVal) {
            const currentLinks = await getTargetLinks();
            if (index >= 0 && index < currentLinks.length) {
              currentLinks[index] = newVal;
              await saveTargetLinks(currentLinks);
            } else {
              await renderTargetLinks();
            }
          } else {
            await renderTargetLinks();
          }
        };

        btnSave.addEventListener('click', (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          saveChanges();
        });

        btnCancel.addEventListener('click', (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          renderTargetLinks();
        });
        
        editInput.addEventListener('keydown', (ke) => {
          if (ke.key === 'Enter') {
            ke.preventDefault();
            saveChanges();
          } else if (ke.key === 'Escape') {
            ke.preventDefault();
            renderTargetLinks();
          }
        });

        actionsGroup.appendChild(btnSave);
        actionsGroup.appendChild(btnCancel);
      });

      const btnDelete = document.createElement('button');
      btnDelete.className = 'btn-icon-action btn-icon-danger';
      btnDelete.title = 'Delete link';
      btnDelete.setAttribute('aria-label', 'Delete link');
      btnDelete.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
      
      // Precise Single Item Deletion Handler
      btnDelete.addEventListener('click', async (e) => {
        e.stopPropagation();
        const currentLinks = await getTargetLinks();
        if (index >= 0 && index < currentLinks.length) {
          currentLinks.splice(index, 1);
          await saveTargetLinks(currentLinks);
        }
      });

      actionsGroup.appendChild(btnEdit);
      actionsGroup.appendChild(btnDelete);
      tdActions.appendChild(actionsGroup);

      tr.appendChild(tdLink);
      tr.appendChild(tdStatus);
      tr.appendChild(tdActions);

      targetLinksList.appendChild(tr);
    });
  }

  if (optionsBtnAddLink && optionsNewLink) {
    const handleAdd = async () => {
      const val = optionsNewLink.value.trim();
      if (!val) return;
      const links = await getTargetLinks();
      if (!links.includes(val)) {
        links.push(val);
        await saveTargetLinks(links);
      }
      optionsNewLink.value = '';
    };

    optionsBtnAddLink.addEventListener('click', handleAdd);
    optionsNewLink.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleAdd();
    });
  }

  // Initial render
  await renderTimers();
  await renderShortcuts();
  await renderTargetLinks();
  await initOptionsGroups();
  
  let renderOptionsGroupsRef = null;

  // Listen for storage changes to keep options dashboard in sync
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') {
      if (changes.autoReloadTabs || changes.clickBehavior) {
        renderTimers();
        if (changes.clickBehavior) {
          selectClickBehavior.value = changes.clickBehavior.newValue;
          updateWarningState(changes.clickBehavior.newValue);
        }
      }
      if (changes.specificUrls || changes.specificUrl) {
        renderTargetLinks();
      }
      if (changes.linkGroups) {
        // Rerender groups in options page when modified
        if (typeof renderOptionsGroupsRef === "function") {
          renderOptionsGroupsRef();
        }
      }
    }
  });

  // 6. Link Groups Central Dashboard Logic in Options Page
  async function initOptionsGroups() {
    const form = document.getElementById("options-group-form");
    const nameInput = document.getElementById("options-group-name");
    const swatches = document.querySelectorAll("#options-color-swatches .color-swatch");
    const customColorInput = document.getElementById("options-group-color");
    const colorPickerBtnWrap = document.getElementById("options-color-picker-btn-wrap");
    const customColorPopover = document.getElementById("options-custom-color-popover");
    const customColorTextInput = document.getElementById("options-custom-color-text-input");
    const customColorPreviewDot = document.getElementById("options-custom-color-preview-dot");
    const formatBtns = document.querySelectorAll("#options-custom-color-popover .format-btn");
    const submitBtn = document.getElementById("options-group-submit");
    const editBanner = document.getElementById("options-group-edit-banner");
    const cancelEditBtn = document.getElementById("options-cancel-group-edit");
    const groupsListContainer = document.getElementById("options-groups-list");

    let selectedColor = "#3b82f6";
    let editingGroupId = null;
    let currentColorFormat = "hex";

    // Format Conversion Utilities
    function hexToRgb(hex) {
      hex = hex.replace(/^#/, "");
      if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
      const num = parseInt(hex, 16);
      return isNaN(num) ? { r: 59, g: 130, b: 246 } : { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
    }

    function rgbToHex(r, g, b) {
      const toHex = (n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
      return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
    }

    function rgbToHsl(r, g, b) {
      r /= 255; g /= 255; b /= 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      let h = 0, s = 0, l = (max + min) / 2;
      if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
          case r: h = (g - b) / d + (g < b ? 6 : 0); break;
          case g: h = (b - r) / d + 2; break;
          case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
      }
      return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
    }

    function hslToRgb(h, s, l) {
      h /= 360; s /= 100; l /= 100;
      let r, g, b;
      if (s === 0) {
        r = g = b = l;
      } else {
        const hue2rgb = (p, q, t) => {
          if (t < 0) t += 1;
          if (t > 1) t -= 1;
          if (t < 1 / 6) return p + (q - p) * 6 * t;
          if (t < 1 / 2) return q;
          if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
          return p;
        };
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue2rgb(p, q, h + 1 / 3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1 / 3);
      }
      return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
    }

    function updateCustomColorUI(hexColor) {
      const hexClean = hexColor.startsWith("#") ? hexColor.toUpperCase() : "#" + hexColor.toUpperCase();
      if (customColorPreviewDot) {
        customColorPreviewDot.style.backgroundColor = hexClean;
        customColorPreviewDot.style.boxShadow = `0 0 10px ${hexClean}`;
      }
      if (customColorInput) customColorInput.value = hexClean.toLowerCase();

      if (!customColorTextInput) return;
      const { r, g, b } = hexToRgb(hexClean);
      if (currentColorFormat === "hex") {
        customColorTextInput.value = hexClean;
      } else if (currentColorFormat === "rgb") {
        customColorTextInput.value = `rgb(${r}, ${g}, ${b})`;
      } else if (currentColorFormat === "hsl") {
        const { h, s, l } = rgbToHsl(r, g, b);
        customColorTextInput.value = `hsl(${h}, ${s}%, ${l}%)`;
      }
    }

    function parseTextInputColor(val) {
      val = val.trim().toLowerCase();
      if (/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(val)) {
        let hex = val.startsWith("#") ? val : "#" + val;
        if (hex.length === 4) hex = "#" + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
        return hex.toUpperCase();
      }
      const rgbMatch = val.match(/^rgb\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i);
      if (rgbMatch) {
        return rgbToHex(parseInt(rgbMatch[1], 10), parseInt(rgbMatch[2], 10), parseInt(rgbMatch[3], 10));
      }
      const hslMatch = val.match(/^hsl\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})%\s*,\s*(\d{1,3})%\s*\)$/i);
      if (hslMatch) {
        const { r, g, b } = hslToRgb(parseInt(hslMatch[1], 10), parseInt(hslMatch[2], 10), parseInt(hslMatch[3], 10));
        return rgbToHex(r, g, b);
      }
      return null;
    }

    swatches.forEach((swatch) => {
      const handleSelect = () => {
        swatches.forEach((s) => s.classList.remove("active"));
        swatch.classList.add("active");
        selectedColor = swatch.dataset.color;
        if (colorPickerBtnWrap) colorPickerBtnWrap.classList.remove("active");
        if (customColorPopover) customColorPopover.classList.add("hidden");
        updateCustomColorUI(selectedColor);
      };
      swatch.addEventListener("click", handleSelect);
      swatch.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleSelect();
        }
      });
    });

    if (colorPickerBtnWrap) {
      const togglePopover = (e) => {
        e.stopPropagation();
        const isOpen = !customColorPopover.classList.contains("hidden");
        if (isOpen) {
          customColorPopover.classList.add("hidden");
        } else {
          customColorPopover.classList.remove("hidden");
          swatches.forEach((s) => s.classList.remove("active"));
          colorPickerBtnWrap.classList.add("active");
          updateCustomColorUI(selectedColor);
        }
      };
      colorPickerBtnWrap.addEventListener("click", togglePopover);
      colorPickerBtnWrap.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          togglePopover(e);
        }
      });
    }

    if (customColorPopover) {
      customColorPopover.addEventListener("click", (e) => e.stopPropagation());
      document.addEventListener("click", (e) => {
        if (!customColorPopover.classList.contains("hidden")) {
          if (!customColorPopover.contains(e.target) && colorPickerBtnWrap && !colorPickerBtnWrap.contains(e.target)) {
            customColorPopover.classList.add("hidden");
          }
        }
      });
    }

    formatBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        formatBtns.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        currentColorFormat = btn.dataset.format;
        updateCustomColorUI(selectedColor);
      });
    });

    if (customColorTextInput) {
      customColorTextInput.addEventListener("input", (e) => {
        const parsedHex = parseTextInputColor(e.target.value);
        if (parsedHex) {
          selectedColor = parsedHex;
          swatches.forEach((s) => s.classList.remove("active"));
          if (colorPickerBtnWrap) colorPickerBtnWrap.classList.add("active");
          if (customColorPreviewDot) {
            customColorPreviewDot.style.backgroundColor = parsedHex;
            customColorPreviewDot.style.boxShadow = `0 0 10px ${parsedHex}`;
          }
          if (customColorInput) customColorInput.value = parsedHex.toLowerCase();
        }
      });
    }

    if (customColorInput) {
      customColorInput.addEventListener("input", (e) => {
        selectedColor = e.target.value;
        swatches.forEach((s) => s.classList.remove("active"));
        if (colorPickerBtnWrap) colorPickerBtnWrap.classList.add("active");
        updateCustomColorUI(selectedColor);
      });
    }

    async function getGroups() {
      const { linkGroups } = await chrome.storage.local.get("linkGroups");
      return Array.isArray(linkGroups) ? linkGroups : [];
    }

    async function saveGroups(groups) {
      await chrome.storage.local.set({ linkGroups: groups });
      await renderOptionsGroups();
    }

    function cancelEdit() {
      editingGroupId = null;
      if (form) form.reset();
      if (editBanner) editBanner.classList.add("hidden");
      if (submitBtn) submitBtn.querySelector("span").textContent = "+ Add Group";
      selectedColor = "#3b82f6";
      swatches.forEach((s) => s.classList.toggle("active", s.dataset.color.toLowerCase() === selectedColor.toLowerCase()));
      if (colorPickerBtnWrap) colorPickerBtnWrap.classList.remove("active");
      if (customColorPopover) customColorPopover.classList.add("hidden");
      updateCustomColorUI(selectedColor);
    }

    if (cancelEditBtn) cancelEditBtn.addEventListener("click", cancelEdit);

    if (form) {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const name = nameInput.value.trim();
        if (!name) return;

        const groups = await getGroups();
        if (editingGroupId) {
          const g = groups.find((x) => x.id === editingGroupId);
          if (g) {
            g.name = name;
            g.color = selectedColor;
          }
        } else {
          groups.push({
            id: "grp_" + Date.now() + "_" + Math.random().toString(36).substr(2, 4),
            name,
            color: selectedColor,
            links: [],
            createdAt: Date.now(),
          });
        }

        await saveGroups(groups);
        cancelEdit();
      });
    }

    async function renderOptionsGroups() {
      if (!groupsListContainer) return;
      const groups = await getGroups();
      groupsListContainer.innerHTML = "";

      if (groups.length === 0) {
        groupsListContainer.innerHTML = `
          <div class="empty-message group-empty-box">
            📁 No link groups created yet. Create a group above to organize your URLs!
          </div>
        `;
        return;
      }

      groups.forEach((group) => {
        const card = document.createElement("div");
        card.className = "options-group-card";
        card.style.setProperty("--group-color", group.color || "#3b82f6");

        const header = document.createElement("div");
        header.className = "options-group-header";
        header.innerHTML = `
          <div class="options-group-title-wrap">
            <div class="options-group-color-dot"></div>
            <span class="options-group-title">${escapeHtml(group.name)}</span>
            <span class="options-group-badge">${group.links ? group.links.length : 0} links</span>
          </div>
          <div class="options-group-actions">
            <button type="button" class="btn-see-all-group" title="See all links in group">
              <span>See All</span>
              <svg class="chevron-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="6 9 12 15 18 9"></polyline>
              </svg>
            </button>
            <button type="button" class="btn-icon-action btn-icon-edit btn-options-edit-group" title="Edit group name and color">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
              </svg>
            </button>
            <button type="button" class="btn-icon-action btn-icon-danger btn-options-delete-group" title="Delete group">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
            </button>
          </div>
        `;

        const linksPanel = document.createElement("div");
        linksPanel.className = "options-group-links-panel hidden";

        const linksList = document.createElement("div");
        linksList.className = "options-links-list";

        if (group.links && group.links.length > 0) {
          group.links.forEach((link) => {
            const item = document.createElement("div");
            item.className = "options-link-item";

            let faviconUrl = "";
            try {
              const domain = new URL(link.url).hostname;
              faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
            } catch (e) {
              faviconUrl = "../icons/icon16.png";
            }

            item.innerHTML = `
              <div class="options-link-info">
                <img class="options-link-favicon" src="${faviconUrl}" onerror="this.src='../icons/icon16.png'" />
                <a href="${escapeHtml(link.url)}" target="_blank" class="options-link-anchor" title="${escapeHtml(link.url)}">${escapeHtml(link.title || link.url)}</a>
              </div>
              <button type="button" class="btn-icon-action btn-icon-danger btn-delete-options-link" title="Delete link">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
              </button>
            `;

            item.querySelector(".btn-delete-options-link").addEventListener("click", async () => {
              const curGroups = await getGroups();
              const g = curGroups.find((x) => x.id === group.id);
              if (g) {
                g.links = g.links.filter((l) => l.id !== link.id);
                await saveGroups(curGroups);
              }
            });

            linksList.appendChild(item);
          });
        } else {
          linksList.innerHTML = `<div class="group-empty-subtext">No links added to this group yet.</div>`;
        }

        const addBox = document.createElement("div");
        addBox.className = "options-add-link-box";
        addBox.innerHTML = `
          <input type="text" class="form-control input-options-group-url" placeholder="Add URL or keyword to this group..." />
          <button type="button" class="btn-add-link-sophisticated btn-options-add-link">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            <span>Add Link</span>
          </button>
        `;

        const inputUrl = addBox.querySelector(".input-options-group-url");
        const btnAdd = addBox.querySelector(".btn-options-add-link");

        async function addLinkToGroup(urlToAdd) {
          if (!urlToAdd) return;
          let formatted = urlToAdd.trim();
          if (!formatted.startsWith("http://") && !formatted.startsWith("https://") && formatted.includes(".")) {
            formatted = "https://" + formatted;
          }
          const curGroups = await getGroups();
          const g = curGroups.find((x) => x.id === group.id);
          if (g) {
            if (!g.links) g.links = [];
            if (!g.links.some((l) => l.url.toLowerCase() === formatted.toLowerCase())) {
              g.links.push({
                id: "lnk_" + Date.now() + "_" + Math.random().toString(36).substr(2, 4),
                url: formatted,
                title: formatted,
              });
              await saveGroups(curGroups);
            }
          }
        }

        btnAdd.addEventListener("click", async () => {
          const val = inputUrl.value.trim();
          if (val) {
            await addLinkToGroup(val);
            inputUrl.value = "";
          }
        });

        inputUrl.addEventListener("keydown", async (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const val = inputUrl.value.trim();
            if (val) {
              await addLinkToGroup(val);
              inputUrl.value = "";
            }
          }
        });

        linksPanel.appendChild(linksList);
        linksPanel.appendChild(addBox);

        // Header Actions: See All
        const btnSeeAll = header.querySelector(".btn-see-all-group");
        btnSeeAll.addEventListener("click", () => {
          btnSeeAll.classList.toggle("expanded");
          linksPanel.classList.toggle("hidden");
        });

        // Header Actions: Edit
        header.querySelector(".btn-options-edit-group").addEventListener("click", () => {
          editingGroupId = group.id;
          nameInput.value = group.name;
          selectedColor = group.color || "#3b82f6";
          swatches.forEach((s) => s.classList.toggle("active", s.dataset.color.toLowerCase() === selectedColor.toLowerCase()));
          if (colorPickerBtnWrap) colorPickerBtnWrap.classList.toggle("active", !Array.from(swatches).some((s) => s.dataset.color.toLowerCase() === selectedColor.toLowerCase()));
          updateCustomColorUI(selectedColor);
          if (editBanner) editBanner.classList.remove("hidden");
          if (submitBtn) submitBtn.querySelector("span").textContent = "Save Group";
          nameInput.focus();
        });

        // Header Actions: Delete
        header.querySelector(".btn-options-delete-group").addEventListener("click", async () => {
          const confirmed = confirm(`Are you sure you want to delete the group "${group.name}"?`);
          if (!confirmed) return;
          const curGroups = await getGroups();
          const updated = curGroups.filter((g) => g.id !== group.id);
          await saveGroups(updated);
          if (editingGroupId === group.id) cancelEdit();
        });

        card.appendChild(header);
        card.appendChild(linksPanel);
        groupsListContainer.appendChild(card);
      });
    }

    renderOptionsGroupsRef = renderOptionsGroups;
    await renderOptionsGroups();
  }

  // --- Cross-Device Activity Sync Settings Logic ---
  const toggleSyncEnabled = document.getElementById('toggle-sync-enabled');
  const inputSyncToken = document.getElementById('input-sync-token');
  const btnGenerateSyncToken = document.getElementById('btn-generate-sync-token');
  const inputSyncTimeout = document.getElementById('input-sync-timeout');
  const optionsNewSyncDomain = document.getElementById('options-new-sync-domain');
  const optionsBtnAddSyncDomain = document.getElementById('options-btn-add-sync-domain');
  const syncDomainsList = document.getElementById('sync-domains-list');
  const syncEmptyState = document.getElementById('sync-empty-state');

  if (toggleSyncEnabled && inputSyncTimeout && optionsNewSyncDomain && optionsBtnAddSyncDomain && syncDomainsList) {
    // Load initial sync settings
    chrome.storage.local.get(['syncEnabled', 'syncTimeout', 'syncDomains', 'syncToken']).then((syncSettings) => {
      toggleSyncEnabled.checked = syncSettings.syncEnabled !== false;
      if (inputSyncToken) inputSyncToken.value = syncSettings.syncToken || '';
      inputSyncTimeout.value = syncSettings.syncTimeout || 5;
      renderSyncDomains();
    });

    // Toggle Enable
    toggleSyncEnabled.addEventListener('change', async () => {
      await chrome.storage.local.set({ syncEnabled: toggleSyncEnabled.checked });
    });

    // Token Change
    if (inputSyncToken) {
      inputSyncToken.addEventListener('input', async () => {
        // Drop the old status too, otherwise a stale error from the previous
        // token keeps showing until the next read/write happens.
        await chrome.storage.local.remove('syncStatus');
        await chrome.storage.local.set({ syncToken: inputSyncToken.value.trim() });
      });
    }

    // Token Generate Button
    if (btnGenerateSyncToken && inputSyncToken) {
      btnGenerateSyncToken.addEventListener('click', async () => {
        // Don't silently destroy an endpoint URL the user pasted in.
        if (/^https?:\/\//i.test(inputSyncToken.value.trim())) {
          if (!confirm('Replace your custom endpoint URL with a generated kvdb.io token?')) return;
        }
        btnGenerateSyncToken.textContent = 'Generating...';
        btnGenerateSyncToken.disabled = true;
        await chrome.storage.local.remove('syncStatus');
        try {
          const response = await fetch('https://kvdb.io/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'email=sync@autorefresh.extension'
          });
          const token = response.ok ? (await response.text()).trim() : '';
          if (!token) throw new Error(`bucket creation failed (HTTP ${response.status})`);

          // A bucket that can't be written to is worse than no token at all —
          // prove it works before saving it, instead of failing silently later.
          const probe = await fetch(`https://kvdb.io/${encodeURIComponent(token)}/__sync_probe`, {
            method: 'POST',
            body: 'probe',
          });
          if (!probe.ok) throw new Error(`bucket rejects writes (HTTP ${probe.status})`);

          inputSyncToken.value = token;
          await chrome.storage.local.set({ syncToken: token });
        } catch (err) {
          // Keep the token empty so the working built-in browser sync is used.
          inputSyncToken.value = '';
          await chrome.storage.local.set({ syncToken: '' });
          alert(`Sync token service unavailable — ${err.message}.\n\nNo token is needed: the extension uses built-in browser sync, which works across devices signed into the same browser account.`);
        } finally {
          btnGenerateSyncToken.textContent = 'Generate';
          btnGenerateSyncToken.disabled = false;
        }
      });
    }

    // Timeout Change
    inputSyncTimeout.addEventListener('change', async () => {
      const val = parseInt(inputSyncTimeout.value, 10) || 5;
      await chrome.storage.local.set({ syncTimeout: val });
    });

    // Render domains list
    async function renderSyncDomains() {
      const { syncDomains = [] } = await chrome.storage.local.get('syncDomains');
      
      // Clear existing dynamic rows
      const rows = syncDomainsList.querySelectorAll('tr:not(#sync-empty-state)');
      rows.forEach(r => r.remove());

      if (syncDomains.length === 0) {
        if (syncEmptyState) syncEmptyState.classList.remove('hidden');
        return;
      }

      if (syncEmptyState) syncEmptyState.classList.add('hidden');

      syncDomains.forEach((domain, idx) => {
        const tr = document.createElement('tr');

        // Domain cell
        const tdDomain = document.createElement('td');
        const span = document.createElement('span');
        span.style.fontFamily = 'monospace';
        span.style.fontSize = '12px';
        span.style.color = '#fff';
        span.textContent = domain;
        tdDomain.appendChild(span);

        // Actions cell
        const tdActions = document.createElement('td');
        tdActions.className = 'col-actions';

        const btnDelete = document.createElement('button');
        btnDelete.className = 'btn-icon-action btn-icon-danger';
        btnDelete.title = 'Delete sync domain';
        btnDelete.innerHTML = `
          <svg class="svg-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        `;

        btnDelete.addEventListener('click', async () => {
          const updated = syncDomains.filter((_, i) => i !== idx);
          await chrome.storage.local.set({ syncDomains: updated });
          renderSyncDomains();
        });

        tdActions.appendChild(btnDelete);
        tr.appendChild(tdDomain);
        tr.appendChild(tdActions);

        syncDomainsList.appendChild(tr);
      });
    }

    // Add Domain Helper
    async function addSyncDomain() {
      const inputVal = optionsNewSyncDomain.value.trim().toLowerCase();
      if (!inputVal) return;

      // Extract domain name from URL if user pastes a full URL
      let cleanDomain = inputVal;
      try {
        if (inputVal.startsWith('http://') || inputVal.startsWith('https://')) {
          cleanDomain = new URL(inputVal).hostname;
        } else if (inputVal.includes('/')) {
          cleanDomain = inputVal.split('/')[0];
        }
      } catch (e) {
        // Fallback
      }

      // Remove www. if present
      if (cleanDomain.startsWith('www.')) {
        cleanDomain = cleanDomain.substring(4);
      }

      if (cleanDomain) {
        const { syncDomains = [] } = await chrome.storage.local.get('syncDomains');
        if (!syncDomains.includes(cleanDomain)) {
          syncDomains.push(cleanDomain);
          await chrome.storage.local.set({ syncDomains });
          optionsNewSyncDomain.value = '';
          renderSyncDomains();
        }
      }
    }

    optionsBtnAddSyncDomain.addEventListener('click', addSyncDomain);
    optionsNewSyncDomain.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addSyncDomain();
      }
    });
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
});
