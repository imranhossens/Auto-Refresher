const scheduledVersions = new Map();

// Only accept messages from our own extension pages/service worker.
const OWN_EXTENSION_ID = chrome.runtime.id;

// Validate that a value is a safe RFC-4122 v4 UUID (what crypto.randomUUID() produces).
function isValidUUID(v) {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

// Validate a URL string is http/https and can be parsed safely.
function isSafeUrl(u) {
  if (typeof u !== "string") return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function totalSeconds(min, sec) {
  return (Number(min) || 0) * 60 + (Number(sec) || 0);
}

function nextSpecificTimeDelayMs(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

function computeDelayMs(job) {
  if (job.mode === "interval") {
    const secs = Math.max(1, totalSeconds(job.intervalMin, job.intervalSec));
    return secs * 1000;
  }
  if (job.mode === "random") {
    const min = Math.max(1, totalSeconds(job.randomMinMin, job.randomMinSec));
    const max = Math.max(min, totalSeconds(job.randomMaxMin, job.randomMaxSec));
    const secs = Math.floor(Math.random() * (max - min + 1)) + min;
    return secs * 1000;
  }
  if (job.mode === "specific") {
    return nextSpecificTimeDelayMs(job.specificTime);
  }
  return 60 * 1000;
}

async function getJobs() {
  const { jobs } = await chrome.storage.local.get("jobs");
  return jobs || [];
}

function waitForTabComplete(tabId, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(ok);
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish(true);
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

// Detects "are you a human?" / bot-check interstitials from most major
// providers (Cloudflare, reCAPTCHA, hCaptcha, Turnstile, Akamai, PerimeterX/
// HUMAN, DataDome, Arkose Labs/FunCaptcha, GeeTest, AWS WAF, generic block
// pages) so a "successful" reload isn't mistaken for a working refresh when
// it's actually stuck behind a verification wall.
//
// Three kinds of signal, combined:
// 1. Text phrases — the wording most vendors' interstitials use. Broad on
//    purpose since "many different kinds" of check use slightly different
//    copy; these pages fully replace the real content, so the phrase
//    disappears once you're through.
// 2. Full-page challenge containers — vendor-specific markup that (for these
//    vendors) means the entire page IS the challenge, same disappearing
//    behavior as #1.
// 3. Embedded widgets (reCAPTCHA/hCaptcha/Turnstile checkboxes) — these sit
//    inside an otherwise-normal page and their div stays in the DOM even
//    after solving, so presence alone would never clear. Check the hidden
//    response token instead: empty = unsolved, filled = solved.
function isHumanCheckActive() {
  const title = (document.title || "").toLowerCase();
  const bodyText = (document.body && document.body.innerText ? document.body.innerText : "").slice(0, 4000).toLowerCase();
  const text = `${title} ${bodyText}`;

  const phraseHit = /just a moment|checking your browser|checking if the site connection is secure|attention required|verify (that )?you('re| are)( a)? human|are you a robot|i'm not a robot|prove you('re| are)( a)? human|access (to this page has been )?denied|unusual traffic from your (computer|network)|please stand by[, ]*while we are checking|ddos protection by|pardon our interruption|please enable (javascript|cookies)|complete the security check|one more step|additional verification required|human verification|bot detection|security check to access|verifying you are human|checking your connection/i.test(
    text
  );

  const fullPageHit = !!document.querySelector(
    [
      "#challenge-running",
      "#cf-challenge-running",
      "form#challenge-form",
      "#px-captcha",
      ".px-captcha-container",
      "#datadome-cn",
      ".datadome-embed",
      "iframe[src*='captcha-delivery.com']",
      ".arkose",
      "#FunCaptcha",
      "iframe[src*='arkoselabs']",
      "iframe[src*='funcaptcha']",
      ".geetest_holder",
      ".geetest_panel",
      "iframe[src*='awswaf']",
    ].join(",")
  );

  const isWidgetUnsolved = (widgetSelector, responseSelector) => {
    if (!document.querySelector(widgetSelector)) return false;
    const responseEl = document.querySelector(responseSelector);
    return !responseEl || !responseEl.value;
  };

  const recaptchaUnsolved = isWidgetUnsolved(
    ".g-recaptcha, iframe[src*='recaptcha']",
    "#g-recaptcha-response, textarea[name='g-recaptcha-response']"
  );
  const hcaptchaUnsolved = isWidgetUnsolved(
    ".h-captcha, iframe[src*='hcaptcha']",
    "textarea[name='h-captcha-response']"
  );
  const turnstileUnsolved = isWidgetUnsolved(
    ".cf-turnstile, iframe[src*='challenges.cloudflare.com']",
    "input[name='cf-turnstile-response']"
  );

  return phraseHit || fullPageHit || recaptchaUnsolved || hcaptchaUnsolved || turnstileUnsolved;
}

// Same detection logic, injected into the challenged tab itself so we find
// out the instant the check is solved — polling from the service worker on
// an alarm can be throttled to 30s+ by Chrome, which isn't "automatic"
// enough. This runs in the tab's own JS engine, unaffected by that. Must be
// fully self-contained (no closures over background.js scope, including
// isHumanCheckActive above) since chrome.scripting serializes it — keep the
// detection logic here in sync with isHumanCheckActive if either changes.
function watchHumanCheckInPage(jobId) {
  if (window.__autoRefreshHumanWatch) return;
  window.__autoRefreshHumanWatch = true;

  function isBlocked() {
    const title = (document.title || "").toLowerCase();
    const bodyText = (document.body && document.body.innerText ? document.body.innerText : "").slice(0, 4000).toLowerCase();
    const text = `${title} ${bodyText}`;

    const phraseHit = /just a moment|checking your browser|checking if the site connection is secure|attention required|verify (that )?you('re| are)( a)? human|are you a robot|i'm not a robot|prove you('re| are)( a)? human|access (to this page has been )?denied|unusual traffic from your (computer|network)|please stand by[, ]*while we are checking|ddos protection by|pardon our interruption|please enable (javascript|cookies)|complete the security check|one more step|additional verification required|human verification|bot detection|security check to access|verifying you are human|checking your connection/i.test(
      text
    );

    const fullPageHit = !!document.querySelector(
      [
        "#challenge-running",
        "#cf-challenge-running",
        "form#challenge-form",
        "#px-captcha",
        ".px-captcha-container",
        "#datadome-cn",
        ".datadome-embed",
        "iframe[src*='captcha-delivery.com']",
        ".arkose",
        "#FunCaptcha",
        "iframe[src*='arkoselabs']",
        "iframe[src*='funcaptcha']",
        ".geetest_holder",
        ".geetest_panel",
        "iframe[src*='awswaf']",
      ].join(",")
    );

    const isUnsolved = (widgetSelector, responseSelector) => {
      if (!document.querySelector(widgetSelector)) return false;
      const responseEl = document.querySelector(responseSelector);
      return !responseEl || !responseEl.value;
    };
    const recaptchaUnsolved = isUnsolved(
      ".g-recaptcha, iframe[src*='recaptcha']",
      "#g-recaptcha-response, textarea[name='g-recaptcha-response']"
    );
    const hcaptchaUnsolved = isUnsolved(".h-captcha, iframe[src*='hcaptcha']", "textarea[name='h-captcha-response']");
    const turnstileUnsolved = isUnsolved(
      ".cf-turnstile, iframe[src*='challenges.cloudflare.com']",
      "input[name='cf-turnstile-response']"
    );
    return phraseHit || fullPageHit || recaptchaUnsolved || hcaptchaUnsolved || turnstileUnsolved;
  }

  const timer = setInterval(() => {
    if (!isBlocked()) {
      clearInterval(timer);
      window.__autoRefreshHumanWatch = false;
      chrome.runtime.sendMessage({ type: "human-check-cleared", jobId });
    }
  }, 800);

  window.addEventListener("beforeunload", () => clearInterval(timer), { once: true });
}

async function injectHumanCheckWatcher(job) {
  const rawUrls = job.urls || (job.url ? [job.url] : []);
  const urls = rawUrls.filter(isSafeUrl);
  for (const url of urls) {
    try {
      const tabs = await chrome.tabs.query({ url });
      for (const tab of tabs) {
        if (tab.id === undefined) continue;
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: watchHumanCheckInPage,
            args: [job.id],
          });
        } catch (e) {
          // Not scriptable — the 15s alarm poll is the fallback.
        }
      }
    } catch (e) {
      // ignore
    }
  }
}

async function refreshTab(job) {
  const rawUrls = job.urls || (job.url ? [job.url] : []);
  const urls = rawUrls.filter(isSafeUrl);
  let anyMatched = false;
  let anyFailed = false;
  let failReason = null;

  for (const url of urls) {
    try {
      const tabs = await chrome.tabs.query({ url });
      if (tabs.length === 0) {
        anyFailed = true;
        failReason = failReason || "no-tab";
        continue;
      }
      for (const tab of tabs) {
        if (tab.id === undefined) continue;
        await chrome.tabs.reload(tab.id);
        anyMatched = true;

        const loaded = await waitForTabComplete(tab.id);
        if (!loaded) continue;

        try {
          const [{ result: isChallenge } = {}] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: isHumanCheckActive,
          });
          if (isChallenge) {
            anyFailed = true;
            failReason = "human-check";
          }
        } catch (e) {
          // Page not scriptable (e.g. chrome:// or blocked); can't verify, assume ok.
        }
      }
    } catch (e) {
      console.error("Auto Refresh Tab: failed to refresh", url, e);
      anyFailed = true;
      failReason = failReason || "error";
    }
  }

  return { ok: anyMatched && !anyFailed, reason: anyFailed ? failReason : null };
}

// Passive check used while paused on an error: looks at the page as-is,
// without reloading, so it doesn't interrupt someone solving a captcha.
async function checkPageState(job) {
  const rawUrls = job.urls || (job.url ? [job.url] : []);
  const urls = rawUrls.filter(isSafeUrl);
  let anyChallenge = false;
  let anyFound = false;

  for (const url of urls) {
    const tabs = await chrome.tabs.query({ url });
    if (tabs.length === 0) continue;
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      anyFound = true;
      try {
        const [{ result: isChallenge } = {}] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: isHumanCheckActive,
        });
        if (isChallenge) anyChallenge = true;
      } catch (e) {
        // Not scriptable; can't tell, assume it's fine.
      }
    }
  }

  if (!anyFound) return { ok: false, reason: "no-tab" };
  if (anyChallenge) return { ok: false, reason: "human-check" };
  return { ok: true, reason: null };
}

