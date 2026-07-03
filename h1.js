// Shared display helpers used by both popup and background.

// Calendar-day difference (local), matching the UI "N days ago" display.
export function daysAgo(iso) {
  if (!iso) return null;
  const then = new Date(iso);
  if (isNaN(then.getTime())) return null;
  const now = new Date();
  const a = Date.UTC(then.getFullYear(), then.getMonth(), then.getDate());
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((b - a) / 86400000);
}

export function relLabel(iso) {
  const d = daysAgo(iso);
  if (d === null) return "—";
  if (d <= 0) return "today";
  if (d === 1) return "yesterday (1d)";
  return d + " days ago";
}

export function substateLabel(s) {
  const map = {
    // HackerOne
    "new": "New",
    "pending-program-review": "Pending program review",
    "triaged": "Triaged",
    "needs-more-info": "Needs more info",
    "resolved": "Resolved",
    "informative": "Informative",
    "not-applicable": "Not applicable",
    "duplicate": "Duplicate",
    "spam": "Spam",
    // Bugcrowd (normalized: underscores replaced by hyphens)
    "unresolved": "Unresolved",
    "informational": "Informational",
    "out-of-scope": "Out of scope",
    "not-reproducible": "Not reproducible",
    "wont-fix": "Won't fix"
  };
  return map[s] || s;
}

const CURRENCY_SYMBOL = { USD: "$", EUR: "€", GBP: "£", CAD: "$", AUD: "$" };

// Returns a compact money label ("$500", "€1,250") or null when there is no bounty.
export function bountyLabel(amount, currency) {
  const n = Number(amount);
  if (!n || n <= 0) return null;
  const cur = currency || "USD";
  const sym = CURRENCY_SYMBOL[cur];
  const val = (n % 1 === 0 ? n : Number(n.toFixed(2))).toLocaleString("en-US");
  return sym ? sym + val : val + " " + cur;
}

export function platformBadge(id) {
  return id === "bugcrowd" ? "BC" : "H1";
}

export function platformName(id) {
  return id === "bugcrowd" ? "Bugcrowd" : "HackerOne";
}
