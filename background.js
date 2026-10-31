// Page Sentinel — service worker.
// Each watched site has an alarm. When it fires, the page is loaded inside a
// hidden extension page (no tab is opened), its text is read and compared with
// the previous check. If it changed: sound + notification + badge.
// If the hidden page can't read the site, a background tab is used instead.

const ALARM_PREFIX = 'site:';
const RETRY_PREFIX = 'retry:';
const TEXT_VERSION = 2;              // bump when the way text is read changes
const FRAME_TIMEOUT_MS = 40000;      // max time for a tab-less read
const PAGE_LOAD_TIMEOUT_MS = 45000;  // fallback: max time for the tab to load
const TEXT_MAX_WAIT_MS = 30000;
const TEXT_QUIET_MS = 3000;
const MAX_DIFF_LINES = 30;
const MAX_RETRIES = 3;               // extra attempts after an error, 1 min apart
const OFFSCREEN_IDLE_MS = 20000;     // close the hidden page after this idle time
const CONFIRM_DELAY_MS = 15000;      // wait before re-reading a page that seems changed
const LOG_MAX = 50;                  // check history kept per site
const LOG_TEXTS_MAX = 10;            // of those, how many keep the full page text
const LOADING_LINE = /^(loading|carregando|cargando|aguarde|please wait)\b.{0,30}$/i;

// ---------- storage ----------

async function getSites() {
  const { sites = {} } = await chrome.storage.local.get('sites');
  return sites;
}

// Serialize writes so two updates never overwrite each other.
let storageLock = Promise.resolve();
function updateSites(mutator) {
  const run = async () => {
    const sites = await getSites();
    const result = await mutator(sites);
    await chrome.storage.local.set({ sites });
    return result;
  };
  const p = storageLock.then(run, run);
  storageLock = p.catch(() => {});
  return p;
}

function updateSite(id, mutator) {
  return updateSites((sites) => {
    if (!sites[id]) return undefined;
    return mutator(sites[id]);
  });
}

// ---------- frame blocking ----------
// Some sites forbid being loaded inside another page. This rule removes that
// restriction only for frames outside tabs (Page Sentinel's hidden page), so
// normal browsing is not affected.

chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: [1],
  addRules: [{
    id: 1,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        { header: 'x-frame-options', operation: 'remove' },
        { header: 'content-security-policy', operation: 'remove' },
      ],
    },
    condition: {
      resourceTypes: ['sub_frame'],
      tabIds: [chrome.tabs.TAB_ID_NONE],
    },
  }],
}).catch((e) => console.error('Could not create frame rule', e));

// ---------- alarms ----------

function alarmName(id) {
  return ALARM_PREFIX + id;
}

async function scheduleAlarm(site) {
  await chrome.alarms.clear(alarmName(site.id));
  if (site.active) {
    await chrome.alarms.create(alarmName(site.id), {
      delayInMinutes: site.intervalMin,
      periodInMinutes: site.intervalMin,
    });
  }
}

function isOverdue(site, now = Date.now()) {
  return site.active && (!site.lastCheck || now - site.lastCheck >= site.intervalMin * 60000 - 5000);
}

// Check right away every site whose last check is overdue.
async function checkOverdue() {
  const sites = await getSites();
  for (const s of Object.values(sites)) {
    if (isOverdue(s)) enqueueCheck(s.id);
  }
}

// Make the alarms match what is stored (after install/restart).
async function syncAlarms() {
  const sites = await updateSites((all) => {
    for (const s of Object.values(all)) {
      if (s.status === 'checking') s.status = 'idle';
    }
    return all;
  });
  const existing = await chrome.alarms.getAll();
  for (const a of existing) {
    if (!a.name.startsWith(ALARM_PREFIX)) continue;
    const id = a.name.slice(ALARM_PREFIX.length);
    if (!sites[id] || !sites[id].active) await chrome.alarms.clear(a.name);
  }
  for (const s of Object.values(sites)) {
    if (!s.active) continue;
    const a = existing.find((x) => x.name === alarmName(s.id));
    if (!a || a.periodInMinutes !== s.intervalMin) await scheduleAlarm(s);
  }
  await updateBadge();
}

chrome.runtime.onInstalled.addListener(async () => {
  await syncAlarms();
  await checkOverdue();
});

chrome.runtime.onStartup.addListener(async () => {
  await syncAlarms();
  await checkOverdue();
});