const ERRORS_KEY = "jobErrors";

async function getJobErrors() {
  const { [ERRORS_KEY]: errors } = await chrome.storage.local.get(ERRORS_KEY);
  return errors || {};
}

async function setJobError(jobId, reason) {
  const errors = await getJobErrors();
  // Keep an existing mute (user already silenced it) unless the reason changed.
  const prev = errors[jobId];
  const muted = prev && prev.reason === reason ? !!prev.muted : false;
  errors[jobId] = { since: prev?.since || Date.now(), reason, muted };
  await chrome.storage.local.set({ [ERRORS_KEY]: errors });
  await syncAlertSound();
}

async function clearJobError(jobId) {
  const errors = await getJobErrors();
  if (!(jobId in errors)) return;
  delete errors[jobId];
  await chrome.storage.local.set({ [ERRORS_KEY]: errors });
  await syncAlertSound();
}

// --- Human/robot check alert sound ---
// Plays via an offscreen document (service workers can't play audio
// directly) and rings continuously until the check clears or the user
// mutes it from the popup.

const OFFSCREEN_URL = "offscreen.html";

async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Play a repeating alert sound while a job is blocked by a human/robot verification check.",
  });
}

async function syncAlertSound() {
  const jobs = await getJobs();
  const enabledIds = new Set(jobs.filter((j) => j.enabled).map((j) => j.id));
  const errors = await getJobErrors();
  const shouldRing = Object.entries(errors).some(
    ([id, e]) => enabledIds.has(id) && e.reason === "human-check" && !e.muted
  );

  if (shouldRing) {
    await ensureOffscreenDocument();
    chrome.runtime.sendMessage({ type: "start-alarm-sound" }).catch(() => {});
  } else if (await chrome.offscreen.hasDocument()) {
    chrome.runtime.sendMessage({ type: "stop-alarm-sound" }).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Reject any message that did not originate from our own extension.
  if (!sender || sender.id !== OWN_EXTENSION_ID) return;

  if (msg.type === "mute-human-check-alert") {
    (async () => {
      const errors = await getJobErrors();
      for (const id of Object.keys(errors)) {
        if (errors[id].reason === "human-check") errors[id].muted = true;
      }
      await chrome.storage.local.set({ [ERRORS_KEY]: errors });
      await syncAlertSound();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === "human-check-cleared") {
    // Validate that jobId is a proper UUID before using it as a storage/alarm key.
    if (!isValidUUID(msg.jobId)) return;
    (async () => {
      const errors = await getJobErrors();
      if (errors[msg.jobId] && errors[msg.jobId].reason === "human-check") {
        await clearJobError(msg.jobId);
        const jobs = await getJobs();
        const job = jobs.find((j) => j.id === msg.jobId);
        if (job && job.enabled) await scheduleJob(job);
        await updateBadge();
      }
      sendResponse({ ok: true });
    })();
    return true;
  }
});

async function scheduleJob(job) {
  chrome.alarms.clear(job.id);
  if (!job.enabled) return;
  const delayMs = computeDelayMs(job);
  chrome.alarms.create(job.id, { when: Date.now() + delayMs });
  scheduledVersions.set(job.id, job.updatedAt);
}

async function syncAlarms() {
  const jobs = await getJobs();
  const jobIds = new Set(jobs.map((j) => j.id));

  const existingAlarms = await chrome.alarms.getAll();
  for (const alarm of existingAlarms) {
    if (!jobIds.has(alarm.name)) {
      chrome.alarms.clear(alarm.name);
      scheduledVersions.delete(alarm.name);
    }
  }

  for (const job of jobs) {
    if (!job.enabled) {
      chrome.alarms.clear(job.id);
      scheduledVersions.delete(job.id);
      continue;
    }
    const alarm = await chrome.alarms.get(job.id);
    if (!alarm || scheduledVersions.get(job.id) !== job.updatedAt) {
      await clearJobError(job.id);
      await scheduleJob(job);
    }
  }

  const errors = await getJobErrors();
  for (const id of Object.keys(errors)) {
    if (!jobIds.has(id)) await clearJobError(id);
  }
}

chrome.runtime.onInstalled.addListener(() => syncAlarms().then(() => syncAlertSound()));
chrome.runtime.onStartup.addListener(() => syncAlarms().then(() => syncAlertSound()));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.jobs) {
    syncAlarms().then(() => updateBadge());
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "badge-tick") {
    updateBadge();
    return;
  }
  const jobs = await getJobs();
  const job = jobs.find((j) => j.id === alarm.name);
  if (!job || !job.enabled) return;

  const errors = await getJobErrors();
  if (errors[job.id]) {
    // Paused on an error: just peek at the page, don't reload it — the
    // user may be mid-way through solving a captcha.
    const { ok, reason } = await checkPageState(job);
    if (ok) {
      await clearJobError(job.id);
      // Human confirmed / page recovered — resume the normal countdown
      // from now, using the job's configured interval.
      await scheduleJob(job);
    } else {
      await setJobError(job.id, reason);
      if (reason === "human-check") await injectHumanCheckWatcher(job);
      chrome.alarms.create(job.id, { when: Date.now() + 15000 });
    }
    updateBadge();
    return;
  }

  const { ok, reason } = await refreshTab(job);
  if (ok) {
    await clearJobError(job.id);
    await scheduleJob(job);
  } else {
    await setJobError(job.id, reason);
    if (reason === "human-check") await injectHumanCheckWatcher(job);
    // Poll (without reloading) instead of waiting the full interval, but
    // the badge stays frozen on the warning state until it recovers. The
    // in-page watcher (above) is the fast path; this alarm is the fallback.
    chrome.alarms.create(job.id, { when: Date.now() + 15000 });
  }
  updateBadge();
});

