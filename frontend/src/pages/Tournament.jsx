import { useEffect, useMemo, useState } from "react";
import api from "@/api";
import { toast } from "sonner";
import { Trophy, Users, X, Zap, Copy, Ban, Link2, Armchair, Gauge } from "lucide-react";
import SeasonSelect, { newestSeason } from "@/components/SeasonSelect";

// Admins: split a group of players into the most even teams for a tournament. The pool, subs and
// rules are remembered in this browser, so they survive a page change.
const KEY = "brstats.tournament";
const load = () => { try { return JSON.parse(window.localStorage.getItem(KEY) || "null") || {}; } catch { return {}; } };
const save = (v) => { try { window.localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private window etc. */ } };

const MODES = [
  { key: "hybrid", label: "Hybrid", desc: "Mostly MMR, plus each team's best role line-up" },
  { key: "mmr", label: "MMR only", desc: "Average MMR only" },
  { key: "synergy", label: "Roles only", desc: "Each team's best role line-up only" },
];
const sel = "bg-[#121828] border border-[#1B2438] focus:border-cyan-400 focus:outline-none rounded px-3 py-2 text-sm";
const roleColor = (r) => (r === "Melee" ? "role-melee" : r === "Ranged" ? "role-ranged" : r === "Support" ? "role-support" : "text-slate-500");

