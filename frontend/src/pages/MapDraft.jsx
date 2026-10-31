import { useEffect, useState } from "react";
import api from "@/api";
import { toast } from "sonner";
import { Ban, Check, Copy, Dices, RotateCcw, Undo2 } from "lucide-react";
import MapPoolPicker from "@/components/MapPoolPicker";

// Admins (preview): map drafting between two teams in a chosen ban / pick order, and a random map picker
// that can repeat maps or not. Runs in the browser only - nothing is saved on the server; the draft and
// the picker's history are kept in this browser so a refresh doesn't lose them.
const STORE_KEY = "brstats.mapDraft";
const sel = "bg-[#121828] border border-[#1B2438] focus:border-cyan-400 focus:outline-none rounded px-3 py-2 text-sm";
const lbl = "block text-xs font-mono-hud uppercase tracking-[0.2em] text-cyan-400/80 mb-1.5";
const btn = "flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono-hud uppercase tracking-wider border rounded transition-colors";

// order presets: each letter is a turn (A = first team), and whether that turn bans or picks
export const PRESETS = [
  { key: "abba", label: "ABBA bans, last map left", order: "ABBA", actions: "BBBB", decider: "last" },
  { key: "aabb", label: "AABB bans, last map left", order: "AABB", actions: "BBBB", decider: "last" },
  { key: "abab", label: "ABAB bans, last map left", order: "ABAB", actions: "BBBB", decider: "last" },
  { key: "bo3", label: "Bo3: ban AB, pick AB, ban AB, decider", order: "ABABAB", actions: "BBPPBB", decider: "random" },
  { key: "pick", label: "ABBA picks", order: "ABBA", actions: "PPPP", decider: "none" },
];
const DECIDERS = { last: "The last map left", random: "Random from what's left", none: "No decider" };
export const MODES = {
  with: "With replacement - any map can come up every time",
  without: "Without replacement - no repeats until every map has come up, then start over",
  recent: "No repeat of the last N maps",
};

function load() {
  try { return JSON.parse(window.localStorage.getItem(STORE_KEY) || "null") || {}; } catch { return {}; }
}

// "Mount Araz (Night)" -> "Mount Araz"
const arenaOf = (m) => m.replace(/\s*\((Day|Night)\)$/i, "");

// A random map from the pool (null if there's none). mode: "with" | "without" | "recent"; history: earlier
// draws, newest last (it can hold maps no longer in the pool); recentN: how many recent draws "recent" keeps out.
// Never the other time of day of the map just drawn, in any mode.
export function drawMap(pool, history, mode, recentN) {
  if (!pool.length) return null;
  let blocked = new Set();
  if (mode === "without") {   // maps drawn in this cycle; a cycle ends once every map has come up
    for (const m of history) {
      if (!pool.includes(m)) continue;
      if (blocked.has(m)) blocked = new Set();   // a cycle started early (only a variant of the last map was left)
      blocked.add(m);
      if (blocked.size >= pool.length) blocked = new Set();
    }
  } else if (mode === "recent") {
    history.slice(-recentN).forEach((m) => blocked.add(m));
  }
  const last = history[history.length - 1];
  // the other time of day of the last map - and, unless repeats are allowed, the last map itself (a new cycle)
  const variant = (m) => last && arenaOf(m) === arenaOf(last) && (m !== last || mode !== "with");
  const open = pool.filter((m) => !blocked.has(m) && !variant(m));
  // all used up (or only the last map's variant is left): start over, still not that arena straight away
  const from = [open, pool.filter((m) => !last || arenaOf(m) !== arenaOf(last)), pool].find((x) => x.length);
  return from[Math.floor(Math.random() * from.length)];
}

