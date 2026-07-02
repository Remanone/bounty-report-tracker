// Shared display helpers (used by both popup and background).
// The actual data fetch lives in providers.js as self-contained pageFetch()
// functions, each injected into its platform's own tab (same origin).

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

// Human-readable substate label, across both platforms.
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

// Short badge and display name per platform.
export function platformBadge(id) {
  return id === "bugcrowd" ? "BC" : "H1";
}

export function platformName(id) {
  return id === "bugcrowd" ? "Bugcrowd" : "HackerOne";
}
