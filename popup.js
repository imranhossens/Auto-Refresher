const form = document.getElementById("job-form");
const modeInput = document.getElementById("mode");
const segButtons = document.querySelectorAll(".seg-btn");
const jobList = document.getElementById("job-list");
const jobCountEl = document.getElementById("job-count");
const editBanner = document.getElementById("edit-banner");
const cancelEditBtn = document.getElementById("cancel-edit");
const submitBtn = document.getElementById("submit-btn");

let editingId = null;
let prefsSnapshotBeforeEdit = null;
const PREFS_KEY = "formPrefs";

// --- Cross-Device Sync Settings Logic in Popup ---
(async () => {
  try {
    const toggleSyncEnabled = document.getElementById('popup-toggle-sync-enabled');
    const syncDetails = document.getElementById('popup-sync-details');
    const inputSyncToken = document.getElementById('popup-input-sync-token');
    const btnGenerateSyncToken = document.getElementById('popup-btn-generate-sync-token');
    const inputSyncTimeout = document.getElementById('popup-input-sync-timeout');
    const newSyncDomain = document.getElementById('popup-new-sync-domain');
    const btnAddSyncDomain = document.getElementById('popup-btn-add-sync-domain');
    const syncDomainsList = document.getElementById('popup-sync-domains-list');
    const syncHeader = document.getElementById('popup-sync-header');
    const syncChevron = document.getElementById('popup-sync-chevron');

    if (!toggleSyncEnabled || !syncDetails || !syncHeader || !syncChevron) {
      return;
    }

    // Load initial sync settings
    const syncSettings = await chrome.storage.local.get(['syncEnabled', 'syncTimeout', 'syncDomains', 'syncToken']);
    const enabled = syncSettings.syncEnabled !== false;
    toggleSyncEnabled.checked = enabled;
    
    if (inputSyncToken) inputSyncToken.value = syncSettings.syncToken || '';
    if (inputSyncTimeout) inputSyncTimeout.value = syncSettings.syncTimeout || 5;

    // Stop click events on the switch toggle from bubbling up to the header
    const syncSwitch = syncHeader.querySelector('.switch');
    if (syncSwitch) {
      syncSwitch.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    }

    // Toggle expand/collapse when header is clicked
    syncHeader.addEventListener('click', (e) => {
      // If the click is inside the switch toggle, don't collapse/expand
      if (e.target.closest('.switch')) {
        return;
      }
      const isCurrentlyHidden = syncDetails.classList.contains('hidden');
      if (isCurrentlyHidden) {
        syncDetails.classList.remove('hidden');
        syncChevron.style.transform = 'rotate(180deg)';
      } else {
        syncDetails.classList.add('hidden');
        syncChevron.style.transform = 'rotate(0deg)';
      }
    });

    // Toggle Enable
    toggleSyncEnabled.addEventListener('change', async () => {
      const isChecked = toggleSyncEnabled.checked;
      await chrome.storage.local.set({ syncEnabled: isChecked });
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

    // Generate Token
    if (btnGenerateSyncToken && inputSyncToken) {
      btnGenerateSyncToken.addEventListener('click', async () => {
        // Don't silently destroy an endpoint URL the user pasted in.
        if (/^https?:\/\//i.test(inputSyncToken.value.trim())) {
          if (!confirm('Replace your custom endpoint URL with a generated kvdb.io token?')) return;
        }
        btnGenerateSyncToken.textContent = '...';
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
          await chrome.storage.local.set({
            syncStatus: {
              ok: false,
              at: Date.now(),
              error: `Token service unavailable — ${err.message}. Staying on built-in browser sync, which needs no token.`,
            },
          });
        } finally {
          btnGenerateSyncToken.textContent = 'Generate';
          btnGenerateSyncToken.disabled = false;
        }
      });
    }

    // Timeout Change
    if (inputSyncTimeout) {
      inputSyncTimeout.addEventListener('change', async () => {
        const val = parseInt(inputSyncTimeout.value, 10) || 5;
        await chrome.storage.local.set({ syncTimeout: val });
      });
    }

    // Render domains list
    async function renderSyncDomains() {
      if (!syncDomainsList) return;
      const { syncDomains = [] } = await chrome.storage.local.get('syncDomains');
      syncDomainsList.innerHTML = '';

      syncDomains.forEach((domain, idx) => {
        const li = document.createElement('li');
        li.style.display = 'flex';
        li.style.alignItems = 'center';
        li.style.justifyContent = 'space-between';
        li.style.padding = '4px 0';
        li.style.borderBottom = '1px solid rgba(255,255,255,0.04)';

        const span = document.createElement('span');
        span.style.fontFamily = 'monospace';
        span.style.fontSize = '11px';
        span.style.color = '#fff';
        span.textContent = domain;

        const btnDel = document.createElement('button');
        btnDel.type = 'button';
        btnDel.style.background = 'none';
        btnDel.style.border = 'none';
        btnDel.style.color = '#ff334b';
        btnDel.style.cursor = 'pointer';
        btnDel.style.padding = '2px';
        btnDel.innerHTML = `
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        `;

        btnDel.addEventListener('click', async () => {
          const updated = syncDomains.filter((_, i) => i !== idx);
          await chrome.storage.local.set({ syncDomains: updated });
          renderSyncDomains();
        });

        li.appendChild(span);
        li.appendChild(btnDel);
        syncDomainsList.appendChild(li);
      });
    }

    // Add Domain Helper
    async function addSyncDomain() {
      if (!newSyncDomain) return;
      const inputVal = newSyncDomain.value.trim().toLowerCase();
      if (!inputVal) return;

      let cleanDomain = inputVal;
      try {
        if (inputVal.startsWith('http://') || inputVal.startsWith('https://')) {
          cleanDomain = new URL(inputVal).hostname;
        } else if (inputVal.includes('/')) {
          cleanDomain = inputVal.split('/')[0];
        }
      } catch (e) {}

      if (cleanDomain.startsWith('www.')) {
        cleanDomain = cleanDomain.substring(4);
      }

      if (cleanDomain) {
        const { syncDomains = [] } = await chrome.storage.local.get('syncDomains');
        if (!syncDomains.includes(cleanDomain)) {
          syncDomains.push(cleanDomain);
          await chrome.storage.local.set({ syncDomains });
          newSyncDomain.value = '';
          renderSyncDomains();
        }
      }
    }

    if (btnAddSyncDomain && newSyncDomain) {
      btnAddSyncDomain.addEventListener('click', addSyncDomain);
      newSyncDomain.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          addSyncDomain();
        }
      });
    }

    const syncStatusEl = document.getElementById('popup-sync-status');

    function describeAgo(ms) {
      const s = Math.max(0, Math.round(ms / 1000));
      if (s < 60) return `${s}s ago`;
      const m = Math.floor(s / 60);
      return `${m}m ${s % 60}s ago`;
    }

    async function renderSyncStatus() {
      if (!syncStatusEl) return;
      const { syncStatus } = await chrome.storage.local.get('syncStatus');
      syncStatusEl.classList.remove('sync-status-active', 'sync-status-error');

      if (!syncStatus) {
        syncStatusEl.textContent = 'Sync status: waiting for first check…';
        return;
      }
      if (!syncStatus.ok) {
        syncStatusEl.classList.add('sync-status-error');
        syncStatusEl.textContent = `Sync error: ${syncStatus.error || 'unknown'}`;
        return;
      }
      // A token that keeps failing is worse than no token — say so plainly.
      const warning = syncStatus.networkError
        ? ` Sync token backend failed (${syncStatus.networkError}) — using built-in browser sync instead. Clear the token to silence this.`
        : '';

      if (syncStatus.remoteActive) {
        syncStatusEl.classList.add('sync-status-active');
        syncStatusEl.textContent = `Paused — ${syncStatus.domain} in use on another device (${describeAgo(Date.now() - syncStatus.lastActive)}).${warning}`;
        return;
      }
      if (warning) syncStatusEl.classList.add('sync-status-error');
      if (syncStatus.wrote) {
        syncStatusEl.textContent = `Sync OK — activity on ${syncStatus.domain} sent ${describeAgo(Date.now() - syncStatus.at)}.${warning}`;
        return;
      }
      const detail =
        syncStatus.reason === 'own-device'
          ? 'last activity was this device'
          : syncStatus.reason === 'no-activity'
          ? 'no activity recorded yet'
          : 'no recent activity elsewhere';
      syncStatusEl.textContent = `Sync OK — refreshing normally (${detail}).${warning}`;
    }

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.syncStatus) renderSyncStatus();
    });

    renderSyncDomains();
    renderSyncStatus();
  } catch (err) {
    console.error("Error in Cross-Device Sync logic:", err);
  }
})();

