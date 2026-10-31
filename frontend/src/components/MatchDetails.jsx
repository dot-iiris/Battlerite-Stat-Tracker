import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import api, { API } from "@/api";
import { Image as ImageIcon, ImagePlus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/AuthContext";
import EditMatchDialog from "@/components/EditMatchDialog";
import MmrChange from "@/components/MmrChange";
import ChampionPortrait from "@/components/ChampionPortrait";
import { teamPlayers } from "@/lib/roleOrder";

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
// highlight(p): true for the player/champion the page is about; tone "cyan" (player) or "gold" (champion)
const TONES = {
  cyan: { row: "bg-cyan-400/[0.07]", ring: "ring-cyan-400", name: "text-cyan-400 font-bold" },
  gold: { row: "bg-[#FFB800]/[0.07]", ring: "ring-[#FFB800]", name: "text-[#FFB800] font-bold" },
};

// A tournament game passes statsPath and screenshotUrl (it isn't a logged match), editable={false},
// teamNames {A, B} and showMmr={false} when the tournament doesn't move MMR.
export default function MatchDetails({ match, playerName, seasonName, onChanged, highlight = null, tone = "cyan",
  statsPath = null, screenshotUrl, editable = true, teamNames = null, showMmr = true }) {
  const teamLabel = (team) => teamNames?.[team] || `Team ${team}`;
  const hl = (p) => !!highlight && highlight(p);
  const T = TONES[tone] || TONES.cyan;
  const portrait = (p) => (
    <span className={`inline-flex leading-[0] rounded flex-shrink-0 ${hl(p) ? `ring-2 ${T.ring} ring-offset-1 ring-offset-[#0C101B]` : ""}`}>
      <ChampionPortrait name={p.champion} role={p.role} size={24} />
    </span>
  );
  const nameClass = (p) => `block text-sm font-medium hover:text-cyan-400 truncate ${hl(p) ? T.name : ""}`;
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(false);
  const { isAdmin } = useAuth();
  const [shotId, setShotId] = useState(match.screenshot_id || null);   // admins can add/replace/remove it here
  const [shotBusy, setShotBusy] = useState(false);
  const fileRef = useRef(null);
  useEffect(() => { setShotId(match.screenshot_id || null); }, [match.screenshot_id]);

  const [reading, setReading] = useState(null);   // what was read from a new screenshot, for the edit form
  const uploadShot = async (file) => {
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    form.append("team_a", match.players.filter((p) => p.team === "A").map((p) => p.player_id).join(","));
    form.append("team_b", match.players.filter((p) => p.team === "B").map((p) => p.player_id).join(","));
    form.append("match_id", match.id);
    setShotBusy(true);
    try {
      const { data } = await api.post("/screenshots/read", form);
      setReading(data);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Couldn't read that screenshot");
    } finally {
      setShotBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const removeShot = async () => {
    if (!window.confirm("Remove this match's screenshot? The match itself isn't changed.")) return;
    try {
      await api.delete(`/matches/${match.id}/screenshot`);
      setShotId(null);
      match.screenshot_id = null;
      toast.success("Screenshot removed");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Couldn't remove it");
    }
  };

  useEffect(() => {
    let alive = true;
    api.get(statsPath || `/matches/${match.id}/stats`)
      .then((r) => alive && setStats(r.data))
      .catch(() => alive && setError(true));
    return () => { alive = false; };
  }, [match.id, statsPath]);

  const byPlayer = Object.fromEntries((stats?.players || []).map((p) => [p.player_id, p]));
  const hasStats = (stats?.players || []).some((p) => p.raw);
  const shotUrl = screenshotUrl !== undefined ? screenshotUrl : shotId ? `${API}/matches/${match.id}/screenshot?v=${shotId}` : null;

  const teamRows = (team) => teamPlayers(match.players, team).map((p) => {
    const s = byPlayer[p.player_id] || {};
    const raw = s.raw || {};
    const d = s.derived || {};
    return (
      <tr key={`${team}-${p.player_id}`} className={`border-t border-[#1B2438] ${hl(p) ? T.row : ""}`}>
        <td className="py-2 pr-3 pl-1">
          <div className="flex items-center gap-2 min-w-0">
            {portrait(p)}
            <div className="min-w-0">
              <Link to={`/players/${p.player_id}`} className={nameClass(p)}>{playerName(p.player_id)}</Link>
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
        {showMmr && <td className="py-2 pl-2 text-right"><MmrChange p={p} size="text-xs" /></td>}
      </tr>
    );
  });

  // Who played what - shown when the match has no scoreboard stats
  const lineup = (team) => {
    const won = match.winner_team === team;
    return (
      <div className="min-w-0">
        <div className={`font-heading font-black uppercase tracking-wide text-sm mb-1 ${team === "A" ? "text-cyan-400" : "text-[#FF2E55]"}`}>
          {teamLabel(team)} {won && <span className="text-[10px] font-mono-hud text-[#00E676] ml-1">WIN</span>}
        </div>
        {teamPlayers(match.players, team).map((p) => (
          <div key={`${team}-${p.player_id}`} className={`flex items-center gap-2 py-1.5 px-1 border-t border-[#1B2438] ${hl(p) ? T.row : ""}`}>
            {portrait(p)}
            <div className="min-w-0 flex-1">
              <Link to={`/players/${p.player_id}`} className={nameClass(p)}>{playerName(p.player_id)}</Link>
              <div className="text-[10px] font-mono-hud text-slate-500 truncate">{p.champion}</div>
            </div>
            {showMmr && <MmrChange p={p} size="text-xs" />}
          </div>
        ))}
      </div>
    );
  };

  const header = (team, won) => (
    <tr>
      <th className={`text-left py-2 pr-3 font-heading font-black uppercase tracking-wide ${team === "A" ? "text-cyan-400" : "text-[#FF2E55]"}`}>
        {teamLabel(team)} {won && <span className="text-[10px] font-mono-hud text-[#00E676] ml-1">WIN</span>}
      </th>
      {STATS.map((s) => <th key={s.key} className="py-2 px-2 text-right text-[10px] font-mono-hud uppercase tracking-wider text-slate-500 font-normal">{s.label}</th>)}
      <th className="py-2 pl-2 text-right text-[10px] font-mono-hud uppercase tracking-wider text-slate-500 font-normal" title="Damage minus the enemy team's protection, split by each player's share of their team's damage">Norm. dmg</th>
      {showMmr && <th className="py-2 pl-2 text-right text-[10px] font-mono-hud uppercase tracking-wider text-slate-500 font-normal">MMR</th>}
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
        {isAdmin && editable && (
          <>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
              onChange={(e) => uploadShot(e.target.files?.[0])} data-testid={`match-shot-input-${match.id}`} />
            <button type="button" disabled={shotBusy} onClick={() => fileRef.current?.click()}
              className="text-slate-400 hover:text-cyan-400 flex items-center gap-1 uppercase disabled:opacity-50">
              <ImagePlus className="w-3 h-3" /> {shotBusy ? "Reading…" : shotId ? "Replace screenshot" : "Add screenshot"}
            </button>
            {shotId && (
              <button type="button" onClick={removeShot} className="text-slate-500 hover:text-[#FF2E55] flex items-center gap-1 uppercase">
                <Trash2 className="w-3 h-3" /> Remove
              </button>
            )}
          </>
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
      {reading && (
        // keep clicks in the dialog from also opening/closing the match card underneath
        <div onClick={(e) => e.stopPropagation()}>
        <EditMatchDialog match={match} screenshot={reading} onClose={() => setReading(null)}
          onSaved={(updated) => {
            setReading(null);
            setShotId(updated?.screenshot_id || null);
            match.screenshot_id = updated?.screenshot_id || null;
            onChanged?.();
          }} />
        </div>
      )}
    </div>
  );
}
