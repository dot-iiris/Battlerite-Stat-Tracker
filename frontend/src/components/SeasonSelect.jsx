import { useEffect } from "react";

// Season picker used across the site.
// Order: newest season first, older ones below it, the Unranked season last.
// With `withAll`: "All" (every season, unranked included, value "") and
// "All Ranked Seasons" (value "ranked") at the top.
// The last pick is remembered in this browser (`remember` names which choice it is), so each
// visitor comes back to the season they were looking at.

const started = (s) => s.start_date || s.created_at || "";
const KEY = (name) => `brstats.season.${name}`;

export function sortSeasons(seasons = []) {
  const ranked = seasons.filter((s) => s.ranked !== false)
    .sort((a, b) => (started(a) < started(b) ? 1 : started(a) > started(b) ? -1 : 0));
  return [...ranked, ...seasons.filter((s) => s.ranked === false)];
}

// the season to start on where there's no "All": the current one, else the newest
export function newestSeason(seasons = []) {
  return seasons.find((s) => s.active) || sortSeasons(seasons)[0] || null;
}

// the visitor's last pick ("" = All when nothing is saved)
export function savedSeason(name = "all") {
  try { return window.localStorage.getItem(KEY(name)) ?? ""; } catch { return ""; }
}

function saveSeason(name, value) {
  try { window.localStorage.setItem(KEY(name), value); } catch { /* private window etc. - just don't remember */ }
}

export default function SeasonSelect({ seasons, value, onChange, withAll = true, remember = "all", className = "", ...rest }) {
  const valid = (v) => (withAll && (v === "" || v === "ranked")) || seasons.some((s) => s.id === v);
  // a remembered season that no longer exists: back to the default
  useEffect(() => {
    if (seasons.length && value !== null && value !== undefined && !valid(value)) {
      onChange(withAll ? "" : newestSeason(seasons)?.id || "");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seasons, value]);

  const pick = (v) => {
    if (remember) saveSeason(remember, v);
    onChange(v);
  };
  return (
    <select value={value ?? ""} onChange={(e) => pick(e.target.value)}
      className={className || "bg-[#121828] border border-[#1B2438] rounded px-3 py-2 text-sm"} {...rest}>
      {withAll && <option value="">All</option>}
      {withAll && <option value="ranked">All Ranked Seasons</option>}
      {sortSeasons(seasons).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </select>
  );
}