function Draft({ pool, saved, save }) {
  const [teamA, setTeamA] = useState(saved.teamA || "Team A");
  const [teamB, setTeamB] = useState(saved.teamB || "Team B");
  const [order, setOrder] = useState(saved.order || "ABBA");
  const [actions, setActions] = useState(saved.actions || "BBBB");
  const [decider, setDecider] = useState(saved.decider || "last");
  const [steps, setSteps] = useState(saved.steps || []);   // [{team, action, map}] done so far
  useEffect(() => { save({ teamA, teamB, order, actions, decider, steps }); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [teamA, teamB, order, actions, decider, steps]);

  const name = (t) => (t === "A" ? teamA : teamB);
  const taken = (m) => steps.some((s) => s.map === m);
  const left = pool.filter((m) => !taken(m));
  const turns = [...order].map((team, i) => ({ team, action: actions[i] === "P" ? "pick" : "ban" }));
  const turn = turns[steps.length];
  const deciderDone = steps.some((s) => s.decider);
  const finished = !turn && (decider === "none" || deciderDone || !left.length);

  const setPreset = (key) => {
    const p = PRESETS.find((x) => x.key === key);
    if (!p) return;
    setOrder(p.order); setActions(p.actions); setDecider(p.decider); setSteps([]);
  };
  const editOrder = (v) => {
    const o = v.toUpperCase().replace(/[^AB]/g, "").slice(0, 16);
    setOrder(o);
    setActions((cur) => o.split("").map((_, i) => cur[i] || "B").join(""));
    setSteps([]);
  };
  const flip = (i) => { setActions(actions.split("").map((a, j) => (j === i ? (a === "P" ? "B" : "P") : a)).join("")); setSteps([]); };
  const choose = (m) => turn && setSteps([...steps, { ...turn, map: m }]);
  const runDecider = () => {
    if (!left.length) return;
    const map = decider === "last" ? left[0] : left[Math.floor(Math.random() * left.length)];
    setSteps([...steps, { team: null, action: "pick", map, decider: true }]);
  };
  const picks = steps.filter((s) => s.action === "pick");
  const copy = async () => {
    const lines = ["**Map draft**", ...steps.map((s) => s.decider ? `Decider: ${s.map}` : `${name(s.team)} ${s.action === "pick" ? "picks" : "bans"} ${s.map}`)];
    if (picks.length) lines.push("", `**Maps:** ${picks.map((s, i) => `${i + 1}. ${s.map}`).join("  ")}`);
    try { await navigator.clipboard.writeText(lines.join("\n")); toast.success("Copied for Discord"); } catch { window.prompt("Copy this", lines.join("\n")); }
  };

  return (
    <div className="space-y-5" data-testid="map-draft">
      <div className="hud-card p-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div><label className={lbl}>Team A (goes first)</label><input value={teamA} onChange={(e) => setTeamA(e.target.value)} className={`${sel} w-full`} data-testid="md-team-a" /></div>
        <div><label className={lbl}>Team B</label><input value={teamB} onChange={(e) => setTeamB(e.target.value)} className={`${sel} w-full`} data-testid="md-team-b" /></div>
        <div>
          <label className={lbl}>Preset</label>
          <select value={PRESETS.find((p) => p.order === order && p.actions === actions && p.decider === decider)?.key || ""}
            onChange={(e) => setPreset(e.target.value)} className={`${sel} w-full`} data-testid="md-preset">
            <option value="">Custom</option>
            {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </div>
        <div>
          <label className={lbl}>After the turns</label>
          <select value={decider} onChange={(e) => { setDecider(e.target.value); setSteps([]); }} className={`${sel} w-full`} data-testid="md-decider">
            {Object.entries(DECIDERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div className="md:col-span-2 xl:col-span-4 flex flex-wrap items-end gap-3">
          <div><label className={lbl}>Order</label>
            <input value={order} onChange={(e) => editOrder(e.target.value)} placeholder="ABBA" className={`${sel} w-40 font-mono-hud tracking-[0.3em] uppercase`} data-testid="md-order" /></div>
          <div className="flex flex-wrap gap-1.5 pb-1">
            {turns.map((t, i) => (
              <button key={i} type="button" onClick={() => flip(i)} title="Click to switch ban / pick" data-testid={`md-turn-${i}`}
                className={`text-[11px] font-mono-hud uppercase px-2 py-1 rounded border ${t.action === "pick" ? "border-cyan-400/60 text-cyan-300" : "border-[#FF2E55]/50 text-[#FF2E55]"}`}>
                {i + 1}. {t.team} {t.action}
              </button>
            ))}
          </div>
        </div>
        {decider === "last" && pool.length - order.length !== 1 && (
          <div className="md:col-span-2 xl:col-span-4 text-xs text-amber-400">
            "The last map left" needs exactly one map left after the turns: the pool has {pool.length}, the order has {order.length} turns.
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="font-heading text-2xl font-black uppercase" data-testid="md-status">
          {turn ? <>{name(turn.team)} <span className={turn.action === "pick" ? "text-cyan-400" : "text-[#FF2E55]"}>{turn.action}s</span></>
            : finished ? "Draft done" : "Decider"}
        </div>
        <div className="flex gap-2">
          {!turn && !finished && (
            <button onClick={runDecider} className={`${btn} border-cyan-400/50 text-cyan-400 hover:bg-cyan-400/10`} data-testid="md-run-decider">
              <Dices className="w-3.5 h-3.5" /> {decider === "last" ? "Take the last map" : "Roll the decider"}
            </button>
          )}
          <button onClick={() => setSteps(steps.slice(0, -1))} disabled={!steps.length} className={`${btn} border-[#1B2438] text-slate-300 hover:border-cyan-400 disabled:opacity-40`} data-testid="md-undo"><Undo2 className="w-3.5 h-3.5" /> Undo</button>
          <button onClick={() => setSteps([])} disabled={!steps.length} className={`${btn} border-[#1B2438] text-slate-300 hover:border-[#FF2E55] disabled:opacity-40`} data-testid="md-reset"><RotateCcw className="w-3.5 h-3.5" /> Restart</button>
          <button onClick={copy} disabled={!steps.length} className={`${btn} border-[#1B2438] text-slate-300 hover:border-cyan-400 disabled:opacity-40`} data-testid="md-copy"><Copy className="w-3.5 h-3.5" /> Copy</button>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {pool.map((m) => {
          const step = steps.find((s) => s.map === m);
          const banned = step?.action === "ban", picked = step?.action === "pick";
          return (
            <button key={m} type="button" disabled={!!step || !turn} onClick={() => choose(m)} data-testid={`md-map-${m}`}
              className={`text-left rounded border px-3 py-2.5 transition-colors ${banned ? "border-[#FF2E55]/30 bg-[#FF2E55]/5 text-slate-500 line-through" : picked ? "border-cyan-400 bg-cyan-400/10 text-cyan-300" : turn ? "border-[#1B2438] hover:border-cyan-400 text-slate-200" : "border-[#1B2438] text-slate-400"}`}>
              <div className="text-sm font-semibold flex items-center gap-1.5">
                {banned && <Ban className="w-3.5 h-3.5 text-[#FF2E55]" />}{picked && <Check className="w-3.5 h-3.5" />}{m}
              </div>
              {step && <div className="text-[10px] font-mono-hud uppercase tracking-wider mt-0.5 no-underline">{step.decider ? "Decider" : `${name(step.team)} · ${step.action}`}</div>}
            </button>
          );
        })}
      </div>

      {picks.length > 0 && (
        <div className="hud-card p-4" data-testid="md-result">
          <div className="text-[10px] font-mono-hud uppercase tracking-[0.25em] text-cyan-400/70 mb-2">Maps</div>
          <ol className="space-y-1 text-sm">
            {picks.map((s, i) => <li key={i}><span className="font-mono-hud text-cyan-400 mr-2">{i + 1}.</span>{s.map} <span className="text-slate-500 text-xs">{s.decider ? "decider" : `${name(s.team)}'s pick`}</span></li>)}
          </ol>
        </div>
      )}
    </div>
  );
}

function Picker({ pool, saved, save }) {
  const [mode, setMode] = useState(saved.mode || "without");
  const [recentN, setRecentN] = useState(saved.recentN || 3);
  const [history, setHistory] = useState(saved.history || []);   // drawn maps, newest last
  useEffect(() => { save({ mode, recentN, history }); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, recentN, history]);

  const draw = () => {
    const m = drawMap(pool, history, mode, Number(recentN) || 0);
    if (!m) { toast.error("No map can come up - the pool is empty"); return; }
    setHistory([...history, m].slice(-100));
  };
  const last = history[history.length - 1];
  return (
    <div className="space-y-5" data-testid="map-picker">
      <div className="hud-card p-4 flex flex-wrap items-end gap-4">
        <div className="flex-1 min-w-[16rem]">
          <label className={lbl}>Replacement</label>
          <select value={mode} onChange={(e) => setMode(e.target.value)} className={`${sel} w-full`} data-testid="mp-mode">
            {Object.entries(MODES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        {mode === "recent" && (
          <div><label className={lbl}>N</label>
            <input type="number" min="1" max={Math.max(1, pool.length - 1)} value={recentN} onChange={(e) => setRecentN(e.target.value)} className={`${sel} w-24`} data-testid="mp-recent" /></div>
        )}
        <button onClick={draw} className="btn-glow bg-cyan-400 hover:bg-cyan-300 text-black font-mono-hud font-bold uppercase tracking-wider px-6 py-2.5 rounded flex items-center gap-2" data-testid="mp-draw">
          <Dices className="w-4 h-4" /> Random map
        </button>
        <button onClick={() => setHistory([])} disabled={!history.length} className={`${btn} border-[#1B2438] text-slate-300 hover:border-[#FF2E55] disabled:opacity-40 py-2.5`} data-testid="mp-clear">
          <RotateCcw className="w-3.5 h-3.5" /> Clear history
        </button>
      </div>
      {last && (
        <div className="hud-card p-6 text-center border-cyan-400/40" data-testid="mp-result">
          <div className="text-[10px] font-mono-hud uppercase tracking-[0.25em] text-cyan-400/70">Map {history.length}</div>
          <div className="font-heading text-4xl font-black uppercase text-cyan-300 mt-1">{last}</div>
        </div>
      )}
      {history.length > 1 && (
        <div className="text-sm text-slate-400">
          <span className="text-[10px] font-mono-hud uppercase tracking-[0.25em] text-cyan-400/70 mr-2">Earlier</span>
          {history.slice(0, -1).reverse().map((m, i) => <span key={i} className="mr-3">{m}</span>)}
        </div>
      )}
    </div>
  );
}

export default function MapDraft() {
  const [info, setInfo] = useState(null);   // { names, pools: { "2v2": [...], "3v3": [...] }, season }
  const [saved] = useState(load);
  const [tab, setTab] = useState(saved.tab || "draft");
  const [format, setFormat] = useState(saved.format || "3v3");
  const [pool, setPool] = useState(saved.pool || null);
  const [parts, setParts] = useState({ draft: saved.draft || {}, picker: saved.picker || {} });

  useEffect(() => {
    Promise.all([api.get("/admin/settings"), api.get("/seasons")]).then(([s, se]) => {
      const general = (k) => s.data.settings.find((r) => r.key === k)?.value || [];
      const season = se.data.find((x) => x.active && x.ranked !== false);
      const pools = {};
      for (const f of ["2v2", "3v3"]) pools[f] = season?.map_pools?.[f] || general(`MAP_POOL_${f.toUpperCase()}`);
      setInfo({ names: s.data.map_names || [], pools, season: season?.name });
      setPool((cur) => cur || pools[format]);
    }).catch(() => toast.error("Couldn't load the map pools"));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify({ tab, format, pool, ...parts })); } catch { /* private window */ }
  }, [tab, format, pool, parts]);

  if (!info || !pool) return <div className="text-sm text-slate-500">Loading…</div>;
  const choosePool = (f) => { setFormat(f); setPool(info.pools[f]); };

  return (
    <div className="space-y-6" data-testid="map-draft-page">
      <div>
        <div className="text-xs font-mono-hud uppercase tracking-[0.3em] text-cyan-400/70 mb-2">// Maps</div>
        <h1 className="font-heading text-4xl sm:text-5xl font-black uppercase tracking-tight">Map Draft</h1>
        <p className="text-sm text-slate-400 mt-2 max-w-3xl">Admin preview. Ban and pick maps in turns, or roll a random map. Nothing is saved on the site - it's kept in this browser only.</p>
      </div>

      <details className="hud-card p-4" data-testid="md-pool">
        <summary className="cursor-pointer text-xs font-mono-hud uppercase tracking-[0.2em] text-cyan-400/80">
          Map pool · {pool.length} maps <span className="text-slate-500 normal-case tracking-normal ml-2">click to change</span>
        </summary>
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {["2v2", "3v3"].map((f) => (
              <button key={f} type="button" onClick={() => choosePool(f)} data-testid={`md-pool-${f}`}
                className={`${btn} ${format === f ? "border-cyan-400 text-cyan-300" : "border-[#1B2438] text-slate-400"}`}>{f} pool</button>
            ))}
            <button type="button" onClick={() => setPool(info.names)} className={`${btn} border-[#1B2438] text-slate-400 hover:border-cyan-400`} data-testid="md-pool-all">Every map</button>
            <span className="text-xs text-slate-500">{info.season ? `The ${info.season} pool where it has its own, else the general one.` : "The general pools (no active ranked season)."}</span>
          </div>
          <MapPoolPicker value={pool} mapNames={info.names} onChange={setPool} testid="draft" />
        </div>
      </details>

      <div className="flex flex-wrap gap-x-1 border-b border-[#1B2438]">
        {[["draft", "Draft"], ["picker", "Random map"]].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} data-testid={`md-tab-${k}`}
            className={`px-4 py-2.5 text-xs font-mono-hud uppercase tracking-wider border-b-2 ${tab === k ? "text-cyan-400 border-cyan-400" : "text-slate-400 border-transparent hover:text-slate-100"}`}>{l}</button>
        ))}
      </div>

      {tab === "draft" && <Draft pool={pool} saved={parts.draft} save={(v) => setParts((p) => ({ ...p, draft: v }))} />}
      {tab === "picker" && <Picker pool={pool} saved={parts.picker} save={(v) => setParts((p) => ({ ...p, picker: v }))} />}
    </div>
  );
}