const modePanels = {
  interval: document.getElementById("fields-interval"),
  specific: document.getElementById("fields-specific"),
  random: document.getElementById("fields-random"),
};

function setPanelOpen(el, isOpen) {
  if (isOpen) {
    el.classList.add("open");
    el.addEventListener(
      "transitionend",
      (e) => {
        if (e.propertyName === "grid-template-rows" && el.classList.contains("open")) {
          el.style.overflow = "visible";
        }
      },
      { once: true }
    );
  } else {
    el.style.overflow = "hidden";
    el.classList.remove("open");
  }
}

function showModeFields() {
  for (const [mode, el] of Object.entries(modePanels)) {
    setPanelOpen(el, mode === modeInput.value);
  }
  for (const btn of segButtons) {
    btn.classList.toggle("active", btn.dataset.mode === modeInput.value);
  }
}

function attachWheelStep(input) {
  input.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const step = e.shiftKey ? 5 : 1;
      const delta = e.deltaY < 0 ? step : -step;
      const min = input.min !== "" ? Number(input.min) : -Infinity;
      const current = Number(input.value) || 0;
      input.value = Math.max(min, current + delta);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.classList.add("wheel-active");
      clearTimeout(input._wheelTimer);
      input._wheelTimer = setTimeout(() => input.classList.remove("wheel-active"), 220);
    },
    { passive: false }
  );
}

document.querySelectorAll('#job-form input[type="number"]').forEach(attachWheelStep);

function val(id) {
  return document.getElementById(id).value;
}
function setVal(id, v) {
  document.getElementById(id).value = v;
}

function collectPrefs() {
  return {
    mode: modeInput.value,
    urls: val("urls"),
    intervalMin: val("intervalMin"),
    intervalSec: val("intervalSec"),
    specificTime: val("specificTime"),
    randomMinMin: val("randomMinMin"),
    randomMinSec: val("randomMinSec"),
    randomMaxMin: val("randomMaxMin"),
    randomMaxSec: val("randomMaxSec"),
  };
}

function applyPrefs(p) {
  if (!p) return;
  if (p.mode) modeInput.value = p.mode;
  if (p.urls !== undefined) setVal("urls", p.urls);
  if (p.intervalMin !== undefined) setVal("intervalMin", p.intervalMin);
  if (p.intervalSec !== undefined) setVal("intervalSec", p.intervalSec);
  if (p.specificTime !== undefined) setVal("specificTime", p.specificTime);
  if (p.randomMinMin !== undefined) setVal("randomMinMin", p.randomMinMin);
  if (p.randomMinSec !== undefined) setVal("randomMinSec", p.randomMinSec);
  if (p.randomMaxMin !== undefined) setVal("randomMaxMin", p.randomMaxMin);
  if (p.randomMaxSec !== undefined) setVal("randomMaxSec", p.randomMaxSec);
  showModeFields();
}

let savePrefsTimer = null;
function schedulePrefsSave() {
  if (editingId) return;
  clearTimeout(savePrefsTimer);
  savePrefsTimer = setTimeout(() => {
    chrome.storage.local.set({ [PREFS_KEY]: collectPrefs() });
  }, 250);
}

async function loadPrefs() {
  const stored = await chrome.storage.local.get(PREFS_KEY);
  applyPrefs(stored[PREFS_KEY]);
}

for (const btn of segButtons) {
  btn.addEventListener("click", () => {
    modeInput.value = btn.dataset.mode;
    showModeFields();
    schedulePrefsSave();
  });
}

document.querySelectorAll("#job-form input, #job-form textarea").forEach((el) => {
  el.addEventListener("input", schedulePrefsSave);
});

showModeFields();

function describeJob(job) {
  if (job.mode === "interval") {
    return `Every ${job.intervalMin}m ${job.intervalSec}s`;
  }
  if (job.mode === "specific") {
    return `Daily at ${job.specificTime}`;
  }
  if (job.mode === "random") {
    return `Random ${job.randomMinMin}m${job.randomMinSec}s – ${job.randomMaxMin}m${job.randomMaxSec}s`;
  }
  return "";
}

async function getJobs() {
  const { jobs } = await chrome.storage.local.get("jobs");
  if (!Array.isArray(jobs)) return [];
  // Sanitize each job to guard against tampered storage values.
  return jobs
    .filter((j) => j && typeof j === "object" && typeof j.id === "string")
    .map((j) => (j.urls ? j : { ...j, urls: j.url ? [j.url] : [] }));
}

async function saveJobs(jobs) {
  await chrome.storage.local.set({ jobs });
}

function startEdit(job) {
  prefsSnapshotBeforeEdit = collectPrefs();
  editingId = job.id;
  setVal("urls", job.urls.join("\n"));
  modeInput.value = job.mode;
  showModeFields();

  if (job.mode === "interval") {
    setVal("intervalMin", job.intervalMin);
    setVal("intervalSec", job.intervalSec);
  } else if (job.mode === "specific") {
    setVal("specificTime", job.specificTime);
  } else if (job.mode === "random") {
    setVal("randomMinMin", job.randomMinMin);
    setVal("randomMinSec", job.randomMinSec);
    setVal("randomMaxMin", job.randomMaxMin);
    setVal("randomMaxSec", job.randomMaxSec);
  }

  editBanner.classList.remove("hidden");
  submitBtn.querySelector(".btn-label").textContent = "Save changes";
  document.body.scrollTo(0, 0);
}

function stopEdit() {
  editingId = null;
  editBanner.classList.add("hidden");
  submitBtn.querySelector(".btn-label").textContent = "Add";
  schedulePrefsSave();
}

function cancelEdit() {
  const snapshot = prefsSnapshotBeforeEdit;
  editingId = null;
  editBanner.classList.add("hidden");
  submitBtn.querySelector(".btn-label").textContent = "Add";
  applyPrefs(snapshot);
}

cancelEditBtn.addEventListener("click", cancelEdit);

const ERROR_REASON_LABEL = {
  "no-tab": "tab not open",
  "human-check": "blocked by human/robot check",
  error: "reload failed",
};

const alarmBanner = document.getElementById("alarm-banner");
const stopAlarmSoundBtn = document.getElementById("stop-alarm-sound");

stopAlarmSoundBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "mute-human-check-alert" });
  renderJobs();
});

