// Season picker used across the site.
// Order: newest season first, older ones below it, the Unranked season last.
// With `withAll`: "All" (every season, unranked included, value "") and
// "All Ranked Seasons" (value "ranked") at the top.

const started = (s) => s.start_date || s.created_at || "";

export function sortSeasons(seasons = []) {
  const ranked = seasons.filter((s) => s.ranked !== false)
    .sort((a, b) => (started(a) < started(b) ? 1 : started(a) > started(b) ? -1 : 0));
  return [...ranked, ...seasons.filter((s) => s.ranked === false)];
}

// the season to start on where there's no "All": the current one, else the newest
export function newestSeason(seasons = []) {
  return seasons.find((s) => s.active) || sortSeasons(seasons)[0] || null;
}

export default function SeasonSelect({ seasons, value, onChange, withAll = true, className = "", ...rest }) {
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value)}
      className={className || "bg-[#121828] border border-[#1B2438] rounded px-3 py-2 text-sm"} {...rest}>
      {withAll && <option value="">All</option>}
      {withAll && <option value="ranked">All Ranked Seasons</option>}
      {sortSeasons(seasons).map((s) => (
        <option key={s.id} value={s.id}>{s.name}{s.active ? " (current)" : ""}</option>
      ))}
    </select>
  );
}
