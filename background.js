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

// A stable per-browser-profile id, so a device can tell its own recorded
// activity apart from another device's — the whole feature is "pause because
// someone is using this site elsewhere", which is meaningless without it.
async function getDeviceId() {
  const { syncDeviceId } = await chrome.storage.local.get('syncDeviceId');
  if (syncDeviceId) return syncDeviceId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ syncDeviceId: id });
  return id;
}

// Stored activity value is `deviceId|timestamp`. Values without the separator
// come from an older version, where the writer was unknown.
function parseActivityValue(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const sep = text.lastIndexOf('|');
  const deviceId = sep === -1 ? null : text.slice(0, sep);
  const timestamp = parseInt(sep === -1 ? text : text.slice(sep + 1), 10);
  if (!Number.isFinite(timestamp)) return null;
  return { deviceId, timestamp };
}

function matchSyncDomain(hostname, syncDomains) {
  return syncDomains.find((d) => {
    const cleanD = String(d).trim().toLowerCase();
    return cleanD && (hostname === cleanD || hostname.endsWith('.' + cleanD));
  });
}

// Surfaced in the popup so a silently failing network write/read is visible
// instead of just looking like "sync does nothing".
async function setSyncStatus(status) {
  await chrome.storage.local.set({ syncStatus: { ...status, at: Date.now() } });
}