async function renderJobs() {
  const jobs = await getJobs();
  const alarms = await chrome.alarms.getAll();
  const alarmByName = Object.fromEntries(alarms.map((a) => [a.name, a]));
  const { jobErrors = {} } = await chrome.storage.local.get("jobErrors");

  const enabledIds = new Set(jobs.filter((j) => j.enabled).map((j) => j.id));
  const isRinging = Object.entries(jobErrors).some(
    ([id, e]) => enabledIds.has(id) && e.reason === "human-check" && !e.muted
  );
  alarmBanner.classList.toggle("hidden", !isRinging);

  const activeCount = jobs.filter((j) => j.enabled).length;
  jobCountEl.textContent =
    jobs.length === 0
      ? "No active jobs"
      : `${activeCount} active · ${jobs.length} total`;

  const navBadge = document.getElementById("nav-badge-count");
  if (navBadge) {
    if (activeCount > 0) {
      navBadge.textContent = activeCount;
      navBadge.classList.remove("hidden");
      
      const hasError = Object.entries(jobErrors).some(
        ([id, e]) => enabledIds.has(id) && e.reason === "human-check"
      );
      navBadge.classList.toggle("error-badge", hasError);
    } else {
      navBadge.classList.add("hidden");
    }
  }

  jobList.innerHTML = "";
  if (jobs.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No jobs yet — add one above.";
    jobList.append(empty);
    return;
  }

  for (const job of jobs) {
    const li = document.createElement("li");
    li.className = `job-card${job.enabled ? "" : " disabled-job"}`;
    li.dataset.id = job.id;

    const top = document.createElement("div");
    top.className = "job-top";

    const jobError = job.enabled ? jobErrors[job.id] : null;

    const dot = document.createElement("span");
    dot.className = `status-dot${job.enabled ? " active" : ""}${jobError ? " error" : ""}`;

    const urlsWrap = document.createElement("div");
    urlsWrap.className = "job-urls";
    const mainUrl = document.createElement("span");
    mainUrl.className = "job-url";
    mainUrl.textContent = job.urls[0];
    urlsWrap.append(mainUrl);
    if (job.urls.length > 1) {
      const extra = document.createElement("span");
      extra.className = "job-url-extra";
      extra.textContent = `+${job.urls.length - 1} more URL${job.urls.length - 1 > 1 ? "s" : ""}`;
      urlsWrap.append(extra);
    }

    const switchLabel = document.createElement("label");
    switchLabel.className = "switch";
    const switchInput = document.createElement("input");
    switchInput.type = "checkbox";
    switchInput.checked = job.enabled;
    switchInput.addEventListener("change", async () => {
      const all = await getJobs();
      const target = all.find((j) => j.id === job.id);
      target.enabled = switchInput.checked;
      target.updatedAt = Date.now();
      await saveJobs(all);
      renderJobs();
    });
    const track = document.createElement("span");
    track.className = "switch-track";
    switchLabel.append(switchInput, track);

    top.append(dot, urlsWrap, switchLabel);

    const metaEl = document.createElement("span");
    metaEl.className = "job-meta";
    const alarm = alarmByName[job.id];
    metaEl.dataset.prefix = describeJob(job);
    metaEl.dataset.enabled = String(job.enabled);
    if (alarm) metaEl.dataset.next = String(alarm.scheduledTime);
    if (jobError) metaEl.dataset.error = ERROR_REASON_LABEL[jobError.reason] || "not working";

    const actions = document.createElement("div");
    actions.className = "job-actions";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "icon-btn";
    editBtn.title = "Edit";
    editBtn.textContent = "✎";
    editBtn.addEventListener("click", () => startEdit(job));

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "icon-btn danger";
    deleteBtn.title = "Delete";
    deleteBtn.textContent = "✕";
    deleteBtn.addEventListener("click", async () => {
      const label = job.urls[0] + (job.urls.length > 1 ? ` (+${job.urls.length - 1} more)` : "");
      if (!confirm(`Delete this job?\n${label}`)) return;
      li.classList.add("removing");
      li.addEventListener(
        "transitionend",
        async () => {
          const all = await getJobs();
          await saveJobs(all.filter((j) => j.id !== job.id));
          if (editingId === job.id) stopEdit();
          renderJobs();
        },
        { once: true }
      );
    });

    actions.append(editBtn, deleteBtn);
    li.append(top, metaEl, actions);
    jobList.append(li);
  }
  updateMeta();
}

function formatDuration(ms) {
  if (ms <= 0) return "due now";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function updateMeta() {
  document.querySelectorAll(".job-meta").forEach((el) => {
    const prefix = el.dataset.prefix || "";
    const enabled = el.dataset.enabled === "true";
    const next = Number(el.dataset.next);
    if (el.dataset.error) {
      el.textContent = `${prefix} · ⚠ Paused — ${el.dataset.error}`;
      return;
    }
    if (!enabled || !next) {
      el.textContent = `${prefix} · Paused`;
      return;
    }
    const remaining = next - Date.now();
    const clockTime = new Date(next).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    el.textContent = `${prefix} · Next in ${formatDuration(remaining)} (${clockTime})`;
  });
}

setInterval(updateMeta, 1000);

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const urls = val("urls")
    .split("\n")
    .map((u) => u.trim())
    .filter(Boolean);

  if (urls.length === 0) {
    alert("Enter one or more full URLs (one per line), each starting with http:// or https://");
    return;
  }

  // Secondary validation: ensure each URL is well-formed and truly http/https.
  for (const u of urls) {
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
    } catch {
      alert(`Invalid URL: ${u}\nEach URL must start with http:// or https://`);
      return;
    }
  }

  const mode = modeInput.value;
  const jobs = await getJobs();
  const existing = editingId ? jobs.find((j) => j.id === editingId) : null;

  const job = existing || {
    id: crypto.randomUUID(),
    enabled: true,
  };
  job.urls = urls;
  job.mode = mode;
  job.updatedAt = Date.now();

  if (mode === "interval") {
    job.intervalMin = Number(val("intervalMin")) || 0;
    job.intervalSec = Number(val("intervalSec")) || 0;
    if (job.intervalMin === 0 && job.intervalSec === 0) {
      alert("Interval must be greater than 0 seconds.");
      return;
    }
  } else if (mode === "specific") {
    job.specificTime = val("specificTime");
    if (!job.specificTime) {
      alert("Pick a time.");
      return;
    }
  } else if (mode === "random") {
    job.randomMinMin = Number(val("randomMinMin")) || 0;
    job.randomMinSec = Number(val("randomMinSec")) || 0;
    job.randomMaxMin = Number(val("randomMaxMin")) || 0;
    job.randomMaxSec = Number(val("randomMaxSec")) || 0;
    const minTotal = job.randomMinMin * 60 + job.randomMinSec;
    const maxTotal = job.randomMaxMin * 60 + job.randomMaxSec;
    if (minTotal <= 0 || maxTotal < minTotal) {
      alert("Random range invalid: min must be > 0 and max >= min.");
      return;
    }
  }

  const wasNew = !existing;
  if (wasNew) jobs.push(job);
  await saveJobs(jobs);
  stopEdit();
  if (wasNew) {
    const keepMode = mode;
    form.reset();
    modeInput.value = keepMode;
    showModeFields();
    await chrome.storage.local.remove(PREFS_KEY);
  }
  renderJobs();
});

renderJobs();
loadPrefs();

// --- Auto-Refresh Keyboard Navigation ---
function focusFirstTimeInput() {
  const mode = document.getElementById("mode").value;
  if (mode === "interval") {
    document.getElementById("intervalMin").focus();
  } else if (mode === "specific") {
    document.getElementById("specificTime").click(); // Open analog clock face
  } else if (mode === "random") {
    document.getElementById("randomMinMin").focus();
  }
}

const urlsTextarea = document.getElementById("urls");
if (urlsTextarea) {
  urlsTextarea.addEventListener("keydown", (e) => {
    // Pressing Enter without Shift moves to the first time selection input
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      focusFirstTimeInput();
    }
  });
}

const intervalMinInput = document.getElementById("intervalMin");
if (intervalMinInput) {
  intervalMinInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      document.getElementById("intervalSec").focus();
    }
  });
}

const randomMinMinInput = document.getElementById("randomMinMin");
if (randomMinMinInput) {
  randomMinMinInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      document.getElementById("randomMinSec").focus();
    }
  });
}

const randomMinSecInput = document.getElementById("randomMinSec");
if (randomMinSecInput) {
  randomMinSecInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      document.getElementById("randomMaxMin").focus();
    }
  });
}

const randomMaxMinInput = document.getElementById("randomMaxMin");
if (randomMaxMinInput) {
  randomMaxMinInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      document.getElementById("randomMaxSec").focus();
    }
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.jobs || changes.jobErrors)) renderJobs();
});

