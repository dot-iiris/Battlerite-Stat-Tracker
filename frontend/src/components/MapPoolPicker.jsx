// A map pool picker: one row per arena with a button for each of its Day / Night versions - lit = in
// the pool. Used for the general pools (Settings) and a season's own pools (Seasons).

// "Mount Araz (Night)" -> ["Mount Araz", "Night"]
function splitMap(m) {
  const hit = /^(.*?)\s*\((Day|Night)\)$/i.exec(m);
  return hit ? [hit[1], hit[2][0].toUpperCase() + hit[2].slice(1).toLowerCase()] : [m, m];
}

export default function MapPoolPicker({ value, mapNames, onChange, testid = "maps", className = "grid gap-2 sm:grid-cols-2 xl:grid-cols-3" }) {
  const have = new Set(value || []);
  const groups = [];
  for (const m of mapNames) {
    const [base, variant] = splitMap(m);
    let g = groups.find((x) => x.base === base);
    if (!g) groups.push((g = { base, items: [] }));
    g.items.push({ name: m, variant });
  }
  const toggle = (m) => {
    if (have.has(m)) {
      if (have.size > 1) onChange(mapNames.filter((x) => have.has(x) && x !== m));
    } else {
      onChange(mapNames.filter((x) => have.has(x) || x === m));
    }
  };
  const btn = (on, last) => `text-xs font-mono-hud uppercase tracking-wider px-2.5 py-1 rounded border transition-colors ${on
    ? "border-cyan-400 bg-cyan-400/15 text-cyan-300 hover:bg-cyan-400/25"
    : "border-[#1B2438] text-slate-500 hover:border-slate-500 hover:text-slate-300"} ${last ? "cursor-not-allowed" : ""}`;
  return (
    <div className={className}>
      {groups.map((g) => (
        <div key={g.base} className="flex items-center justify-between gap-3 rounded border border-[#1B2438] bg-[#0C101B] px-3 py-2"
          data-testid={`map-group-${testid}-${g.base}`}>
          <span className={`text-sm truncate ${g.items.some((i) => have.has(i.name)) ? "text-slate-200" : "text-slate-500"}`}>{g.base}</span>
          <div className="flex gap-1.5 flex-shrink-0">
            {g.items.map(({ name, variant }) => {
              const on = have.has(name);
              const last = on && have.size === 1;
              return (
                <button key={name} type="button" onClick={() => toggle(name)} aria-pressed={on} className={btn(on, last)}
                  title={last ? "Keep at least one map" : `${on ? "Remove" : "Add"} ${name}`} data-testid={`map-toggle-${testid}-${name}`}>
                  {variant}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
