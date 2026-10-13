import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "@/api";
import { Grid3x3, Flame } from "lucide-react";
import ChampionPortrait from "@/components/ChampionPortrait";
import SeasonSelect from "@/components/SeasonSelect";

const roleClass = (r) => r === "Melee" ? "role-bg-melee" : r === "Ranged" ? "role-bg-ranged" : "role-bg-support";

export default function ChampionMatrix() {
  const [data, setData] = useState(null);
  const [seasons, setSeasons] = useState([]);
  const [seasonId, setSeasonId] = useState("");
  const [minMatches, setMinMatches] = useState(1);
  const [rowHl, setRowHl] = useState(null);
  const [colHl, setColHl] = useState(null);

  useEffect(() => {
    (async () => {
      const s = await api.get("/seasons");
      setSeasons(s.data);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const params = {};
    if (seasonId) params.season_id = seasonId;
    api.get("/stats/champion-matrix", { params }).then((r) => setData(r.data));
  }, [seasonId]);

  const cellColor = (wr, matches) => {
    if (matches < minMatches) return "bg-[#121828] text-slate-700";
    if (wr >= 60) return "bg-[#00E676]/20 text-[#00E676]";
    if (wr >= 50) return "bg-cyan-400/10 text-cyan-400";
    if (wr >= 40) return "bg-[#FFB800]/10 text-[#FFB800]";
    return "bg-[#FF2E55]/20 text-[#FF2E55]";
  };

  return (
    <div className="space-y-6" data-testid="champion-matrix-page">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="text-xs font-mono-hud uppercase tracking-[0.3em] text-cyan-400/70 mb-2">// Champion Analytics</div>
          <h1 className="font-heading text-4xl sm:text-5xl font-black uppercase tracking-tight flex items-center gap-3"><Grid3x3 className="w-8 h-8 text-cyan-400" /> Champion Matrix</h1>
          <p className="text-slate-400 text-sm mt-2">Row champion's winrate when facing each column champion.</p>
        </div>
        <div className="flex gap-2 items-end">
          <div>
            <label className="block text-[10px] font-mono-hud uppercase tracking-wider text-slate-400 mb-1">Min matches</label>
            <input type="number" min="1" value={minMatches} onChange={(e) => setMinMatches(Number(e.target.value) || 1)}
              className="w-20 bg-[#121828] border border-[#1B2438] rounded px-2 py-1.5 text-sm font-mono-hud text-center" data-testid="cm-min-matches" />
          </div>
          <SeasonSelect seasons={seasons} value={seasonId} onChange={setSeasonId}
            className="bg-[#121828] border border-[#1B2438] rounded px-3 py-2 text-sm" data-testid="cm-season" />
        </div>
      </div>

      {!data || data.champions.length === 0 ? (
        <div className="hud-card p-12 text-center text-slate-500 font-mono-hud">No champion data yet.</div>
      ) : (
        <>
          <div className="hud-card p-5">
            <h3 className="font-heading text-lg font-bold uppercase mb-3 flex items-center gap-2"><Flame className="w-4 h-4 text-[#FFB800]" /> Champion Roster & Winrates</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
              {data.totals.map((c) => (
                <Link
                  key={c.champion}
                  to={`/champions/${encodeURIComponent(c.champion)}`}
                  className={`flex items-center justify-between p-2 bg-[#121828]/60 border rounded hover:border-cyan-400/50 transition-colors ${c.picks === 0 ? "border-[#1B2438] opacity-60" : "border-[#1B2438]"}`}
                  data-testid={`cm-total-${c.champion}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <ChampionPortrait name={c.champion} role={c.role} size={28} disableHover linkToProfile={false} />
                    <span className="font-medium text-sm truncate">{c.champion}</span>
                  </div>
                  <div className="text-right flex-shrink-0 ml-2">
                    {c.picks === 0 ? (
                      <div className="text-[9px] font-mono-hud uppercase tracking-wider text-slate-500">unplayed</div>
                    ) : (
                      <>
                        <div className={`font-mono-hud text-xs font-bold ${c.winrate >= 50 ? "text-[#00E676]" : "text-[#FF2E55]"}`}>{c.winrate}%</div>
                        <div className="text-[9px] font-mono-hud text-slate-500">{c.picks}p</div>
                      </>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          </div>

          <div className="hud-card p-4 overflow-x-auto">
            {(rowHl || colHl) && (
              <div className="mb-3 flex items-center gap-3 text-xs font-mono-hud flex-wrap">
                {rowHl && <span><span className="text-slate-400 uppercase tracking-wider">Row:</span> <span className="text-cyan-400 font-bold">{rowHl}</span></span>}
                {colHl && <span><span className="text-slate-400 uppercase tracking-wider">Column:</span> <span className="text-[#FFB800] font-bold">{colHl}</span></span>}
                <button onClick={() => { setRowHl(null); setColHl(null); }} className="text-slate-500 hover:text-[#FF2E55] underline" data-testid="cm-clear-highlight">clear</button>
              </div>
            )}
            <table className="min-w-full text-xs font-mono-hud">
              <thead>
                <tr>
                  <th className="p-2 text-left text-cyan-400/80 uppercase tracking-wider sticky left-0 bg-[#0C101B] z-10">vs →</th>
                  {data.champions.map((c) => (
                    <th key={c}
                      onClick={() => setColHl(colHl === c ? null : c)}
                      className={`p-2 text-center uppercase tracking-wider min-w-[60px] whitespace-nowrap cursor-pointer select-none transition-colors ${colHl === c ? "bg-[#FFB800]/15 text-[#FFB800]" : "text-cyan-400/80 hover:bg-[#121828]"}`}
                      data-testid={`cm-col-header-${c}`}
                    >{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.champions.map((row) => (
                  <tr key={row} className={rowHl === row ? "bg-cyan-400/10" : ""}>
                    <td
                      onClick={() => setRowHl(rowHl === row ? null : row)}
                      className={`p-2 font-bold sticky left-0 z-10 border-r border-[#1B2438] whitespace-nowrap cursor-pointer select-none transition-colors ${rowHl === row ? "bg-cyan-400/15 text-cyan-300" : "bg-[#0C101B] text-slate-100 hover:bg-[#121828]"}`}
                      data-testid={`cm-row-header-${row}`}
                    >{row}</td>
                    {data.champions.map((col) => {
                      if (row === col) return <td key={col} className="p-2 text-center text-slate-700">—</td>;
                      const cell = data.matrix[row]?.[col] || { matches: 0, wins: 0 };
                      const wr = cell.matches ? Math.round((cell.wins / cell.matches) * 100) : 0;
                      const isRowHl = rowHl === row;
                      const isColHl = colHl === col;
                      const isIntersection = isRowHl && isColHl;
                      const anyHl = rowHl || colHl;
                      const dim = anyHl && !isRowHl && !isColHl ? "opacity-30" : "";
                      const focus = isIntersection ? "ring-2 ring-cyan-400 ring-inset" : "";
                      return (
                        <td key={col} className={`p-2 text-center ${cellColor(wr, cell.matches)} ${dim} ${focus}`} data-testid={`cm-cell-${row}-${col}`}>
                          {cell.matches < minMatches ? (
                            <span className="text-slate-700">—</span>
                          ) : (
                            <>
                              <div className="font-bold">{wr}%</div>
                              <div className="text-[9px] opacity-70">{cell.wins}-{cell.matches - cell.wins}</div>
                            </>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