// --- Analog clock picker for "Specific time" mode ---
// (clockToggle selector removed)
const clockPopover = document.getElementById("clock-popover");
const clockSegHour = document.getElementById("clock-seg-hour");
const clockSegMinute = document.getElementById("clock-seg-minute");
const clockAm = document.getElementById("clock-am");
const clockPm = document.getElementById("clock-pm");
const clockFace = document.getElementById("clock-face");
const clockHand = document.getElementById("clock-hand");
const clockDone = document.getElementById("clock-done");
const specificTimeInput = document.getElementById("specificTime");

let clockHour24 = 9;
let clockMinute = 0;
let clockRing = "hour";
let clockDragging = false;

function to12(h24) {
  const period = h24 < 12 ? "AM" : "PM";
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  return { h12, period };
}

function toHour24(h12, period) {
  let h = h12 % 12;
  if (period === "PM") h += 12;
  return h;
}

function parseTimeValue(str) {
  if (str) {
    const [h, m] = str.split(":").map(Number);
    if (!Number.isNaN(h) && !Number.isNaN(m)) return { h, m };
  }
  return { h: 9, m: 0 };
}

function minuteMarkDiff(m, mark) {
  const d = Math.abs(m - mark);
  return Math.min(d, 60 - d);
}

function commitClockTime() {
  const time = `${String(clockHour24).padStart(2, "0")}:${String(clockMinute).padStart(2, "0")}`;
  setVal("specificTime", time);
  specificTimeInput.dispatchEvent(new Event("input", { bubbles: true }));
}

function updateHand() {
  const { h12 } = to12(clockHour24);
  const deg = clockRing === "hour" ? (h12 % 12) * 30 : clockMinute * 6;
  clockHand.style.transform = `translateX(-50%) rotate(${deg}deg)`;
}

function renderClockFace() {
  clockFace.querySelectorAll(".clock-number").forEach((el) => el.remove());
  const isHour = clockRing === "hour";
  const { h12 } = to12(clockHour24);
  const values = isHour ? Array.from({ length: 12 }, (_, i) => i + 1) : Array.from({ length: 12 }, (_, i) => i * 5);

  for (const v of values) {
    const deg = isHour ? (v % 12) * 30 : v * 6;
    const rad = (deg * Math.PI) / 180;
    const x = 88 + 70 * Math.sin(rad);
    const y = 88 - 70 * Math.cos(rad);

    const el = document.createElement("div");
    el.className = "clock-number";
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.textContent = isHour ? String(v) : String(v).padStart(2, "0");

    const isActive = isHour ? h12 === v : minuteMarkDiff(clockMinute, v) <= 2;
    if (isActive) el.classList.add("active");

    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isHour) {
        selectHour(v);
      } else {
        selectMinute(v);
      }
    });
    clockFace.append(el);
  }
  updateHand();
}

function renderClockDigital() {
  const { h12, period } = to12(clockHour24);
  clockSegHour.textContent = String(h12).padStart(2, "0");
  clockSegMinute.textContent = String(clockMinute).padStart(2, "0");
  clockSegHour.classList.toggle("active", clockRing === "hour");
  clockSegMinute.classList.toggle("active", clockRing === "minute");
  clockAm.classList.toggle("active", period === "AM");
  clockPm.classList.toggle("active", period === "PM");
}

function renderClock() {
  renderClockDigital();
  renderClockFace();
}

function selectHour(v) {
  const { period } = to12(clockHour24);
  clockHour24 = toHour24(v, period);
  clockRing = "minute";
  renderClock();
  commitClockTime();
}

function selectMinute(v) {
  clockMinute = v;
  renderClock();
  commitClockTime();
}

function setPeriod(period) {
  const { h12 } = to12(clockHour24);
  clockHour24 = toHour24(h12, period);
  renderClock();
  commitClockTime();
}

function positionClockPopover() {
  const rect = specificTimeInput.getBoundingClientRect();
  const popoverWidth = clockPopover.offsetWidth || 208;
  let left = rect.right - popoverWidth;
  left = Math.max(8, Math.min(left, window.innerWidth - popoverWidth - 8));
  let top = rect.bottom + 8;
  const popoverHeight = clockPopover.offsetHeight || 300;
  if (top + popoverHeight > window.innerHeight - 8) {
    top = Math.max(8, rect.top - popoverHeight - 8);
  }
  clockPopover.style.left = `${left}px`;
  clockPopover.style.top = `${top}px`;
}

function openClock() {
  const parsed = parseTimeValue(val("specificTime"));
  clockHour24 = parsed.h;
  clockMinute = parsed.m;
  clockRing = "hour";
  renderClock();
  clockPopover.classList.remove("hidden");
  positionClockPopover();
}

function closeClock() {
  clockPopover.classList.add("hidden");
}

function applyPointerAngle(e) {
  const rect = clockFace.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = e.clientX - cx;
  const dy = e.clientY - cy;
  let deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  if (deg < 0) deg += 360;

  if (clockRing === "hour") {
    let h12 = Math.round(deg / 30) % 12;
    if (h12 === 0) h12 = 12;
    const { period } = to12(clockHour24);
    clockHour24 = toHour24(h12, period);
  } else {
    clockMinute = Math.round(deg / 6) % 60;
  }
  renderClock();
  commitClockTime();
}

function toggleClock() {
  if (clockPopover.classList.contains("hidden")) {
    openClock();
  } else {
    closeClock();
  }
}

// (clockToggle click listener removed)

specificTimeInput.addEventListener("click", (e) => {
  e.stopPropagation();
  if (clockPopover.classList.contains("hidden")) openClock();
});
specificTimeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    if (clockPopover.classList.contains("hidden")) openClock();
  }
});

clockSegHour.addEventListener("click", () => {
  clockRing = "hour";
  renderClock();
});
clockSegMinute.addEventListener("click", () => {
  clockRing = "minute";
  renderClock();
});
clockAm.addEventListener("click", () => setPeriod("AM"));
clockPm.addEventListener("click", () => setPeriod("PM"));
clockDone.addEventListener("click", closeClock);

clockFace.addEventListener("pointerdown", (e) => {
  clockDragging = true;
  clockFace.setPointerCapture(e.pointerId);
  applyPointerAngle(e);
});
clockFace.addEventListener("pointermove", (e) => {
  if (clockDragging) applyPointerAngle(e);
});
clockFace.addEventListener("pointerup", () => {
  if (clockDragging) {
    clockDragging = false;
    if (clockRing === "hour") {
      clockRing = "minute";
      renderClock();
      commitClockTime();
    }
  }
});

document.addEventListener("click", (e) => {
  if (!clockPopover.classList.contains("hidden") && !clockPopover.contains(e.target) && e.target !== clockToggle && e.target !== specificTimeInput) {
    closeClock();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeClock();
});

// --- Tab Switching Logic ---
const tabButtons = document.querySelectorAll(".tab-nav-btn");
const tabContents = document.querySelectorAll(".tab-content");

function activateTab(targetId) {
  tabButtons.forEach((b) => b.classList.toggle("active", b.dataset.tab === targetId));
  tabContents.forEach((c) => c.classList.toggle("hidden", c.id !== targetId));
}

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.tab;
    activateTab(target);
    chrome.storage.local.set({ activeTabId: target });
  });
});

async function restoreActiveTab() {
  try {
    const { activeTabId } = await chrome.storage.local.get("activeTabId");
    if (activeTabId && document.getElementById(activeTabId)) {
      activateTab(activeTabId);
    }
  } catch (err) {
    console.error("Error restoring active tab:", err);
  }
}
restoreActiveTab();

// --- Tab Reload Feature Logic ---

