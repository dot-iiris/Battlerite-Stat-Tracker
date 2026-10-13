// A player's MMR in one match: "1200 → 1224  +24" (before → after, then the change).
// Unranked matches (no MMR before) show just the change.
export default function MmrChange({ p, className = "", size = "text-[10px]" }) {
  const d = p.elo_delta ?? 0;
  const colour = d >= 0 ? "text-[#00E676]" : "text-[#FF2E55]";
  const delta = `${d >= 0 ? "+" : ""}${d}`;
  if (p.mmr_before == null) {
    return <span className={`${size} font-mono-hud ${colour} ${className}`}>{delta}</span>;
  }
  const before = Math.round(p.mmr_before);
  const after = Math.round(p.mmr_before + d);
  return (
    <span className={`${size} font-mono-hud whitespace-nowrap ${className}`} title={`MMR before ${before}, after ${after} (${delta})`}>
      <span className="text-slate-500">{before}</span>
      <span className="text-slate-600 mx-0.5">→</span>
      <span className="text-slate-200">{after}</span>
      <span className={`${colour} ml-1.5`}>{delta}</span>
    </span>
  );
}
