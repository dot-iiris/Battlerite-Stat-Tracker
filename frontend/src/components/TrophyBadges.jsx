import { Link } from "react-router-dom";
import { Trophy } from "lucide-react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";

const PLACES = {
  1: { label: "1st place", text: "text-[#FFD54F]", cls: "text-[#FFD54F] border-[#FFD54F]/50 bg-[#FFD54F]/10 hover:bg-[#FFD54F]/20" },
  2: { label: "2nd place", text: "text-slate-300", cls: "text-slate-300 border-slate-300/50 bg-slate-300/10 hover:bg-slate-300/20" },
  3: { label: "3rd place", text: "text-[#D08A4E]", cls: "text-[#D08A4E] border-[#D08A4E]/50 bg-[#D08A4E]/10 hover:bg-[#D08A4E]/20" },
};

const day = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !isNaN(d) ? d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : null;
};

// One trophy per top-3 tournament finish, newest first (the API sends them in that order).
// Hovering shows a card with the details; clicking opens the tournament.
export default function TrophyBadges({ trophies, size = "sm" }) {
  if (!trophies?.length) return null;
  const cls = size === "lg" ? "p-1.5" : "p-1";
  const iconSize = size === "lg" ? "w-4 h-4" : "w-3 h-3";
  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap" data-testid="trophy-badges">
      {trophies.map((t) => {
        const p = PLACES[t.place];
        if (!p) return null;
        const to = `/tournaments/${t.tournament_id}`;
        const when = day(t.finished_at);
        return (
          <HoverCard key={t.tournament_id} openDelay={100} closeDelay={100}>
            <HoverCardTrigger asChild>
              <Link to={to} aria-label={`${p.label} · ${t.tournament_name}`}
                className={`inline-flex items-center border rounded transition-colors ${cls} ${p.cls}`}
                data-testid={`trophy-${t.place}-${t.tournament_id}`}>
                <Trophy className={iconSize} strokeWidth={2.5} />
              </Link>
            </HoverCardTrigger>
            <HoverCardContent side="bottom" align="start"
              className="w-60 bg-[#0C101B] border-[#1B2438] text-slate-100 p-3"
              data-testid={`trophy-card-${t.tournament_id}`}>
              <div className="flex items-start gap-3">
                <div className={`shrink-0 border rounded p-2 ${p.cls}`}>
                  <Trophy className="w-5 h-5" strokeWidth={2.5} />
                </div>
                <div className="min-w-0">
                  <div className={`text-[10px] font-mono-hud uppercase tracking-[0.2em] ${p.text}`}>{p.label}</div>
                  <Link to={to} className="block font-heading text-base font-black uppercase tracking-tight truncate hover:text-cyan-400 transition-colors">
                    {t.tournament_name} <span className="text-cyan-400/70 text-sm">→</span>
                  </Link>
                  {t.team_name && <div className="text-xs text-slate-300 truncate">{t.team_name}</div>}
                  <div className="text-[10px] font-mono-hud text-slate-500 mt-1">
                    {[t.format, when].filter(Boolean).join(" · ")}
                  </div>
                </div>
              </div>
            </HoverCardContent>
          </HoverCard>
        );
      })}
    </span>
  );
}