// The sync token field accepts either a full https:// endpoint (any backend
// speaking the contract below) or a bare kvdb.io bucket id. Keeping it one
// field means switching backends is a paste, not a code change.
//
// Contract: GET <base>/<domain> returns the stored string (404/empty = none),
// POST <base>/<domain> with the string as body stores it.
function buildSyncUrl(syncToken, domain) {
  const token = String(syncToken).trim();
  if (/^https?:\/\//i.test(token)) {
    const base = token.replace(/\/+$/, '');
    const url = new URL(`${base}/${encodeURIComponent(domain)}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString();
  }
  return `https://kvdb.io/${encodeURIComponent(token)}/${encodeURIComponent(domain)}`;
}

// Helper to check if cross-device activity should block refreshing for a URL/hostname
async function isCrossDeviceActive(url) {
  try {
    const { syncEnabled = true, syncTimeout = 5, syncDomains = [], syncToken } = await chrome.storage.local.get([
      'syncEnabled',
      'syncTimeout',
      'syncDomains',
      'syncToken'
    ]);
    if (!syncEnabled || syncDomains.length === 0) return false;
    if (!isSafeUrl(url)) return false;

    const hostname = new URL(url).hostname.toLowerCase();
    const matchedDomain = matchSyncDomain(hostname, syncDomains);
    if (!matchedDomain) return false;

    let activity = null;
    let transport = 'browser-sync';
    let networkError = null;

    if (syncToken) {
      // Network-based sync (works across different browsers, e.g. Comet <-> Chrome)
      try {
        const res = await fetch(buildSyncUrl(syncToken, matchedDomain));
        if (res.ok) {
          activity = parseActivityValue(await res.text());
          transport = 'network';
        } else if (res.status === 404) {
          activity = null; // Nothing recorded for this domain yet.
          transport = 'network';
        } else {
          networkError = `HTTP ${res.status}`;
        }
      } catch (err) {
        networkError = err.message;
      }
    }

    if (transport !== 'network') {
      // Built-in browser sync: the default, and the fallback whenever the
      // token backend is unreachable or rejects us.
      const storageKey = `cross_device_active_${matchedDomain}`;
      const syncData = await chrome.storage.sync.get(storageKey);
      activity = parseActivityValue(syncData[storageKey]);
    }

    const base = { ok: true, domain: matchedDomain, transport, networkError };

    if (!activity) {
      await setSyncStatus({ ...base, remoteActive: false, reason: 'no-activity' });
      return false;
    }

    // Our own activity must not pause our own refreshing.
    const deviceId = await getDeviceId();
    if (activity.deviceId === deviceId) {
      await setSyncStatus({ ...base, remoteActive: false, reason: 'own-device' });
      return false;
    }

    const elapsedMs = Date.now() - activity.timestamp;
    const timeoutMs = syncTimeout * 60 * 1000;
    const remoteActive = elapsedMs >= 0 && elapsedMs < timeoutMs;
    await setSyncStatus({
      ...base,
      remoteActive,
      lastActive: activity.timestamp,
      reason: remoteActive ? 'remote-active' : 'remote-idle',
    });
    return remoteActive;
  } catch (e) {
    await setSyncStatus({ ok: false, error: `Sync check failed: ${e.message}` });
  }
  return false;
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

// Flags a tab so the content script on the *next* load knows the reload came
// from us, not from the user. sessionStorage survives the reload and is scoped
// to that tab+origin. Without this, our own auto-refresh would register as
// "user active here", and the job would block its own next refresh.
async function markSelfReload(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => sessionStorage.setItem("__autoRefreshSelfReload", "1"),
    });
  } catch (e) {
    // Not scriptable; the reload just counts as user activity.
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
        await markSelfReload(tab.id);
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

  if (msg.type === 'getAutoReloadConfig') {
    const tabId = sender.tab?.id;
    const tabUrl = sender.tab?.url;
    if (!tabId) {
      sendResponse({ enabled: false });
      return;
    }
    
    (async () => {
      const result = await chrome.storage.local.get('autoReloadTabs');
      const autoReloadTabs = result.autoReloadTabs || {};
      const config = autoReloadTabs[tabId];
      if (config && config.enabled) {
        if (tabUrl && await isCrossDeviceActive(tabUrl)) {
          sendResponse({ enabled: true, interval: 30, delayOnly: true });
        } else {
          sendResponse({ enabled: true, interval: config.interval });
        }
      } else {
        sendResponse({ enabled: false });
      }
    })();
    return true; // Keep message channel open for async response
  }

  if (msg.type === 'recordSyncActivity') {
    (async () => {
      try {
        const { syncToken, syncDomains = [] } = await chrome.storage.local.get(['syncToken', 'syncDomains']);
        // Never write a domain the user hasn't configured — msg.domain comes
        // from a content script and ends up in the request path.
        const domain = matchSyncDomain(String(msg.domain || '').toLowerCase(), syncDomains);
        if (!domain) return;

        const value = `${await getDeviceId()}|${Date.now()}`;
        let networkError = null;

        if (syncToken) {
          try {
            const res = await fetch(buildSyncUrl(syncToken, domain), {
              method: 'POST',
              body: value,
            });
            if (res.ok) {
              await setSyncStatus({ ok: true, domain, wrote: true, transport: 'network' });
              return;
            }
            networkError = `HTTP ${res.status}`;
          } catch (err) {
            networkError = err.message;
          }
        }

        // No token, or the token backend rejected us — use built-in browser
        // sync so activity still reaches this account's other devices.
        const storageKey = `cross_device_active_${domain}`;
        await chrome.storage.sync.set({ [storageKey]: value });
        await setSyncStatus({ ok: true, domain, wrote: true, transport: 'browser-sync', networkError });
      } catch (err) {
        await setSyncStatus({ ok: false, error: `Write failed: ${err.message}` });
      }
    })();
    return true;
  }
  
  if (msg.type === 'settingsChanged') {
    updateClickBehavior().then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

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

  if (msg.type === 'darkmode-sync-active-tab') {
    (async () => {
      try {
        await syncDarkModePreloadScript();
        const tabs = await chrome.tabs.query({});
        await Promise.allSettled(
          tabs
            .filter((t) => t && t.id && t.url && /^https?:\/\//i.test(t.url))
            .map((t) => ensureDarkModeOnTab(t.id, false))
        );
        sendResponse({ ok: true });
      } catch {
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  if (msg.type === 'darkmode-toggle-shortcut') {
    (async () => {
      try {
        let tabId = sender && sender.tab ? sender.tab.id : null;
        let tabUrl = sender && sender.tab ? sender.tab.url : null;
        if (!tabId) {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          tabId = activeTab ? activeTab.id : null;
          tabUrl = activeTab ? activeTab.url : null;
        }
        if (tabId && tabUrl && /^https?:\/\//i.test(tabUrl)) {
          const res = await toggleDarkModeForTab(tabId, tabUrl);
          sendResponse({ ok: true, active: res.active, domain: res.domain });
        } else {
          sendResponse({ ok: false });
        }
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === 'darkmode-probe-image' && typeof msg.url === 'string') {
    (async () => {
      try {
        const res = await probeExternalImageKind(msg.url);
        sendResponse(res);
      } catch {
        sendResponse({ kind: 'normal' });
      }
    })();
    return true;
  }

  if (msg.type === 'darkmode-probe-svg' && typeof msg.url === 'string') {
    (async () => {
      try {
        const res = await probeExternalImageKind(msg.url);
        sendResponse({ kind: res.kind, dataUri: res.dataUri, isDarkMono: res.kind === 'dark-mono' });
      } catch {
        sendResponse({ kind: 'normal', isDarkMono: false });
      }
    })();
    return true;
  }

  if (msg.type === 'darkmode-transform-css' && typeof msg.url === 'string') {
    (async () => {
      try {
        const css = await fetchAndTransformExternalCss(msg.url, msg.isPureBlack !== false);
        sendResponse({ ok: true, css });
      } catch {
        sendResponse({ ok: false, css: '' });
      }
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

async function handleInstalledOrStartup(isInstalled) {
  if (isInstalled) {
    createContextMenus();
  }
  await updateClickBehavior();
  await syncAlarms();
  await syncAlertSound();
}

chrome.runtime.onInstalled.addListener(() => handleInstalledOrStartup(true));
chrome.runtime.onStartup.addListener(() => handleInstalledOrStartup(false));

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

  // CHECK CROSS-DEVICE ACTIVE SYNC
  const rawUrls = job.urls || (job.url ? [job.url] : []);
  const urls = rawUrls.filter(isSafeUrl);
  let syncBlocked = false;
  for (const url of urls) {
    if (await isCrossDeviceActive(url)) {
      syncBlocked = true;
      break;
    }
  }

  if (syncBlocked) {
    // Postpone reload: schedule next check in 30 seconds
    chrome.alarms.create(job.id, { when: Date.now() + 30000 });
    return;
  }

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

// --- Tab Reload features ---

// Helper to reload a single tab with option to bypass cache
async function reloadTab(tabId, bypassCache = false) {
  try {
    await chrome.tabs.reload(tabId, { bypassCache });
  } catch (err) {
    console.error(`Failed to reload tab ${tabId}:`, err);
  }
}

// Core reload logic for various targets
async function performReload(actionType, bypassCache = false) {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
  switch (actionType) {
    case 'all': {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      for (const tab of tabs) {
        await reloadTab(tab.id, bypassCache);
      }
      break;
    }
    
    case 'active': {
      if (activeTab) {
        await reloadTab(activeTab.id, bypassCache);
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
      
      // Reload the moved/selected tabs
      for (const tab of selectedTabs) {
        await reloadTab(tab.id, bypassCache);
      }
      break;
    }
    
    case 'domain': {
      if (activeTab && activeTab.url) {
        try {
          const activeDomain = new URL(activeTab.url).hostname;
          const tabs = await chrome.tabs.query({ currentWindow: true });
          for (const tab of tabs) {
            try {
              if (tab.url && new URL(tab.url).hostname === activeDomain) {
                await reloadTab(tab.id, bypassCache);
              }
            } catch (e) {
              // Ignore invalid URLs
            }
          }
        } catch (e) {
          console.error("Error parsing active tab URL", e);
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
      let { specificUrls, specificUrl } = await chrome.storage.local.get(['specificUrls', 'specificUrl']);
      if (!Array.isArray(specificUrls)) {
        specificUrls = specificUrl ? [specificUrl] : [];
      }
      if (specificUrls.length === 0) break;

      const tabs = await chrome.tabs.query({ currentWindow: true });
      const targetTabs = tabs.filter(t => {
        if (!t.url) return false;
        const tabUrl = t.url.toLowerCase();
        return specificUrls.some(u => {
          const query = u.toLowerCase().trim();
          return query && tabUrl.includes(query);
        });
      });

      if (targetTabs.length > 0) {
        for (const tab of targetTabs) {
          await reloadTab(tab.id, bypassCache);
        }
      }
      break;
    }
  }
}

// Context Menu Setup
const CONTEXT_MENUS = [
  { id: 'reload-all', title: 'Reload All Tabs', contexts: ['action'] },
  { id: 'reload-selected', title: 'Reload Selected Tabs (Move Left)', contexts: ['action'] },
  { id: 'reload-domain', title: 'Reload Same Domain Tabs', contexts: ['action'] },
  { id: 'reload-left', title: 'Reload Tabs to the Left', contexts: ['action'] },
  { id: 'reload-right', title: 'Reload Tabs to the Right', contexts: ['action'] },
  { id: 'reload-specific', title: 'Reload Specific Link', contexts: ['action'] },
  { id: 'separator-1', type: 'separator', contexts: ['action', 'page'] },
  { id: 'set-specific-url', title: 'Set Page as Specific Reload Link', contexts: ['action', 'page'] },
  { id: 'separator-2', type: 'separator', contexts: ['action'] },
  { id: 'options', title: 'Configure Action Settings...', contexts: ['action'] },
  { id: 'darkmode-toggle-page', title: 'Toggle Dark Mode for This Domain', contexts: ['page'] },
  { id: 'darkmode-add-link', title: 'Add Main Domain to Dark Mode', contexts: ['link'] }
];

function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    for (const menu of CONTEXT_MENUS) {
      const { contexts = ['action'], ...rest } = menu;
      chrome.contextMenus.create({
        ...rest,
        contexts
      });
    }
  });
}

// Set click behavior (popup vs direct quick reload)
async function updateClickBehavior() {
  const { clickBehavior = 'popup' } = await chrome.storage.local.get('clickBehavior');
  if (clickBehavior === 'popup') {
    await chrome.action.setPopup({ popup: 'popup.html' });
  } else {
    await chrome.action.setPopup({ popup: '' });
  }
}

// Listen for direct clicks on the action icon (only fires if default_popup is cleared)
chrome.action.onClicked.addListener(async () => {
  const { clickBehavior = 'popup', bypassCache = false } = await chrome.storage.local.get(['clickBehavior', 'bypassCache']);
  if (clickBehavior !== 'popup') {
    await performReload(clickBehavior, bypassCache);
  }
});

// Context Menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'options') {
    chrome.runtime.openOptionsPage();
    return;
  }

  if (info.menuItemId === 'darkmode-toggle-page') {
    const targetTab = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (targetTab && targetTab.id && targetTab.url) {
      await toggleDarkModeForTab(targetTab.id, targetTab.url);
    }
    return;
  }

  if (info.menuItemId === 'darkmode-add-link' && info.linkUrl) {
    try {
      const parsed = new URL(info.linkUrl);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        const domain = extractMainDomain(parsed.hostname);
        const { darkModeConfig = {} } = await chrome.storage.local.get('darkModeConfig');
        const nextConfig = {
          ...darkModeConfig,
          siteRules: { ...(darkModeConfig.siteRules || {}), [domain]: 'on' }
        };
        await chrome.storage.local.set({ darkModeConfig: nextConfig });
        const targetTab = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
        if (targetTab && targetTab.id) {
          chrome.tabs.sendMessage(targetTab.id, {
            type: 'darkmode-show-toast',
            message: `Dark Mode added for ${domain}`
          }).catch(() => {});
        }
      }
    } catch {
      // Ignore non-HTTP links
    }
    return;
  }

  if (info.menuItemId === 'set-specific-url') {
    const targetTab = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (targetTab && targetTab.url) {
      let { specificUrls, specificUrl } = await chrome.storage.local.get(['specificUrls', 'specificUrl']);
      if (!Array.isArray(specificUrls)) {
        specificUrls = specificUrl ? [specificUrl] : [];
      }
      if (!specificUrls.includes(targetTab.url)) {
        specificUrls.push(targetTab.url);
        await chrome.storage.local.set({ specificUrls });
      }
      try {
        await chrome.action.setBadgeText({ text: 'SET' });
        await chrome.action.setBadgeBackgroundColor({ color: '#00F0FF' });
        setTimeout(() => {
          chrome.action.setBadgeText({ text: '' });
        }, 2000);
      } catch (e) {
        console.error("Failed to set badge feedback:", e);
      }
    }
    return;
  }
  
  const { bypassCache = false } = await chrome.storage.local.get('bypassCache');
  
  switch (info.menuItemId) {
    case 'reload-all':
      await performReload('all', bypassCache);
      break;
    case 'reload-selected':
      await performReload('selected', bypassCache);
      break;
    case 'reload-domain':
      await performReload('domain', bypassCache);
      break;
    case 'reload-left':
      await performReload('left', bypassCache);
      break;
    case 'reload-right':
      await performReload('right', bypassCache);
      break;
    case 'reload-specific':
      await performReload('specific', bypassCache);
      break;
  }
});

// Keyboard Commands
chrome.commands.onCommand.addListener(async (command) => {
  const { bypassCache = false } = await chrome.storage.local.get('bypassCache');
  switch (command) {
    case 'reload-all':
      await performReload('all', bypassCache);
      break;
    case 'reload-selected':
      await performReload('selected', bypassCache);
      break;
    case 'reload-domain':
      await performReload('domain', bypassCache);
      break;
    case 'reload-left':
      await performReload('left', bypassCache);
      break;
    case 'reload-right':
      await performReload('right', bypassCache);
      break;
    case 'reload-others':
      await performReload('others', bypassCache);
      break;
    case 'toggle-dark-mode': {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab && activeTab.id && activeTab.url) {
        await toggleDarkModeForTab(activeTab.id, activeTab.url);
      }
      break;
    }
  }
});

async function toggleDarkModeForTab(tabId, tabUrl) {
  try {
    const parsed = new URL(tabUrl);
    const domain = extractMainDomain(parsed.hostname) || parsed.hostname.toLowerCase();
    const { darkModeConfig = {} } = await chrome.storage.local.get('darkModeConfig');
    if (!darkModeConfig.enabled) {
      return { active: false, domain };
    }
    const siteRules = { ...(darkModeConfig.siteRules || {}) };
    const pageRules = { ...(darkModeConfig.pageRules || {}) };

    let path = parsed.pathname || '/';
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    const pageKey = parsed.origin.toLowerCase() + path;

    let currentOn = false;
    if (pageKey in pageRules) {
      currentOn = pageRules[pageKey] === 'on';
      delete pageRules[pageKey];
    } else if (domain in siteRules) {
      currentOn = siteRules[domain] === 'on';
    } else if (parsed.hostname.toLowerCase() in siteRules) {
      currentOn = siteRules[parsed.hostname.toLowerCase()] === 'on';
    }

    const nextActive = !currentOn;
    siteRules[domain] = nextActive ? 'on' : 'off';

    const nextConfig = {
      ...darkModeConfig,
      siteRules,
      pageRules
    };

    await chrome.storage.local.set({ darkModeConfig: nextConfig });
    await syncDarkModePreloadScript();

    // Make sure content script is active on tab
    await ensureDarkModeOnTab(tabId, false);

    // Notify all frames in the tab of the updated state with toast
    chrome.tabs.sendMessage(tabId, {
      type: 'darkmode-show-toast',
      message: nextActive ? `Dark Mode: ON (${domain})` : `Dark Mode: OFF (${domain})`
    }).catch(() => {});
    chrome.tabs.sendMessage(tabId, {
      type: 'darkmode-force-sync'
    }).catch(() => {});

    return { active: nextActive, domain };
  } catch (err) {
    console.warn('[darkmode] toggleDarkModeForTab failed:', err);
    return { active: false, domain: '' };
  }
}

// ---- Dark Mode Helpers: Instant Tab Injection & Cross-Origin SVG Icon Probe ----
const svgProbeCache = new Map();

async function ensureDarkModeOnTab(tabId, shouldToggle = false) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !tab.url || !/^https?:\/\//i.test(tab.url)) return;

    try {
      const res = await chrome.tabs.sendMessage(tabId, {
        type: shouldToggle ? 'darkmode-toggle-shortcut' : 'darkmode-force-sync'
      });
      if (res && res.ok) return;
    } catch {
      // Tab was already open before install/reload; inject darkmode.js immediately so no refresh is needed
    }

    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['darkmode.js']
    });

    if (shouldToggle) {
      await chrome.tabs.sendMessage(tabId, { type: 'darkmode-toggle-shortcut' }).catch(() => {});
    }
  } catch {
    // Restricted or closed tab
  }
}

function parseHexToRgba(hex) {
  if (!hex || typeof hex !== 'string') return null;
  let h = hex.trim();
  if (!h.startsWith('#')) return null;
  h = h.slice(1);
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length === 4) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  if (h.length !== 6 && h.length !== 8) return null;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a };
}

function parseRgbaString(str) {
  if (!str || typeof str !== 'string') return null;
  const m = str.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)/i);
  if (!m) return null;
  const r = Math.max(0, Math.min(255, parseFloat(m[1])));
  const g = Math.max(0, Math.min(255, parseFloat(m[2])));
  const b = Math.max(0, Math.min(255, parseFloat(m[3])));
  let a = 1;
  if (m[4] !== undefined) {
    a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  }
  return { r, g, b, a };
}

function transformSvgMarkupColors(text) {
  if (!text || !text.includes('<svg')) return null;

  // 1. Neutralize blend modes that turn black over dark backgrounds
  let transformed = text.replace(/mix-blend-mode\s*:\s*(multiply|darken|color-burn)/gi, 'mix-blend-mode: normal');

  let hasColor = false;
  let hasDarkNeutral = false;
  let hasSemiAlphaDark = false;

  const inspectColor = (r, g, b, a = 1) => {
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    const chroma = max - min;
    if (a < 0.55 && l < 0.55) {
      hasSemiAlphaDark = true;
    } else if (chroma >= 0.15) {
      hasColor = true;
    } else if (l < 0.55) {
      hasDarkNeutral = true;
    }
  };

  // 2. Transform dark neutral fills and strokes to crisp light #E8EAED
  // while preserving vibrant colored fills (e.g. Google yellow/blue/green/red) 100% untouched!
  transformed = transformed.replace(/(fill|stroke)\s*=\s*["']([^"']+)["']/gi, (match, attr, val) => {
    const trimmed = val.trim();
    if (!trimmed || trimmed === 'none' || trimmed.startsWith('url(')) return match;
    const rgba = parseHexToRgba(trimmed) || parseRgbaString(trimmed);
    if (!rgba || rgba.a < 0.05) return match;
    inspectColor(rgba.r, rgba.g, rgba.b, rgba.a);
    const rn = rgba.r / 255, gn = rgba.g / 255, bn = rgba.b / 255;
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    const chroma = max - min;
    if (chroma < 0.15 && l < 0.55) {
      return `${attr}="#E8EAED"`;
    }
    return match;
  });

  // 3. Transform CSS style declarations inside <style> tags or inline style=""
  transformed = transformed.replace(/(fill|stroke)\s*:\s*([^;"]+)/gi, (match, prop, val) => {
    const trimmed = val.trim();
    if (!trimmed || trimmed === 'none' || trimmed.startsWith('url(')) return match;
    const rgba = parseHexToRgba(trimmed) || parseRgbaString(trimmed);
    if (!rgba || rgba.a < 0.05) return match;
    inspectColor(rgba.r, rgba.g, rgba.b, rgba.a);
    const rn = rgba.r / 255, gn = rgba.g / 255, bn = rgba.b / 255;
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    const chroma = max - min;
    if (chroma < 0.15 && l < 0.55) {
      return `${prop}: #E8EAED`;
    }
    return match;
  });

  // 4. Boost low-opacity dark/slate shapes (e.g. Google Material illustrations with fill-opacity="0.08")
  transformed = transformed.replace(/(fill-opacity|stroke-opacity|opacity)\s*=\s*["']0?\.(0\d|[1-4]\d?)["']/gi, (m, attr) => {
    hasSemiAlphaDark = true;
    return `${attr}="0.45"`;
  });

  // If the SVG contains dark neutral text/lines alongside colors, or semi-alpha shapes:
  if (hasDarkNeutral || hasSemiAlphaDark || (hasColor && transformed !== text)) {
    const dataUri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(transformed);
    return { kind: 'svg-transformed', dataUri };
  }

  // Pure dark monochrome SVG without colors
  if (!hasColor && (hasDarkNeutral || /<(path|circle|rect|polygon|text)\b/i.test(text))) {
    return { kind: 'dark-mono' };
  }

  return { kind: 'normal' };
}

function classifyRgbaPixels(data, totalPixels) {
  let transparentCount = 0;
  let visibleCount = 0;
  let semiAlphaDarkCount = 0;
  let opaqueDarkCount = 0;
  let colorCount = 0;
  let brightNeutralCount = 0;

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 6) {
      transparentCount++;
      continue;
    }
    visibleCount++;
    const rn = data[i] / 255, gn = data[i + 1] / 255, bn = data[i + 2] / 255;
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    const chroma = max - min;
    const alphaNorm = a / 255;

    if (alphaNorm < 0.72 && l < 0.55) {
      semiAlphaDarkCount++;
    } else if (chroma >= 0.16 && alphaNorm >= 0.45) {
      colorCount++;
    } else if (l * alphaNorm < 0.34) {
      opaqueDarkCount++;
    } else {
      brightNeutralCount++;
    }
  }

  if (visibleCount === 0) return { kind: 'normal' };
  const hasTransparency = (transparentCount / totalPixels >= 0.05) || (semiAlphaDarkCount / visibleCount >= 0.12);
  if (!hasTransparency) return { kind: 'normal' };

  const semiRatio = semiAlphaDarkCount / visibleCount;
  const darkRatio = (opaqueDarkCount + semiAlphaDarkCount) / visibleCount;
  const colorRatio = colorCount / visibleCount;
  const brightRatio = brightNeutralCount / visibleCount;

  // Pure dark monochrome icon / logo / line art (no vivid colors) -> crisp invert
  if (darkRatio >= 0.78 && colorRatio < 0.10 && brightRatio < 0.15) {
    return { kind: 'dark-mono' };
  }
  // Graphic with semi-transparent dark shapes (Google Material illustrations) -> alpha-lift
  if (semiRatio >= 0.08) {
    return { kind: 'alpha-dark' };
  }
  return { kind: 'normal' };
}

