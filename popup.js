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
  submitBtn.querySelector(".btn-label").textContent = "Add job";
  schedulePrefsSave();
}

function cancelEdit() {
  const snapshot = prefsSnapshotBeforeEdit;
  editingId = null;
  editBanner.classList.add("hidden");
  submitBtn.querySelector(".btn-label").textContent = "Add job";
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

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.jobs || changes.jobErrors)) renderJobs();
});

// --- Analog clock picker for "Specific time" mode ---
const clockToggle = document.getElementById("clock-toggle");
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
  const rect = clockToggle.getBoundingClientRect();
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

clockToggle.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleClock();
});

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
