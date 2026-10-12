import { useCallback, useEffect, useState } from "react";
import api from "@/api";
import { toast } from "sonner";
import { CheckCircle2, Inbox, Link2, Trash2, XCircle } from "lucide-react";
import { invalidateChampionStats } from "@/lib/championStats";

const STAT_FIELDS = ["score", "damage", "protection", "disables"];
const inputCls = "bg-[#121828] border border-[#1B2438] focus:border-cyan-400 focus:outline-none rounded px-2 py-1.5 text-sm";

function PendingMatchCard({ pm, playerName, champions, seasonName, onDone }) {
  const roster = [
    ...pm.team_a.map((id) => ({ id, team: "A" })),
    ...pm.team_b.map((id) => ({ id, team: "B" })),
  ];
  const [picks, setPicks] = useState(() =>
    Object.fromEntries(roster.map((r) => [r.id, { champion: "", score: "", damage: "", protection: "", disables: "" }]))
  );
  const [aRounds, setARounds] = useState(pm.team_a_rounds);
  const [bRounds, setBRounds] = useState(pm.team_b_rounds);
  const [busy, setBusy] = useState(false);

  const set = (pid, key, val) => setPicks((p) => ({ ...p, [pid]: { ...p[pid], [key]: val } }));

  const complete = async () => {
    for (const r of roster) {
      if (!picks[r.id].champion) { toast.error(`Pick a champion for ${playerName(r.id)}`); return; }
    }
    for (const team of ["A", "B"]) {
      const champs = roster.filter((r) => r.team === team).map((r) => picks[r.id].champion);
      if (new Set(champs).size !== champs.length) { toast.error(`Team ${team} has the same champion twice`); return; }
    }
    if (Number(aRounds) === Number(bRounds)) { toast.error("Rounds cannot be tied"); return; }
    const players = roster.map((r) => {
      const p = picks[r.id];
      const filled = STAT_FIELDS.filter((f) => p[f] !== "");
      const stats = filled.length
        ? Object.fromEntries(STAT_FIELDS.map((f) => [f, p[f] === "" ? null : Number(p[f])]))
        : null;
      return { player_id: r.id, champion: p.champion, stats };
    });
    setBusy(true);
    try {
      await api.post(`/pending-matches/${pm.id}/complete`, {
        players, team_a_rounds: Number(aRounds), team_b_rounds: Number(bRounds),
      });
      invalidateChampionStats();
      toast.success("Match logged");
      onDone();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to log match");
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (!window.confirm("Discard this reported match? It won't be logged.")) return;
    setBusy(true);
    try {
      await api.delete(`/pending-matches/${pm.id}`);
      toast.success("Discarded");
      onDone();
    } finally {
      setBusy(false);
    }
  };

  const renderTeam = (team, color) => (
    <div className="space-y-2">
      <div className={`font-heading font-black uppercase tracking-wide ${color}`}>Team {team}</div>
      {roster.filter((r) => r.team === team).map((r) => (
        <div key={r.id} className="grid grid-cols-2 sm:grid-cols-6 gap-2 items-center">
          <div className="col-span-2 sm:col-span-1 text-sm font-semibold truncate">{playerName(r.id)}</div>
          <select value={picks[r.id].champion} onChange={(e) => set(r.id, "champion", e.target.value)}
            className={`${inputCls} col-span-2 sm:col-span-1`} data-testid={`pending-champ-${r.id}`}>
            <option value="">Champion…</option>
            {champions.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.role})</option>)}
          </select>
          {STAT_FIELDS.map((f) => (
            <input key={f} type="number" min="0" placeholder={f} value={picks[r.id][f]}
              onChange={(e) => set(r.id, f, e.target.value)} className={inputCls} title={f} />
          ))}
        </div>
      ))}
    </div>
  );

  return (
    <div className="hud-card p-5 space-y-4" data-testid={`pending-${pm.id}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-mono-hud uppercase tracking-wider text-slate-400">
        <span className={pm.ranked ? "text-cyan-400" : "text-amber-400"}>{pm.ranked ? "Ranked" : "Unranked"}</span>
        <span>{pm.format}</span>
        <span>{seasonName(pm.season_id)}</span>
        {pm.map && <span>{pm.map}</span>}
        <span>{new Date(pm.played_at).toLocaleString()}</span>
        {pm.reported_by && <span>Reported by {pm.reported_by}</span>}
        {pm.confirmed_by && <span>Confirmed by {pm.confirmed_by}</span>}
        {pm.source_ref && <a href={pm.source_ref} target="_blank" rel="noreferrer" className="text-cyan-400 hover:underline">Discord message</a>}
      </div>
      <div className="hidden sm:grid grid-cols-6 gap-2 text-[10px] font-mono-hud uppercase tracking-wider text-slate-500">
        <span>Player</span><span>Champion</span>{STAT_FIELDS.map((f) => <span key={f}>{f} (optional)</span>)}
      </div>
      {renderTeam("A", "text-cyan-400")}
      {renderTeam("B", "text-[#FF2E55]")}
      <div className="flex flex-wrap items-center gap-3 pt-2">
        <span className="text-xs font-mono-hud uppercase tracking-wider text-slate-400">Rounds</span>
        <input type="number" min="0" max="20" value={aRounds} onChange={(e) => setARounds(e.target.value)} className={`${inputCls} w-16 text-center text-cyan-400`} />
        <span className="text-slate-500">:</span>
        <input type="number" min="0" max="20" value={bRounds} onChange={(e) => setBRounds(e.target.value)} className={`${inputCls} w-16 text-center text-[#FF2E55]`} />
        <div className="flex-1" />
        <button onClick={discard} disabled={busy} className="flex items-center gap-2 px-3 py-2 text-xs font-mono-hud uppercase tracking-wider text-slate-300 border border-[#1B2438] hover:border-[#FF2E55] hover:text-[#FF2E55] rounded disabled:opacity-60">
          <Trash2 className="w-3.5 h-3.5" /> Discard
        </button>
        <button onClick={complete} disabled={busy} className="btn-glow bg-cyan-400 hover:bg-cyan-300 text-black font-mono-hud font-bold uppercase tracking-wider px-4 py-2 rounded flex items-center gap-2 disabled:opacity-60" data-testid={`pending-complete-${pm.id}`}>
          <CheckCircle2 className="w-4 h-4" /> Log match
        </button>
      </div>
    </div>
  );
}

export default function Pending() {
  const [pending, setPending] = useState([]);
  const [links, setLinks] = useState([]);
  const [players, setPlayers] = useState([]);
  const [champions, setChampions] = useState([]);
  const [seasons, setSeasons] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [pm, lr, p, c, s] = await Promise.all([
      api.get("/pending-matches"), api.get("/link-requests"),
      api.get("/players"), api.get("/champions"), api.get("/seasons"),
    ]);
    setPending(pm.data); setLinks(lr.data); setPlayers(p.data); setChampions(c.data); setSeasons(s.data);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const playerName = (id) => players.find((p) => p.id === id)?.name || "Unknown player";
  const seasonName = (id) => seasons.find((s) => s.id === id)?.name || "";

  const decide = async (req, approve) => {
    try {
      await api.post(`/link-requests/${req.id}/decision`, { approve });
      toast.success(approve ? `Linked ${req.discord_name} to ${req.player_name}` : "Request denied");
      load();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed");
    }
  };

  return (
    <div className="space-y-8" data-testid="pending-page">
      <div>
        <div className="text-xs font-mono-hud uppercase tracking-[0.3em] text-cyan-400/70 mb-2">// Discord Inbox</div>
        <h1 className="font-heading text-4xl sm:text-5xl font-black uppercase tracking-tight">Pending</h1>
        <p className="text-sm text-slate-400 mt-2">Matches reported from Discord wait here until an admin adds champions. Stats are optional.</p>
      </div>

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 font-heading text-xl font-black uppercase"><Link2 className="w-5 h-5 text-cyan-400" /> Discord link requests</h2>
        {links.length === 0 ? (
          <div className="text-sm text-slate-500">No link requests waiting.</div>
        ) : links.map((r) => (
          <div key={r.id} className="hud-card p-4 flex flex-wrap items-center gap-3">
            <span className="font-semibold">{r.discord_name}</span>
            <span className="text-slate-500 text-sm">wants to be</span>
            <span className="font-semibold text-cyan-400">{r.player_name}</span>
            <span className="text-xs text-slate-500">{new Date(r.created_at).toLocaleString()}</span>
            <div className="flex-1" />
            <button onClick={() => decide(r, false)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono-hud uppercase border border-[#1B2438] hover:border-[#FF2E55] hover:text-[#FF2E55] rounded"><XCircle className="w-3.5 h-3.5" /> Deny</button>
            <button onClick={() => decide(r, true)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono-hud uppercase bg-cyan-400 text-black font-bold rounded"><CheckCircle2 className="w-3.5 h-3.5" /> Approve</button>
          </div>
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 font-heading text-xl font-black uppercase"><Inbox className="w-5 h-5 text-cyan-400" /> Reported matches</h2>
        {loading ? (
          <div className="text-sm text-slate-500">Loading…</div>
        ) : pending.length === 0 ? (
          <div className="text-sm text-slate-500">No matches waiting.</div>
        ) : pending.map((pm) => (
          <PendingMatchCard key={pm.id} pm={pm} playerName={playerName} champions={champions}
            seasonName={seasonName} onDone={load} />
        ))}
      </section>
    </div>
  );
}