async function probeExternalImageKind(url) {
  if (!/^https?:\/\//i.test(url)) return { kind: 'normal' };
  if (svgProbeCache.has(url)) return svgProbeCache.get(url);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      const def = { kind: 'normal' };
      svgProbeCache.set(url, def);
      return def;
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    let result = { kind: 'normal' };

    if (contentType.includes('svg') || /\.svg(\?|#|$)/i.test(url)) {
      const text = await res.text();
      const transformed = transformSvgMarkupColors(text);
      result = transformed || { kind: 'normal' };
    } else if (
      contentType.includes('image/png') ||
      contentType.includes('image/webp') ||
      contentType.includes('image/gif') ||
      contentType.includes('image/avif') ||
      (contentType.includes('image/') && !contentType.includes('jpeg') && !contentType.includes('jpg'))
    ) {
      const blob = await res.blob();
      if (blob.size > 0 && blob.size <= 3 * 1024 * 1024 && typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function') {
        const bmp = await createImageBitmap(blob);
        const cw = Math.min(40, Math.max(1, bmp.width));
        const ch = Math.min(40, Math.max(1, bmp.height));
        const canvas = new OffscreenCanvas(cw, ch);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(bmp, 0, 0, cw, ch);
          const data = ctx.getImageData(0, 0, cw, ch).data;
          result = classifyRgbaPixels(data, cw * ch);
        }
        if (bmp.close) bmp.close();
      }
    }

    if (svgProbeCache.size > 500) svgProbeCache.clear();
    svgProbeCache.set(url, result);
    return result;
  } catch {
    const def = { kind: 'normal' };
    svgProbeCache.set(url, def);
    return def;
  }
}

