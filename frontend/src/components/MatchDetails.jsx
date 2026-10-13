import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api, { API } from "@/api";
import { Image as ImageIcon } from "lucide-react";
import MmrChange from "@/components/MmrChange";
import ChampionPortrait from "@/components/ChampionPortrait";

const STATS = [
  { key: "score", label: "Score" },
  { key: "damage", label: "Damage" },
  { key: "protection", label: "Protection" },
  { key: "disables", label: "Disables" },
];

const fmt = (v, digits = 0) => (v === null || v === undefined ? "—" : Number(v).toLocaleString(undefined, { maximumFractionDigits: digits }));
const pct = (v) => (v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`);

// Expanded view of one match: per-player scoreboard stats (round averages)
// and the derived numbers from /api/matches/{id}/stats.
export default function MatchDetails({ match, playerName, seasonName }) {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    api.get(`/matches/${match.id}/stats`)
      .then((r) => alive && setStats(r.data))
      .catch(() => alive && setError(true));
    return () => { alive = false; };
  }, [match.id]);

  const byPlayer = Object.fromEntries((stats?.players || []).map((p) => [p.player_id, p]));
  const hasStats = (stats?.players || []).some((p) => p.raw);
  const shotUrl = match.screenshot_id ? `${API}/matches/${match.id}/screenshot` : null;

  const teamRows = (team) => match.players.filter((p) => p.team === team).map((p) => {
    const s = byPlayer[p.player_id] || {};
    const raw = s.raw || {};
    const d = s.derived || {};
    return (
      <tr key={`${team}-${p.player_id}`} className="border-t border-[#1B2438]">
        <td className="py-2 pr-3">
          <div className="flex items-center gap-2 min-w-0">
            <ChampionPortrait name={p.champion} role={p.role} size={24} />
            <div className="min-w-0">
              <Link to={`/players/${p.player_id}`} className="block text-sm font-medium hover:text-cyan-400 truncate">{playerName(p.player_id)}</Link>
              <div className="text-[10px] font-mono-hud text-slate-500 truncate">{p.champion}</div>
            </div>
          </div>
        </td>
        {STATS.map((st) => (
          <td key={st.key} className="py-2 px-2 text-right font-mono-hud text-sm">
            {fmt(raw[st.key])}
            <div className="text-[10px] text-slate-500">{pct(d[`${st.key}_team_share`])}</div>
          </td>
        ))}
        <td className="py-2 pl-2 text-right font-mono-hud text-sm text-cyan-400">{fmt(d.damage_normalised, 1)}</td>
        <td className="py-2 pl-2 text-right"><MmrChange p={p} size="text-xs" /></td>
      </tr>
    );
  });

  // Who played what - shown when the match has no scoreboard stats
  const lineup = (team) => {
    const won = match.winner_team === team;
    return (
      <div className="min-w-0">
        <div className={`font-heading font-black uppercase tracking-wide text-sm mb-1 ${team === "A" ? "text-cyan-400" : "text-[#FF2E55]"}`}>
          Team {team} {won && <span className="text-[10px] font-mono-hud text-[#00E676] ml-1">WIN</span>}
        </div>
        {match.players.filter((p) => p.team === team).map((p) => (
          <div key={`${team}-${p.player_id}`} className="flex items-center gap-2 py-1.5 border-t border-[#1B2438]">
            <ChampionPortrait name={p.champion} role={p.role} size={24} />
            <div className="min-w-0 flex-1">
              <Link to={`/players/${p.player_id}`} className="block text-sm font-medium hover:text-cyan-400 truncate">{playerName(p.player_id)}</Link>
              <div className="text-[10px] font-mono-hud text-slate-500 truncate">{p.champion}</div>
            </div>
            <MmrChange p={p} size="text-xs" />
          </div>
        ))}
      </div>
    );
  };

  const header = (team, won) => (
    <tr>
      <th className={`text-left py-2 pr-3 font-heading font-black uppercase tracking-wide ${team === "A" ? "text-cyan-400" : "text-[#FF2E55]"}`}>
        Team {team} {won && <span className="text-[10px] font-mono-hud text-[#00E676] ml-1">WIN</span>}
      </th>
      {STATS.map((s) => <th key={s.key} className="py-2 px-2 text-right text-[10px] font-mono-hud uppercase tracking-wider text-slate-500 font-normal">{s.label}</th>)}
      <th className="py-2 pl-2 text-right text-[10px] font-mono-hud uppercase tracking-wider text-slate-500 font-normal" title="Damage minus the enemy team's protection, split by each player's share of their team's damage">Norm. dmg</th>
      <th className="py-2 pl-2 text-right text-[10px] font-mono-hud uppercase tracking-wider text-slate-500 font-normal">MMR</th>
    </tr>
  );

  return (
    <div className="mt-4 pt-4 border-t border-[#1B2438] space-y-4" data-testid={`match-details-${match.id}`}>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] font-mono-hud uppercase tracking-wider text-slate-400">
        {seasonName && <span>{seasonName}</span>}
        {match.map && <span>{match.map}</span>}
        <span>{match.team_a_rounds + match.team_b_rounds} rounds</span>
        {match.team_a_mmr_before != null && <span>Avg MMR {Math.round(match.team_a_mmr_before)} vs {Math.round(match.team_b_mmr_before)}</span>}
        {match.source === "discord" && match.source_ref && (
          <a href={match.source_ref} target="_blank" rel="noreferrer" className="text-cyan-400 hover:underline">Discord</a>
        )}
        {shotUrl && (
          <a href={shotUrl} target="_blank" rel="noreferrer" className="text-cyan-400 hover:underline flex items-center gap-1">
            <ImageIcon className="w-3 h-3" /> Screenshot
          </a>
        )}
      </div>

      {error ? (
        <div className="text-sm text-slate-500">Couldn't load stats for this match.</div>
      ) : !stats || !hasStats ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
            {lineup("A")}
            {lineup("B")}
          </div>
          <div className="text-[11px] text-slate-500 font-mono-hud">
            {!stats ? "Loading stats…" : "No scoreboard stats were recorded for this match."}
          </div>
        </>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-slate-100">
              <tbody>
                {header("A", match.winner_team === "A")}
                {teamRows("A")}
                <tr><td colSpan={7} className="h-3" /></tr>
                {header("B", match.winner_team === "B")}
                {teamRows("B")}
              </tbody>
            </table>
          </div>
          <div className="text-[11px] text-slate-500">
            Scoreboard values are round averages (Average Total tab). Small % = share of own team.
            Norm. dmg = damage minus enemy protection × damage share.
          </div>
        </>
      )}
    </div>
  );
}