export default function Tournament() {
  const saved = useMemo(load, []);
  const [players, setPlayers] = useState([]);
  const [seasons, setSeasons] = useState([]);
  const [seasonId, setSeasonId] = useState("");
  const [pool, setPool] = useState(() => new Set(saved.pool || []));
  const [subs, setSubs] = useState(() => new Set(saved.subs || []));
  const [rules, setRules] = useState(() => saved.rules || []);   // [{a, b, kind: "apart" | "together"}]
  const [overrides, setOverrides] = useState(() => saved.overrides || {});   // player id -> MMR, tournament only
  const [ovDraft, setOvDraft] = useState({ id: "", mmr: "" });
  const [format, setFormat] = useState(saved.format || "3v3");
  const [mode, setMode] = useState(saved.mode || "hybrid");
  const [draft, setDraft] = useState({ a: "", b: "", kind: "apart" });
  const [result, setResult] = useState(null);
  const [option, setOption] = useState(0);
  const [running, setRunning] = useState(false);

  useEffect(() => { save({ pool: [...pool], subs: [...subs], rules, format, mode, overrides }); }, [pool, subs, rules, format, mode, overrides]);

  useEffect(() => {
    Promise.all([api.get("/players"), api.get("/seasons")]).then(([p, s]) => {
      setPlayers(p.data);
      const known = new Set(p.data.map((x) => x.id));
      setPool((cur) => new Set([...cur].filter((id) => known.has(id))));
      setSubs((cur) => new Set([...cur].filter((id) => known.has(id))));
      setRules((cur) => cur.filter((r) => known.has(r.a) && known.has(r.b)));
      setOverrides((cur) => Object.fromEntries(Object.entries(cur).filter(([id]) => known.has(id))));
      setSeasons(s.data);
      setSeasonId(newestSeason(s.data)?.id || "");
    }).catch(() => toast.error("Couldn't load players"));
  }, []);

  const name = (id) => players.find((p) => p.id === id)?.name || "?";
  const size = format === "2v2" ? 2 : 3;
  const playing = pool.size - [...subs].filter((id) => pool.has(id)).length;
  const teams = Math.floor(playing / size);
  const leftOver = playing % size;
  const inPool = players.filter((p) => pool.has(p.id));

  const toggle = (id) => {
    const next = new Set(pool);
    if (next.has(id)) {
      next.delete(id);
      setSubs((s) => { const n = new Set(s); n.delete(id); return n; });
      setRules((rs) => rs.filter((r) => r.a !== id && r.b !== id));
    } else next.add(id);
    setPool(next);
    setResult(null);
  };
  const toggleSub = (id) => { setSubs((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }); setResult(null); };

  const addRule = () => {
    const { a, b, kind } = draft;
    if (!a || !b || a === b) return toast.error("Pick two different players");
    if (rules.some((r) => (r.a === a && r.b === b) || (r.a === b && r.b === a))) return toast.error("Those two already have a rule");
    setRules([...rules, { a, b, kind }]);
    setDraft({ a: "", b: "", kind });
    setResult(null);
  };

  const addOverride = () => {
    const v = Number(ovDraft.mmr);
    if (!ovDraft.id || ovDraft.mmr === "" || !Number.isFinite(v)) return toast.error("Pick a player and enter an MMR");
    if (v < 0 || v > 4000) return toast.error("MMR must be between 0 and 4000");
    setOverrides({ ...overrides, [ovDraft.id]: v });
    setOvDraft({ id: "", mmr: "" });
    setResult(null);
  };

  const run = async () => {
    setRunning(true);
    try {
      const { data } = await api.post("/tournament/balance", {
        player_ids: [...pool], format, mode, season_id: seasonId || null,
        subs: [...subs].filter((id) => pool.has(id)),
        apart: rules.filter((r) => r.kind === "apart").map((r) => [r.a, r.b]),
        together: rules.filter((r) => r.kind === "together").map((r) => [r.a, r.b]),
        mmr_overrides: Object.fromEntries(Object.entries(overrides).filter(([id]) => pool.has(id))),
      });
      setResult(data);
      setOption(0);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Couldn't make teams");
    } finally {
      setRunning(false);
    }
  };

  const shown = result?.options?.[option];

  const copy = async () => {
    if (!shown) return;
    const lines = [`**Tournament teams (${format})**`, ""];
    for (const t of shown.teams) {
      lines.push(`**Team ${t.seed}** (avg ${Math.round(t.avg_mmr)})`);
      lines.push(t.players.map((p) => (p.role ? `${p.name} (${p.role})` : p.name)).join(", "));
      lines.push("");
    }
    if (shown.subs.length) lines.push(`Subs: ${shown.subs.map((s) => s.name).join(", ")}`);
    try {
      await navigator.clipboard.writeText(lines.join("\n").trim());
      toast.success("Copied - paste it in Discord");
    } catch {
      toast.error("Couldn't copy");
    }
  };

  return (
    <div className="space-y-6" data-testid="tournament-page">
      <div>
        <div className="text-xs font-mono-hud uppercase tracking-[0.3em] text-cyan-400/70 mb-2">// Admin</div>
        <h1 className="font-heading text-4xl sm:text-5xl font-black uppercase tracking-tight flex items-center gap-3">
          <Trophy className="w-8 h-8 text-cyan-400" /> Tournament Teams
        </h1>
        <p className="text-sm text-slate-400 mt-2 max-w-3xl">
          Pick everyone who's playing and get the most even teams, using the same balancing as matchmaking. Mark subs to
          leave them out, or let it pick who sits out when the numbers don't divide. Rules keep two players apart or together.
        </p>
      </div>

      <div className="hud-card p-5 flex flex-wrap gap-4 items-end">
        <div>
          <div className="text-xs font-mono-hud uppercase tracking-[0.2em] text-cyan-400/80 mb-1.5">Format</div>
          <div className="flex gap-2">
            {["2v2", "3v3"].map((f) => (
              <button key={f} onClick={() => { setFormat(f); setResult(null); }} data-testid={`tour-format-${f}`}
                className={`px-4 py-2 rounded border font-mono-hud text-sm ${format === f ? "bg-cyan-400/10 border-cyan-400 text-cyan-400" : "border-[#1B2438] text-slate-300"}`}>{f}</button>
            ))}
          </div>
        </div>
        <div>
          <div className="text-xs font-mono-hud uppercase tracking-[0.2em] text-cyan-400/80 mb-1.5">Balance by</div>
          <select value={mode} onChange={(e) => { setMode(e.target.value); setResult(null); }} className={sel} title={MODES.find((m) => m.key === mode)?.desc}
            data-testid="tour-mode">
            {MODES.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </div>
        <div>
          <div className="text-xs font-mono-hud uppercase tracking-[0.2em] text-cyan-400/80 mb-1.5">MMR from</div>
          <SeasonSelect seasons={seasons.filter((s) => s.ranked !== false)} value={seasonId} onChange={setSeasonId} withAll={false} remember=""
            className={sel} />
        </div>
      </div>

      <div className="hud-card p-5">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <h3 className="font-heading text-lg font-bold uppercase flex items-center gap-2"><Users className="w-4 h-4 text-cyan-400" /> Players</h3>
          <div className="flex items-center gap-3 text-xs font-mono-hud text-slate-400">
            <span data-testid="tour-count">{pool.size} picked · {teams} team{teams === 1 ? "" : "s"}{subs.size ? ` · ${[...subs].filter((id) => pool.has(id)).length} marked subs` : ""}{leftOver ? ` · ${leftOver} more will sit out` : ""}</span>
            <button onClick={() => { setPool(new Set(players.map((p) => p.id))); setResult(null); }} className="uppercase hover:text-cyan-400">All</button>
            {pool.size > 0 && (
              <button onClick={() => { setPool(new Set()); setSubs(new Set()); setRules([]); setResult(null); }} data-testid="tour-clear"
                className="uppercase hover:text-[#FF2E55] flex items-center gap-1"><X className="w-3.5 h-3.5" /> Clear</button>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
          {players.map((p) => {
            const on = pool.has(p.id), sub = subs.has(p.id);
            return (
              <div key={p.id} className={`flex items-stretch rounded border text-sm ${on ? (sub ? "border-[#FFB800]/60 bg-[#FFB800]/5" : "border-cyan-400 bg-cyan-400/10") : "border-[#1B2438] bg-[#121828]"}`}>
                <button onClick={() => toggle(p.id)} className={`flex-1 text-left px-3 py-2 font-medium truncate ${on ? (sub ? "text-[#FFB800]" : "text-cyan-400") : "text-slate-300"}`}
                  data-testid={`tour-player-${p.id}`}>{p.name}</button>
                {on && (
                  <button onClick={() => toggleSub(p.id)} title={sub ? "Playing instead" : "Sub (sits out)"}
                    className={`px-2 border-l border-[#1B2438] ${sub ? "text-[#FFB800]" : "text-slate-500 hover:text-[#FFB800]"}`} data-testid={`tour-sub-${p.id}`}>
                    <Armchair className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="hud-card p-5 space-y-3">
        <h3 className="font-heading text-lg font-bold uppercase">Rules</h3>
        <div className="flex flex-wrap gap-2 items-center">
          <select value={draft.a} onChange={(e) => setDraft({ ...draft, a: e.target.value })} className={sel} data-testid="tour-rule-a">
            <option value="">Player…</option>
            {inPool.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })} className={sel} data-testid="tour-rule-kind">
            <option value="apart">can't play with</option>
            <option value="together">must play with</option>
          </select>
          <select value={draft.b} onChange={(e) => setDraft({ ...draft, b: e.target.value })} className={sel} data-testid="tour-rule-b">
            <option value="">Player…</option>
            {inPool.filter((p) => p.id !== draft.a).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button onClick={addRule} className="text-xs font-mono-hud uppercase text-cyan-400 border border-cyan-400 px-3 py-2 rounded hover:bg-cyan-400/10" data-testid="tour-rule-add">Add rule</button>
        </div>
        {rules.length === 0 ? (
          <div className="text-xs text-slate-500">No rules.</div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {rules.map((r, n) => (
              <span key={n} className="inline-flex items-center gap-1.5 text-xs font-mono-hud px-2 py-1 rounded border border-[#1B2438] bg-[#0C101B]">
                {r.kind === "apart" ? <Ban className="w-3 h-3 text-[#FF2E55]" /> : <Link2 className="w-3 h-3 text-[#00E676]" />}
                {name(r.a)} {r.kind === "apart" ? "can't play with" : "must play with"} {name(r.b)}
                <button onClick={() => { setRules(rules.filter((_, i) => i !== n)); setResult(null); }} className="text-slate-500 hover:text-[#FF2E55]" aria-label="Remove rule">
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="hud-card p-5 space-y-3">
        <h3 className="font-heading text-lg font-bold uppercase flex items-center gap-2"><Gauge className="w-4 h-4 text-cyan-400" /> MMR overrides</h3>
        <p className="text-xs text-slate-400">Use a different MMR for someone in this tournament only - e.g. a new player who's better than their 1200 start.
          Their real MMR isn't changed. Role adjustments still apply on top.</p>
        <div className="flex flex-wrap gap-2 items-center">
          <select value={ovDraft.id} onChange={(e) => setOvDraft({ ...ovDraft, id: e.target.value })} className={sel} data-testid="tour-ov-player">
            <option value="">Player…</option>
            {inPool.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input type="number" min="0" max="4000" value={ovDraft.mmr} onChange={(e) => setOvDraft({ ...ovDraft, mmr: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && addOverride()} placeholder="MMR" className={`${sel} w-28`} data-testid="tour-ov-mmr" />
          <button onClick={addOverride} className="text-xs font-mono-hud uppercase text-cyan-400 border border-cyan-400 px-3 py-2 rounded hover:bg-cyan-400/10" data-testid="tour-ov-add">Set MMR</button>
        </div>
        {Object.keys(overrides).filter((id) => pool.has(id)).length === 0 ? (
          <div className="text-xs text-slate-500">No overrides - everyone uses their season MMR.</div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {Object.entries(overrides).filter(([id]) => pool.has(id)).map(([id, v]) => (
              <span key={id} className="inline-flex items-center gap-1.5 text-xs font-mono-hud px-2 py-1 rounded border border-[#FFB800]/50 bg-[#0C101B] text-[#FFB800]" data-testid={`tour-ov-${id}`}>
                {name(id)}: {v}
                <button onClick={() => { const n = { ...overrides }; delete n[id]; setOverrides(n); setResult(null); }} className="text-slate-500 hover:text-[#FF2E55]" aria-label="Remove override">
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      <button onClick={run} disabled={running || teams < 2}
        className="btn-glow bg-cyan-400 hover:bg-cyan-300 text-black font-mono-hud font-bold uppercase tracking-wider px-6 py-3 rounded flex items-center gap-2 disabled:opacity-40"
        data-testid="tour-run">
        <Zap className="w-4 h-4" strokeWidth={3} /> {running ? "Making teams..." : teams < 2 ? `Pick at least ${size * 2} players` : `Make ${teams} teams`}
      </button>

      {shown && (
        <div className="space-y-4" data-testid="tour-result">
          <div className="flex flex-wrap items-center gap-2">
            {result.options.map((o, n) => (
              <button key={n} onClick={() => setOption(n)} data-testid={`tour-option-${n}`}
                className={`px-3 py-1.5 rounded border text-xs font-mono-hud uppercase ${option === n ? "bg-cyan-400/10 border-cyan-400 text-cyan-400" : "border-[#1B2438] text-slate-400"}`}>
                {n === 0 ? "Best" : `Option ${n + 1}`} · gap {Math.round(o.spread)}
              </button>
            ))}
            <div className="flex-1" />
            <button onClick={copy} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono-hud uppercase border border-[#1B2438] hover:border-cyan-400 rounded"
              data-testid="tour-copy"><Copy className="w-3.5 h-3.5" /> Copy for Discord</button>
          </div>
          <div className="text-xs text-slate-400">
            Strongest and weakest team are <span className="text-cyan-400 font-mono-hud">{Math.round(shown.spread)}</span> apart in team strength. Teams are listed strongest first, for seeding.
            {shown.rules_broken > 0 && <span className="text-[#FF2E55]"> Couldn't meet {shown.rules_broken} rule{shown.rules_broken === 1 ? "" : "s"} - check them.</span>}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {shown.teams.map((t) => (
              <div key={t.seed} className="hud-card p-4" data-testid={`tour-team-${t.seed}`}>
                <div className="flex items-baseline justify-between mb-2">
                  <div className="font-heading font-black uppercase text-lg">Team {t.seed}</div>
                  <div className="text-[11px] font-mono-hud text-slate-400">avg MMR {Math.round(t.avg_mmr)} · strength {Math.round(t.strength)}</div>
                </div>
                {t.players.map((p) => (
                  <div key={p.id} className="flex items-center justify-between py-1 text-sm">
                    <span className="font-medium">{p.name}</span>
                    <span className="flex items-center gap-3 font-mono-hud text-xs">
                      {p.role && <span className={roleColor(p.role)}>{p.role}</span>}
                      <span className={`w-10 text-right ${p.overridden ? "text-[#FFB800]" : "text-slate-400"}`}
                        title={p.overridden ? `Set for this tournament (season MMR ${p.season_mmr})` : "Season MMR"}>{p.mmr}{p.overridden ? "*" : ""}</span>
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
          {shown.subs.length > 0 && (
            <div className="hud-card p-4 text-sm" data-testid="tour-subs">
              <span className="font-heading font-bold uppercase mr-3">Subs</span>
              {shown.subs.map((s) => (
                <span key={s.id} className="mr-3">{s.name} <span className="text-xs text-slate-500">{s.chosen ? "(marked)" : "(picked to keep teams even)"}</span></span>
              ))}
            </div>
          )}
          {shown.teams.some((t) => t.players.some((p) => p.overridden)) && (
            <div className="text-xs text-[#FFB800]">* MMR set for this tournament</div>
          )}
          {result.role_model !== "spread" && mode !== "mmr" && (
            <div className="text-xs text-slate-500">Roles shown are each team's suggested line-up.</div>
          )}
        </div>
      )}
    </div>
  );
}