// ---- Proactive Cross-Origin CSS Stylesheet Transformer (0ms SPA & Webmail Dark Mode) ----
const cssTransformCache = new Map();
const CSS_NAMED_COLORS = {
  white: { r: 255, g: 255, b: 255, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  snow: { r: 255, g: 250, b: 250, a: 1 },
  ivory: { r: 255, g: 255, b: 240, a: 1 },
  whitesmoke: { r: 245, g: 245, b: 245, a: 1 },
  ghostwhite: { r: 248, g: 248, b: 255, a: 1 },
  aliceblue: { r: 240, g: 248, b: 255, a: 1 },
  gainsboro: { r: 220, g: 220, b: 220, a: 1 },
  lightgray: { r: 211, g: 211, b: 211, a: 1 },
  lightgrey: { r: 211, g: 211, b: 211, a: 1 },
  silver: { r: 192, g: 192, b: 192, a: 1 },
  darkgray: { r: 169, g: 169, b: 169, a: 1 },
  gray: { r: 128, g: 128, b: 128, a: 1 },
  grey: { r: 128, g: 128, b: 128, a: 1 },
  dimgray: { r: 105, g: 105, b: 105, a: 1 },
  dimgrey: { r: 105, g: 105, b: 105, a: 1 },
  darkslategray: { r: 47, g: 79, b: 79, a: 1 },
  darkslategrey: { r: 47, g: 79, b: 79, a: 1 }
};

function cssRgbToHsl(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
    else if (max === gn) h = ((bn - rn) / d + 2) * 60;
    else h = ((rn - gn) / d + 4) * 60;
  }
  return { h, s, l, chroma: d };
}

function cssHslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r1 = 0, g1 = 0, b1 = 0;
  if (h < 60) { r1 = c; g1 = x; }
  else if (h < 120) { r1 = x; g1 = c; }
  else if (h < 180) { g1 = c; b1 = x; }
  else if (h < 240) { g1 = x; b1 = c; }
  else if (h < 300) { r1 = x; b1 = c; }
  else { r1 = c; b1 = x; }
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255)
  };
}

function parseSingleCssColor(val) {
  const s = String(val || '').trim().toLowerCase();
  if (!s || s === 'none' || s === 'transparent' || s === 'inherit' || s === 'initial' || s === 'unset' || s === 'currentcolor' || s.includes('var(') || s.includes('url(') || s.includes('gradient(')) {
    return null;
  }
  if (CSS_NAMED_COLORS[s]) return CSS_NAMED_COLORS[s];
  if (s.startsWith('#')) return parseHexToRgba(s);
  if (s.startsWith('rgb')) return parseRgbaString(s);
  return null;
}

function formatCssRgba(r, g, b, a) {
  return a >= 0.999 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${Number(a.toFixed(3))})`;
}

function transformCssDeclarationBlock(decls, isPureBlack) {
  const parts = decls.split(';');
  let ruleHasKeptVibrantBg = false;
  const parsed = [];

  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i].trim();
    if (!raw) continue;
    const colonIdx = raw.indexOf(':');
    if (colonIdx <= 0) continue;
    const prop = raw.slice(0, colonIdx).trim().toLowerCase();
    if (
      prop !== 'background-color' &&
      prop !== 'background' &&
      prop !== 'color' &&
      prop !== 'border-color' &&
      prop !== 'border-top-color' &&
      prop !== 'border-right-color' &&
      prop !== 'border-bottom-color' &&
      prop !== 'border-left-color'
    ) {
      continue;
    }
    let val = raw.slice(colonIdx + 1).trim();
    const isImp = /!important\s*$/i.test(val);
    if (isImp) val = val.replace(/!important\s*$/i, '').trim();
    const rgba = parseSingleCssColor(val);
    if (!rgba || rgba.a < 0.05) continue;

    if (prop === 'background-color' || prop === 'background') {
      const { l, chroma } = cssRgbToHsl(rgba.r, rgba.g, rgba.b);
      if (chroma >= 0.14 && l <= 0.76) {
        ruleHasKeptVibrantBg = true;
        continue;
      }
      if (l <= 0.28) {
        ruleHasKeptVibrantBg = true;
        continue;
      }
    }
    parsed.push({ prop, rgba, isImp });
  }

  const out = [];
  for (const item of parsed) {
    const { prop, rgba, isImp } = item;
    const imp = isImp ? ' !important' : '';
    const { h, s, l, chroma } = cssRgbToHsl(rgba.r, rgba.g, rgba.b);

    if (prop === 'background-color' || prop === 'background') {
      if (l > 0.72 && chroma >= 0.04) {
        const targetL = isPureBlack ? 0.14 + (1 - l) * 0.28 : 0.16 + (1 - l) * 0.26;
        const rgb = cssHslToRgb(h, Math.max(0.28, Math.min(0.60, s * 0.65)), Math.min(0.26, targetL));
        out.push(`background-color:${formatCssRgba(rgb.r, rgb.g, rgb.b, rgba.a)}${imp}`);
      } else if (l > 0.50 && chroma < 0.14) {
        if (isPureBlack) {
          if (l >= 0.82) {
            out.push(`background-color:${formatCssRgba(0, 0, 0, rgba.a)}${imp}`);
          } else {
            const rgb = cssHslToRgb(225, 0.08, Math.min(0.12, 0.04 + (1 - l) * 0.15));
            out.push(`background-color:${formatCssRgba(rgb.r, rgb.g, rgb.b, rgba.a)}${imp}`);
          }
        } else {
          const rgb = cssHslToRgb(225, 0.08, Math.min(0.27, 0.085 + (1 - l) * 0.38));
          out.push(`background-color:${formatCssRgba(rgb.r, rgb.g, rgb.b, rgba.a)}${imp}`);
        }
      }
    } else if (prop === 'color') {
      if (ruleHasKeptVibrantBg) continue;
      if (chroma < 0.14 && l < 0.68) {
        const targetL = Math.max(0.72, Math.min(0.95, 0.95 - l * 0.35));
        const rgb = cssHslToRgb(220, 0.08, targetL);
        out.push(`color:${formatCssRgba(rgb.r, rgb.g, rgb.b, rgba.a)}${imp}`);
      }
    } else if (prop.endsWith('color')) {
      if (chroma < 0.14 && l > 0.55) {
        const targetL = Math.max(0.18, Math.min(0.30, 0.20 + (1 - l) * 0.25));
        const rgb = cssHslToRgb(225, 0.08, targetL);
        out.push(`${prop}:${formatCssRgba(rgb.r, rgb.g, rgb.b, Math.min(rgba.a, 0.85))}${imp}`);
      }
    }
  }
  return out.join(';');
}

function buildDarkOverrideFromCssText(cssText, isPureBlack) {
  if (!cssText || cssText.length > 650000) return '';
  const cleaned = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  const len = cleaned.length;
  let pos = 0;

  const parseBlock = (endPos) => {
    const out = [];
    while (pos < endPos) {
      while (pos < endPos && (cleaned[pos] <= ' ' || cleaned[pos] === ';')) pos++;
      if (pos >= endPos) break;
      if (cleaned[pos] === '}') {
        pos++;
        break;
      }

      const start = pos;
      let braceIdx = -1;
      let semiIdx = -1;
      let inStr = '';
      while (pos < endPos) {
        const ch = cleaned[pos];
        if (inStr) {
          if (ch === '\\') { pos += 2; continue; }
          if (ch === inStr) inStr = '';
        } else if (ch === '"' || ch === "'") {
          inStr = ch;
        } else if (ch === '{') {
          braceIdx = pos;
          pos++;
          break;
        } else if (ch === ';') {
          semiIdx = pos;
          pos++;
          break;
        } else if (ch === '}') {
          break;
        }
        pos++;
      }

      if (semiIdx !== -1 || braceIdx === -1) continue;
      const prelude = cleaned.slice(start, braceIdx).trim();

      // Find matching closing brace for this block
      const bodyStart = pos;
      let depth = 1;
      inStr = '';
      while (pos < endPos && depth > 0) {
        const ch = cleaned[pos];
        if (inStr) {
          if (ch === '\\') { pos += 2; continue; }
          if (ch === inStr) inStr = '';
        } else if (ch === '"' || ch === "'") {
          inStr = ch;
        } else if (ch === '{') {
          depth++;
        } else if (ch === '}') {
          depth--;
        }
        pos++;
      }
      const bodyEnd = pos - 1;

      if (!prelude) continue;
      if (prelude.startsWith('@')) {
        const lower = prelude.toLowerCase();
        if (lower.startsWith('@media') || lower.startsWith('@supports') || lower.startsWith('@layer')) {
          const savedPos = pos;
          pos = bodyStart;
          const inner = parseBlock(bodyEnd);
          pos = savedPos;
          if (inner) out.push(`${prelude}{${inner}}`);
        }
        continue;
      }

      const decls = cleaned.slice(bodyStart, bodyEnd);
      const transformed = transformCssDeclarationBlock(decls, isPureBlack);
      if (transformed) {
        out.push(`${prelude}{${transformed}}`);
      }
    }
    return out.join('');
  };

  return parseBlock(len);
}

async function fetchAndTransformExternalCss(url, isPureBlack) {
  if (!/^https?:\/\//i.test(url)) return '';
  const cacheKey = `${isPureBlack ? '1' : '0'}|${url}`;
  if (cssTransformCache.has(cacheKey)) return cssTransformCache.get(cacheKey);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      cssTransformCache.set(cacheKey, '');
      return '';
    }
    const text = await res.text();
    const transformed = buildDarkOverrideFromCssText(text, isPureBlack);
    if (cssTransformCache.size > 120) cssTransformCache.clear();
    cssTransformCache.set(cacheKey, transformed);
    return transformed;
  } catch {
    cssTransformCache.set(cacheKey, '');
    return '';
  }
}

// ---- Dark Mode 0ms Preload Script Registration ----
const DARKMODE_PRELOAD_ID = 'ar-darkmode-preload';
const DM_MULTI_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk',
  'com.au', 'net.au', 'org.au', 'edu.au',
  'com.bd', 'org.bd', 'net.bd', 'edu.bd', 'gov.bd',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp',
  'co.in', 'net.in', 'org.in', 'ac.in',
  'com.br', 'com.mx', 'com.cn', 'com.sg', 'com.hk', 'com.tw', 'co.nz', 'co.za', 'co.kr'
]);

function extractMainDomain(hostname) {
  const clean = String(hostname || '').toLowerCase().replace(/^www\./, '');
  if (!clean || /^(\d+\.){3}\d+$/.test(clean) || clean === 'localhost' || !clean.includes('.')) {
    return clean;
  }
  const parts = clean.split('.');
  if (parts.length <= 2) return clean;
  const lastTwo = parts.slice(-2).join('.');
  if (DM_MULTI_PART_TLDS.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}

async function syncDarkModePreloadScript() {
  try {
    const { darkModeConfig } = await chrome.storage.local.get('darkModeConfig');
    const isEnabled = Boolean(darkModeConfig && darkModeConfig.enabled);
    const siteRules = (darkModeConfig && darkModeConfig.siteRules) || {};
    const pageRules = (darkModeConfig && darkModeConfig.pageRules) || {};

    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [DARKMODE_PRELOAD_ID] });
    if (existing && existing.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: [DARKMODE_PRELOAD_ID] });
    }

    if (!isEnabled) return;

    const matchSet = new Set();
    for (const [host, rule] of Object.entries(siteRules)) {
      if (rule === 'on' && host && !host.includes('/') && !host.includes('*')) {
        matchSet.add(`*://${host}/*`);
        matchSet.add(`*://*.${host}/*`);
      }
    }
    for (const [pageUrl, rule] of Object.entries(pageRules)) {
      if (rule === 'on' && /^https?:\/\//i.test(pageUrl)) {
        matchSet.add(`${pageUrl}*`);
      }
    }
    const matches = Array.from(matchSet);
    if (matches.length > 0) {
      await chrome.scripting.registerContentScripts([
        {
          id: DARKMODE_PRELOAD_ID,
          matches,
          css: ['darkmode-preload.css'],
          runAt: 'document_start',
          allFrames: true,
          persistAcrossSessions: true
        }
      ]);
    }
  } catch (err) {
    console.warn('[darkmode] preload script sync failed:', err);
  }
}

