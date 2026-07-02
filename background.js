// Each provider's fetch runs inside a tab on that platform's own origin via
// chrome.scripting.executeScript, because the sites reject API calls coming
// from the extension origin.
import { relLabel, substateLabel, platformBadge } from "./h1.js";
import { providersFor, DEFAULT_PLATFORMS } from "./providers.js";

const ALARM = "bounty-check";
const DEFAULT_PERIOD_MIN = 60;

console.log("Bounty Report Tracker service worker loaded: v1.4.3");

// Swallow the rejection so a platform that is simply not logged in does not
// surface as an uncaught error in the extensions panel; the real reason is
// stored in lastError and shown in the popup.
function backgroundCheck() {
  check().catch(e => console.debug("Background check failed:", String(e && e.message || e)));
}

chrome.runtime.onInstalled.addListener(async () => {
  const { periodMin } = await chrome.storage.local.get("periodMin");
  chrome.alarms.create(ALARM, { periodInMinutes: periodMin || DEFAULT_PERIOD_MIN });
  backgroundCheck();
});

chrome.runtime.onStartup.addListener(() => backgroundCheck());

chrome.alarms.onAlarm.addListener(a => {
  if (a.name === ALARM) backgroundCheck();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "checkNow") {
    check().then(r => sendResponse({ ok: true, ...r }))
           .catch(e => sendResponse({ ok: false, error: String(e.message || e) }));
    return true; // async response
  }
  if (msg && msg.type === "setPeriod") {
    const m = Math.max(1, parseInt(msg.periodMin, 10) || DEFAULT_PERIOD_MIN);
    chrome.storage.local.set({ periodMin: m });
    chrome.alarms.create(ALARM, { periodInMinutes: m });
    sendResponse({ ok: true });
    return; // sync response
  }
  if (msg && msg.type === "testDiscord") {
    (async () => {
      const { discordEveryone } = await chrome.storage.local.get("discordEveryone");
      await postDiscord(msg.webhook, Object.assign({
        username: "Bounty Report Tracker",
        embeds: [{
          title: "Test message",
          color: 0x50c878,
          description: "Your Discord webhook works. Report changes will appear here.",
          footer: { text: "Bounty Report Tracker" },
          timestamp: new Date().toISOString()
        }]
      }, mentionPart(discordEveryone !== false)));
    })()
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: String(e.message || e) }));
    return true; // async response
  }
});

// Resolves true when the tab loads, false on timeout. NEVER rejects, so no
// "tab load timeout" rejection can escape as an uncaught promise error.
function waitForComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(val);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") finish(true);
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(t => { if (t && t.status === "complete") finish(true); }).catch(() => {});
  });
}

