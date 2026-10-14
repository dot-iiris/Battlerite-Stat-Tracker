import { useState } from "react";
import { ChevronDown } from "lucide-react";
import ChampionPortrait from "@/components/ChampionPortrait";
import MatchDetails from "@/components/MatchDetails";
import MmrChange from "@/components/MmrChange";
import { MatchCode } from "@/components/FormatFilter";

// Compact match rows (both teams with champion + player name) that open the full match in place.
// Used on player pages, champion pages and the dashboard; the Matches page has its own big cards.
//   focusPlayer:   that player's side shows first, as Win/Loss, with their MMR change
//   focusChampion: the side that played that champion shows first; its picks are outlined
//   limit:         rows shown before "Show all" (showAllButton=false to never show more)
export default function MatchList({
  matches, playerName, seasons = [], onChanged,
  focusPlayer = null, focusChampion = null,
  limit = 10, showAllButton = true, emptyText = "No matches found.", testid = "match-list",
}) {
  const [openId, setOpenId] = useState(null);
  const [showAll, setShowAll] = useState(false);
  if (matches.length === 0) return <div className="text-slate-500 text-sm font-mono-hud">{emptyText}</div>;
  const shown = showAll ? matches : matches.slice(0, limit);

  return (
    <div className="space-y-2" data-testid={testid}>
      {shown.map((m) => {
        const me = focusPlayer ? m.players.find((p) => p.player_id === focusPlayer) : null;
        let side = me?.team || null;
        if (!side && focusChampion) {
          const sides = [...new Set(m.players.filter((p) => p.champion === focusChampion).map((p) => p.team))];
          if (sides.length === 1) side = sides[0];
        }
        const first = side || m.winner_team || "A";
        const second = first === "A" ? "B" : "A";
        const rounds = (t) => (t === "A" ? m.team_a_rounds : m.team_b_rounds);
        const won = side && side === m.winner_team;
        const open = openId === m.id;
        const marked = (p) => (focusPlayer ? p.player_id === focusPlayer : focusChampion && p.champion === focusChampion);
        const ring = focusPlayer ? "ring-cyan-400" : "ring-[#FFB800]";

        const team = (t) => (
          <span className={`flex flex-col gap-1 min-w-0 ${t === m.winner_team ? "" : "opacity-60"}`}>
            {m.players.filter((p) => p.team === t).map((p) => (
              <span key={p.player_id} className="flex items-center gap-1.5 min-w-0">
                <span className={`inline-flex leading-[0] rounded flex-shrink-0 ${marked(p) ? `ring-2 ${ring} ring-offset-1 ring-offset-[#121828]` : ""}`}>
                  <ChampionPortrait name={p.champion} role={p.role} size={22} linkToProfile={false} />
                </span>
                <span className={`text-xs truncate ${focusPlayer && p.player_id === focusPlayer ? "text-cyan-400 font-bold" : "text-slate-300"}`}>
                  {playerName(p.player_id)}
                </span>
              </span>
            ))}
          </span>
        );

        return (
          <div key={m.id} className={`bg-[#121828]/60 border rounded transition-colors ${open ? "border-cyan-400/50" : "border-[#1B2438] hover:border-cyan-400/40"}`}>
            <button type="button" onClick={() => setOpenId(open ? null : m.id)} data-testid={`${testid}-${m.id}`}
              className="w-full grid grid-cols-[auto_1fr] sm:grid-cols-[auto_1fr_auto] items-center gap-3 p-3 text-left">
              <div className="flex flex-col items-start gap-1.5">
                {side ? (
                  <span className={`text-[10px] font-mono-hud font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${won ? "text-[#00E676] border-[#00E676]/40 bg-[#00E676]/10" : "text-[#FF2E55] border-[#FF2E55]/40 bg-[#FF2E55]/10"}`}>
                    {won ? "Win" : "Loss"} {rounds(first)}:{rounds(second)}
                  </span>
                ) : (
                  <span className="text-[10px] font-mono-hud font-bold tracking-wider px-2 py-0.5 rounded border text-slate-200 border-[#1B2438] bg-[#0C101B]">
                    {rounds(first)}:{rounds(second)}
                  </span>
                )}
                <span className="text-[10px] font-mono-hud uppercase tracking-[0.15em] px-2 py-0.5 bg-[#0C101B] border border-[#1B2438] rounded">{m.format}</span>
              </div>
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 min-w-0">
                {team(first)}
                <span className="text-xs text-slate-600">vs</span>
                {team(second)}
              </div>
              <div className="col-span-2 sm:col-span-1 flex sm:flex-col items-center sm:items-end justify-between gap-1 text-xs font-mono-hud text-slate-500 whitespace-nowrap border-t border-[#1B2438] pt-2 sm:border-0 sm:pt-0">
                {me && <MmrChange p={me} />}
                <MatchCode match={m} />
                <span className="flex items-center gap-1">
                  {new Date(m.played_at).toLocaleDateString()}
                  <ChevronDown className={`w-4 h-4 transition-transform ${open ? "rotate-180 text-cyan-400" : ""}`} />
                </span>
              </div>
            </button>
            {open && (
              <div className="px-3 pb-3">
                <MatchDetails match={m} playerName={playerName} onChanged={onChanged}
                  seasonName={seasons.find((x) => x.id === m.season_id)?.name} />
              </div>
            )}
          </div>
        );
      })}
      {showAllButton && matches.length > shown.length && (
        <button type="button" onClick={() => setShowAll(true)} data-testid={`${testid}-show-all`}
          className="w-full py-2 text-xs font-mono-hud uppercase tracking-wider text-cyan-400 hover:text-cyan-300">
          Show all {matches.length} matches
        </button>
      )}
    </div>
  );
}