// ---- Cross-device settings sync ----
// Mirrors the user's actual input (jobs, link groups, specific URLs, prefs,
// toggles) from chrome.storage.local into chrome.storage.sync, so signing
// into the same Google/Chrome account on another device (even a fresh
// unpacked/dev-mode install) restores everything automatically. Excluded:
// per-device runtime state (syncDeviceId, syncStatus, jobErrors, activeTabId,
// autoReloadTabs), which is meaningless off the device that produced it.
//
// chrome.storage.sync caps each item at 8KB, so values are split into
// chunks under `${key}__c0`, `${key}__c1`, ... with a `${key}__meta` item
// holding {v: version, n: chunkCount}. `version` is a local write timestamp
// used for last-write-wins, and to tell a value we just pulled down from a
// value the user just typed (otherwise pull and push would loop forever).
const SYNC_MIRROR_KEYS = [
  'jobs',
  'specificUrls',
  'linkGroups',
  'formPrefs',
  'bypassCache',
  'clickBehavior',
  'syncEnabled',
  'syncDomains',
  'syncToken',
  'syncTimeout',
  'darkModeConfig',
];
const SYNC_VERSIONS_KEY = '__syncVersions'; // local-only: { [key]: lastSyncedVersion }
const SYNC_CHUNK_BYTES = 6000;
const syncApplying = new Set(); // keys currently being written to local as part of a pull

