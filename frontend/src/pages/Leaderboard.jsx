import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "@/api";
import { Trophy, TrendingUp, Download, Info } from "lucide-react";
import StreakBadge from "@/components/StreakBadge";
import { useAuth } from "@/AuthContext";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TIERS, tierFor } from "@/lib/tiers";

const tier = tierFor;

export default function Leaderboard() {
  const { isAdmin } = useAuth();
  const [rows, setRows] = useState([]);
  const [seasons, setSeasons] = useState([]);
  const [seasonId, setSeasonId] = useState("");
  const [format, setFormat] = useState("all");

  useEffect(() => {
    (async () => {
      const s = await api.get("/seasons");
      setSeasons(s.data);
      const active = s.data.find((x) => x.active) || s.data[0];
      setSeasonId(active?.id || "");
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!seasonId) return;
    const params = { season_id: seasonId };
    if (format !== "all") params.format = format;
    api.get("/stats/leaderboard", { params }).then((r) => setRows(r.data));
  }, [seasonId, format]);

  const csvHref = `${process.env.REACT_APP_BACKEND_URL}/api/exports/leaderboard.csv?season_id=${seasonId}${format !== "all" ? `&format=${format}` : ""}`;

  return (
    <div className="space-y-6" data-testid="leaderboard-page">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="text-xs font-mono-hud uppercase tracking-[0.3em] text-cyan-400/70 mb-2">// Rank Ladder</div>
          <h1 className="font-heading text-4xl sm:text-5xl font-black uppercase tracking-tight flex items-center gap-3">
            Leaderboard
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center justify-center w-9 h-9 rounded border border-[#1B2438] bg-[#121828] text-cyan-400 hover:border-cyan-400 hover:bg-cyan-400/10 transition-colors"
                  data-testid="tier-info-btn"
                  aria-label="Tier system info"
                >
                  <Info className="w-4 h-4" strokeWidth={2.5} />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-80 bg-[#0C101B] border-[#1B2438] text-slate-100 p-4" data-testid="tier-info-panel">
                <div className="text-xs font-mono-hud uppercase tracking-[0.2em] text-cyan-400/80 mb-1">// Tier System</div>
                <h3 className="font-heading text-lg font-black uppercase tracking-tight mb-2">How ranks work</h3>
                <p className="text-xs text-slate-400 font-mono-hud leading-relaxed mb-3">
                  Everyone starts at 1200 MMR. Each match you win pushes your MMR up (and losses down), scaled by K=32, your opponents' average MMR, and the round differential multiplier.
                </p>
                <div className="space-y-2">
                  {TIERS.map((t) => (
                    <div key={t.name} className="flex items-start gap-3 p-2 bg-[#121828]/60 border border-[#1B2438] rounded" data-testid={`tier-row-${t.name.toLowerCase()}`}>
                      <span className={`text-[10px] font-mono-hud uppercase tracking-wider px-2 py-1 border rounded ${t.color} ${t.border} flex-shrink-0 self-start`}>{t.name}</span>
                      <div className="min-w-0">
                        <div className="font-mono-hud text-xs font-bold text-slate-200">
                          {t.max === null ? `${t.min}+ MMR` : `${t.min}–${t.max} MMR`}
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5">{t.desc}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          </h1>
        </div>
        <div className="flex gap-2 items-end">
          {isAdmin && <a href={csvHref}
            className="btn-glow bg-cyan-400 hover:bg-cyan-300 text-black font-mono-hud font-bold uppercase tracking-wider text-xs px-4 py-2 rounded flex items-center gap-2"
            data-testid="leaderboard-export-csv">
            <Download className="w-3.5 h-3.5" strokeWidth={3} /> CSV
          </a>}
          <select value={seasonId} onChange={(e) => setSeasonId(e.target.value)} className="bg-[#121828] border border-[#1B2438] rounded px-3 py-2 text-sm" data-testid="leaderboard-season">
            {seasons.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      </div>

      <div className="flex gap-1 flex-wrap">
        {[
          { k: "all", label: "All Formats" },
          { k: "1v1", label: "1v1" },
          { k: "2v2", label: "2v2" },
          { k: "3v3", label: "3v3" },
        ].map((f) => (
          <button
            key={f.k}
            onClick={() => setFormat(f.k)}
            className={`px-4 py-2 font-mono-hud text-xs uppercase tracking-wider rounded border transition-colors ${
              format === f.k
                ? "bg-cyan-400 text-black border-cyan-400 font-bold"
                : "bg-[#121828] border-[#1B2438] text-slate-300 hover:border-cyan-400/40"
            }`}
            data-testid={`leaderboard-format-${f.k}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="hud-card p-12 text-center text-slate-500 font-mono-hud">No ranked data.</div>
      ) : (
        <div className="hud-card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-[#121828] border-b border-[#1B2438]">
              <tr className="text-left">
                <th className="px-4 py-3 font-mono-hud text-xs uppercase tracking-[0.15em] text-cyan-400/80">Rank</th>
                <th className="px-4 py-3 font-mono-hud text-xs uppercase tracking-[0.15em] text-cyan-400/80">Player</th>
                <th className="px-4 py-3 font-mono-hud text-xs uppercase tracking-[0.15em] text-cyan-400/80">Tier</th>
                <th className="px-4 py-3 font-mono-hud text-xs uppercase tracking-[0.15em] text-cyan-400/80 text-right">MMR</th>
                <th className="px-4 py-3 font-mono-hud text-xs uppercase tracking-[0.15em] text-cyan-400/80 text-right hidden md:table-cell">Peak</th>
                <th className="px-4 py-3 font-mono-hud text-xs uppercase tracking-[0.15em] text-cyan-400/80 text-right">W-L</th>
                <th className="px-4 py-3 font-mono-hud text-xs uppercase tracking-[0.15em] text-cyan-400/80 text-right">WR%</th>
                <th className="px-4 py-3 font-mono-hud text-xs uppercase tracking-[0.15em] text-cyan-400/80 text-right hidden md:table-cell">Rounds ±</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const t = tier(r.mmr);
                return (
                  <tr key={r.player_id} className="border-b border-[#1B2438]/60 hover:bg-[#121828]/60 transition-colors" data-testid={`leaderboard-row-${r.player_id}`}>
                    <td className="px-4 py-3 font-mono-hud font-black text-[#FFB800]">#{r.rank}</td>
                    <td className="px-4 py-3"><div className="flex items-center gap-2"><Link to={`/players/${r.player_id}`} className="hover:text-cyan-400 font-medium">{r.name}</Link><StreakBadge streak={r.streak} /></div></td>
                    <td className="px-4 py-3"><span className={`text-[10px] font-mono-hud uppercase tracking-wider px-2 py-1 border rounded ${t.color} ${t.border}`}>{t.name}</span></td>
                    <td className="px-4 py-3 text-right font-mono-hud font-bold text-cyan-400">{Math.round(r.mmr)}</td>
                    <td className="px-4 py-3 text-right font-mono-hud text-slate-400 hidden md:table-cell">{Math.round(r.peak_mmr)}</td>
                    <td className="px-4 py-3 text-right font-mono-hud text-slate-300">{r.wins}-{r.losses}</td>
                    <td className="px-4 py-3 text-right font-mono-hud text-[#00E676]">{r.winrate}%</td>
                    <td className="px-4 py-3 text-right font-mono-hud text-slate-400 hidden md:table-cell">{r.rounds_won - r.rounds_lost >= 0 ? "+" : ""}{r.rounds_won - r.rounds_lost}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