// When the computer is unlocked or wakes up, the state goes back to "active".
chrome.idle.onStateChanged.addListener((state) => {
  if (state === 'active') checkOverdue();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name.startsWith(RETRY_PREFIX)) {
    enqueueCheck(alarm.name.slice(RETRY_PREFIX.length));
    return;
  }
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  const id = alarm.name.slice(ALARM_PREFIX.length);
  const site = (await getSites())[id];
  // Skip if there was a recent check (for example, the one done on wake-up).
  if (site && site.lastCheck && Date.now() - site.lastCheck < site.intervalMin * 60000 * 0.5) return;
  enqueueCheck(id);
});

// ---------- checking ----------

// One check at a time.
let checkChain = Promise.resolve();
const queued = new Set();

function enqueueCheck(id) {
  if (queued.has(id)) return checkChain;
  queued.add(id);
  checkChain = checkChain
    .then(() => runCheck(id))
    .catch((e) => console.error('Check failed', e))
    .finally(() => queued.delete(id));
  return checkChain;
}

async function runCheck(id) {
  const site = (await getSites())[id];
  if (!site) return;

  await updateSite(id, (s) => { s.status = 'checking'; });

  const hasBaseline = site.lastText != null && site.textVersion === TEXT_VERSION;
  const log = { at: Date.now(), reads: [] };
  const read = async () => {
    const started = Date.now();
    try {
      const result = await readPage(site.url);
      log.reads.push({ ...describeRead(result.text), method: result.method, loading: result.loading, ms: Date.now() - started, text: result.text });
      return result;
    } catch (e) {
      log.reads.push({ ms: Date.now() - started, error: String((e && e.message) || e) });
      throw e;
    }
  };

  let text;
  let method;
  try {
    let result = await read();
    if (hasBaseline && result.text !== site.lastText) {
      // Looks like a change. Read again before alerting, so a page that
      // loaded halfway (slow or failing server) doesn't cause a false alarm.
      await new Promise((resolve) => setTimeout(resolve, CONFIRM_DELAY_MS));
      result = await read();
    }
    // Still showing "Loading..." after waiting: treat it as an error, unless
    // the page always shows that message (it is in the saved version too, or
    // it kept showing it through every retry).
    const alwaysLoading = (hasBaseline && isLoadingText(site.lastText)) || (site.errorStreak || 0) >= MAX_RETRIES;
    if (result.loading && result.text !== site.lastText && !alwaysLoading) {
      throw new Error('The page was still loading.');
    }
    ({ text, method } = result);
  } catch (e) {
    const error = String((e && e.message) || e);
    const retry = await updateSite(id, (s) => {
      s.status = 'error';
      s.lastError = error;
      s.lastCheck = Date.now();
      s.errorStreak = (s.errorStreak || 0) + 1;
      return s.active && s.intervalMin > 1 && s.errorStreak <= MAX_RETRIES;
    });
    if (retry) chrome.alarms.create(RETRY_PREFIX + id, { delayInMinutes: 1 });
    await saveLog(id, { ...log, outcome: 'error', error }, site.lastText);
    return;
  }

  let outcome;
  const changed = await updateSite(id, (s) => {
    s.lastCheck = Date.now();
    s.lastError = null;
    s.errorStreak = 0;
    s.status = 'idle';
    s.method = method;
    if (s.lastText == null || s.textVersion !== TEXT_VERSION) {
      // First read (or a read in a new format): becomes the baseline.
      s.lastText = text;
      s.textVersion = TEXT_VERSION;
      outcome = 'baseline';
      return false;
    }
    if (s.lastText === text) {
      outcome = log.reads.length > 1 ? 'change not confirmed' : 'no change';
      return false;
    }
    const { added, removed } = diffLines(s.lastText, text);
    s.lastText = text;
    s.unseen = true;
    s.lastChange = { at: Date.now(), added, removed };
    outcome = 'change';
    return true;
  });
  if (outcome) await saveLog(id, { ...log, outcome }, site.lastText);

  if (changed) {
    const updated = (await getSites())[id];
    if (updated) await alertChange(updated);
  }
}

function isLoadingText(text) {
  return String(text || '').split('\n').some((line) => LOADING_LINE.test(line));
}

function describeRead(text) {
  return { lines: text.split('\n').length, chars: text.length, hash: hashText(text) };
}

// Short fingerprint, so log entries can be compared at a glance.
function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---------- check history (log) ----------
// Kept under its own key ("log:<id>") so the popup doesn't load it every time.
// The full page text is only kept when it differs from the saved version,
// and only for the most recent entries.

