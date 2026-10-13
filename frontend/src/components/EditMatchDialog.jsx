import { useEffect, useRef, useState } from "react";
import api, { API } from "@/api";
import { toast } from "sonner";
import { X, Save, AlertTriangle, Image as ImageIcon } from "lucide-react";
import { invalidateChampionStats } from "@/lib/championStats";

const STAT_FIELDS = ["score", "damage", "protection", "disables"];
const SHORT = { score: "score", damage: "dmg", protection: "prot", disables: "disables" };
const statStr = (v) => (v === null || v === undefined ? "" : String(v));
const toSlot = (p) => ({
  player_id: p.player_id, champion: p.champion,
  ...Object.fromEntries(STAT_FIELDS.map((f) => [f, statStr(p.stats?.[f])])),
});
const emptySlot = () => ({ player_id: "", champion: "", score: "", damage: "", protection: "", disables: "" });

const roleClass = (r) => r === "Melee" ? "role-bg-melee" : r === "Ranged" ? "role-bg-ranged" : "role-bg-support";

// With `screenshot` (from /screenshots/read), the form starts filled from what was read; saving
// attaches the screenshot, and what you save is compared with what was read.
function readSlots(match, screenshot) {
  const read = screenshot?.players || {};
  const teamOf = (p) => screenshot?.teams?.[p.player_id] || p.team;
  const slot = (p) => {
    const base = toSlot(p);
    const r = read[p.player_id] || {};
    const out = { ...base, champion: r.champion || base.champion };
    for (const f of STAT_FIELDS) {
      const v = r.stats?.[f];
      if (v !== null && v !== undefined) out[f] = String(v);
    }
    return out;
  };
  let a = match.players.filter((p) => teamOf(p) === "A");
  let b = match.players.filter((p) => teamOf(p) === "B");
  if (a.length !== b.length) {   // the screenshot's teams don't add up - keep the logged ones
    a = match.players.filter((p) => p.team === "A");
    b = match.players.filter((p) => p.team === "B");
  }
  return [a.map(slot), b.map(slot)];
}

