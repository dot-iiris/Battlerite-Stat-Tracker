import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import api from "@/api";
import { Trophy, Swords, Flame, Users, TrendingUp } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import ChampionPortrait from "@/components/ChampionPortrait";
import StreakBadge from "@/components/StreakBadge";
import { tierFor } from "@/lib/tiers";
import SeasonSelect from "@/components/SeasonSelect";

const roleClass = (r) => r === "Melee" ? "role-bg-melee" : r === "Ranged" ? "role-bg-ranged" : "role-bg-support";

export default function PlayerProfile() {
  const { id } = useParams();
  const [stats, setStats] = useState(null);
  const [seasons, setSeasons] = useState([]);
  const [seasonId, setSeasonId] = useState("");

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
    api.get(`/stats/player/${id}`, { params }).then((r) => setStats(r.data));
  }, [id, seasonId]);

  if (!stats) return <div className="text-slate-400 font-mono-hud">Loading dossier...</div>;

  return (
    <div className="space-y-6" data-testid="player-profile-page">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="text-xs font-mono-hud uppercase tracking-[0.3em] text-cyan-400/70 mb-2">// Player Dossier</div>
          <h1 className="font-heading text-4xl sm:text-5xl font-black uppercase tracking-tight flex items-center gap-3">{stats.player.name}<StreakBadge streak={stats.streak} size="lg" /></h1>
        </div>
        <SeasonSelect seasons={seasons} value={seasonId} onChange={setSeasonId}
          className="bg-[#121828] border border-[#1B2438] rounded px-3 py-2 text-sm" data-testid="profile-season" />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="hud-card hud-corner p-5">
          <div className="text-xs font-mono-hud uppercase tracking-[0.2em] text-slate-400 mb-2">Current Rank · MMR</div>
          <div className="font-mono-hud text-3xl font-black text-cyan-400" data-testid="profile-mmr">{Math.round(stats.mmr)}</div>
          {(() => {
            const t = tierFor(stats.mmr);
            return <span className={`inline-block mt-2 text-[10px] font-mono-hud uppercase tracking-wider px-2 py-1 border rounded ${t.color} ${t.border}`} data-testid="profile-current-rank">{t.name}</span>;
          })()}
        </div>
        <div className="hud-card hud-corner p-5">
          <div className="text-xs font-mono-hud uppercase tracking-[0.2em] text-slate-400 mb-2">Peak Rank</div>
          {(() => {
            const peak = stats.peak_mmr_all_time ?? stats.peak_mmr;
            const t = tierFor(peak);
            return (
              <>
                <div className="flex items-baseline gap-2">
                  <span className={`font-heading text-xl font-black ${t.color}`} data-testid="profile-peak-rank">{t.name}</span>
                  <span className="font-mono-hud text-lg font-black text-slate-300" data-testid="profile-peak-mmr">{Math.round(peak)}</span>
                </div>
                {stats.peak_season_name && (
                  <div className="text-[10px] font-mono-hud text-slate-500 mt-1" data-testid="profile-peak-season">in {stats.peak_season_name}</div>
                )}
              </>
            );
          })()}
        </div>
        <div className="hud-card hud-corner p-5">
          <div className="text-xs font-mono-hud uppercase tracking-[0.2em] text-slate-400 mb-2">Matches</div>
          <div className="font-mono-hud text-3xl font-black">{stats.total_matches}</div>
          <div className="text-[10px] font-mono-hud text-slate-500 mt-1">{stats.total_wins}W · {stats.total_losses}L</div>
        </div>
        <div className="hud-card hud-corner p-5">
          <div className="text-xs font-mono-hud uppercase tracking-[0.2em] text-slate-400 mb-2">Winrate · Fav</div>
          <div className="font-mono-hud text-2xl font-black text-[#00E676]">{stats.winrate}%</div>
          <div className="font-heading text-sm font-black text-[#FFB800] truncate mt-1">{stats.champions[0]?.champion || "—"}</div>
        </div>
      </div>

      <div className="hud-card p-5">
        <h3 className="font-heading text-lg font-bold uppercase mb-4 flex items-center gap-2"><TrendingUp className="w-4 h-4 text-cyan-400" /> MMR Trajectory</h3>
        {stats.mmr_history.length === 0 ? (
          <div className="text-slate-500 text-sm font-mono-hud">No history yet.</div>
        ) : (
          <div className="h-56" data-testid="mmr-chart">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={stats.mmr_history.map((h, i) => ({ idx: i + 1, mmr: h.mmr }))} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1B2438" />
                <XAxis dataKey="idx" stroke="#64748B" fontSize={10} tickLine={false} axisLine={{ stroke: "#1B2438" }} />
                <YAxis stroke="#64748B" fontSize={10} tickLine={false} axisLine={{ stroke: "#1B2438" }} domain={["dataMin - 20", "dataMax + 20"]} />
                <Tooltip contentStyle={{ background: "#0C101B", border: "1px solid #1B2438", fontFamily: "JetBrains Mono", fontSize: 12 }} labelStyle={{ color: "#00F0FF" }} formatter={(v) => [Math.round(v), "MMR"]} labelFormatter={(l) => `Match #${l}`} />
                <Line type="monotone" dataKey="mmr" stroke="#00F0FF" strokeWidth={2} dot={{ fill: "#00F0FF", r: 3 }} activeDot={{ r: 5, fill: "#FFB800" }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="hud-card p-5">
          <h3 className="font-heading text-lg font-bold uppercase mb-4 flex items-center gap-2"><Flame className="w-4 h-4 text-[#FFB800]" /> Champion Pool</h3>
          {stats.champions.length === 0 ? <div className="text-slate-500 text-sm font-mono-hud">No matches yet.</div> : (
            <div className="space-y-2">
              {stats.champions.slice(0, 8).map((c) => (
                <Link key={c.champion} to={`/champions/${encodeURIComponent(c.champion)}`} className="group flex items-center justify-between p-2 bg-[#121828]/60 border border-[#1B2438] rounded hover:border-cyan-400/40 transition-colors">
                  <div className="flex items-center gap-2">
                    <ChampionPortrait name={c.champion} role={c.role} size={28} linkToProfile={false} />
                    <span className="font-medium group-hover:text-cyan-400">{c.champion}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-mono-hud text-slate-400">{c.matches}m</span>
                    <span className="font-mono-hud text-[#00E676] font-bold text-sm">{c.winrate}%</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="hud-card p-5">
          <h3 className="font-heading text-lg font-bold uppercase mb-4 flex items-center gap-2"><Users className="w-4 h-4 text-cyan-400" /> Role Distribution</h3>
          <div className="space-y-3">
            {stats.roles.map((r) => (
              <div key={r.role}>
                <div className="flex justify-between text-xs font-mono-hud mb-1">
                  <span className={r.role === "Melee" ? "role-melee" : r.role === "Ranged" ? "role-ranged" : "role-support"}>{r.role}</span>
                  <span className="text-slate-400">{r.matches} matches · {r.winrate}% WR</span>
                </div>
                <div className="h-2 bg-[#121828] rounded overflow-hidden">
                  <div className={`h-full ${r.role === "Melee" ? "bg-[#FF4655]" : r.role === "Ranged" ? "bg-cyan-400" : "bg-[#00E676]"}`}
                    style={{ width: `${stats.total_matches ? (r.matches / stats.total_matches) * 100 : 0}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="hud-card p-5">
          <h3 className="font-heading text-lg font-bold uppercase mb-4 text-cyan-400">Teammates (H2H)</h3>
          {stats.teammates.length === 0 ? <div className="text-slate-500 text-sm font-mono-hud">No teammates yet.</div> : (
            <div className="space-y-2">
              {stats.teammates.map((t) => (
                <Link key={t.player_id} to={`/players/${t.player_id}`} className="group flex items-center justify-between p-2 bg-[#121828]/60 border border-[#1B2438] rounded hover:border-cyan-400/40 transition-colors">
                  <span className="group-hover:text-cyan-400">{t.name}</span>
                  <div className="flex items-center gap-3 text-xs font-mono-hud">
                    <span className="text-slate-400">{t.wins}W / {t.matches - t.wins}L</span>
                    <span className={t.winrate >= 50 ? "text-[#00E676]" : "text-[#FF2E55]"}>{t.winrate}%</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="hud-card p-5">
          <h3 className="font-heading text-lg font-bold uppercase mb-4 text-[#FF2E55]">Opponents (H2H)</h3>
          {stats.opponents.length === 0 ? <div className="text-slate-500 text-sm font-mono-hud">No opponents yet.</div> : (
            <div className="space-y-2">
              {stats.opponents.map((o) => (
                <Link key={o.player_id} to={`/players/${o.player_id}`} className="group flex items-center justify-between p-2 bg-[#121828]/60 border border-[#1B2438] rounded hover:border-cyan-400/40 transition-colors">
                  <span className="group-hover:text-cyan-400">{o.name}</span>
                  <div className="flex items-center gap-3 text-xs font-mono-hud">
                    <span className="text-slate-400">{o.wins}W / {o.matches - o.wins}L</span>
                    <span className={o.winrate >= 50 ? "text-[#00E676]" : "text-[#FF2E55]"}>{o.winrate}%</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
