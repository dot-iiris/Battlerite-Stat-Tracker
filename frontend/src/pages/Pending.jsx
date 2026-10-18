import { useCallback, useEffect, useState } from "react";
import api, { API } from "@/api";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, ImageUp, Inbox, Link2, RefreshCw, Trash2, XCircle } from "lucide-react";
import { invalidateChampionStats } from "@/lib/championStats";
import OcrAccuracy from "@/components/OcrAccuracy";

const STAT_FIELDS = ["score", "damage", "protection", "disables"];
const inputCls = "bg-[#121828] border border-[#1B2438] focus:border-cyan-400 focus:outline-none rounded px-2 py-1.5 text-sm";

function PendingMatchCard({ pm, playerName, champions, seasonName, onDone }) {
  const roster = [
    ...pm.team_a.map((id) => ({ id, team: "A" })),
    ...pm.team_b.map((id) => ({ id, team: "B" })),
  ];
  const prefill = pm.prefill?.players || {};
  const [picks, setPicks] = useState(() =>
    Object.fromEntries(roster.map((r) => {
      const pre = prefill[r.id] || {};
      const st = pre.stats || {};
      const val = (f) => (st[f] === null || st[f] === undefined ? "" : String(st[f]));
      return [r.id, { champion: pre.champion || "", score: val("score"), damage: val("damage"), protection: val("protection"), disables: val("disables") }];
    }))
  );
  const [teams, setTeams] = useState(() =>
    Object.fromEntries(roster.map((r) => [r.id, pm.prefill?.teams?.[r.id] || r.team]))
  );
  const swapTeam = (pid) => setTeams((t) => ({ ...t, [pid]: t[pid] === "A" ? "B" : "A" }));
  const [aRounds, setARounds] = useState(pm.team_a_rounds ?? "");
  const [bRounds, setBRounds] = useState(pm.team_b_rounds ?? "");
  const [busy, setBusy] = useState(false);
  const warnings = pm.prefill?.warnings || [];
  const shotUrl = pm.screenshot ? `${API}/pending-matches/${pm.id}/screenshot?v=${encodeURIComponent(pm.screenshot.uploaded_at)}` : null;

  const upload = async (file) => {
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    setBusy(true);
    try {
      await api.post(`/pending-matches/${pm.id}/screenshot`, form);
      toast.success("Screenshot read — check the values");
      onDone();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  const reparse = async () => {
    setBusy(true);
    try {
      await api.post(`/pending-matches/${pm.id}/reparse`);
      toast.success("Read the screenshot again");
      onDone();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed");
    } finally {
      setBusy(false);
    }
  };

  const set = (pid, key, val) => setPicks((p) => ({ ...p, [pid]: { ...p[pid], [key]: val } }));

  const complete = async () => {
    for (const r of roster) {
      if (!picks[r.id].champion) { toast.error(`Pick a champion for ${playerName(r.id)}`); return; }
    }
    if (roster.filter((r) => teams[r.id] === "A").length * 2 !== roster.length) { toast.error("Both teams need the same number of players"); return; }
    for (const team of ["A", "B"]) {
      const champs = roster.filter((r) => teams[r.id] === team).map((r) => picks[r.id].champion);
      if (new Set(champs).size !== champs.length) { toast.error(`Team ${team} has the same champion twice`); return; }
    }
    if (aRounds === "" || bRounds === "") { toast.error("Enter the round score"); return; }
    if (Number(aRounds) === Number(bRounds)) { toast.error("Rounds cannot be tied"); return; }
    const players = roster.map((r) => {
      const p = picks[r.id];
      const filled = STAT_FIELDS.filter((f) => p[f] !== "");
      const stats = filled.length
        ? Object.fromEntries(STAT_FIELDS.map((f) => [f, p[f] === "" ? null : Number(p[f])]))
        : null;
      return { player_id: r.id, champion: p.champion, team: teams[r.id], stats };
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
      {roster.filter((r) => teams[r.id] === team).map((r) => (
        <div key={r.id} className="grid grid-cols-2 sm:grid-cols-6 gap-2 items-center">
          <div className="col-span-2 sm:col-span-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold truncate">{playerName(r.id)}</span>
              <button type="button" onClick={() => swapTeam(r.id)} title="Move to the other team"
                className="text-[10px] font-mono-hud text-slate-500 hover:text-cyan-400 border border-[#1B2438] rounded px-1">⇄</button>
            </div>
            {prefill[r.id]?.ocr_name && (
              <div className={`text-[10px] font-mono-hud truncate ${prefill[r.id].name_confidence < 0.6 ? "text-amber-400" : "text-slate-500"}`}
                title="Name read from the screenshot">
                read as "{prefill[r.id].ocr_name}"{prefill[r.id].champion_source === "icon" ? " · champ from portrait" : ""}
              </div>
            )}
          </div>
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
      {pm.needs_check?.length > 0 ? (
        <div className="text-xs text-amber-400 space-y-1" data-testid={`pending-needs-${pm.id}`}>
          <div className="font-semibold">The players confirmed the score ({pm.team_a_rounds}-{pm.team_b_rounds}) but it couldn't be logged as read - finish it below:</div>
          <ul className="list-disc pl-5">{pm.needs_check.map((r, i) => <li key={i}>{r}</li>)}</ul>
        </div>
      ) : pm.source === "discord" && (
        <div className="text-xs text-slate-400">
          The players are confirming the round score in Discord - it logs itself once they do, with the rest read from the screenshot. Logging or discarding it here overrides them.
        </div>
      )}
      <div className="flex flex-wrap items-start gap-4">
        {shotUrl ? (
          <a href={shotUrl} target="_blank" rel="noreferrer" className="block w-full sm:w-80 shrink-0" title="Open full size">
            <img src={shotUrl} alt="Scoreboard screenshot" className="w-full rounded border border-[#1B2438]" />
          </a>
        ) : (
          <div className="text-xs text-amber-400">No screenshot - enter the result by hand, or upload one.</div>
        )}
        <div className="flex-1 min-w-[12rem] space-y-2">
          {warnings.length > 0 && (
            <ul className="space-y-1">
              {warnings.map((w, i) => (
                <li key={i} className="flex items-start gap-1.5 text-xs text-amber-400"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{w}</li>
              ))}
            </ul>
          )}
          {pm.screenshot && warnings.length === 0 && (
            <div className="text-xs text-slate-400">Values below were read from the screenshot — compare and fix anything wrong.</div>
          )}
          <div className="flex flex-wrap gap-2">
            <label className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono-hud uppercase border border-[#1B2438] hover:border-cyan-400 rounded cursor-pointer ${busy ? "opacity-60 pointer-events-none" : ""}`}>
              <ImageUp className="w-3.5 h-3.5" /> {pm.screenshot ? "Replace screenshot" : "Upload screenshot"}
              <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
            </label>
            {pm.screenshot && (
              <button onClick={reparse} disabled={busy} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono-hud uppercase border border-[#1B2438] hover:border-cyan-400 rounded disabled:opacity-60">
                <RefreshCw className="w-3.5 h-3.5" /> Read again
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="hidden sm:grid grid-cols-6 gap-2 text-[10px] font-mono-hud uppercase tracking-wider text-slate-500">
        <span>Player</span><span>Champion</span>{STAT_FIELDS.map((f) => <span key={f}>{f} avg (optional)</span>)}
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

function CheckCard({ m, playerName, onDone }) {
  const done = async () => {
    try {
      await api.post(`/matches/${m.id}/checked`);
      toast.success("Marked as checked");
      onDone();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed");
    }
  };
  const team = (t) => m.players.filter((p) => p.team === t).map((p) => `${playerName(p.player_id)} (${p.champion})`).join(", ");
  return (
    <div className="hud-card p-4 space-y-2" data-testid={`check-${m.id}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-mono-hud uppercase tracking-wider text-slate-400">
        <span className="text-cyan-400">#{m.discord_match_id || m.id.slice(0, 8)}</span>
        <span>{m.format}</span>
        <span>{new Date(m.played_at).toLocaleString()}</span>
        {m.confirmed_by && <span>Score confirmed by {m.confirmed_by}</span>}
      </div>
      <div className="text-sm"><span className="text-cyan-400 font-semibold">A {m.team_a_rounds}</span> · {team("A")}</div>
      <div className="text-sm"><span className="text-[#FF2E55] font-semibold">B {m.team_b_rounds}</span> · {team("B")}</div>
      <ul className="space-y-1">
        {m.needs_check.map((r, i) => (
          <li key={i} className="flex items-start gap-1.5 text-xs text-amber-400"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{r}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2 pt-1">
        <a href={`/matches?match=${m.id}`} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono-hud uppercase border border-[#1B2438] hover:border-cyan-400 rounded">
          Open match (edit there)
        </a>
        <button onClick={done} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono-hud uppercase bg-cyan-400 text-black font-bold rounded"
          data-testid={`check-done-${m.id}`}>
          <CheckCircle2 className="w-3.5 h-3.5" /> Looks right
        </button>
      </div>
    </div>
  );
}

export default function Pending() {
  const [toCheck, setToCheck] = useState([]);
  const [pending, setPending] = useState([]);
  const [links, setLinks] = useState([]);
  const [players, setPlayers] = useState([]);
  const [champions, setChampions] = useState([]);
  const [seasons, setSeasons] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [pm, lr, p, c, s, tc] = await Promise.all([
      api.get("/pending-matches"), api.get("/link-requests"),
      api.get("/players"), api.get("/champions"), api.get("/seasons"),
      api.get("/matches-to-check").catch(() => ({ data: [] })),
    ]);
    setPending(pm.data); setLinks(lr.data); setPlayers(p.data); setChampions(c.data); setSeasons(s.data); setToCheck(tc.data);
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
        <p className="text-sm text-slate-400 mt-2">Matches reported from Discord wait here while the players confirm the round score in Discord (or until an admin logs them here). Screenshots are read automatically — check every value before logging. Stats come from the scoreboard's Average Total tab.</p>
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
            {r.new_player && (
              <span className="text-[10px] font-mono-hud uppercase tracking-wider px-1.5 py-0.5 border border-amber-400/50 text-amber-400 rounded" title="No player with this name yet - approving creates them">new player</span>
            )}
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
          <PendingMatchCard key={`${pm.id}-${pm.parsed_at || ""}`} pm={pm} playerName={playerName} champions={champions}
            seasonName={seasonName} onDone={load} />
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 font-heading text-xl font-black uppercase"><AlertTriangle className="w-5 h-5 text-amber-400" /> Logged matches to check</h2>
        <p className="text-sm text-slate-400">The players confirmed these scores and they're logged, but something on the scoreboard wasn't read cleanly. Compare with the screenshot, fix anything on the match if needed, then mark it checked.</p>
        {toCheck.length === 0 ? (
          <div className="text-sm text-slate-500">Nothing to check.</div>
        ) : toCheck.map((m) => <CheckCard key={m.id} m={m} playerName={playerName} onDone={load} />)}
      </section>

      <OcrAccuracy key={pending.length} />
    </div>
  );
}
