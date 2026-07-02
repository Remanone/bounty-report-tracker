import { relLabel, substateLabel, platformBadge, platformName } from "./h1.js";
import { PROVIDERS, DEFAULT_PLATFORMS } from "./providers.js";

const $ = sel => document.querySelector(sel);
const userEl = $("#user");
const statusEl = $("#status");
const listEl = $("#list");
const metaEl = $("#meta");
const refreshBtn = $("#refresh");
const settingsBtn = $("#settings");
const settingsPanel = $("#settings-panel");
const webhookInput = $("#discord-webhook");
const webhookTestBtn = $("#discord-test");
const webhookStatus = $("#discord-status");
const everyoneBox = $("#discord-everyone");
const periodEl = $("#period");
const filtersEl = $("#filters");
const platformFiltersEl = $("#platform-filters");
const sortEl = $("#sort");

const FILTER_KEY = "filterSubstates";
const PLATFORM_FILTER_KEY = "platformFilter";
const SORT_KEY = "sortBy";
const PLATFORMS_KEY = "enabledPlatforms";
const WEBHOOK_KEY = "discordWebhook";
const EVERYONE_KEY = "discordEveryone";
const PERIOD_KEY = "periodMin";
const ORDER = [
  "new", "pending-program-review", "triaged", "needs-more-info", "unresolved",
  "resolved", "informative", "informational", "not-applicable", "not-reproducible",
  "out-of-scope", "wont-fix", "duplicate", "spam"
];

// Selected substates / platforms. Empty set = show all.
let selected = new Set();
let platformSel = new Set();
let sortBy = "internal_desc";
let enabledPlatforms = DEFAULT_PLATFORMS.slice();
let currentReports = [];
let lastChangedKeys = new Set();

function keyOf(r) { return r.platform + ":" + r._id; }
function cmpStr(a, b) { return String(a || "").localeCompare(String(b || "")); }

function sortRows(rows) {
  const r = rows.slice();
  switch (sortBy) {
    case "submitted_asc": r.sort((a, b) => cmpStr(a.submitted_at, b.submitted_at)); break;
    case "activity_desc": r.sort((a, b) => cmpStr(b.latest_activity_at, a.latest_activity_at)); break;
    case "internal_desc": r.sort((a, b) => cmpStr(b.report_pending_party_last_activity, a.report_pending_party_last_activity)); break;
    case "status": r.sort((a, b) => (ORDER.indexOf(a.substate) - ORDER.indexOf(b.substate)) || cmpStr(b.submitted_at, a.submitted_at)); break;
    case "id_desc": r.sort((a, b) => Number(b._id) - Number(a._id)); break;
    case "submitted_desc":
    default: r.sort((a, b) => cmpStr(b.submitted_at, a.submitted_at)); break;
  }
  return r;
}