async function saveLog(id, entry, baseline) {
  for (const r of entry.reads) {
    if (r.text === baseline) delete r.text;
  }
  const key = 'log:' + id;
  const { [key]: log = [] } = await chrome.storage.local.get(key);
  log.push(entry);
  log.splice(0, Math.max(0, log.length - LOG_MAX));
  let withText = 0;
  for (let i = log.length - 1; i >= 0; i--) {
    for (const r of log[i].reads || []) {
      if (r.text != null && ++withText > LOG_TEXTS_MAX) delete r.text;
    }
  }
  await chrome.storage.local.set({ [key]: log });
}

// Line-by-line comparison: what appeared and what disappeared.
function diffLines(oldText, newText) {
  const oldSet = new Set(oldText.split('\n'));
  const newSet = new Set(newText.split('\n'));
  return {
    added: [...newSet].filter((l) => l && !oldSet.has(l)).slice(0, MAX_DIFF_LINES),
    removed: [...oldSet].filter((l) => l && !newSet.has(l)).slice(0, MAX_DIFF_LINES),
  };
}

// Try without a tab; if that fails, use a background tab.
// Returns { text, loading, method }.
async function readPage(url) {
  try {
    const { text, loading } = await readViaFrame(url);
    if (!text) throw new Error('The page loaded without any text.');
    return { text, loading, method: 'frame' };
  } catch (frameError) {
    // Site down or no internet: opening a tab won't help.
    try {
      await fetch(url, { cache: 'no-store' });
    } catch {
      throw new Error('Could not reach the site (offline or wrong address).');
    }
    console.warn('Tab-less read failed, using a tab:', frameError);
    const { text, loading } = await readViaTab(url);
    return { text, loading, method: 'tab' };
  }
}

async function readViaFrame(url) {
  await ensureOffscreen();
  try {
    const res = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'scrape',
      url,
      timeoutMs: FRAME_TIMEOUT_MS,
    });
    if (!res || !res.ok) throw new Error((res && res.error) || 'No response from the hidden page.');
    return { text: res.text, loading: !!res.loading };
  } finally {
    scheduleOffscreenClose();
  }
}

// Fallback: open the page in a background tab and read its text.
async function readViaTab(url) {
  let tabId = null;
  let windowId = null;
  try {
    try {
      const tab = await chrome.tabs.create({ url, active: false });
      tabId = tab.id;
    } catch {
      // No window open: create a minimized one just for the check.
      const win = await chrome.windows.create({ url, focused: false, state: 'minimized' });
      windowId = win.id;
      tabId = win.tabs[0].id;
    }
    chrome.tabs.update(tabId, { muted: true, autoDiscardable: false }).catch(() => {});

    await waitForTabComplete(tabId, PAGE_LOAD_TIMEOUT_MS);

    await chrome.scripting.executeScript({ target: { tabId }, files: ['frame-reader.js'] });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (maxWait, quiet) => globalThis.__pageSentinelExtract(maxWait, quiet),
      args: [TEXT_MAX_WAIT_MS, TEXT_QUIET_MS],
    });
    const result = injection && injection.result;
    if (!result || !result.text) throw new Error('The page loaded without any text.');
    return result;
  } finally {
    if (windowId != null) chrome.windows.remove(windowId).catch(() => {});
    else if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('The page took too long to load.'));
    }, timeoutMs);
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        cleanup();
        resolve();
      }
    };
    const removedListener = (id) => {
      if (id === tabId) {
        cleanup();
        reject(new Error('The check tab was closed.'));
      }
    };
    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved.removeListener(removedListener);
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(removedListener);
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === 'complete') { cleanup(); resolve(); }
    }).catch(() => {});
  });
}

// ---------- hidden page (reading and sound) ----------
// It only exists while it's needed and is closed after a short idle time,
// so it doesn't keep memory between checks.

let creatingOffscreen = null;
let offscreenCloseTimer = null;

async function ensureOffscreen() {
  clearTimeout(offscreenCloseTimer);
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_SCRAPING', 'AUDIO_PLAYBACK'],
      justification: 'Read watched sites without opening tabs and play the alert sound.',
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

function scheduleOffscreenClose() {
  clearTimeout(offscreenCloseTimer);
  offscreenCloseTimer = setTimeout(async () => {
    if (queued.size || creatingOffscreen) return; // still busy; rescheduled later
    try {
      await chrome.offscreen.closeDocument();
    } catch {
      // already closed
    }
  }, OFFSCREEN_IDLE_MS);
}

async function playSound() {
  await ensureOffscreen();
  try {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'play' });
  } finally {
    scheduleOffscreenClose();
  }
}

