import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "@/api";
import { Trophy, Swords, Users, Activity, Flame } from "lucide-react";
import SeasonCountdown from "@/components/SeasonCountdown";
import FormatFilter, { byFormat } from "@/components/FormatFilter";
import MatchList from "@/components/MatchList";

function Stat({ label, value, icon: Icon, accent = "cyan" }) {
  const color = { cyan: "text-cyan-400", amber: "text-[#FFB800]", crimson: "text-[#FF2E55]", emerald: "text-[#00E676]" }[accent];
  return (
    <div className="hud-card hud-corner p-5 relative overflow-hidden">
      <div className="flex items-start justify-between mb-3">
        <div className="text-xs font-mono-hud uppercase tracking-[0.2em] text-slate-400">{label}</div>
        <Icon className={`w-4 h-4 ${color}`} />
      </div>
      <div className={`font-heading text-3xl md:text-4xl font-black ${color} font-mono-hud tracking-tight`}>{value}</div>
    </div>
  );
}

function RivalrySpotlight({ rivalry }) {
  if (!rivalry) return null;
  const total = rivalry.matches;
  const aPct = total ? (rivalry.a_wins / total) * 100 : 50;
  const bPct = 100 - aPct;
  const leaderA = rivalry.a_wins > rivalry.b_wins;
  const leaderB = rivalry.b_wins > rivalry.a_wins;
  return (
    <div className="hud-card hud-corner p-5 relative overflow-hidden border-[#FF2E55]/50 bg-[#FF2E55]/5" data-testid="dashboard-rivalry">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Swords className="w-4 h-4 text-[#FF2E55]" />
          <h2 className="font-heading text-xl font-bold uppercase tracking-wide">Main Event Rivalry</h2>
        </div>
        <Link to="/recap" className="text-xs font-mono-hud uppercase text-cyan-400 hover:text-cyan-300">All bouts →</Link>
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4">
        <div className="text-right min-w-0">
          <Link to={`/players/${rivalry.player_a_id}`} className={`font-heading text-xl md:text-2xl font-black uppercase tracking-tight hover:text-cyan-400 block truncate ${leaderA ? "text-[#00E676]" : leaderB ? "text-slate-400" : "text-slate-100"}`} data-testid="dashboard-rivalry-a">
            {rivalry.player_a_name}
          </Link>
          <div className="font-mono-hud text-xs text-slate-500">{rivalry.a_wins} wins</div>
        </div>
        <div className="flex flex-col items-center">
          <span className="font-heading text-3xl md:text-4xl font-black text-[#FFB800] font-mono-hud leading-none" data-testid="dashboard-rivalry-score">
            {rivalry.a_wins}<span className="text-slate-600 mx-1.5">–</span>{rivalry.b_wins}
          </span>
          <span className="text-[9px] font-mono-hud uppercase tracking-[0.25em] text-slate-500 mt-1">{total} meetings</span>
        </div>
        <div className="text-left min-w-0">
          <Link to={`/players/${rivalry.player_b_id}`} className={`font-heading text-xl md:text-2xl font-black uppercase tracking-tight hover:text-cyan-400 block truncate ${leaderB ? "text-[#00E676]" : leaderA ? "text-slate-400" : "text-slate-100"}`} data-testid="dashboard-rivalry-b">
            {rivalry.player_b_name}
          </Link>
          <div className="font-mono-hud text-xs text-slate-500">{rivalry.b_wins} wins</div>
        </div>
      </div>
      <div className="flex h-2 mt-4 rounded overflow-hidden bg-[#0C101B] border border-[#1B2438]">
        <div className="bg-[#00F0FF]/70" style={{ width: `${aPct}%` }} />
        <div className="bg-[#FF2E55]/70" style={{ width: `${bPct}%` }} />
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [seasons, setSeasons] = useState([]);
  const [activeSeason, setActiveSeason] = useState(null);
  const [leaderboard, setLeaderboard] = useState([]);
  const [matches, setMatches] = useState([]);
  const [recentFormat, setRecentFormat] = useState("all");
  const [players, setPlayers] = useState([]);
  const [rivalry, setRivalry] = useState(null);

  useEffect(() => {
    (async () => {
      const s = await api.get("/seasons");
      setSeasons(s.data);
      const active = s.data.find((x) => x.active) || s.data[0];
      setActiveSeason(active);
      const [lb, mm, pp, recap] = await Promise.all([
        api.get("/stats/leaderboard", { params: { season_id: active?.id } }),
        api.get("/matches", { params: { season_id: active?.id } }),
        api.get("/players"),
        api.get("/stats/recap", { params: { days: 90, season_id: active?.id } }),
      ]);
      setLeaderboard(lb.data);
      setMatches(mm.data);
      setPlayers(pp.data);
      setRivalry(recap.data?.rivalries?.[0] || null);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalMatches = matches.length;
  const totalRounds = matches.reduce((s, m) => s + m.team_a_rounds + m.team_b_rounds, 0);
  const topPlayer = leaderboard[0];

  const playerNames = Object.fromEntries(players.map((p) => [p.id, p.name]));
  const loadMatches = () => api.get("/matches", { params: { season_id: activeSeason?.id } }).then((r) => setMatches(r.data));

  return (
    <div className="space-y-8" data-testid="dashboard-page">
      <div>
        <div className="text-xs font-mono-hud uppercase tracking-[0.3em] text-cyan-400/70 mb-2">// Command Center</div>
        <h1 className="font-heading text-4xl sm:text-5xl lg:text-6xl font-black uppercase tracking-tight">Arena Telemetry</h1>
        <p className="text-slate-400 mt-2">Live competitive intel — {activeSeason ? activeSeason.name : "no active season"}</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat label="Total Matches" value={totalMatches} icon={Swords} accent="cyan" />
        <Stat label="Rounds Played" value={totalRounds} icon={Activity} accent="amber" />
        <Stat label="Active Players" value={players.length} icon={Users} accent="emerald" />
        <Stat label="Top ELO" value={topPlayer ? Math.round(topPlayer.mmr) : "—"} icon={Trophy} accent="crimson" />
      </div>

      {rivalry && <RivalrySpotlight rivalry={rivalry} />}

      {activeSeason?.end_date && (
        <SeasonCountdown endDate={activeSeason.end_date} seasonName={activeSeason.name} />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="hud-card p-6 lg:col-span-7">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-heading text-xl font-bold uppercase tracking-wide text-slate-100 flex items-center gap-2"><Swords className="w-4 h-4 text-cyan-400" /> Recent Matches</h2>
            <div className="flex items-center gap-3">
              <FormatFilter value={recentFormat} onChange={setRecentFormat} small testid="dashboard-recent-format" />
              <Link to="/matches" className="text-xs font-mono-hud uppercase text-cyan-400 hover:text-cyan-300">View all →</Link>
            </div>
          </div>
          {matches.length === 0 ? (
            <div className="text-slate-500 text-sm py-6 text-center font-mono-hud">No matches logged yet. <Link to="/log" className="text-cyan-400 hover:underline">Log one</Link>.</div>
          ) : (
            <MatchList key={recentFormat} matches={matches.filter(byFormat(recentFormat))} playerName={(id) => playerNames[id] || "?"}
              seasons={seasons} onChanged={loadMatches} limit={6} showAllButton={false}
              emptyText={`No ${recentFormat} matches yet.`} testid="dashboard-recent" />
          )}
        </div>

        <div className="hud-card p-6 lg:col-span-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-heading text-xl font-bold uppercase tracking-wide text-slate-100 flex items-center gap-2"><Trophy className="w-4 h-4 text-[#FFB800]" /> Top 6 Ladder</h2>
            <Link to="/leaderboard" className="text-xs font-mono-hud uppercase text-cyan-400 hover:text-cyan-300">Full →</Link>
          </div>
          {leaderboard.length === 0 ? (
            <div className="text-slate-500 text-sm py-6 text-center font-mono-hud">No ranked players yet.</div>
          ) : (
            <div className="space-y-2">
              {leaderboard.slice(0, 6).map((p) => (
                <Link key={p.player_id} to={`/players/${p.player_id}`} className="flex items-center gap-3 p-2.5 bg-[#121828]/60 border border-[#1B2438] rounded hover:border-cyan-400/40 transition-colors">
                  <span className="font-mono-hud font-extrabold text-lg text-[#FFB800] w-8">#{p.rank}</span>
                  <span className="flex-1 font-medium">{p.name}</span>
                  <span className="font-mono-hud text-cyan-400 font-bold">{Math.round(p.mmr)}</span>
                  <span className="text-xs font-mono-hud text-slate-500">{p.winrate}%</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
