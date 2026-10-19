import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import api from "@/api";
import { Flame, Users, Swords, Shield, ArrowLeft } from "lucide-react";
import MatchList from "@/components/MatchList";
import ChampionPortrait from "@/components/ChampionPortrait";
import SeasonSelect, { savedSeason } from "@/components/SeasonSelect";
import FormatFilter from "@/components/FormatFilter";

const roleAccent = (r) =>
  r === "Melee" ? { text: "text-[#FF4655]", bg: "bg-[#FF4655]/10", border: "border-[#FF4655]/40" } :
  r === "Ranged" ? { text: "text-cyan-400", bg: "bg-cyan-400/10", border: "border-cyan-400/40" } :
                   { text: "text-[#00E676]", bg: "bg-[#00E676]/10", border: "border-[#00E676]/40" };

export default function ChampionProfile() {
  const { name } = useParams();
  const [stats, setStats] = useState(null);
  const [seasons, setSeasons] = useState([]);
  const [seasonId, setSeasonId] = useState(savedSeason);   // the visitor's last pick, else All
  const [players, setPlayers] = useState([]);
  const [format, setFormat] = useState("all");

  useEffect(() => {
    api.get("/seasons").then((r) => setSeasons(r.data));
    api.get("/players").then((r) => setPlayers(r.data));
  }, []);


  useEffect(() => {
    setStats(null);
    const params = {};
    if (seasonId) params.season_id = seasonId;
    if (format !== "all") params.format = format;   // the whole page follows the format buttons
    api.get(`/stats/champion/${encodeURIComponent(name)}`, { params })
      .then((r) => setStats(r.data))
      .catch(() => setStats({ error: true }));
  }, [name, seasonId, format]);

  if (!stats) return <div className="text-slate-400 font-mono-hud">Loading dossier...</div>;
  if (stats.error) return (
    <div className="hud-card p-10 text-center">
      <div className="text-slate-400 font-mono-hud mb-3">Champion not found.</div>
      <Link to="/champions" className="text-cyan-400 hover:underline text-sm">← Back to roster</Link>
    </div>
  );

  const accent = roleAccent(stats.role);
  const allMatches = stats.matches || stats.recent_matches || [];
  const playerName = (id) => players.find((p) => p.id === id)?.name || "—";
  const wrClass = stats.total_picks === 0 ? "text-slate-500" : (stats.winrate >= 50 ? "text-[#00E676]" : "text-[#FF2E55]");

  return (
    <div className="space-y-6" data-testid="champion-profile-page">
      <Link to="/champions" className="inline-flex items-center gap-1.5 text-xs font-mono-hud uppercase tracking-wider text-slate-400 hover:text-cyan-400" data-testid="champion-back-link">
        <ArrowLeft className="w-3.5 h-3.5" /> All champions
      </Link>

      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="text-xs font-mono-hud uppercase tracking-[0.3em] text-cyan-400/70 mb-2">// Champion Dossier</div>
          <div className="flex items-center gap-4">
            <ChampionPortrait name={stats.champion} role={stats.role} size={72} disableHover linkToProfile={false} />
            <div>
              <h1 className="font-heading text-4xl sm:text-5xl font-black uppercase tracking-tight leading-none">{stats.champion}</h1>
              <span className={`inline-block mt-2 text-[10px] font-mono-hud uppercase tracking-wider px-2 py-1 border rounded ${accent.text} ${accent.border} ${accent.bg}`} data-testid="champion-role-badge">{stats.role}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <FormatFilter value={format} onChange={setFormat} testid="champion-format" />
          <SeasonSelect seasons={seasons} value={seasonId} onChange={setSeasonId}
            className="bg-[#121828] border border-[#1B2438] rounded px-3 py-2 text-sm" data-testid="champion-profile-season" />
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="hud-card hud-corner p-5">
          <div className="text-xs font-mono-hud uppercase tracking-[0.2em] text-slate-400 mb-2">Picks</div>
          <div className="font-mono-hud text-3xl font-black text-cyan-400" data-testid="champion-picks">{stats.total_picks}</div>
        </div>
        <div className="hud-card hud-corner p-5">
          <div className="text-xs font-mono-hud uppercase tracking-[0.2em] text-slate-400 mb-2">Winrate</div>
          <div className={`font-mono-hud text-3xl font-black ${wrClass}`} data-testid="champion-winrate">{stats.total_picks ? `${stats.winrate}%` : "—"}</div>
        </div>
        <div className="hud-card hud-corner p-5">
          <div className="text-xs font-mono-hud uppercase tracking-[0.2em] text-slate-400 mb-2">Wins</div>
          <div className="font-mono-hud text-3xl font-black text-[#00E676]" data-testid="champion-wins">{stats.total_wins}</div>
        </div>
        <div className="hud-card hud-corner p-5">
          <div className="text-xs font-mono-hud uppercase tracking-[0.2em] text-slate-400 mb-2">Losses</div>
          <div className="font-mono-hud text-3xl font-black text-[#FF2E55]" data-testid="champion-losses">{stats.total_losses}</div>
        </div>
      </div>

      <div className="hud-card p-5">
        <h3 className="font-heading text-lg font-bold uppercase mb-4 flex items-center gap-2"><Users className="w-4 h-4 text-cyan-400" /> Played By</h3>
        {stats.players.length === 0 ? (
          <div className="text-slate-500 text-sm font-mono-hud">No one has played {stats.champion} yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-[10px] font-mono-hud uppercase tracking-wider text-slate-400 border-b border-[#1B2438]">
                  <th className="p-2 text-left">Player</th>
                  <th className="p-2 text-right">Games</th>
                  <th className="p-2 text-right">Wins</th>
                  <th className="p-2 text-right">Losses</th>
                  <th className="p-2 text-right">Winrate</th>
                </tr>
              </thead>
              <tbody>
                {stats.players.map((p) => (
                  <tr key={p.player_id} className="border-b border-[#1B2438]/50 hover:bg-[#121828]/60" data-testid={`champion-player-${p.player_id}`}>
                    <td className="p-2">
                      <Link to={`/players/${p.player_id}`} className="hover:text-cyan-400">{p.name}</Link>
                    </td>
                    <td className="p-2 text-right font-mono-hud text-slate-300">{p.matches}</td>
                    <td className="p-2 text-right font-mono-hud text-[#00E676]">{p.wins}</td>
                    <td className="p-2 text-right font-mono-hud text-[#FF2E55]">{p.matches - p.wins}</td>
                    <td className={`p-2 text-right font-mono-hud font-bold ${p.winrate >= 50 ? "text-[#00E676]" : "text-[#FF2E55]"}`}>{p.winrate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="hud-card p-5">
          <h3 className="font-heading text-lg font-bold uppercase mb-4 flex items-center gap-2"><Shield className="w-4 h-4 text-cyan-400" /> Top Teammates</h3>
          {stats.teammate_champions.length === 0 ? <div className="text-slate-500 text-sm font-mono-hud">No teammates yet.</div> : (
            <div className="space-y-2">
              {stats.teammate_champions.slice(0, 10).map((c) => (
                <Link
                  key={c.champion}
                  to={`/champions/${encodeURIComponent(c.champion)}`}
                  className="flex items-center justify-between p-2 bg-[#121828]/60 border border-[#1B2438] rounded hover:border-cyan-400/40 transition-colors"
                  data-testid={`champion-teammate-${c.champion}`}
                >
                  <div className="flex items-center gap-2">
                    <ChampionPortrait name={c.champion} role={c.role} size={28} disableHover linkToProfile={false} />
                    <span className="font-medium">{c.champion}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs font-mono-hud">
                    <span className="text-slate-400">{c.matches}m</span>
                    <span className={c.winrate >= 50 ? "text-[#00E676] font-bold" : "text-[#FF2E55] font-bold"}>{c.winrate}%</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="hud-card p-5">
          <h3 className="font-heading text-lg font-bold uppercase mb-4 flex items-center gap-2"><Swords className="w-4 h-4 text-[#FF2E55]" /> Top Opponents</h3>
          {stats.opponent_champions.length === 0 ? <div className="text-slate-500 text-sm font-mono-hud">No opponents yet.</div> : (
            <div className="space-y-2">
              {stats.opponent_champions.slice(0, 10).map((c) => (
                <Link
                  key={c.champion}
                  to={`/champions/${encodeURIComponent(c.champion)}`}
                  className="flex items-center justify-between p-2 bg-[#121828]/60 border border-[#1B2438] rounded hover:border-[#FF2E55]/40 transition-colors"
                  data-testid={`champion-opponent-${c.champion}`}
                >
                  <div className="flex items-center gap-2">
                    <ChampionPortrait name={c.champion} role={c.role} size={28} disableHover linkToProfile={false} />
                    <span className="font-medium">{c.champion}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs font-mono-hud">
                    <span className="text-slate-400">{c.matches}m</span>
                    <span className={c.winrate >= 50 ? "text-[#00E676] font-bold" : "text-[#FF2E55] font-bold"}>{c.winrate}%</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="hud-card p-5">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
          <h3 className="font-heading text-lg font-bold uppercase flex items-center gap-2">
            <Flame className="w-4 h-4 text-[#FFB800]" /> Matches
            <span className="text-xs font-mono-hud text-slate-500 normal-case">{allMatches.length}</span>
          </h3>
        </div>
        <MatchList key={`${name}-${seasonId}-${format}`} matches={allMatches} playerName={playerName} seasons={seasons}
          focusChampion={stats.champion} testid="champion-match" />
      </div>
    </div>
  );
}
