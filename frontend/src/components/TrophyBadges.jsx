import { Link } from "react-router-dom";
import { Trophy } from "lucide-react";

const PLACES = {
  1: { label: "1st", cls: "text-[#FFD54F] border-[#FFD54F]/50 bg-[#FFD54F]/10 hover:bg-[#FFD54F]/20" },
  2: { label: "2nd", cls: "text-slate-300 border-slate-300/50 bg-slate-300/10 hover:bg-slate-300/20" },
  3: { label: "3rd", cls: "text-[#D08A4E] border-[#D08A4E]/50 bg-[#D08A4E]/10 hover:bg-[#D08A4E]/20" },
};

// One trophy per top-3 tournament finish, newest first (the API sends them in that order).
// Each links to its tournament.
export default function TrophyBadges({ trophies, size = "sm" }) {
  if (!trophies?.length) return null;
  const cls = size === "lg" ? "p-1.5" : "p-1";
  const iconSize = size === "lg" ? "w-4 h-4" : "w-3 h-3";
  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap" data-testid="trophy-badges">
      {trophies.map((t) => {
        const p = PLACES[t.place];
        if (!p) return null;
        const title = `${p.label} · ${t.tournament_name}${t.team_name ? ` · ${t.team_name}` : ""}`;
        return (
          <Link key={t.tournament_id} to={`/tournaments/${t.tournament_id}`} title={title} aria-label={title}
            className={`inline-flex items-center border rounded transition-colors ${cls} ${p.cls}`}
            data-testid={`trophy-${t.place}-${t.tournament_id}`}>
            <Trophy className={iconSize} strokeWidth={2.5} />
          </Link>
        );
      })}
    </span>
  );
}
