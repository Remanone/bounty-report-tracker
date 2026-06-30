// Service worker: periodic check + diff + notifications.
// The GraphQL fetch runs INSIDE a hackerone.com tab (same origin) via
// chrome.scripting.executeScript, because HackerOne returns 403 for /graphql
// requests originating from the extension origin.
import { relLabel, substateLabel } from "./h1.js";

const ALARM = "h1-check";
const DEFAULT_PERIOD_MIN = 60;

chrome.runtime.onInstalled.addListener(async () => {
  const { periodMin } = await chrome.storage.local.get("periodMin");
  chrome.alarms.create(ALARM, { periodInMinutes: periodMin || DEFAULT_PERIOD_MIN });
  check();
});

chrome.runtime.onStartup.addListener(() => check());

chrome.alarms.onAlarm.addListener(a => {
  if (a.name === ALARM) check();
});

// Lets the popup trigger a check and get the result.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "checkNow") {
    check().then(r => sendResponse({ ok: true, ...r }))
           .catch(e => sendResponse({ ok: false, error: String(e.message || e) }));
    return true; // async response
  }
});

// ---- This function is serialized and executed in the hackerone.com page. ----
// It must be fully self-contained (no references to outer scope).
async function pageFetchReports() {
  const meta = document.querySelector('meta[name="csrf-token"]');
  if (!meta || !meta.content) {
    return { error: "Not logged in to HackerOne (no CSRF meta on page)." };
  }
  const csrf = meta.content;

  async function gql(query, variables) {
    const res = await fetch("/graphql", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ query, variables })
    });
    if (!res.ok) return { __http: res.status };
    const j = await res.json();
    if (j.errors && j.errors.length) return { __gql: j.errors.map(e => e.message).join("; ") };
    return j.data;
  }

  const me = await gql("query { me { _id username } }", {});
  if (me.__http) return { error: "HTTP " + me.__http + " on /graphql" };
  if (me.__gql) return { error: me.__gql };
  if (!me || !me.me) return { error: "Invalid session (me == null). Sign in to HackerOne." };

  // latest_activity_at is always null on H1's API; latest_public_activity_at holds the
  // real "last public activity" value. Aliased so the rest of the code is untouched.
  const q = "query Tracker($rid: Int!) {" +
    " reports(first: 100, where: { reporter: { id: { _eq: $rid } } }) {" +
    " edges { node { _id title substate url submitted_at" +
    " latest_activity_at: latest_public_activity_at" +
    " report_pending_party_last_activity team { handle name } } } } }";
  const rid = parseInt(me.me._id, 10);
  const data = await gql(q, { rid });
  if (data.__http) return { error: "HTTP " + data.__http + " on /graphql" };
  if (data.__gql) return { error: data.__gql };

  const reports = (data.reports.edges || []).map(e => e.node);
  // Sort newest submission first (client-side; avoids schema-specific order_by).
  reports.sort((a, b) => String(b.submitted_at || "").localeCompare(String(a.submitted_at || "")));
  return { me: me.me, reports };
}

function waitForComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      fn(arg);
    };
    const timer = setTimeout(() => finish(reject, new Error("tab load timeout")), timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") finish(resolve);
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(t => { if (t.status === "complete") finish(resolve); }).catch(() => {});
  });
}

// Run pageFetchReports inside a hackerone.com tab (reuse one if open, else open a hidden one).
async function runInH1Tab() {
  const tabs = await chrome.tabs.query({ url: "https://hackerone.com/*" });
  let tab = tabs.find(t => t.status === "complete") || tabs[0];
  let created = false;

  if (!tab) {
    tab = await chrome.tabs.create({ url: "https://hackerone.com/bugs", active: false });
    created = true;
  }
  try {
    if (tab.status !== "complete") await waitForComplete(tab.id);
    const [inj] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageFetchReports });
    const result = inj && inj.result;
    if (!result) throw new Error("No result from page (injection blocked?).");
    if (result.error) throw new Error(result.error);
    return result;
  } finally {
    if (created) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

function snapshotOf(reports) {
  const snap = {};
  for (const r of reports) {
    snap[r._id] = {
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
    const before = prev[r._id];
    if (!before) {
      changes.push({ id: r._id, title: r.title, kind: "new", detail: substateLabel(r.substate) });
      continue;
    }
    if (before.substate !== r.substate) {
      changes.push({
        id: r._id, title: r.title, kind: "substate",
        detail: substateLabel(before.substate) + " -> " + substateLabel(r.substate)
      });
    } else if ((before.pend || null) !== (r.report_pending_party_last_activity || null)) {
      changes.push({
        id: r._id, title: r.title, kind: "internal",
        detail: "internal activity updated (" + relLabel(r.report_pending_party_last_activity) + ")"
      });
    } else if ((before.latest || null) !== (r.latest_activity_at || null)) {
      changes.push({
        id: r._id, title: r.title, kind: "activity",
        detail: "new activity (" + relLabel(r.latest_activity_at) + ")"
      });
    }
  }
  return changes;
}

export async function check() {
  try {
    const { me, reports } = await runInH1Tab();
    const snap = snapshotOf(reports);

    const stored = await chrome.storage.local.get(["lastSnapshot", "initialized"]);
    const prev = stored.lastSnapshot || {};
    const changes = stored.initialized ? diff(prev, reports) : [];

    await chrome.storage.local.set({
      lastSnapshot: snap,
      reports,
      me,
      lastCheck: Date.now(),
      lastError: null,
      initialized: true
    });

    chrome.action.setBadgeBackgroundColor({ color: "#d9534f" });
    chrome.action.setBadgeText({ text: changes.length ? String(changes.length) : "" });

    if (changes.length) notify(changes);

    return { reports, changes, me };
  } catch (e) {
    await chrome.storage.local.set({ lastError: String(e.message || e), lastCheck: Date.now() });
    throw e;
  }
}

function notify(changes) {
  const title = changes.length === 1
    ? "1 change on your H1 reports"
    : changes.length + " changes on your H1 reports";
  const lines = changes.slice(0, 5).map(c => `#${c.id} — ${c.detail}`);
  if (changes.length > 5) lines.push("…and " + (changes.length - 5) + " more");
  chrome.notifications.create("h1-" + Date.now(), {
    type: "basic",
    iconUrl: "icon128.png",
    title,
    message: lines.join("\n"),
    priority: 2
  });
}

// Open the report when the notification is clicked.
chrome.notifications.onClicked.addListener(async () => {
  const { reports } = await chrome.storage.local.get("reports");
  const url = reports && reports[0] ? reports[0].url : "https://hackerone.com/bugs";
  chrome.tabs.create({ url });
});