export default function EditMatchDialog({ match, screenshot = null, onClose, onSaved }) {
  const [initA, initB] = readSlots(match, screenshot);
  const [seasons, setSeasons] = useState([]);
  const [players, setPlayers] = useState([]);
  const [champions, setChampions] = useState([]);
  const [format, setFormat] = useState(match.format);
  const [seasonId, setSeasonId] = useState(match.season_id);
  const [teamARounds, setTeamARounds] = useState(match.team_a_rounds);
  const [teamBRounds, setTeamBRounds] = useState(match.team_b_rounds);
  const [teamA, setTeamA] = useState(initA);
  const [teamB, setTeamB] = useState(initB);
  const [notes, setNotes] = useState(match.notes || "");
  const [submitting, setSubmitting] = useState(false);
  const saved = useRef(false);
  // closing without saving: the read screenshot isn't kept
  const close = () => {
    if (screenshot && !saved.current) api.delete(`/screenshots/${screenshot.screenshot_id}`).catch(() => {});
    onClose();
  };

  useEffect(() => {
    (async () => {
      const [s, p, c] = await Promise.all([api.get("/seasons"), api.get("/players"), api.get("/champions")]);
      setSeasons(s.data); setPlayers(p.data); setChampions(c.data);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getChampRole = (name) => champions.find((c) => c.name === name)?.role || "";

  const usedPlayers = new Set([...teamA, ...teamB].map((s) => s.player_id).filter(Boolean));
  const usedChampsA = new Set(teamA.map((s) => s.champion).filter(Boolean));
  const usedChampsB = new Set(teamB.map((s) => s.champion).filter(Boolean));

  const applyFormat = (fmt) => {
    setFormat(fmt);
    const size = { "1v1": 1, "2v2": 2, "3v3": 3 }[fmt];
    setTeamA((cur) => Array.from({ length: size }, (_, i) => cur[i] || emptySlot()));
    setTeamB((cur) => Array.from({ length: size }, (_, i) => cur[i] || emptySlot()));
  };

  const setSlot = (side, idx, key, val) => {
    const setter = side === "A" ? setTeamA : setTeamB;
    setter((cur) => cur.map((s, i) => i === idx ? { ...s, [key]: val } : s));
  };

  const submit = async (e) => {
    e.preventDefault();
    if (teamARounds === teamBRounds) { toast.error("Rounds cannot be tied"); return; }
    const all = [...teamA.map((s) => ({ ...s, team: "A" })), ...teamB.map((s) => ({ ...s, team: "B" }))];
    for (const s of all) if (!s.player_id || !s.champion) { toast.error("Fill all slots"); return; }
    const pids = all.map((s) => s.player_id);
    if (new Set(pids).size !== pids.length) { toast.error("A player can only appear once per match"); return; }
    for (const label of ["A", "B"]) {
      const champs = all.filter((s) => s.team === label).map((s) => s.champion);
      if (new Set(champs).size !== champs.length) { toast.error(`Team ${label} cannot pick the same champion twice`); return; }
    }
    setSubmitting(true);
    try {
      const { data } = await api.put(`/matches/${match.id}`, {
        season_id: seasonId, format, notes, screenshot_id: screenshot?.screenshot_id || null,
        team_a_rounds: Number(teamARounds), team_b_rounds: Number(teamBRounds),
        players: all.map((s) => {
          const filled = STAT_FIELDS.some((f) => s[f] !== "");
          return {
            player_id: s.player_id, champion: s.champion, role: getChampRole(s.champion), team: s.team,
            stats: filled ? Object.fromEntries(STAT_FIELDS.map((f) => [f, s[f] === "" ? null : Number(s[f])])) : null,
          };
        }),
      });
      invalidateChampionStats();
      toast.success(screenshot ? "Screenshot added · match updated" : "Match updated · ELO recomputed");
      saved.current = true;
      onSaved(data);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed");
    } finally { setSubmitting(false); }
  };

  const renderTeam = (side, roster, color) => (
    <div>
      <h4 className={`font-heading text-base font-black uppercase mb-3 ${color}`}>Team {side}</h4>
      <div className="space-y-2">
        {roster.map((slot, i) => (
          <div key={`${side}-${i}`} className="grid grid-cols-2 gap-2 pb-2 border-b border-[#1B2438]/60 last:border-0">
            <select value={slot.player_id} onChange={(e) => setSlot(side, i, "player_id", e.target.value)}
              className="bg-[#121828] border border-[#1B2438] rounded px-2 py-1.5 text-sm" data-testid={`edit-player-${side}-${i}`}>
              <option value="">Player…</option>
              {players.map((p) => <option key={p.id} value={p.id} disabled={p.id !== slot.player_id && usedPlayers.has(p.id)}>{p.name}{p.id !== slot.player_id && usedPlayers.has(p.id) ? " (picked)" : ""}</option>)}
            </select>
            <select value={slot.champion} onChange={(e) => setSlot(side, i, "champion", e.target.value)}
              className="bg-[#121828] border border-[#1B2438] rounded px-2 py-1.5 text-sm" data-testid={`edit-champion-${side}-${i}`}>
              <option value="">Champion…</option>
              {champions.map((c) => {
                const teamChamps = side === "A" ? usedChampsA : usedChampsB;
                const dup = c.name !== slot.champion && teamChamps.has(c.name);
                return <option key={c.name} value={c.name} disabled={dup}>{c.name} ({c.role}){dup ? " · in team" : ""}</option>;
              })}
            </select>
            <div className="col-span-2 grid grid-cols-4 gap-1.5">
              {STAT_FIELDS.map((f) => (
                <input key={f} type="number" min="0" placeholder={SHORT[f]} title={`${f} (round average)`} value={slot[f]}
                  onChange={(e) => setSlot(side, i, f, e.target.value)}
                  className="bg-[#0C101B] border border-[#1B2438] focus:border-cyan-400 focus:outline-none rounded px-1.5 py-1 text-xs font-mono-hud min-w-0"
                  data-testid={`edit-${f}-${side}-${i}`} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto" onClick={close} data-testid="edit-match-dialog">
      <div className="hud-card hud-corner w-full max-w-3xl my-8 p-6 relative" onClick={(e) => e.stopPropagation()}>
        <button onClick={close} className="absolute top-3 right-3 text-slate-500 hover:text-white p-1" data-testid="edit-close"><X className="w-5 h-5" /></button>
        <h2 className="font-heading text-2xl font-black uppercase tracking-tight mb-4">{screenshot ? "Add Screenshot" : "Edit Match"}</h2>
        {screenshot && (
          <div className="mb-4 flex flex-wrap gap-3 items-start text-xs text-slate-300 border border-cyan-400/30 bg-cyan-400/5 rounded p-3">
            <a href={`${API}/screenshots/${screenshot.screenshot_id}`} target="_blank" rel="noreferrer" className="block w-40 shrink-0" title="Open full size">
              <img src={`${API}/screenshots/${screenshot.screenshot_id}`} alt="Scoreboard" className="w-full rounded border border-[#1B2438]" />
            </a>
            <div className="space-y-1 min-w-0 flex-1">
              <div className="flex items-center gap-1 text-cyan-400"><ImageIcon className="w-3.5 h-3.5" /> Filled in from the screenshot - check it against the image, fix anything wrong, then save.</div>
              <div className="text-slate-500">What you save is compared with what was read: any fix counts as a correction for the reader.</div>
              {(screenshot.warnings || []).map((w, i) => (
                <div key={i} className="flex items-start gap-1 text-amber-400"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {w}</div>
              ))}
            </div>
          </div>
        )}
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-mono-hud uppercase tracking-[0.2em] text-cyan-400/80 mb-1.5">Season</label>
              <select value={seasonId} onChange={(e) => setSeasonId(e.target.value)} className="w-full bg-[#121828] border border-[#1B2438] rounded px-2 py-1.5 text-sm" data-testid="edit-season">
                {seasons.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-mono-hud uppercase tracking-[0.2em] text-cyan-400/80 mb-1.5">Format</label>
              <div className="flex gap-1">
                {["1v1", "2v2", "3v3"].map((f) => (
                  <button type="button" key={f} onClick={() => applyFormat(f)}
                    className={`flex-1 px-2 py-1.5 font-mono-hud text-xs uppercase rounded border ${format === f ? "bg-cyan-400 text-black border-cyan-400 font-bold" : "bg-[#121828] border-[#1B2438] text-slate-300"}`}
                    data-testid={`edit-format-${f}`}>{f}</button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-xs font-mono-hud uppercase tracking-[0.2em] text-cyan-400/80 mb-1.5">Notes</label>
              <input value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full bg-[#121828] border border-[#1B2438] rounded px-2 py-1.5 text-sm" data-testid="edit-notes" />
            </div>
          </div>
          <div className="text-[11px] text-slate-500">Stats under each player are optional round averages (score · damage · protection · disables) from the Average Total tab.</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
            {renderTeam("A", teamA, "text-cyan-400")}
            {renderTeam("B", teamB, "text-[#FF2E55]")}
          </div>
          <div className="flex items-center justify-center gap-4 py-3 border-y border-[#1B2438]">
            <div className="text-center">
              <div className="text-[10px] font-mono-hud uppercase tracking-[0.2em] text-cyan-400 mb-1">A rounds</div>
              <input type="number" min="0" max="20" value={teamARounds}
                onChange={(e) => setTeamARounds(Number(e.target.value))}
                className="w-16 bg-[#121828] border border-[#1B2438] rounded px-2 py-1 font-mono-hud text-xl font-bold text-center text-cyan-400"
                data-testid="edit-rounds-a" />
            </div>
            <div className="font-mono-hud text-2xl font-black text-slate-600 self-end pb-1">:</div>
            <div className="text-center">
              <div className="text-[10px] font-mono-hud uppercase tracking-[0.2em] text-[#FF2E55] mb-1">B rounds</div>
              <input type="number" min="0" max="20" value={teamBRounds}
                onChange={(e) => setTeamBRounds(Number(e.target.value))}
                className="w-16 bg-[#121828] border border-[#1B2438] rounded px-2 py-1 font-mono-hud text-xl font-bold text-center text-[#FF2E55]"
                data-testid="edit-rounds-b" />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-3 border-t border-[#1B2438]">
            <button type="button" onClick={close} className="px-4 py-2 text-sm font-mono-hud uppercase border border-[#1B2438] rounded hover:border-slate-400">Cancel</button>
            <button type="submit" disabled={submitting} className="btn-glow bg-cyan-400 hover:bg-cyan-300 text-black font-mono-hud font-bold uppercase tracking-wider px-4 py-2 rounded flex items-center gap-2 disabled:opacity-60" data-testid="edit-submit">
              <Save className="w-4 h-4" strokeWidth={3} /> {submitting ? "Saving…" : "Save & Recompute"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