async function runInProviderTab(provider) {
  const tabs = await chrome.tabs.query({ url: provider.tabMatch });
  // Only reuse a fully loaded tab. Waiting on one stuck in "loading" (a
  // long-polling SPA) is what caused "tab load timeout"; instead we open our
  // own controlled tab when none is ready.
  let tab = tabs.find(t => t.status === "complete");
  let created = false;

  if (!tab) {
    tab = await chrome.tabs.create({ url: provider.tabUrl, active: false });
    created = true;
    // Best-effort wait; we inject regardless, as executeScript gives a clearer
    // error if the page really is not ready.
    await waitForComplete(tab.id, 20000);
  }
  try {
    // If the tab redirected off the platform origin (e.g. Bugcrowd bounces to its
    // OAuth login host when the session is gone), we cannot and should not inject
    // there. Report a clean "sign in" message instead of the raw host error.
    const cur = await chrome.tabs.get(tab.id).catch(() => null);
    if (cur && cur.url && !cur.url.startsWith(provider.origin)) {
      throw new Error("Not signed in to " + provider.name + ". Open " + provider.name + " in a tab, sign in, then refresh.");
    }
    let inj;
    try {
      [inj] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: provider.pageFetch });
    } catch (e) {
      const m = String(e && e.message || e);
      if (/Cannot access contents of|Cannot access a chrome|must request permission/i.test(m)) {
        throw new Error("Not signed in to " + provider.name + ". Open " + provider.name + " in a tab, sign in, then refresh.");
      }
      throw e;
    }
    const result = inj && inj.result;
    if (!result) throw new Error("No result from " + provider.name + " page (injection blocked?).");
    if (result.error) throw new Error(result.error);
    return result;
  } finally {
    if (created) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

function keyOf(r) { return r.platform + ":" + r._id; }

function snapshotOf(reports) {
  const snap = {};
  for (const r of reports) {
    snap[keyOf(r)] = {
      substate: r.substate,
      pend: r.report_pending_party_last_activity || null,
      latest: r.latest_activity_at || null
    };
  }
  return snap;
}

function diff(prev, reports) {
  const changes = [];
  for (const r of reports) {
    const k = keyOf(r);
    const before = prev[k];
    const base = { key: k, platform: r.platform, id: r._id, title: r.title, url: r.url };
    if (!before) {
      changes.push({ ...base, kind: "new", detail: substateLabel(r.substate) });
      continue;
    }
    if (before.substate !== r.substate) {
      changes.push({
        ...base, kind: "substate",
        detail: substateLabel(before.substate) + " -> " + substateLabel(r.substate)
      });
    } else if ((before.pend || null) !== (r.report_pending_party_last_activity || null)) {
      changes.push({
        ...base, kind: "internal",
        detail: "internal activity updated (" + relLabel(r.report_pending_party_last_activity) + ")"
      });
    } else if ((before.latest || null) !== (r.latest_activity_at || null)) {
      changes.push({
        ...base, kind: "activity",
        detail: "new activity (" + relLabel(r.latest_activity_at) + ")"
      });
    }
  }
  return changes;
}

export async function check() {
  try {
    const { enabledPlatforms } = await chrome.storage.local.get("enabledPlatforms");
    const providers = providersFor(enabledPlatforms || DEFAULT_PLATFORMS);

    let reports = [];
    const me = {};
    const errors = [];
    for (const p of providers) {
      try {
        const res = await runInProviderTab(p);
        if (res.me) me[p.id] = res.me;
        reports = reports.concat(res.reports || []);
      } catch (e) {
        errors.push(p.name + ": " + String(e.message || e));
      }
    }

    // If every enabled provider failed, surface the error.
    if (!reports.length && errors.length) {
      throw new Error(errors.join(" | "));
    }

    const snap = snapshotOf(reports);
    const stored = await chrome.storage.local.get(["lastSnapshot", "initialized"]);
    const prev = stored.lastSnapshot || {};
    const changes = stored.initialized ? diff(prev, reports) : [];

    await chrome.storage.local.set({
      lastSnapshot: snap,
      reports,
      me,
      lastCheck: Date.now(),
      lastError: errors.length ? errors.join(" | ") : null,
      initialized: true
    });

    chrome.action.setBadgeBackgroundColor({ color: "#d9534f" });
    chrome.action.setBadgeText({ text: changes.length ? String(changes.length) : "" });

    if (changes.length) {
      notify(changes);
      sendDiscordForChanges(changes);
    }

    return { reports, changes, me, errors };
  } catch (e) {
    await chrome.storage.local.set({ lastError: String(e.message || e), lastCheck: Date.now() });
    throw e;
  }
}

function notify(changes) {
  const title = changes.length === 1
    ? "1 change on your reports"
    : changes.length + " changes on your reports";
  const lines = changes.slice(0, 5).map(c => `[${platformBadge(c.platform)}] #${c.id} — ${c.detail}`);
  if (changes.length > 5) lines.push("…and " + (changes.length - 5) + " more");
  chrome.notifications.create("h1-" + Date.now(), {
    type: "basic",
    iconUrl: "assets/icon128.png",
    title,
    message: lines.join("\n"),
    priority: 2
  });
}

function mentionPart(everyone) {
  return everyone
    ? { content: "@everyone", allowed_mentions: { parse: ["everyone"] } }
    : { allowed_mentions: { parse: [] } };
}

async function postDiscord(webhook, payload) {
  if (!webhook || !/^https:\/\/discord\.com\/api\/webhooks\//.test(webhook)) {
    throw new Error("Invalid Discord webhook URL.");
  }
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error("Discord HTTP " + res.status);
}

const DISCORD_GREEN = 0x50c878;
const DISCORD_ORANGE = 0xe08a00;

function shortId(c) {
  return c.platform === "bugcrowd" ? String(c.id).slice(0, 8) : String(c.id);
}

function buildChangesEmbed(changes) {
  const blocks = changes.slice(0, 10).map(c => {
    const t = (c.title || "").length > 100 ? c.title.slice(0, 97) + "..." : (c.title || "open");
    const head = "**[" + platformBadge(c.platform) + "] #" + shortId(c) + "** — " + c.detail;
    const body = c.url ? "[" + t + "](" + c.url + ")" : t;
    return head + "\n" + body;
  });
  if (changes.length > 10) blocks.push("...and " + (changes.length - 10) + " more");

  const allBc = changes.every(c => c.platform === "bugcrowd");
  const title = changes.length === 1
    ? "1 change on your bounty reports"
    : changes.length + " changes on your bounty reports";

  return {
    title,
    color: allBc ? DISCORD_ORANGE : DISCORD_GREEN,
    description: blocks.join("\n\n"),
    footer: { text: "Bounty Report Tracker" },
    timestamp: new Date().toISOString()
  };
}

async function sendDiscordForChanges(changes) {
  try {
    const { discordWebhook, discordEveryone } = await chrome.storage.local.get(["discordWebhook", "discordEveryone"]);
    if (!discordWebhook) return;
    await postDiscord(discordWebhook, Object.assign({
      username: "Bounty Report Tracker",
      embeds: [buildChangesEmbed(changes)]
    }, mentionPart(discordEveryone !== false)));
  } catch (e) {
    // Non-fatal: a broken webhook should never break the check itself.
    console.warn("Discord webhook failed:", String(e.message || e));
  }
}

chrome.notifications.onClicked.addListener(async () => {
  const { reports } = await chrome.storage.local.get("reports");
  const url = reports && reports[0] ? reports[0].url : "https://hackerone.com/bugs";
  chrome.tabs.create({ url });
});