function chunkString(str, size) {
  const chunks = [];
  for (let i = 0; i < str.length; i += size) chunks.push(str.slice(i, i + size));
  return chunks.length ? chunks : [''];
}

async function pushKeyToSync(key, version) {
  try {
    const { [key]: value } = await chrome.storage.local.get(key);
    const json = JSON.stringify(value === undefined ? null : value);
    const chunks = chunkString(json, SYNC_CHUNK_BYTES);
    const oldMeta = (await chrome.storage.sync.get(`${key}__meta`))[`${key}__meta`];
    const payload = { [`${key}__meta`]: { v: version, n: chunks.length } };
    chunks.forEach((c, i) => { payload[`${key}__c${i}`] = c; });
    await chrome.storage.sync.set(payload);
    if (oldMeta && oldMeta.n > chunks.length) {
      const stale = [];
      for (let i = chunks.length; i < oldMeta.n; i++) stale.push(`${key}__c${i}`);
      await chrome.storage.sync.remove(stale);
    }
  } catch (e) {
    console.warn('[sync] push failed for', key, e);
  }
}

async function pullKeyFromSync(key) {
  const { [`${key}__meta`]: meta } = await chrome.storage.sync.get(`${key}__meta`);
  if (!meta) return null;
  const chunkKeys = Array.from({ length: meta.n }, (_, i) => `${key}__c${i}`);
  const chunkRes = chunkKeys.length ? await chrome.storage.sync.get(chunkKeys) : {};
  const json = chunkKeys.map((k) => chunkRes[k] || '').join('');
  try {
    return { v: meta.v, value: JSON.parse(json) };
  } catch {
    return null;
  }
}

