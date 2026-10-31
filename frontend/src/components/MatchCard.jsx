import { Link } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import ChampionPortrait from "@/components/ChampionPortrait";
import MmrChange from "@/components/MmrChange";
import MatchDetails from "@/components/MatchDetails";
import { teamPlayers } from "@/lib/roleOrder";

// One match as a big card (Match History, tournament games): both teams with champions, the round
// score, and the full scoreboard when opened.
//   tags:        shown at the top left (match code, format, date...)
//   actions:     admin buttons at the top right, next to Stats
//   showMmr:     false hides MMR changes (unranked matches, tournament games)
//   teamNames:   {A, B} - a name above each team (tournament teams)
//   detailsProps: extra props for MatchDetails
export default function MatchCard({ match: m, playerName, open, onToggle, tags, actions, showMmr = true,
  teamNames = null, detailsProps = {}, onChanged, seasonName, testid = "match-row" }) {
  const aWon = m.winner_team === "A";
  const teamCard = (team, won) => (
    <div className="min-w-0">
      {teamNames?.[team] && <div className={`text-[10px] font-mono-hud uppercase tracking-wider mb-1 truncate ${won ? "text-[#00E676]" : "text-slate-500"}`}>{teamNames[team]}</div>}
      <div className={`p-3 rounded border ${won ? "border-[#00E676]/40 bg-[#00E676]/5" : "border-[#1B2438] bg-[#121828]/40"}`}>
        {teamPlayers(m.players, team).map((p) => (
          <div key={`${p.team}-${p.player_id}-${p.champion}`} className="flex items-center justify-between gap-2 py-1">
            <div className="flex items-center gap-2 min-w-0">
              <ChampionPortrait name={p.champion} role={p.role} size={26} />
              <Link to={`/players/${p.player_id}`} className="text-sm font-medium hover:text-cyan-400 truncate">{playerName(p.player_id)}</Link>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className="text-xs font-mono-hud text-slate-400 hidden lg:inline">{p.champion}</span>
              {showMmr && <MmrChange p={p} />}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
  return (
    <div id={`match-${m.id}`}
      className={`hud-card p-5 cursor-pointer transition-colors ${open ? "border-cyan-400/60 ring-1 ring-cyan-400/40" : "hover:border-cyan-400/30"}`}
      onClick={(e) => { if (!e.target.closest("a,button,input,select")) onToggle(); }}
      data-testid={`${testid}-${m.id}`}>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-3 flex-wrap">{tags}</div>
        <div className="flex items-center gap-1">
          <button onClick={onToggle} className="text-slate-400 hover:text-cyan-400 text-[10px] font-mono-hud uppercase tracking-wider flex items-center gap-1 p-1" data-testid={`${testid}-open-${m.id}`}>
            {open ? "Hide stats" : "Stats"} <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
          {actions}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-4 items-center">
        {teamCard("A", aWon)}
        <div className="text-center">
          <div className="font-mono-hud text-3xl md:text-4xl font-black">
            <span className={aWon ? "text-[#00E676]" : "text-slate-400"}>{m.team_a_rounds}</span>
            <span className="text-slate-600 mx-2">:</span>
            <span className={!aWon ? "text-[#00E676]" : "text-slate-400"}>{m.team_b_rounds}</span>
          </div>
        </div>
        {teamCard("B", !aWon)}
      </div>
      {open && (
        <MatchDetails match={m} playerName={playerName} onChanged={onChanged} seasonName={seasonName}
          showMmr={showMmr} teamNames={teamNames} {...detailsProps} />
      )}
    </div>
  );
}