// --- Toolbar badge countdown ---

function formatBadge(ms) {
  if (ms <= 0) return "now";
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec >= 3600) return `${Math.floor(totalSec / 3600)}h`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatTitle(ms) {
  if (ms <= 0) return "refreshing…";
  const totalSec = Math.ceil(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

const ERROR_REASON_LABEL = {
  "no-tab": "target tab isn't open",
  "human-check": "blocked by a human/robot verification check",
  error: "reload failed",
};

async function updateBadge() {
  const jobs = await getJobs();
  const enabledIds = new Set(jobs.filter((j) => j.enabled).map((j) => j.id));
  if (enabledIds.size === 0) {
    chrome.action.setBadgeText({ text: "" });
    chrome.action.setTitle({ title: "Auto Refresh Tab" });
    return;
  }

  // Freeze the countdown on a warning if any enabled job can't refresh —
  // ticking numbers would falsely suggest everything is working.
  const errors = await getJobErrors();
  const erroredJob = jobs.find((j) => enabledIds.has(j.id) && errors[j.id]);
  if (erroredJob) {
    const reason = errors[erroredJob.id].reason;
    const label = ERROR_REASON_LABEL[reason] || "refresh isn't working";
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
    chrome.action.setTitle({
      title: `Auto Refresh paused — ${label}\n${erroredJob.urls?.[0] || ""}`,
    });
    return;
  }

  const alarms = await chrome.alarms.getAll();
  const relevant = alarms.filter((a) => enabledIds.has(a.name));
  if (relevant.length === 0) {
    chrome.action.setBadgeText({ text: "" });
    chrome.action.setTitle({ title: "Auto Refresh Tab" });
    return;
  }

  const soonest = relevant.reduce((a, b) => (a.scheduledTime < b.scheduledTime ? a : b));
  const remaining = soonest.scheduledTime - Date.now();
  const job = jobs.find((j) => j.id === soonest.name);
  const urlLabel = job && job.urls && job.urls[0] ? job.urls[0] : "";

  chrome.action.setBadgeText({ text: formatBadge(remaining) });
  chrome.action.setBadgeBackgroundColor({ color: "#6366f1" });
  chrome.action.setTitle({
    title: `Next refresh in ${formatTitle(remaining)}${urlLabel ? `\n${urlLabel}` : ""}`,
  });
}

chrome.alarms.create("badge-tick", { periodInMinutes: 1 });
setInterval(updateBadge, 1000);
updateBadge();