// ---------- alerts ----------

async function alertChange(site) {
  playSound().catch((e) => console.error('Could not play sound', e));
  const firstAdded = site.lastChange && site.lastChange.added[0];
  chrome.notifications.create(alarmName(site.id), {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Change detected!',
    message: site.url,
    contextMessage: firstAdded ? 'New: ' + firstAdded.slice(0, 120) : '',
    priority: 2,
    requireInteraction: true,
  });
  await updateBadge();
}

chrome.notifications.onClicked.addListener(async (notifId) => {
  if (!notifId.startsWith(ALARM_PREFIX)) return;
  const id = notifId.slice(ALARM_PREFIX.length);
  const site = (await getSites())[id];
  chrome.notifications.clear(notifId);
  if (site) {
    chrome.tabs.create({ url: site.url, active: true });
    await acknowledge(id);
  }
});

async function acknowledge(id) {
  await updateSite(id, (s) => { s.unseen = false; });
  chrome.notifications.clear(alarmName(id));
  await updateBadge();
}

async function updateBadge() {
  const sites = await getSites();
  const count = Object.values(sites).filter((s) => s.unseen).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#ff5a00' });
  await chrome.action.setBadgeTextColor({ color: '#000000' }).catch(() => {});
  await chrome.action.setBadgeText({ text: count ? String(count) : '' });
}

// ---------- popup messages ----------

function normalizeUrl(raw) {
  let value = String(raw || '').trim();
  if (!value) throw new Error('Enter the site address.');
  if (!/^https?:\/\//i.test(value)) value = 'https://' + value;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an http or https address.');
  return url.href;
}

function normalizeInterval(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) throw new Error('The minimum interval is 1 minute.');
  return Math.round(n);
}

const handlers = {
  async add({ url, intervalMin }) {
    const site = {
      id: crypto.randomUUID(),
      url: normalizeUrl(url),
      intervalMin: normalizeInterval(intervalMin),
      active: true,
      createdAt: Date.now(),
      status: 'idle',
      lastText: null,
      textVersion: TEXT_VERSION,
      lastCheck: null,
      lastError: null,
      lastChange: null,
      unseen: false,
      errorStreak: 0,
    };
    await updateSites((all) => { all[site.id] = site; });
    await scheduleAlarm(site);
    enqueueCheck(site.id); // the first read becomes the baseline
  },

  async remove({ id }) {
    await updateSites((all) => { delete all[id]; });
    await chrome.storage.local.remove('log:' + id);
    await chrome.alarms.clear(alarmName(id));
    await chrome.alarms.clear(RETRY_PREFIX + id);
    chrome.notifications.clear(alarmName(id));
    await updateBadge();
  },

  async toggle({ id }) {
    const site = await updateSite(id, (s) => { s.active = !s.active; return { ...s }; });
    if (!site) return;
    await scheduleAlarm(site);
    if (site.active) enqueueCheck(id);
    else await chrome.alarms.clear(RETRY_PREFIX + id);
  },

  async setInterval({ id, intervalMin }) {
    const value = normalizeInterval(intervalMin);
    const site = await updateSite(id, (s) => { s.intervalMin = value; return { ...s }; });
    if (site) await scheduleAlarm(site);
  },

  async checkNow({ id }) {
    enqueueCheck(id);
  },

  async ack({ id }) {
    await acknowledge(id);
  },

  async resetBaseline({ id }) {
    await updateSite(id, (s) => { s.lastText = null; s.lastChange = null; s.unseen = false; });
    await updateBadge();
    enqueueCheck(id);
  },

  async testSound() {
    await playSound();
  },

  // Everything needed to understand a site's recent checks, for download.
  async getLog({ id }) {
    const site = (await getSites())[id];
    if (!site) throw new Error('Site not found.');
    const key = 'log:' + id;
    const { [key]: log = [] } = await chrome.storage.local.get(key);
    const { lastText, ...info } = site;
    return {
      extension: chrome.runtime.getManifest().version,
      exportedAt: new Date().toISOString(),
      site: { ...info, savedVersion: lastText != null ? { ...describeRead(lastText), text: lastText } : null },
      checks: log.map((e) => ({ ...e, at: new Date(e.at).toISOString() })),
    };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'background') return false;
  const handler = handlers[msg.type];
  if (!handler) return false;
  handler(msg)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true; // async response
});
