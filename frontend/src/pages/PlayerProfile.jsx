import { useCallback, useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import api from "@/api";
import { Flame, Users, TrendingUp, History } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import ChampionPortrait from "@/components/ChampionPortrait";
import StreakBadge from "@/components/StreakBadge";
import { tierFor } from "@/lib/tiers";
import SeasonSelect, { savedSeason } from "@/components/SeasonSelect";
import FormatFilter, { byFormat } from "@/components/FormatFilter";
import MatchList from "@/components/MatchList";

// Rank head-to-head records fairly for small samples: each record counts as if it had PRIOR_GAMES
// extra games at the player's own overall win rate, so 2-0 doesn't beat a steady 15-5.
const PRIOR_GAMES = 5;
const adjusted = (r, base) => (r.wins + PRIOR_GAMES * base) / (r.matches + PRIOR_GAMES);
const ranked = (rows, base, best) => [...rows]
  .sort((a, b) => (best ? adjusted(b, base) - adjusted(a, base) : adjusted(a, base) - adjusted(b, base)) || b.matches - a.matches);

function ShowAll({ total, open, onClick, testid }) {
  if (total <= 3) return null;
  return (
    <button type="button" onClick={onClick} data-testid={testid}
      className="w-full pt-2 text-xs font-mono-hud uppercase tracking-wider text-cyan-400 hover:text-cyan-300">
      {open ? "Show top 3" : `Show all ${total}`}
    </button>
  );
}

const roleClass = (r) => r === "Melee" ? "role-bg-melee" : r === "Ranged" ? "role-bg-ranged" : "role-bg-support";

export default function PlayerProfile() {
  const { id } = useParams();
  const [stats, setStats] = useState(null);
  const [seasons, setSeasons] = useState([]);
  const [seasonId, setSeasonId] = useState(savedSeason);   // the visitor's last pick, else All
  const [matches, setMatches] = useState([]);
  const [players, setPlayers] = useState([]);
  const [format, setFormat] = useState("all");
  const [allMates, setAllMates] = useState(false);
  const [allFoes, setAllFoes] = useState(false);

  useEffect(() => {
    (async () => {
      const s = await api.get("/seasons");
      setSeasons(s.data);
    })();
    api.get("/players").then((r) => setPlayers(r.data));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadMatches = useCallback(() => {
    const params = { player_id: id };
    if (seasonId) params.season_id = seasonId;
    return api.get("/matches", { params }).then((r) => setMatches(r.data));
  }, [id, seasonId]);

  useEffect(() => {
    const params = {};
    if (seasonId) params.season_id = seasonId;
    if (format !== "all") params.format = format;
    api.get(`/stats/player/${id}`, { params }).then((r) => setStats(r.data));
    setAllMates(false);
    setAllFoes(false);
    loadMatches();
  }, [id, seasonId, format, loadMatches]);

  if (!stats) return <div className="text-slate-400 font-mono-hud">Loading dossier...</div>;

  const playerName = (pid) => players.find((p) => p.id === pid)?.name || "—";
  const listed = matches.filter(byFormat(format));
  const base = stats.total_matches ? stats.total_wins / stats.total_matches : 0.5;
  const mates = ranked(stats.teammates, base, true);    // best partners first
  const foes = ranked(stats.opponents, base, false);    // toughest opponents first
  const teammates = allMates ? mates : mates.slice(0, 3);
  const opponents = allFoes ? foes : foes.slice(0, 3);

  return (
    <div className="space-y-6" data-testid="player-profile-page">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="text-xs font-mono-hud uppercase tracking-[0.3em] text-cyan-400/70 mb-2">// Player Dossier</div>
          <h1 className="font-heading text-4xl sm:text-5xl font-black uppercase tracking-tight flex items-center gap-3">{stats.player.name}<StreakBadge streak={stats.streak} size="lg" /></h1>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <FormatFilter value={format} onChange={setFormat} testid="profile-format" />
          <SeasonSelect seasons={seasons} value={seasonId} onChange={setSeasonId}
            className="bg-[#121828] border border-[#1B2438] rounded px-3 py-2 text-sm" data-testid="profile-season" />
        </div>
      </div>
      {format !== "all" && (
        <div className="text-xs text-slate-500 -mt-3" data-testid="profile-format-note">
          Showing {format} only. MMR, peak rank and the MMR trajectory cover both formats - there's one MMR.
        </div>
      )}

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
        <h3 className="font-heading text-lg font-bold uppercase mb-4 flex items-center gap-2"><TrendingUp className="w-4 h-4 text-cyan-400" /> MMR Trajectory
          {stats.mmr_history_season_name && (
            <span className="text-[10px] font-mono-hud font-normal text-slate-500 normal-case tracking-wider" data-testid="mmr-chart-season">
              · {stats.mmr_history_season_name}
            </span>
          )}
        </h3>
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
          <h3 className="font-heading text-lg font-bold uppercase text-cyan-400">Best Teammates</h3>
          <div className="text-[10px] font-mono-hud text-slate-500 mb-4" title={`Win rate with each player, counting ${PRIOR_GAMES} extra games at this player's usual win rate so a few lucky games don't top the list`}>{allMates ? "All" : "Top 3"} · win rate together, weighted by games played</div>
          {teammates.length === 0 ? <div className="text-slate-500 text-sm font-mono-hud">No teammates yet.</div> : (
            <div className="space-y-2">
              {teammates.map((t) => (
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
          {!!mates.length && (
            <ShowAll total={mates.length} open={allMates} onClick={() => setAllMates(!allMates)} testid="profile-teammates-all" />
          )}
        </div>

        <div className="hud-card p-5">
          <h3 className="font-heading text-lg font-bold uppercase text-[#FF2E55]">Toughest Opponents</h3>
          <div className="text-[10px] font-mono-hud text-slate-500 mb-4" title={`Win rate against each player, counting ${PRIOR_GAMES} extra games at this player's usual win rate so a few unlucky games don't top the list`}>{allFoes ? "All" : "Top 3"} · lowest win rate against, weighted by games played</div>
          {opponents.length === 0 ? <div className="text-slate-500 text-sm font-mono-hud">No opponents yet.</div> : (
            <div className="space-y-2">
              {opponents.map((o) => (
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
          {!!foes.length && (
            <ShowAll total={foes.length} open={allFoes} onClick={() => setAllFoes(!allFoes)} testid="profile-opponents-all" />
          )}
        </div>
      </div>

      <div className="hud-card p-5" data-testid="profile-matches">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
          <h3 className="font-heading text-lg font-bold uppercase flex items-center gap-2">
            <History className="w-4 h-4 text-cyan-400" /> Match History
            <span className="text-xs font-mono-hud text-slate-500 normal-case">{listed.length}</span>
          </h3>
        </div>
        <MatchList key={`${id}-${seasonId}-${format}`} matches={listed} playerName={playerName} seasons={seasons}
          onChanged={loadMatches} focusPlayer={id} testid="profile-match" />
      </div>
    </div>
  );
}