async function initTabReload() {
  const btnReloadAll = document.getElementById("btn-reload-all");
  const btnReloadSelected = document.getElementById("btn-reload-selected");
  const btnReloadDomain = document.getElementById("btn-reload-domain");
  const btnReloadLeft = document.getElementById("btn-reload-left");
  const btnReloadRight = document.getElementById("btn-reload-right");
  const btnReloadOthers = document.getElementById("btn-reload-others");
  const btnReloadSpecific = document.getElementById("btn-reload-specific");
  
  const selectedCountText = document.getElementById("selected-count");
  const domainNameText = document.getElementById("domain-name");
  const specificLinkStatus = document.getElementById("specific-link-status");
  const specificLinksCount = document.getElementById("specific-links-count");
  const specificLinksChips = document.getElementById("specific-links-chips");
  
  const inputSpecificUrl = document.getElementById("input-specific-url");
  const btnAddSpecificUrl = document.getElementById("btn-add-specific-url");
  const btnUseCurrentUrl = document.getElementById("btn-use-current-url");
  const btnManageLinks = document.getElementById("btn-manage-links");
  
  const toggleBypassCache = document.getElementById("toggle-bypass-cache");
  const selectClickBehavior = document.getElementById("select-click-behavior");
  const behaviorHint = document.getElementById("behavior-hint");

  // Helper to reload a single tab
  async function reloadTab(tabId, bypassCache) {
    try {
      await chrome.tabs.reload(tabId, { bypassCache });
    } catch (err) {
      console.error(`Error reloading tab ${tabId}:`, err);
    }
  }

  // Get array of target URLs from storage
  async function getSpecificUrls() {
    let { specificUrls, specificUrl } = await chrome.storage.local.get(['specificUrls', 'specificUrl']);
    if (!Array.isArray(specificUrls)) {
      specificUrls = specificUrl ? [specificUrl] : [];
      await chrome.storage.local.set({ specificUrls });
    }
    return specificUrls;
  }

  // Save array of target URLs
  async function saveSpecificUrls(urls) {
    const clean = Array.from(new Set(urls.map(u => u.trim()).filter(Boolean)));
    await chrome.storage.local.set({ specificUrls: clean });
    await renderLinksUI();
  }

  // Render Target Links UI & Status
  async function renderLinksUI() {
    const urls = await getSpecificUrls();
    if (specificLinksCount) specificLinksCount.textContent = urls.length;
    
    // Render Chips
    if (specificLinksChips) {
      specificLinksChips.innerHTML = '';
      urls.forEach((urlStr, index) => {
        const chip = document.createElement('div');
        chip.className = 'link-chip';
        
        const chipText = document.createElement('span');
        chipText.className = 'link-chip-text';
        chipText.textContent = urlStr;
        chipText.title = urlStr;
        
        const removeBtn = document.createElement('button');
        removeBtn.className = 'chip-remove';
        removeBtn.textContent = '✕';
        removeBtn.title = 'Remove link';
        removeBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          urls.splice(index, 1);
          await saveSpecificUrls(urls);
        });

        chip.appendChild(chipText);
        chip.appendChild(removeBtn);
        specificLinksChips.appendChild(chip);
      });
    }

    // Update Status Badge on Button
    const tabs = await chrome.tabs.query({ currentWindow: true });
    if (specificLinkStatus) {
      if (urls.length === 0) {
        specificLinkStatus.textContent = 'No target links set';
      } else {
        const matchingOpen = urls.filter(u => {
          const query = u.toLowerCase().trim();
          return tabs.some(t => t.url && t.url.toLowerCase().includes(query));
        });

        if (matchingOpen.length > 0) {
          specificLinkStatus.textContent = `Link open (${matchingOpen.length}/${urls.length})`;
        } else {
          specificLinkStatus.textContent = 'Target links not open';
        }
      }
    }
  }

  // Perform reload based on type
  async function performReload(actionType, bypassCache) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    switch (actionType) {
      case 'all': {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        for (const tab of tabs) {
          await reloadTab(tab.id, bypassCache);
        }
        break;
      }
      
      case 'selected': {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const selectedTabs = tabs.filter(t => t.highlighted);
        
        // Move selected tabs to the left
        for (let i = 0; i < selectedTabs.length; i++) {
          try {
            await chrome.tabs.move(selectedTabs[i].id, { index: i });
          } catch (e) {
            console.error("Failed to move tab", e);
          }
        }
        
        // Reload selected tabs
        for (const tab of selectedTabs) {
          await reloadTab(tab.id, bypassCache);
        }
        break;
      }
      
      case 'domain': {
        if (activeTab && activeTab.url) {
          try {
            const activeDomain = new URL(activeTab.url).hostname;
            if (activeDomain) {
              const tabs = await chrome.tabs.query({ currentWindow: true });
              for (const tab of tabs) {
                try {
                  if (tab.url && new URL(tab.url).hostname === activeDomain) {
                    await reloadTab(tab.id, bypassCache);
                  }
                } catch (e) {
                  // Ignore internal/empty urls
                }
              }
            }
          } catch (e) {
            console.error("Failed to parse active domain", e);
          }
        }
        break;
      }
      
      case 'left': {
        if (activeTab) {
          const tabs = await chrome.tabs.query({ currentWindow: true });
          const activeIndex = activeTab.index;
          for (const tab of tabs) {
            if (tab.index < activeIndex) {
              await reloadTab(tab.id, bypassCache);
            }
          }
        }
        break;
      }
      
      case 'right': {
        if (activeTab) {
          const tabs = await chrome.tabs.query({ currentWindow: true });
          const activeIndex = activeTab.index;
          for (const tab of tabs) {
            if (tab.index > activeIndex) {
              await reloadTab(tab.id, bypassCache);
            }
          }
        }
        break;
      }
      
      case 'others': {
        if (activeTab) {
          const tabs = await chrome.tabs.query({ currentWindow: true });
          for (const tab of tabs) {
            if (tab.id !== activeTab.id) {
              await reloadTab(tab.id, bypassCache);
            }
          }
        }
        break;
      }

      case 'specific': {
        const urls = await getSpecificUrls();
        if (urls.length === 0) {
          if (inputSpecificUrl) {
            inputSpecificUrl.focus();
            inputSpecificUrl.style.borderColor = '#ff4757';
            setTimeout(() => { inputSpecificUrl.style.borderColor = ''; }, 1500);
          }
          return;
        }
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const targetTabs = tabs.filter(t => {
          if (!t.url) return false;
          const tabUrl = t.url.toLowerCase();
          return urls.some(u => {
            const query = u.toLowerCase().trim();
            return query && tabUrl.includes(query);
          });
        });

        if (targetTabs.length > 0) {
          for (const tab of targetTabs) {
            await reloadTab(tab.id, bypassCache);
          }
        } else {
          if (specificLinkStatus) specificLinkStatus.textContent = '⚠️ No target links open';
          return;
        }
        break;
      }
    }
    
    // Close the popup after action
    window.close();
  }

  // Load active tab info & dynamic counts
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const allWindowTabs = await chrome.tabs.query({ currentWindow: true });
  
  // 1. Update Selected Tabs Count
  const selectedTabs = allWindowTabs.filter(t => t.highlighted);
  selectedCountText.textContent = `${selectedTabs.length} tab${selectedTabs.length > 1 ? 's' : ''} selected`;
  
  // 2. Update Domain name
  let activeDomain = '';
  if (activeTab && activeTab.url) {
    try {
      const parsedUrl = new URL(activeTab.url);
      if (parsedUrl.protocol.startsWith('http')) {
        activeDomain = parsedUrl.hostname;
        domainNameText.textContent = activeDomain;
      } else {
        domainNameText.textContent = 'Non-web page';
        btnReloadDomain.disabled = true;
      }
    } catch (e) {
      domainNameText.textContent = 'Unavailable';
      btnReloadDomain.disabled = true;
    }
  } else {
    domainNameText.textContent = 'Unavailable';
    btnReloadDomain.disabled = true;
  }
  
  // 3. Load settings from storage & render Target Links UI
  const settings = await chrome.storage.local.get(['bypassCache', 'clickBehavior']);
  await renderLinksUI();
  
  // Bypass Cache Toggle
  const isBypassCache = settings.bypassCache || false;
  toggleBypassCache.checked = isBypassCache;
  
  // Click Behavior Select
  const clickBehavior = settings.clickBehavior || 'popup';
  selectClickBehavior.value = clickBehavior;
  if (clickBehavior !== 'popup') {
    behaviorHint.classList.remove('hidden');
  }

  // --- Click Listeners for Reload Actions ---
  btnReloadAll.addEventListener('click', () => performReload('all', toggleBypassCache.checked));
  btnReloadSelected.addEventListener('click', () => performReload('selected', toggleBypassCache.checked));
  btnReloadDomain.addEventListener('click', () => performReload('domain', toggleBypassCache.checked));
  btnReloadLeft.addEventListener('click', () => performReload('left', toggleBypassCache.checked));
  btnReloadRight.addEventListener('click', () => performReload('right', toggleBypassCache.checked));
  btnReloadOthers.addEventListener('click', () => performReload('others', toggleBypassCache.checked));
  if (btnReloadSpecific) btnReloadSpecific.addEventListener('click', () => performReload('specific', toggleBypassCache.checked));

  // --- Add Specific Link handler ---
  const addEnteredLink = async () => {
    if (!inputSpecificUrl) return;
    const val = inputSpecificUrl.value.trim();
    if (!val) return;
    const urls = await getSpecificUrls();
    if (!urls.includes(val)) {
      urls.push(val);
      await saveSpecificUrls(urls);
    }
    inputSpecificUrl.value = '';

    if (btnAddSpecificUrl) {
      const origContent = btnAddSpecificUrl.innerHTML;
      btnAddSpecificUrl.style.background = 'rgba(46, 213, 115, 0.2)';
      btnAddSpecificUrl.style.color = '#2ed573';
      btnAddSpecificUrl.style.borderColor = '#2ed573';
      btnAddSpecificUrl.innerHTML = '✓ Added!';
      setTimeout(() => {
        btnAddSpecificUrl.style.background = '';
        btnAddSpecificUrl.style.color = '';
        btnAddSpecificUrl.style.borderColor = '';
        btnAddSpecificUrl.innerHTML = origContent;
      }, 1200);
    }
  };

  if (btnAddSpecificUrl) {
    btnAddSpecificUrl.addEventListener('click', addEnteredLink);
  }

  if (inputSpecificUrl) {
    inputSpecificUrl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addEnteredLink();
    });
  }

  // --- + Current Tab handler ---
  if (btnUseCurrentUrl) {
    btnUseCurrentUrl.addEventListener('click', async () => {
      const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (currentTab && currentTab.url) {
        const urls = await getSpecificUrls();
        if (!urls.includes(currentTab.url)) {
          urls.push(currentTab.url);
          await saveSpecificUrls(urls);
        }
        
        // Quick visual feedback
        const origContent = btnUseCurrentUrl.innerHTML;
        btnUseCurrentUrl.style.background = 'rgba(46, 213, 115, 0.2)';
        btnUseCurrentUrl.style.color = '#2ed573';
        btnUseCurrentUrl.style.borderColor = '#2ed573';
        btnUseCurrentUrl.innerHTML = '✓ Added!';
        setTimeout(() => {
          btnUseCurrentUrl.style.background = '';
          btnUseCurrentUrl.style.color = '';
          btnUseCurrentUrl.style.borderColor = '';
          btnUseCurrentUrl.innerHTML = origContent;
        }, 1200);
      }
    });
  }

  // --- Manage in Dashboard handler ---
  if (btnManageLinks) {
    btnManageLinks.addEventListener('click', async () => {
      try {
        await chrome.storage.local.set({ highlightSection: 'target-links' });
      } catch (e) {}
      chrome.runtime.openOptionsPage();
    });
  }

  // --- Toggle Bypass Cache ---
  toggleBypassCache.addEventListener('change', async () => {
    await chrome.storage.local.set({ bypassCache: toggleBypassCache.checked });
  });

  // --- Change Click Behavior ---
  selectClickBehavior.addEventListener('change', async () => {
    const val = selectClickBehavior.value;
    await chrome.storage.local.set({ clickBehavior: val });
    
    if (val === 'popup') {
      behaviorHint.classList.add('hidden');
    } else {
      behaviorHint.classList.remove('hidden');
    }
    
    // Notify background.js to update the chrome.action popup setting
    chrome.runtime.sendMessage({ type: 'settingsChanged' });
  });

  // --- View Dashboard Click Listener ---
  const btnOpenOptions = document.getElementById("btn-open-options");
  if (btnOpenOptions) {
    btnOpenOptions.addEventListener("click", () => {
      chrome.runtime.openOptionsPage();
    });
  }
}

