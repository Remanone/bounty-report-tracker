// Each provider fetches the current user's reports from one platform. pageFetch()
// is serialized and run inside a tab on that platform's own origin via
// chrome.scripting.executeScript, because both sites return errors for API calls
// coming from the extension origin. Each pageFetch MUST be fully self-contained
// (no outer-scope refs) and returns a normalized shape:
//
//   { me: { platform, username }, reports: [ normalizedReport, ... ] }
//   normalizedReport = {
//     platform, _id, title, substate, url, submitted_at,
//     latest_activity_at,                     // last PUBLIC activity
//     report_pending_party_last_activity,     // last INTERNAL activity
//     bounty,                                 // total awarded amount (number) or null
//     bountyCurrency,                         // ISO code, e.g. "USD", or null
//     team: { handle, name } | null
//   }

async function hackeronePageFetch() {
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

  // latest_activity_at is always null on H1's API; latest_public_activity_at
  // holds the real value, so it is aliased to keep the shape uniform.
  const q = "query Tracker($rid: Int!) {" +
    " reports(first: 100, where: { reporter: { id: { _eq: $rid } } }) {" +
    " edges { node { _id title substate url submitted_at" +
    " latest_activity_at: latest_public_activity_at" +
    " report_pending_party_last_activity team { handle name } } } } }";
  const rid = parseInt(me.me._id, 10);
  const data = await gql(q, { rid });
  if (data.__http) return { error: "HTTP " + data.__http + " on /graphql" };
  if (data.__gql) return { error: data.__gql };

  const reports = (data.reports.edges || []).map(e => {
    const n = e.node;
    return {
      platform: "hackerone",
      _id: String(n._id),
      title: n.title,
      substate: n.substate,
      url: n.url || ("https://hackerone.com/reports/" + n._id),
      submitted_at: n.submitted_at,
      latest_activity_at: n.latest_activity_at,
      report_pending_party_last_activity: n.report_pending_party_last_activity,
      bounty: null,
      bountyCurrency: null,
      team: n.team ? { handle: n.team.handle, name: n.team.name } : null
    };
  });

  // Bounties are fetched in a separate best-effort query: if this field shape
  // ever changes, the main report list still renders, just without amounts.
  try {
    const bq = "query Bounties($rid: Int!) {" +
      " reports(first: 100, where: { reporter: { id: { _eq: $rid } } }) {" +
      " edges { node { _id bounties(first: 25) { edges { node { awarded_amount awarded_bonus_amount } } } } } } }";
    const bd = await gql(bq, { rid });
    if (bd && !bd.__http && !bd.__gql && bd.reports) {
      const totals = {};
      for (const e of (bd.reports.edges || [])) {
        const n = e.node;
        let total = 0;
        for (const be of ((n.bounties && n.bounties.edges) || [])) {
          total += parseFloat(be.node.awarded_amount || 0) || 0;
          total += parseFloat(be.node.awarded_bonus_amount || 0) || 0;
        }
        totals[String(n._id)] = total;
      }
      for (const r of reports) {
        if (totals[r._id] > 0) { r.bounty = totals[r._id]; r.bountyCurrency = "USD"; }
      }
    }
  } catch (e) { /* bounty is optional */ }

  reports.sort((a, b) => String(b.submitted_at || "").localeCompare(String(a.submitted_at || "")));
  return { me: { platform: "hackerone", username: me.me.username }, reports };
}

// The list endpoint returns an array under one of several top-level keys.
// Bugcrowd does NOT expose an internal-only activity timestamp the way HackerOne
// does, so `report_pending_party_last_activity` stays null for Bugcrowd;
// `last_activity_date` is used as the public-activity signal (it moves on any
// activity, program-side included).
async function bugcrowdPageFetch() {
  const meta = document.querySelector('meta[name="csrf-token"]');
  const csrf = meta ? meta.content : null;

  async function getList(url) {
    let res;
    try {
      res = await fetch(url, {
        credentials: "include",
        headers: Object.assign({ "accept": "application/json" }, csrf ? { "x-csrf-token": csrf } : {})
      });
    } catch (e) { return { __err: String(e) }; }
    if (!res.ok) return { __http: res.status };
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("json")) return { __http: "non-json" };
    let body;
    try { body = await res.json(); } catch (e) { return { __err: "bad json" }; }
    const list = body.submissions || body.data || body.results;
    if (!Array.isArray(list)) return { __err: "no list in response" };
    return { list };
  }

  const candidates = [
    "/submissions.json?sort=newest",
    "/submissions.json",
    "/submissions?sort=newest",
    "/dashboard/submissions.json"
  ];
  let list = null;
  let lastErr = "no endpoint responded";
  for (const url of candidates) {
    const r = await getList(url);
    if (r.list) { list = r.list; break; }
    lastErr = r.__http ? ("HTTP " + r.__http) : r.__err;
  }
  if (!list) {
    return { error: "Bugcrowd: could not load submissions (" + lastErr + ")." };
  }

  function toAmount(v) {
    if (v == null) return null;
    const n = parseFloat(String(v).replace(/[^0-9.]/g, ""));
    return n > 0 ? n : null;
  }

  const reports = list.map(s => {
    const path = s.submission_url || (s.reference_number ? "/submissions/" + s.reference_number : "");
    const raw = String(s.substate || "").toLowerCase().replace(/_/g, "-").replace(/[^a-z-]/g, "");
    const bounty = toAmount(
      s.amount != null ? s.amount
      : s.monetary_reward != null ? s.monetary_reward
      : s.reward_amount != null ? s.reward_amount
      : s.total_rewarded_amount
    );
    return {
      platform: "bugcrowd",
      _id: String(s.reference_number || path.split("/").pop() || ""),
      title: s.title || s.caption || "(untitled)",
      substate: raw,
      url: path ? ("https://bugcrowd.com" + path) : "https://bugcrowd.com/submissions",
      submitted_at: s.submitted_at || s.created_at || null,
      latest_activity_at: s.last_activity_date || s.researcher_updated_at || null,
      // Bugcrowd's list API has no internal-only activity timestamp.
      report_pending_party_last_activity: null,
      bounty,
      bountyCurrency: bounty ? "USD" : null,
      team: {
        handle: s.engagement_name || null,
        name: s.program_name || s.engagement_name || null
      }
    };
  });

  reports.sort((a, b) => String(b.submitted_at || "").localeCompare(String(a.submitted_at || "")));
  const username = (list[0] && list[0].username) || "bugcrowd";
  return { me: { platform: "bugcrowd", username }, reports };
}

export const PROVIDERS = [
  {
    id: "hackerone",
    name: "HackerOne",
    origin: "https://hackerone.com/",
    tabMatch: "https://hackerone.com/*",
    tabUrl: "https://hackerone.com/bugs",
    pageFetch: hackeronePageFetch
  },
  {
    id: "bugcrowd",
    name: "Bugcrowd",
    origin: "https://bugcrowd.com/",
    tabMatch: "https://bugcrowd.com/*",
    tabUrl: "https://bugcrowd.com/submissions",
    pageFetch: bugcrowdPageFetch
  }
];

export const DEFAULT_PLATFORMS = ["hackerone"];

export function providersFor(enabled) {
  const set = new Set(enabled && enabled.length ? enabled : DEFAULT_PLATFORMS);
  return PROVIDERS.filter(p => set.has(p.id));
}
