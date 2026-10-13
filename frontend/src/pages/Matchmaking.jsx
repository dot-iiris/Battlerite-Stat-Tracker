import { useEffect, useState } from "react";
import api from "@/api";
import { toast } from "sonner";
import { Sliders, Zap, Users } from "lucide-react";
import SeasonSelect, { newestSeason } from "@/components/SeasonSelect";

const modes = [
  { key: "mmr", label: "MMR Balance", desc: "Match teams by average ELO only" },
  { key: "synergy", label: "Role Synergy", desc: "Optimize role diversity within teams" },
  { key: "hybrid", label: "Hybrid Balance", desc: "60% MMR + 40% Role Synergy" },
];

export default function Matchmaking() {
  const [players, setPlayers] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [format, setFormat] = useState("2v2");
  const [mode, setMode] = useState("hybrid");
  const [seasons, setSeasons] = useState([]);
  const [seasonId, setSeasonId] = useState("");
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    (async () => {
      const [p, s] = await Promise.all([api.get("/players"), api.get("/seasons")]);
      setPlayers(p.data);
      setSeasons(s.data);
      setSeasonId(newestSeason(s.data)?.id || "");   // the current season, else the newest
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const size = { "2v2": 4, "3v3": 6 }[format];

  const toggle = (id) => {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id);
    else if (s.size < size) s.add(id);
    else { toast.error(`Only ${size} players for ${format}`); return; }
    setSelected(s);
  };

  const run = async () => {
    if (selected.size !== size) { toast.error(`Need exactly ${size} players`); return; }
    setRunning(true);
    try {
      const { data } = await api.post("/matchmaking/balance", {
        player_ids: [...selected],
        format,
        mode,
        season_id: seasonId,
      });
      setResult(data);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed");
    } finally {
      setRunning(false);
    }
  };

  const roleColor = (r) => r === "Melee" ? "role-melee" : r === "Ranged" ? "role-ranged" : "role-support";

  return (
    <div className="space-y-6" data-testid="matchmaking-page">
      <div>
        <div className="text-xs font-mono-hud uppercase tracking-[0.3em] text-cyan-400/70 mb-2">// Team Balancer</div>
        <h1 className="font-heading text-4xl sm:text-5xl font-black uppercase tracking-tight flex items-center gap-3"><Sliders className="w-8 h-8 text-cyan-400" /> Matchmaking</h1>
      </div>

      <div className="hud-card p-5 grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <label className="block text-xs font-mono-hud uppercase tracking-[0.2em] text-cyan-400/80 mb-1.5">Format</label>
          <div className="flex gap-2">
            {["2v2", "3v3"].map((f) => (
              <button key={f} onClick={() => { setFormat(f); setSelected(new Set()); setResult(null); }}
                className={`flex-1 px-3 py-2 font-mono-hud text-sm uppercase rounded border ${format === f ? "bg-cyan-400 text-black border-cyan-400 font-bold" : "bg-[#121828] border-[#1B2438] text-slate-300"}`}
                data-testid={`mm-format-${f}`}>{f}</button>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-xs font-mono-hud uppercase tracking-[0.2em] text-cyan-400/80 mb-1.5">Balance Mode</label>
          <select value={mode} onChange={(e) => setMode(e.target.value)} className="w-full bg-[#121828] border border-[#1B2438] rounded px-3 py-2.5 text-sm" data-testid="mm-mode">
            {modes.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
          <p className="text-[10px] font-mono-hud text-slate-500 mt-1">{modes.find((m) => m.key === mode)?.desc}</p>
        </div>
        <div>
          <label className="block text-xs font-mono-hud uppercase tracking-[0.2em] text-cyan-400/80 mb-1.5">Season (for MMR)</label>
          <SeasonSelect seasons={seasons} value={seasonId} onChange={setSeasonId} withAll={false} remember={null}
            className="w-full bg-[#121828] border border-[#1B2438] rounded px-3 py-2.5 text-sm" data-testid="mm-season" />
        </div>
      </div>

      <div className="hud-card p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-heading text-lg font-bold uppercase flex items-center gap-2"><Users className="w-4 h-4 text-cyan-400" /> Select Player Pool</h3>
          <span className="text-xs font-mono-hud text-slate-400">{selected.size} / {size} selected</span>
        </div>
        {players.length === 0 ? (
          <div className="text-slate-500 text-sm font-mono-hud">Add players first.</div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {players.map((p) => (
              <button key={p.id} onClick={() => toggle(p.id)}
                className={`px-3 py-2 rounded border text-sm font-medium transition-colors ${selected.has(p.id) ? "bg-cyan-400/10 border-cyan-400 text-cyan-400" : "bg-[#121828] border-[#1B2438] text-slate-300 hover:border-cyan-400/40"}`}
                data-testid={`mm-player-${p.id}`}>{p.name}</button>
            ))}
          </div>
        )}
      </div>

      <button onClick={run} disabled={selected.size !== size || running}
        className="btn-glow bg-cyan-400 hover:bg-cyan-300 text-black font-mono-hud font-bold uppercase tracking-wider px-6 py-3 rounded flex items-center gap-2 disabled:opacity-40"
        data-testid="mm-compute">
        <Zap className="w-4 h-4" strokeWidth={3} /> {running ? "Computing..." : "Compute Balance"}
      </button>

      {result && (
        <div className="space-y-4" data-testid="mm-result">
          <div className="hud-card p-5 grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
            <div><div className="text-xs font-mono-hud text-slate-400 uppercase tracking-wider">Balance Score</div><div className="font-mono-hud text-2xl font-black text-[#00E676]">{result.balance_score}</div></div>
            <div><div className="text-xs font-mono-hud text-slate-400 uppercase tracking-wider">MMR Diff</div><div className="font-mono-hud text-2xl font-black text-cyan-400">{result.mmr_diff}</div></div>
            <div><div className="text-xs font-mono-hud text-slate-400 uppercase tracking-wider">Team A Win %</div><div className="font-mono-hud text-2xl font-black text-[#FFB800]">{result.win_probability_a}%</div></div>
            <div><div className="text-xs font-mono-hud text-slate-400 uppercase tracking-wider">Team B Win %</div><div className="font-mono-hud text-2xl font-black text-[#FFB800]">{(100 - result.win_probability_a).toFixed(1)}%</div></div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[
              { label: "A", players: result.team_a, mmr: result.team_a_mmr, syn: result.team_a_synergy, color: "text-cyan-400", border: "border-cyan-400/40" },
              { label: "B", players: result.team_b, mmr: result.team_b_mmr, syn: result.team_b_synergy, color: "text-[#FF2E55]", border: "border-[#FF2E55]/40" },
            ].map((t) => (
              <div key={t.label} className={`hud-card p-5 border-2 ${t.border}`}>
                <div className="flex items-center justify-between mb-3">
                  <h4 className={`font-heading text-xl font-black uppercase ${t.color}`}>Team {t.label}</h4>
                  <div className="text-right">
                    <div className="text-[10px] font-mono-hud text-slate-500 uppercase">MMR / Synergy</div>
                    <div className="font-mono-hud text-sm"><span className="text-cyan-400 font-bold">{t.mmr}</span> · <span className="text-[#00E676] font-bold">{t.syn}</span></div>
                  </div>
                </div>
                <div className="space-y-2">
                  {t.players.map((p) => (
                    <div key={p.id} className="flex items-center justify-between p-2 bg-[#121828]/60 border border-[#1B2438] rounded">
                      <span className="font-medium">{p.name}</span>
                      <div className="flex items-center gap-2 text-xs font-mono-hud">
                        <span className={roleColor(p.preferred_role)}>{p.preferred_role}</span>
                        <span className="text-cyan-400 font-bold">{Math.round(p.mmr)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