function fmtTime(ts) {
  if (!ts) return "never";
  const d = new Date(ts);
  return d.toLocaleString("en-GB", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Platform filter chips (only shown when reports span more than one platform).
function buildPlatformFilters(reports) {
  const counts = {};
  for (const r of reports) counts[r.platform] = (counts[r.platform] || 0) + 1;
  const present = Object.keys(counts);

  platformFiltersEl.innerHTML = "";
  if (present.length < 2) return;

  for (const p of present) {
    const on = platformSel.has(p);
    const label = document.createElement("label");
    label.className = "chip plat plat-" + p + (on ? " on" : "");
    label.innerHTML =
      `<input type="checkbox" ${on ? "checked" : ""} />` +
      `<img class="picon" src="assets/${p}.png" alt="" />` +
      `<span>${escapeHtml(platformName(p))}</span>` +
      `<span class="cnt">${counts[p]}</span>`;
    const input = label.querySelector("input");
    input.addEventListener("change", async () => {
      if (input.checked) platformSel.add(p); else platformSel.delete(p);
      label.classList.toggle("on", input.checked);
      await chrome.storage.local.set({ [PLATFORM_FILTER_KEY]: [...platformSel] });
      renderList();
    });
    platformFiltersEl.appendChild(label);
  }
}

// Substate filter chips, built from the substates present in the data.
function buildFilters(reports) {
  const counts = {};
  for (const r of reports) counts[r.substate] = (counts[r.substate] || 0) + 1;

  const present = Object.keys(counts);
  const ordered = ORDER.filter(s => present.includes(s))
    .concat(present.filter(s => !ORDER.includes(s)));

  filtersEl.innerHTML = "";
  for (const s of ordered) {
    const on = selected.has(s);
    const label = document.createElement("label");
    label.className = "chip" + (on ? " on" : "");
    label.innerHTML =
      `<input type="checkbox" ${on ? "checked" : ""} />` +
      `<span>${escapeHtml(substateLabel(s))}</span>` +
      `<span class="cnt">${counts[s]}</span>`;
    const input = label.querySelector("input");
    input.addEventListener("change", async () => {
      if (input.checked) selected.add(s); else selected.delete(s);
      label.classList.toggle("on", input.checked);
      await chrome.storage.local.set({ [FILTER_KEY]: [...selected] });
      renderList();
    });
    filtersEl.appendChild(label);
  }
}

function makeCard(r) {
  const changed = lastChangedKeys.has(keyOf(r));
  const ppr = r.substate === "pending-program-review";
  const card = document.createElement("div");
  card.className = "card" + (changed ? " changed" : ppr ? " ppr" : "");
  card.addEventListener("click", () => {
    chrome.tabs.create({ url: r.url || ("https://hackerone.com/reports/" + r._id) });
  });
  const idText = r.platform === "bugcrowd" ? String(r._id).slice(0, 8) : r._id;
  const internalSpan = r.platform === "bugcrowd"
    ? ""
    : `<span>internal: ${relLabel(r.report_pending_party_last_activity)}</span>`;
  card.innerHTML = `
    <div class="top">
      <span class="title"><img class="picon" src="assets/${r.platform}.png" alt="${escapeHtml(platformName(r.platform))}" /><span class="ttext">${escapeHtml(r.title || "(untitled)")}</span></span>
      <span class="top-right">
        ${changed ? '<span class="badge-changed">CHANGED</span>' : ""}
        <span class="id" title="#${escapeHtml(String(r._id))}">#${escapeHtml(idText)}</span>
      </span>
    </div>
    <div class="sub">${escapeHtml(substateLabel(r.substate))}</div>
    <div class="meta-line">
      <span>activity: ${relLabel(r.latest_activity_at)}</span>
      ${internalSpan}
    </div>`;
  return card;
}

function renderList() {
  let rows = currentReports;
  if (platformSel.size) rows = rows.filter(r => platformSel.has(r.platform));
  if (selected.size) rows = rows.filter(r => selected.has(r.substate));
  rows = sortRows(rows);

  listEl.innerHTML = "";
  if (!rows.length) {
    listEl.innerHTML = '<div class="empty">No reports match the filter.</div>';
  } else {
    for (const r of rows) listEl.appendChild(makeCard(r));
  }

  const pprCount = currentReports.filter(r => r.substate === "pending-program-review").length;
  metaEl.textContent = `${rows.length}/${currentReports.length} shown · ${pprCount} in PPR`;
}

function render(reports, changes) {
  currentReports = reports || [];
  lastChangedKeys = new Set((changes || []).map(c => c.key || (c.platform + ":" + c.id)));
  buildPlatformFilters(currentReports);
  buildFilters(currentReports);
  renderList();
}

function showUser(me) {
  // me is a map of platform -> { username }. Tolerate the old single-object shape.
  if (!me) return;
  let names;
  if (typeof me.username === "string") {
    names = ["@" + me.username];
  } else {
    names = Object.keys(me)
      .map(p => me[p] && me[p].username ? "@" + me[p].username : null)
      .filter(Boolean);
  }
  if (names.length) userEl.textContent = names.join("  ·  ");
}

async function load(triggerCheck) {
  const data = await chrome.storage.local.get(["reports", "me", "lastCheck", "lastError"]);
  showUser(data.me);
  if (data.reports) render(data.reports, []);
  if (data.lastError) {
    statusEl.textContent = "⚠ " + data.lastError;
    statusEl.className = "status error";
  } else {
    statusEl.textContent = "Last check: " + fmtTime(data.lastCheck);
    statusEl.className = "status";
  }
  if (triggerCheck) await doCheck();
}

async function doCheck() {
  refreshBtn.classList.add("spin");
  statusEl.className = "status";
  statusEl.textContent = "Checking…";
  try {
    const resp = await chrome.runtime.sendMessage({ type: "checkNow" });
    if (!resp || !resp.ok) throw new Error(resp ? resp.error : "no response");
    showUser(resp.me);
    render(resp.reports, resp.changes);
    const n = (resp.changes || []).length;
    let txt = n ? `${n} change(s)!` : "No changes.";
    if (resp.errors && resp.errors.length) txt += " ⚠ " + resp.errors.join(" | ");
    statusEl.textContent = txt;
    if (resp.errors && resp.errors.length) statusEl.className = "status error";
    chrome.action.setBadgeText({ text: "" }); // seen
  } catch (e) {
    statusEl.className = "status error";
    statusEl.textContent = "⚠ " + (e.message || e);
  } finally {
    refreshBtn.classList.remove("spin");
  }
}

refreshBtn.addEventListener("click", doCheck);

settingsBtn.addEventListener("click", () => {
  settingsPanel.hidden = !settingsPanel.hidden;
});

// Persist the Discord webhook live, on every keystroke, so it is never lost.
webhookInput.addEventListener("input", () => {
  chrome.storage.local.set({ [WEBHOOK_KEY]: webhookInput.value.trim() });
});
webhookInput.addEventListener("change", () => {
  const val = webhookInput.value.trim();
  chrome.storage.local.set({ [WEBHOOK_KEY]: val });
  webhookStatus.textContent = val ? "Webhook set." : "Disabled.";
});

webhookTestBtn.addEventListener("click", async () => {
  const val = webhookInput.value.trim();
  if (!/^https:\/\/discord\.com\/api\/webhooks\//.test(val)) {
    webhookStatus.textContent = "Enter a valid Discord webhook URL first.";
    return;
  }
  await chrome.storage.local.set({ [WEBHOOK_KEY]: val });
  webhookTestBtn.disabled = true;
  webhookStatus.textContent = "Sending test…";
  try {
    const resp = await chrome.runtime.sendMessage({ type: "testDiscord", webhook: val });
    if (!resp || !resp.ok) throw new Error(resp ? resp.error : "no response");
    webhookStatus.textContent = "Webhook saved.";
  } catch (e) {
    webhookStatus.textContent = "Failed: " + (e.message || e);
  } finally {
    webhookTestBtn.disabled = false;
  }
});

// Persist the @everyone toggle.
everyoneBox.addEventListener("change", () => {
  chrome.storage.local.set({ [EVERYONE_KEY]: everyoneBox.checked });
});

// Change the background auto-check interval.
periodEl.addEventListener("change", async () => {
  const m = parseInt(periodEl.value, 10) || 60;
  await chrome.storage.local.set({ [PERIOD_KEY]: m });
  chrome.runtime.sendMessage({ type: "setPeriod", periodMin: m });
});

sortEl.addEventListener("change", async () => {
  sortBy = sortEl.value;
  await chrome.storage.local.set({ [SORT_KEY]: sortBy });
  renderList();
});

// Wire platform checkboxes in the settings panel.
for (const p of PROVIDERS) {
  const box = document.querySelector("#plat-" + p.id);
  if (!box) continue;
  box.addEventListener("change", async () => {
    if (box.checked) { if (!enabledPlatforms.includes(p.id)) enabledPlatforms.push(p.id); }
    else enabledPlatforms = enabledPlatforms.filter(x => x !== p.id);
    if (!enabledPlatforms.length) { enabledPlatforms = [p.id]; box.checked = true; return; }
    await chrome.storage.local.set({ [PLATFORMS_KEY]: enabledPlatforms });
    statusEl.className = "status";
    statusEl.textContent = "Platforms updated. Refreshing…";
    await doCheck();
  });
}

// Init: load persisted settings, then data, then maybe refresh if stale.
(async () => {
  const store = await chrome.storage.local.get([FILTER_KEY, PLATFORM_FILTER_KEY, SORT_KEY, PLATFORMS_KEY, WEBHOOK_KEY, EVERYONE_KEY, PERIOD_KEY, "lastCheck"]);
  selected = new Set(store[FILTER_KEY] || []);
  platformSel = new Set(store[PLATFORM_FILTER_KEY] || []);
  sortBy = store[SORT_KEY] || "internal_desc";
  enabledPlatforms = (store[PLATFORMS_KEY] && store[PLATFORMS_KEY].length) ? store[PLATFORMS_KEY] : DEFAULT_PLATFORMS.slice();
  webhookInput.value = store[WEBHOOK_KEY] || "";
  webhookStatus.textContent = store[WEBHOOK_KEY] ? "Webhook set." : "";
  everyoneBox.checked = store[EVERYONE_KEY] !== false; // default on
  periodEl.value = String(store[PERIOD_KEY] || 60);
  sortEl.value = sortBy;
  for (const p of PROVIDERS) {
    const box = document.querySelector("#plat-" + p.id);
    if (box) box.checked = enabledPlatforms.includes(p.id);
  }
  const stale = !store.lastCheck || (Date.now() - store.lastCheck > 5 * 60 * 1000);
  await load(stale);
})();