// Initialise the reload feature logic
initTabReload();

// --- Link Groups Feature Logic ---
async function initGroups() {
  const groupForm = document.getElementById("group-form");
  const groupNameInput = document.getElementById("group-name-input");
  const colorSwatches = document.querySelectorAll(".color-swatch");
  const groupCustomColor = document.getElementById("group-custom-color");
  const colorPickerBtnWrap = document.getElementById("color-picker-btn-wrap");
  const customColorPopover = document.getElementById("custom-color-popover");
  const customColorTextInput = document.getElementById("custom-color-text-input");
  const customColorPreviewDot = document.getElementById("custom-color-preview-dot");
  const formatButtons = document.querySelectorAll(".color-format-segmented .format-btn");
  const groupSubmitBtn = document.getElementById("group-submit-btn");
  const groupEditBanner = document.getElementById("group-edit-banner");
  const cancelGroupEditBtn = document.getElementById("cancel-group-edit");
  const groupsContainer = document.getElementById("groups-container");
  const navGroupsCount = document.getElementById("nav-groups-count");

  let selectedColor = "#3b82f6";
  let editingGroupId = null;
  let currentFormat = "hex";

  // Helper: Format hex to target format string (HEX, RGB, HSL)
  function formatColorValue(hex, format) {
    if (!hex || !hex.startsWith("#")) return hex;
    const num = parseInt(hex.slice(1), 16);
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;

    if (format === "rgb") {
      return `rgb(${r}, ${g}, ${b})`;
    }
    if (format === "hsl") {
      const rNorm = r / 255, gNorm = g / 255, bNorm = b / 255;
      const max = Math.max(rNorm, gNorm, bNorm), min = Math.min(rNorm, gNorm, bNorm);
      let h, s, l = (max + min) / 2;
      if (max === min) {
        h = s = 0;
      } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
          case rNorm: h = (gNorm - bNorm) / d + (gNorm < bNorm ? 6 : 0); break;
          case gNorm: h = (bNorm - rNorm) / d + 2; break;
          case bNorm: h = (rNorm - gNorm) / d + 4; break;
        }
        h /= 6;
      }
      return `hsl(${Math.round(h * 360)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
    }
    return hex.toUpperCase();
  }

  // Helper: Parse any color input (HEX, RGB, HSL) into standard #RRGGBB hex
  function parseColorToHex(str) {
    if (!str) return null;
    str = str.trim();
    if (/^#?[0-9a-fA-F]{6}$/.test(str)) {
      return str.startsWith('#') ? str.toLowerCase() : '#' + str.toLowerCase();
    }
    if (/^#?[0-9a-fA-F]{3}$/.test(str)) {
      const raw = str.startsWith('#') ? str.slice(1) : str;
      const hex = raw.split('').map(c => c + c).join('');
      return '#' + hex.toLowerCase();
    }
    const rgbMatch = str.match(/(?:rgb\()?(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})\)?/i);
    if (rgbMatch) {
      const r = Math.min(255, parseInt(rgbMatch[1], 10));
      const g = Math.min(255, parseInt(rgbMatch[2], 10));
      const b = Math.min(255, parseInt(rgbMatch[3], 10));
      return "#" + [r, g, b].map(x => x.toString(16).padStart(2, "0")).join("");
    }
    const hslMatch = str.match(/(?:hsl\()?(\d{1,3})[\s,]+(\d{1,3})%?[\s,]+(\d{1,3})%?\)?/i);
    if (hslMatch) {
      const h = parseInt(hslMatch[1], 10) / 360;
      const s = parseInt(hslMatch[2], 10) / 100;
      const l = parseInt(hslMatch[3], 10) / 100;
      let r, g, b;
      if (s === 0) {
        r = g = b = l;
      } else {
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        const hue2rgb = (p, q, t) => {
          if (t < 0) t += 1;
          if (t > 1) t -= 1;
          if (t < 1/6) return p + (q - p) * 6 * t;
          if (t < 1/2) return q;
          if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
          return p;
        };
        r = hue2rgb(p, q, h + 1/3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1/3);
      }
      return "#" + [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)].map(x => x.toString(16).padStart(2, "0")).join("");
    }
    return null;
  }

  // Update Custom Color Popover UI
  function updateCustomColorUI(hexVal) {
    if (!hexVal) return;
    selectedColor = hexVal;
    if (customColorPreviewDot) {
      customColorPreviewDot.style.backgroundColor = selectedColor;
      customColorPreviewDot.style.boxShadow = `0 0 10px ${selectedColor}`;
    }
    if (customColorTextInput) {
      customColorTextInput.value = formatColorValue(selectedColor, currentFormat);
    }
    if (groupCustomColor) {
      groupCustomColor.value = selectedColor;
    }
  }

  // Toggle Palette Popover
  if (colorPickerBtnWrap && customColorPopover) {
    colorPickerBtnWrap.addEventListener("click", () => {
      customColorPopover.classList.toggle("hidden");
      colorSwatches.forEach((s) => s.classList.remove("active"));
      colorPickerBtnWrap.classList.add("active");
      updateCustomColorUI(selectedColor);
    });
  }

  // Format segmented buttons
  formatButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      formatButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentFormat = btn.dataset.format;
      updateCustomColorUI(selectedColor);
    });
  });

  // Text input color handler
  if (customColorTextInput) {
    customColorTextInput.addEventListener("input", (e) => {
      const parsedHex = parseColorToHex(e.target.value);
      if (parsedHex) {
        selectedColor = parsedHex;
        if (customColorPreviewDot) {
          customColorPreviewDot.style.backgroundColor = selectedColor;
          customColorPreviewDot.style.boxShadow = `0 0 10px ${selectedColor}`;
        }
        if (groupCustomColor) groupCustomColor.value = selectedColor;
      }
    });
  }

  // Visual color wheel picker handler
  if (groupCustomColor) {
    groupCustomColor.addEventListener("input", (e) => {
      const hex = e.target.value;
      updateCustomColorUI(hex);
    });
  }

  // Swatch click logic
  colorSwatches.forEach((swatch) => {
    swatch.addEventListener("click", () => {
      colorSwatches.forEach((s) => s.classList.remove("active"));
      if (colorPickerBtnWrap) colorPickerBtnWrap.classList.remove("active");
      if (customColorPopover) customColorPopover.classList.add("hidden");
      swatch.classList.add("active");
      selectedColor = swatch.dataset.color;
      if (groupCustomColor) groupCustomColor.value = selectedColor;
    });
  });

  let expandedGroupIds = new Set();

  // Get groups from storage
  async function getGroups() {
    const { linkGroups } = await chrome.storage.local.get("linkGroups");
    return Array.isArray(linkGroups) ? linkGroups : [];
  }

  // Save groups to storage & update UI
  async function saveGroups(groups) {
    await chrome.storage.local.set({ linkGroups: groups });
    await renderGroupsUI();
  }

  // Cancel edit mode
  function cancelEdit() {
    editingGroupId = null;
    if (groupForm) groupForm.reset();
    if (groupEditBanner) groupEditBanner.classList.add("hidden");
    if (customColorPopover) customColorPopover.classList.add("hidden");
    if (groupSubmitBtn) groupSubmitBtn.querySelector(".btn-label").textContent = "+ Add Group";
    selectedColor = "#3b82f6";
    colorSwatches.forEach((s) => {
      s.classList.toggle("active", s.dataset.color.toLowerCase() === selectedColor.toLowerCase());
    });
    if (colorPickerBtnWrap) colorPickerBtnWrap.classList.remove("active");
    if (groupCustomColor) groupCustomColor.value = selectedColor;
  }

  if (cancelGroupEditBtn) {
    cancelGroupEditBtn.addEventListener("click", cancelEdit);
  }

  // Handle Create / Edit Group
  if (groupForm) {
    groupForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = groupNameInput.value.trim();
      if (!name) return;

      const groups = await getGroups();

      if (editingGroupId) {
        // Edit existing group
        const group = groups.find((g) => g.id === editingGroupId);
        if (group) {
          group.name = name;
          group.color = selectedColor;
        }
      } else {
        // Create new group
        const newGroup = {
          id: "grp_" + Date.now() + "_" + Math.random().toString(36).substr(2, 4),
          name,
          color: selectedColor,
          links: [],
          createdAt: Date.now(),
        };
        groups.push(newGroup);
      }

      await saveGroups(groups);
      cancelEdit();
    });
  }

  // Render Groups UI
  async function renderGroupsUI() {
    const groups = await getGroups();

    // Update Badge
    if (navGroupsCount) {
      if (groups.length > 0) {
        navGroupsCount.textContent = groups.length;
        navGroupsCount.classList.remove("hidden");
      } else {
        navGroupsCount.classList.add("hidden");
      }
    }

    if (!groupsContainer) return;
    groupsContainer.innerHTML = "";

    if (groups.length === 0) {
      groupsContainer.innerHTML = `
        <div class="empty-groups-notice">
          📁 No groups created yet. Create a group above to organize your target links!
        </div>
      `;
      return;
    }

    groups.forEach((group) => {
      const card = document.createElement("div");
      card.className = "group-card";
      card.style.setProperty("--group-color", group.color || "#3b82f6");

      // Header
      const header = document.createElement("div");
      header.className = "group-card-header";
      header.innerHTML = `
        <div class="group-title-wrap">
          <div class="group-color-indicator"></div>
          <span class="group-title" title="${escapeHtml(group.name)}">${escapeHtml(group.name)}</span>
          <span class="group-count-badge" style="cursor: pointer;" title="Click to toggle links">${group.links ? group.links.length : 0} links</span>
        </div>
        <div class="group-header-actions">
          <button type="button" class="btn-open-all-group btn-open-group" title="Open links in current profile / tab">
            <svg class="svg-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="5 3 19 12 5 21 5 3"></polygon>
            </svg>
            Open All
          </button>
          <button type="button" class="gear-btn-modern btn-gear-group" title="Manage Group & Links">
            <svg class="gear-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
          </button>
          <button type="button" class="btn-expand-group" title="Expand or collapse links">
            <svg class="chevron-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>
        </div>
      `;

      // Add link inline box (shown directly on the group card)
      const addBox = document.createElement("div");
      addBox.className = "group-add-link-box";
      addBox.innerHTML = `
        <input type="text" class="input-group-url" placeholder="Add URL or keyword..." />
        <button type="button" class="secondary-btn-sm btn-add-link-manual" title="Add typed link">+ Add</button>
        <button type="button" class="secondary-btn-sm btn-add-link-current" title="Add active tab URL">+ Current Tab</button>
      `;

      const inputUrl = addBox.querySelector(".input-group-url");
      const btnAddManual = addBox.querySelector(".btn-add-link-manual");
      const btnAddCurrent = addBox.querySelector(".btn-add-link-current");

      // Add manual link function
      async function addLinkToGroup(urlToAdd, titleToAdd) {
        if (!urlToAdd) return;
        let formattedUrl = urlToAdd.trim();
        if (!formattedUrl.startsWith("http://") && !formattedUrl.startsWith("https://") && formattedUrl.includes(".")) {
          formattedUrl = "https://" + formattedUrl;
        }

        const curGroups = await getGroups();
        const g = curGroups.find((x) => x.id === group.id);
        if (g) {
          if (!g.links) g.links = [];
          if (!g.links.some((l) => (typeof l === 'object' ? l.url : l).toLowerCase() === formattedUrl.toLowerCase())) {
            expandedGroupIds.add(group.id);
            g.links.push({
              id: "lnk_" + Date.now() + "_" + Math.random().toString(36).substr(2, 4),
              url: formattedUrl,
              title: titleToAdd || formattedUrl,
            });
            await saveGroups(curGroups);
          }
        }
      }

      btnAddManual.addEventListener("click", async () => {
        const val = inputUrl.value.trim();
        if (val) {
          await addLinkToGroup(val, val);
          inputUrl.value = "";
        }
      });

      inputUrl.addEventListener("keydown", async (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const val = inputUrl.value.trim();
          if (val) {
            await addLinkToGroup(val, val);
            inputUrl.value = "";
          }
        }
      });

      btnAddCurrent.addEventListener("click", async () => {
        try {
          const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (currentTab && currentTab.url) {
            await addLinkToGroup(currentTab.url, currentTab.title || currentTab.url);
            
            // Visual feedback
            const origText = btnAddCurrent.textContent;
            btnAddCurrent.textContent = "✓ Added!";
            btnAddCurrent.style.color = "#2ed573";
            setTimeout(() => {
              btnAddCurrent.textContent = origText;
              btnAddCurrent.style.color = "";
            }, 1000);
          }
        } catch (err) {
          console.error("Error adding current tab:", err);
        }
      });

      // Gear Button Handler: Redirect to Dashboard Options page to manage / edit / delete
      header.querySelector(".btn-gear-group").addEventListener("click", async () => {
        try {
          await chrome.storage.local.set({ highlightGroupId: group.id });
        } catch (e) {
          console.warn("Could not save highlightGroupId:", e);
        }
        chrome.runtime.openOptionsPage();
      });

      // Open All Button Click Handler (opens first link in current tab, rest in new tabs)
      header.querySelector(".btn-open-group").addEventListener("click", async () => {
        if (group.links && group.links.length > 0) {
          try {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            group.links.forEach((l, index) => {
              if (index === 0 && activeTab && activeTab.id) {
                chrome.tabs.update(activeTab.id, { url: l.url });
              } else {
                chrome.tabs.create({ url: l.url });
              }
            });
          } catch (err) {
            console.error("Error opening group links:", err);
          }
        }
      });

      // Expand / Collapse Chevron Icon Button
      const toggleBtn = header.querySelector(".btn-expand-group");
      const countBadge = header.querySelector(".group-count-badge");

      // Collapsible card body holding both links list and add-link box (COLLAPSED BY DEFAULT)
      const cardBody = document.createElement("div");
      cardBody.className = "group-card-body hidden";

      const linksContainer = document.createElement("div");
      linksContainer.className = "group-links-list";

      const isInitiallyExpanded = expandedGroupIds.has(group.id);
      if (isInitiallyExpanded) {
        toggleBtn.classList.add("expanded");
        cardBody.classList.remove("hidden");
      }

      const toggleExpansion = (e) => {
        if (e) e.stopPropagation();
        const isExp = toggleBtn.classList.toggle("expanded");
        cardBody.classList.toggle("hidden", !isExp);
        if (isExp) {
          expandedGroupIds.add(group.id);
        } else {
          expandedGroupIds.delete(group.id);
        }
      };

      toggleBtn.addEventListener("click", toggleExpansion);
      if (countBadge) {
        countBadge.addEventListener("click", toggleExpansion);
      }

      const linksList = Array.isArray(group.links) ? group.links : [];
      if (linksList.length > 0) {
        linksList.forEach((rawLink) => {
          const link = typeof rawLink === "string" ? {
            id: "lnk_" + Math.random().toString(36).substr(2, 6),
            url: rawLink,
            title: rawLink
          } : {
            id: rawLink.id || ("lnk_" + Math.random().toString(36).substr(2, 6)),
            url: rawLink.url || "",
            title: rawLink.title || rawLink.url || ""
          };

          const item = document.createElement("div");
          item.className = "group-link-item";

          let faviconUrl = "";
          try {
            const domain = new URL(link.url).hostname;
            faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
          } catch (e) {
            faviconUrl = "icons/icon16.png";
          }

          const renderNormalView = () => {
            item.innerHTML = `
              <div class="group-link-info">
                <img class="group-link-favicon" src="${faviconUrl}" onerror="this.src='icons/icon16.png'" />
                <a href="${escapeHtml(link.url)}" target="_blank" class="group-link-anchor" title="${escapeHtml(link.url)}">${escapeHtml(link.title || link.url)}</a>
              </div>
              <div class="group-link-actions" style="display: flex; gap: 4px; align-items: center; flex-shrink: 0;">
                <button type="button" class="icon-action-btn btn-edit-group-link" title="Edit link" style="width: 22px; height: 22px; padding: 0;">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                  </svg>
                </button>
                <button type="button" class="icon-action-btn danger btn-delete-group-link" title="Delete link" style="width: 22px; height: 22px; padding: 0;">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                  </svg>
                </button>
              </div>
            `;

            item.querySelector(".btn-edit-group-link").addEventListener("click", (e) => {
              e.stopPropagation();
              renderEditView();
            });

            item.querySelector(".btn-delete-group-link").addEventListener("click", async (e) => {
              e.stopPropagation();
              expandedGroupIds.add(group.id);
              const curGroups = await getGroups();
              const g = curGroups.find((x) => x.id === group.id);
              if (g && Array.isArray(g.links)) {
                g.links = g.links.filter((l) => (typeof l === "object" && l.id ? l.id !== link.id : (l.url || l) !== link.url));
                await saveGroups(curGroups);
              }
            });
          };

          const renderEditView = () => {
            item.innerHTML = `
              <div style="display: flex; gap: 4px; flex: 1; min-width: 0;">
                <input type="text" class="input-edit-url" value="${escapeHtml(link.url)}" placeholder="https://..." style="flex: 1; font-size: 11px; padding: 3px 6px; background: rgba(0,0,0,0.4); border: 1px solid var(--border-color); border-radius: 4px; color: #fff; min-width: 0;" />
              </div>
              <div style="display: flex; gap: 4px; align-items: center; flex-shrink: 0;">
                <button type="button" class="icon-action-btn primary btn-save-edit" title="Save" style="width: 22px; height: 22px; padding: 0; color: #2ed573;">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                </button>
                <button type="button" class="icon-action-btn btn-cancel-edit" title="Cancel" style="width: 22px; height: 22px; padding: 0;">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
              </div>
            `;

            const inputEdit = item.querySelector(".input-edit-url");
            const btnSave = item.querySelector(".btn-save-edit");
            const btnCancel = item.querySelector(".btn-cancel-edit");

            inputEdit.focus();
            inputEdit.select();

            const doSave = async () => {
              const val = inputEdit.value.trim();
              if (!val) return;
              let formatted = val;
              if (!formatted.startsWith("http://") && !formatted.startsWith("https://") && formatted.includes(".")) {
                formatted = "https://" + formatted;
              }
              expandedGroupIds.add(group.id);
              const curGroups = await getGroups();
              const g = curGroups.find((x) => x.id === group.id);
              if (g && Array.isArray(g.links)) {
                const targetL = g.links.find((l) => (typeof l === "object" && l.id ? l.id === link.id : (l.url || l) === link.url));
                if (targetL) {
                  if (typeof targetL === "string") {
                    const idx = g.links.indexOf(targetL);
                    g.links[idx] = { id: link.id, url: formatted, title: formatted };
                  } else {
                    targetL.url = formatted;
                    targetL.title = formatted;
                  }
                  await saveGroups(curGroups);
                }
              }
            };

            btnSave.addEventListener("click", doSave);
            btnCancel.addEventListener("click", renderNormalView);

            inputEdit.addEventListener("keydown", (e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                doSave();
              } else if (e.key === "Escape") {
                e.preventDefault();
                renderNormalView();
              }
            });
          };

          renderNormalView();
          linksContainer.appendChild(item);
        });
      } else {
        linksContainer.innerHTML = `<div class="empty-group-links-subtext" style="font-size: 11px; color: var(--text-secondary); padding: 8px 4px; text-align: center;">No links in this workspace yet. Add a link below!</div>`;
      }

      cardBody.appendChild(linksContainer);
      cardBody.appendChild(addBox);

      card.appendChild(header);
      card.appendChild(cardBody);
      groupsContainer.appendChild(card);
    });
  }

  // Initial render
  await renderGroupsUI();
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

// Initialise Groups feature
initGroups();