async function getSyncVersions() {
  const { [SYNC_VERSIONS_KEY]: v } = await chrome.storage.local.get(SYNC_VERSIONS_KEY);
  return v || {};
}

async function handleLocalMirrorChange(key) {
  if (syncApplying.has(key)) return; // our own pull-triggered write, don't echo back
  const version = Date.now();
  const versions = await getSyncVersions();
  versions[key] = version;
  await chrome.storage.local.set({ [SYNC_VERSIONS_KEY]: versions });
  await pushKeyToSync(key, version);
}

async function reconcileKeyFromSync(key) {
  const remote = await pullKeyFromSync(key);
  if (!remote) return;
  const versions = await getSyncVersions();
  if ((versions[key] || 0) >= remote.v) return; // local already current or newer
  syncApplying.add(key);
  try {
    await chrome.storage.local.set({ [key]: remote.value });
    versions[key] = remote.v;
    await chrome.storage.local.set({ [SYNC_VERSIONS_KEY]: versions });
  } finally {
    syncApplying.delete(key);
  }
}

async function reconcileAllFromSync() {
  for (const key of SYNC_MIRROR_KEYS) {
    await reconcileKeyFromSync(key);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    for (const key of SYNC_MIRROR_KEYS) {
      if (key in changes) handleLocalMirrorChange(key);
    }
    if ('darkModeConfig' in changes) {
      syncDarkModePreloadScript();
    }
  } else if (area === 'sync') {
    for (const key of SYNC_MIRROR_KEYS) {
      if (`${key}__meta` in changes) reconcileKeyFromSync(key);
    }
  }
});

chrome.runtime.onStartup.addListener(() => {
  reconcileAllFromSync();
  syncDarkModePreloadScript();
});
chrome.runtime.onInstalled.addListener(() => {
  reconcileAllFromSync();
  syncDarkModePreloadScript();
});
reconcileAllFromSync();
syncDarkModePreloadScript();

// Automatically notify darkmode.js on EVERY SPA URL change or completed page load
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!tab || !tab.url || !/^https?:\/\//i.test(tab.url)) return;
  if (changeInfo.url || changeInfo.status === 'complete') {
    chrome.tabs.sendMessage(tabId, {
      type: 'darkmode-page-navigated',
      url: changeInfo.url || tab.url,
      status: changeInfo.status || ''
    }).catch(() => {});
  }
});
