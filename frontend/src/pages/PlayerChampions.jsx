import { Fragment, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams, Link } from "react-router-dom";
import api from "@/api";
import { ArrowLeft, ChevronDown, ChevronRight, Flame, RotateCcw } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import ChampionPortrait from "@/components/ChampionPortrait";
import SeasonSelect, { savedSeason } from "@/components/SeasonSelect";
import FormatFilter from "@/components/FormatFilter";
import MatchList from "@/components/MatchList";

// A player's whole champion pool: one row per champion with results and scoreboard averages
// (per-round averages from the in-game "Average Total" tab). The server sends every game; the
// filters below narrow the games and everything is totalled here.

const STATS = [
  { key: "score", label: "Score" },
  { key: "damage", label: "Damage" },
  { key: "protection", label: "Prot." , title: "Protection" },
  { key: "disables", label: "Disables" },
  { key: "damage_normalised", label: "Norm. dmg", title: "Damage minus the enemy team's protection, split by each player's share of their team's damage" },
];
const SHARES = [
  { key: "damage_team_share", label: "Dmg share", title: "Share of the team's damage" },
  { key: "protection_team_share", label: "Prot. share", title: "Share of the team's protection" },
];

const num = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v) ? "—" : Number(v).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }));
const pct = (v) => (v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`);
const signed = (v, d = 1) => (v === null || v === undefined ? "—" : `${v > 0 ? "+" : ""}${num(v, d)}`);
const wrClass = (wr) => (wr === null ? "text-slate-500" : wr >= 50 ? "text-[#00E676]" : "text-[#FF2E55]");
const statOf = (g, key) => (g.stats?.[key] ?? g.derived?.[key] ?? null);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const LAST_N = [{ k: 0, label: "All games" }, { k: 10, label: "Last 10" }, { k: 25, label: "Last 25" }, { k: 50, label: "Last 50" }];

// totals for a set of games (one champion, or all of them)
function summarise(games) {
  const n = games.length;
  const wins = games.filter((g) => g.won).length;
  const withStats = games.filter((g) => g.stats);
  const out = {
    count: n, wins, losses: n - wins,
    winrate: n ? (wins / n) * 100 : null,
    roundDiff: n ? avg(games.map((g) => g.rounds_won - g.rounds_lost)) : null,
    mmr: games.reduce((a, g) => a + (g.mmr_change || 0), 0),
    statGames: withStats.length,
  };
  for (const s of [...STATS, ...SHARES]) {
    const vals = withStats.map((g) => statOf(g, s.key)).filter((v) => v !== null);
    out[s.key] = avg(vals);
    out[`${s.key}_best`] = vals.length ? Math.max(...vals) : null;
  }
  return out;
}

// games grouped by some key -> [{key, games, wins, winrate}] most played first
function breakdown(games, keysOf) {
  const m = new Map();
  for (const g of games) {
    for (const k of keysOf(g)) {
      if (k === null || k === undefined) continue;
      const r = m.get(k) || { key: k, games: 0, wins: 0 };
      r.games += 1;
      r.wins += g.won ? 1 : 0;
      m.set(k, r);
    }
  }
  return [...m.values()].map((r) => ({ ...r, winrate: (r.wins / r.games) * 100 }))
    .sort((a, b) => b.games - a.games || b.winrate - a.winrate);
}

const COLUMNS = [
  { key: "champion", label: "Champion", left: true },
  { key: "games", label: "Games" },
  { key: "winrate", label: "WR" },
  { key: "roundDiff", label: "Rnd ±", title: "Average round difference per game" },
  { key: "mmr", label: "MMR ±", title: "Total MMR change" },
  ...STATS,
  ...SHARES,
];

function Select({ value, onChange, children, testid }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} data-testid={testid}
      className="bg-[#121828] border border-[#1B2438] rounded px-3 py-2 text-sm max-w-[12rem]">
      {children}
    </select>
  );
}

function Pills({ value, onChange, options, testid }) {
  return (
    <div className="flex gap-1" data-testid={testid}>
      {options.map((o) => (
        <button key={o.k} type="button" onClick={() => onChange(o.k)} data-testid={`${testid}-${o.k}`}
          className={`px-3 py-2 text-xs font-mono-hud uppercase tracking-wider rounded border transition-colors ${
            value === o.k ? "bg-cyan-400 text-black border-cyan-400 font-bold" : "bg-[#121828] border-[#1B2438] text-slate-300 hover:border-cyan-400/40"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function BreakdownList({ title, rows, render, empty = "Nothing yet." }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, 5);
  return (
    <div>
      <div className="text-[10px] font-mono-hud uppercase tracking-wider text-slate-500 mb-2">{title}</div>
      {rows.length === 0 ? <div className="text-xs font-mono-hud text-slate-600">{empty}</div> : (
        <div className="space-y-1">
          {shown.map((r) => (
            <div key={r.key} className="flex items-center justify-between gap-2 text-xs px-2 py-1 bg-[#121828]/60 border border-[#1B2438] rounded">
              <div className="min-w-0 truncate">{render(r)}</div>
              <div className="flex items-center gap-2 font-mono-hud flex-shrink-0">
                <span className="text-slate-400">{r.wins}-{r.games - r.wins}</span>
                <span className={`font-bold ${wrClass(r.winrate)}`}>{Math.round(r.winrate)}%</span>
              </div>
            </div>
          ))}
          {rows.length > 5 && (
            <button type="button" onClick={() => setAll(!all)}
              className="w-full pt-1 text-[10px] font-mono-hud uppercase tracking-wider text-cyan-400 hover:text-cyan-300">
              {all ? "Show top 5" : `Show all ${rows.length}`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// the open row under a champion: compared with everyone else, per-game trend, breakdowns, matches
function ChampionDetail({ champion, role, games, sum, others, playerName, seasons, pid }) {
  const [trendKey, setTrendKey] = useState("damage");
  const trend = [...games].reverse().filter((g) => g.stats)
    .map((g, i) => ({ idx: i + 1, value: statOf(g, trendKey), won: g.won, date: g.played_at?.slice(0, 10), map: g.map }));
  const otherWr = others?.winrate ?? null;

  return (
    <div className="p-4 space-y-5 bg-[#0C101B] border-t border-[#1B2438]" data-testid={`pool-detail-${champion}`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-3">
          <ChampionPortrait name={champion} role={role} size={40} disableHover linkToProfile={false} />
          <div>
            <div className="font-heading text-xl font-black uppercase leading-none">{champion}</div>
            <div className="text-[10px] font-mono-hud text-slate-500 mt-1">
              {sum.statGames} of {sum.count} game{sum.count === 1 ? "" : "s"} with scoreboard stats
            </div>
          </div>
        </div>
        <Link to={`/champions/${encodeURIComponent(champion)}`} className="text-xs font-mono-hud uppercase tracking-wider text-cyan-400 hover:text-cyan-300">
          Champion page →
        </Link>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-[10px] font-mono-hud uppercase tracking-wider text-slate-500 border-b border-[#1B2438]">
                <th className="p-2 text-left font-normal">Per round</th>
                <th className="p-2 text-right font-normal">Avg</th>
                <th className="p-2 text-right font-normal">Best</th>
                <th className="p-2 text-right font-normal" title={`Everyone else on ${champion}, same seasons and format`}>
                  Others{others?.stat_games ? ` (${others.stat_games})` : ""}
                </th>
                <th className="p-2 text-right font-normal">Diff</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-[#1B2438]/50">
                <td className="p-2 text-slate-300">Win rate</td>
                <td className={`p-2 text-right font-mono-hud font-bold ${wrClass(sum.winrate)}`}>{sum.winrate === null ? "—" : `${num(sum.winrate, 0)}%`}</td>
                <td className="p-2 text-right font-mono-hud text-slate-600">—</td>
                <td className="p-2 text-right font-mono-hud text-slate-400">{otherWr === null ? "—" : `${num(otherWr, 0)}%`}</td>
                <td className={`p-2 text-right font-mono-hud ${otherWr === null || sum.winrate === null ? "text-slate-600" : sum.winrate >= otherWr ? "text-[#00E676]" : "text-[#FF2E55]"}`}>
                  {otherWr === null || sum.winrate === null ? "—" : `${signed(sum.winrate - otherWr, 0)}%`}
                </td>
              </tr>
              {[...STATS, ...SHARES].map((s) => {
                const share = s.key.endsWith("_share");
                const mine = sum[s.key];
                const theirs = others?.[s.key] ?? null;
                const diff = mine !== null && theirs !== null && theirs ? (mine - theirs) / theirs : null;
                return (
                  <tr key={s.key} className="border-b border-[#1B2438]/50">
                    <td className="p-2 text-slate-300" title={s.title}>{s.title && !share ? s.title : s.label}</td>
                    <td className="p-2 text-right font-mono-hud text-cyan-400 font-bold">{share ? pct(mine) : num(mine)}</td>
                    <td className="p-2 text-right font-mono-hud text-slate-300">{share ? pct(sum[`${s.key}_best`]) : num(sum[`${s.key}_best`])}</td>
                    <td className="p-2 text-right font-mono-hud text-slate-400">{share ? pct(theirs) : num(theirs)}</td>
                    <td className={`p-2 text-right font-mono-hud ${diff === null ? "text-slate-600" : diff >= 0 ? "text-[#00E676]" : "text-[#FF2E55]"}`}>
                      {diff === null ? "—" : `${signed(diff * 100, 0)}%`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div>
          <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
            <div className="text-[10px] font-mono-hud uppercase tracking-wider text-slate-500">Per game, oldest → newest</div>
            <Select value={trendKey} onChange={setTrendKey} testid="pool-trend-stat">
              {STATS.map((s) => <option key={s.key} value={s.key}>{s.title || s.label}</option>)}
            </Select>
          </div>
          {trend.length < 2 ? (
            <div className="text-xs font-mono-hud text-slate-600 py-10 text-center">Not enough games with scoreboard stats for a trend.</div>
          ) : (
            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trend} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1B2438" />
                  <XAxis dataKey="idx" stroke="#64748B" fontSize={10} tickLine={false} axisLine={{ stroke: "#1B2438" }} />
                  <YAxis stroke="#64748B" fontSize={10} tickLine={false} axisLine={{ stroke: "#1B2438" }} />
                  <Tooltip contentStyle={{ background: "#0C101B", border: "1px solid #1B2438", fontFamily: "JetBrains Mono", fontSize: 12 }}
                    labelStyle={{ color: "#00F0FF" }}
                    labelFormatter={(l, p) => { const d = p?.[0]?.payload; return d ? `${d.date}${d.map ? ` · ${d.map}` : ""} · ${d.won ? "Win" : "Loss"}` : `Game ${l}`; }}
                    formatter={(v) => [num(v), STATS.find((s) => s.key === trendKey)?.title || STATS.find((s) => s.key === trendKey)?.label]} />
                  <Line type="monotone" dataKey="value" stroke="#00F0FF" strokeWidth={2}
                    dot={(p) => <circle key={p.index} cx={p.cx} cy={p.cy} r={3} fill={p.payload.won ? "#00E676" : "#FF2E55"} />} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
          <div className="text-[10px] font-mono-hud text-slate-600 mt-1">Green dot = win, red = loss</div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <BreakdownList title="Maps" rows={breakdown(games, (g) => [g.map])} render={(r) => r.key} empty="No maps recorded." />
        <BreakdownList title="With" rows={breakdown(games, (g) => g.teammates.map((t) => t.player_id))}
          render={(r) => <Link to={`/players/${r.key}`} className="hover:text-cyan-400">{playerName(r.key)}</Link>} />
        <BreakdownList title="Against" rows={breakdown(games, (g) => g.opponents.map((t) => t.player_id))}
          render={(r) => <Link to={`/players/${r.key}`} className="hover:text-cyan-400">{playerName(r.key)}</Link>} />
        <BreakdownList title="Enemy champions" rows={breakdown(games, (g) => [...new Set(g.opponents.map((t) => t.champion))])}
          render={(r) => <span className="inline-flex items-center gap-1.5"><ChampionPortrait name={r.key} size={18} disableHover linkToProfile={false} />{r.key}</span>} />
      </div>

      <div>
        <div className="text-[10px] font-mono-hud uppercase tracking-wider text-slate-500 mb-2">Matches · {games.length}</div>
        <MatchList matches={games.map((g) => g.match)} playerName={playerName} seasons={seasons}
          focusPlayer={pid} limit={5} testid={`pool-match-${champion}`} />
      </div>
    </div>
  );
}

export default function PlayerChampions() {
  const { id } = useParams();
  const [search] = useSearchParams();
  const [data, setData] = useState(null);
  const [seasons, setSeasons] = useState([]);
  const [players, setPlayers] = useState([]);
  const [seasonId, setSeasonId] = useState(savedSeason);
  const [format, setFormat] = useState("all");
  const [result, setResult] = useState("all");
  const [map, setMap] = useState("");
  const [role, setRole] = useState("");
  const [mate, setMate] = useState("");
  const [foe, setFoe] = useState("");
  const [lastN, setLastN] = useState(0);
  const [statsOnly, setStatsOnly] = useState(false);
  const [minGames, setMinGames] = useState(1);
  const [sort, setSort] = useState({ key: "games", desc: true });
  const [open, setOpen] = useState(() => search.get("open"));   // a card on the player page opens its champion

  useEffect(() => {
    api.get("/seasons").then((r) => setSeasons(r.data));
    api.get("/players").then((r) => setPlayers(r.data));
  }, []);

  useEffect(() => {
    setData(null);
    const params = seasonId ? { season_id: seasonId } : {};
    api.get(`/stats/player/${id}/champions`, { params })
      .then((r) => setData(r.data))
      .catch(() => setData({ error: true }));
  }, [id, seasonId]);

  const playerName = (pid) => players.find((p) => p.id === pid)?.name || "—";
  const allGames = useMemo(() => data?.games || [], [data]);

  // filter choices come from the season's games
  const maps = useMemo(() => [...new Set(allGames.map((g) => g.map).filter(Boolean))].sort(), [allGames]);
  const people = (side) => [...new Set(allGames.flatMap((g) => g[side].map((t) => t.player_id)))]
    .sort((a, b) => playerName(a).localeCompare(playerName(b)));

  const games = useMemo(() => {
    let gs = allGames.filter((g) =>
      (format === "all" || g.format === format) &&
      (result === "all" || (result === "win") === g.won) &&
      (!map || g.map === map) &&
      (!role || g.role === role) &&
      (!mate || g.teammates.some((t) => t.player_id === mate)) &&
      (!foe || g.opponents.some((t) => t.player_id === foe)) &&
      (!statsOnly || g.stats));
    if (lastN) gs = gs.slice(0, lastN);   // newest first
    return gs;
  }, [allGames, format, result, map, role, mate, foe, statsOnly, lastN]);

  const rows = useMemo(() => {
    const by = new Map();
    for (const g of games) {
      if (!by.has(g.champion)) by.set(g.champion, { champion: g.champion, role: g.role, games: [] });
      by.get(g.champion).games.push(g);
    }
    const list = [...by.values()].map((r) => ({ ...r, ...summarise(r.games) })).filter((r) => r.games.length >= minGames);
    const dir = sort.desc ? -1 : 1;
    return list.sort((a, b) => {
      if (sort.key === "champion") return dir * a.champion.localeCompare(b.champion);
      const av = sort.key === "games" ? a.games.length : a[sort.key];
      const bv = sort.key === "games" ? b.games.length : b[sort.key];
      if (av === null && bv === null) return b.games.length - a.games.length;
      if (av === null) return 1;
      if (bv === null) return -1;
      return dir * (av - bv) || b.games.length - a.games.length;
    });
  }, [games, minGames, sort]);

  const total = useMemo(() => summarise(games), [games]);
  const filtered = format !== "all" || result !== "all" || map || role || mate || foe || lastN || statsOnly || minGames > 1;
  const reset = () => { setFormat("all"); setResult("all"); setMap(""); setRole(""); setMate(""); setFoe(""); setLastN(0); setStatsOnly(false); setMinGames(1); };
  const sortBy = (key) => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== "champion" }));

  if (!data) return <div className="text-slate-400 font-mono-hud">Loading champion pool...</div>;
  if (data.error) return (
    <div className="hud-card p-10 text-center">
      <div className="text-slate-400 font-mono-hud mb-3">Player not found.</div>
      <Link to="/players" className="text-cyan-400 hover:underline text-sm">← Back to players</Link>
    </div>
  );

  const cell = (r, c) => {
    const share = c.key.endsWith("_share");
    switch (c.key) {
      case "games": return <span className="text-slate-300">{r.games.length} <span className="text-slate-500 text-xs">({r.wins}-{r.losses})</span></span>;
      case "winrate": return <span className={`font-bold ${wrClass(r.winrate)}`}>{num(r.winrate, 0)}%</span>;
      case "roundDiff": return <span className={r.roundDiff >= 0 ? "text-[#00E676]" : "text-[#FF2E55]"}>{signed(r.roundDiff)}</span>;
      case "mmr": return <span className={r.mmr >= 0 ? "text-[#00E676]" : "text-[#FF2E55]"}>{signed(r.mmr, 0)}</span>;
      default: return <span className={c.key === "damage_normalised" ? "text-cyan-400" : "text-slate-300"}>{share ? pct(r[c.key]) : num(r[c.key])}</span>;
    }
  };
  const baselineFor = (champ) => data.baseline?.[champ]?.[format === "all" ? "all" : format];

  return (
    <div className="space-y-6" data-testid="player-champions-page">
      <Link to={`/players/${id}`} className="inline-flex items-center gap-1.5 text-xs font-mono-hud uppercase tracking-wider text-slate-400 hover:text-cyan-400" data-testid="pool-back-link">
        <ArrowLeft className="w-3.5 h-3.5" /> {data.player.name}
      </Link>

      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <div className="text-xs font-mono-hud uppercase tracking-[0.3em] text-cyan-400/70 mb-2">// Champion Pool</div>
          <h1 className="font-heading text-4xl sm:text-5xl font-black uppercase tracking-tight">{data.player.name}</h1>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <FormatFilter value={format} onChange={setFormat} testid="pool-format" />
          <SeasonSelect seasons={seasons} value={seasonId} onChange={setSeasonId}
            className="bg-[#121828] border border-[#1B2438] rounded px-3 py-2 text-sm" data-testid="pool-season" />
        </div>
      </div>

      <div className="hud-card p-4 flex items-center gap-2 flex-wrap" data-testid="pool-filters">
        <Pills value={result} onChange={setResult} testid="pool-result"
          options={[{ k: "all", label: "All" }, { k: "win", label: "Wins" }, { k: "loss", label: "Losses" }]} />
        <Select value={role} onChange={setRole} testid="pool-role">
          <option value="">Any role</option>
          {["Melee", "Ranged", "Support"].map((r) => <option key={r} value={r}>{r}</option>)}
        </Select>
        <Select value={map} onChange={setMap} testid="pool-map">
          <option value="">Any map</option>
          {maps.map((m) => <option key={m} value={m}>{m}</option>)}
        </Select>
        <Select value={mate} onChange={setMate} testid="pool-with">
          <option value="">With anyone</option>
          {people("teammates").map((p) => <option key={p} value={p}>With {playerName(p)}</option>)}
        </Select>
        <Select value={foe} onChange={setFoe} testid="pool-against">
          <option value="">Against anyone</option>
          {people("opponents").map((p) => <option key={p} value={p}>Against {playerName(p)}</option>)}
        </Select>
        <Select value={String(lastN)} onChange={(v) => setLastN(Number(v))} testid="pool-last">
          {LAST_N.map((o) => <option key={o.k} value={o.k}>{o.label}</option>)}
        </Select>
        <Select value={String(minGames)} onChange={(v) => setMinGames(Number(v))} testid="pool-min-games">
          {[1, 3, 5, 10].map((n) => <option key={n} value={n}>{n === 1 ? "Any # of games" : `${n}+ games`}</option>)}
        </Select>
        <label className="flex items-center gap-2 text-xs font-mono-hud text-slate-300 px-2 cursor-pointer">
          <input type="checkbox" checked={statsOnly} onChange={(e) => setStatsOnly(e.target.checked)} data-testid="pool-stats-only" />
          Only games with scoreboard
        </label>
        {filtered && (
          <button type="button" onClick={reset} data-testid="pool-reset"
            className="ml-auto inline-flex items-center gap-1 text-xs font-mono-hud uppercase tracking-wider text-slate-400 hover:text-cyan-400">
            <RotateCcw className="w-3 h-3" /> Reset
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="hud-card hud-corner p-5">
          <div className="text-xs font-mono-hud uppercase tracking-[0.2em] text-slate-400 mb-2">Games</div>
          <div className="font-mono-hud text-3xl font-black">{total.count}</div>
          <div className="text-[10px] font-mono-hud text-slate-500 mt-1">{total.wins}W · {total.losses}L · {rows.length} champion{rows.length === 1 ? "" : "s"}</div>
        </div>
        <div className="hud-card hud-corner p-5">
          <div className="text-xs font-mono-hud uppercase tracking-[0.2em] text-slate-400 mb-2">Winrate · Rounds</div>
          <div className={`font-mono-hud text-3xl font-black ${wrClass(total.winrate)}`}>{total.winrate === null ? "—" : `${num(total.winrate, 1)}%`}</div>
          <div className="text-[10px] font-mono-hud text-slate-500 mt-1">{signed(total.roundDiff)} rounds per game · {signed(total.mmr, 0)} MMR</div>
        </div>
        <div className="hud-card hud-corner p-5">
          <div className="text-xs font-mono-hud uppercase tracking-[0.2em] text-slate-400 mb-2">Avg Damage · Norm.</div>
          <div className="font-mono-hud text-3xl font-black text-cyan-400">{num(total.damage)}</div>
          <div className="text-[10px] font-mono-hud text-slate-500 mt-1">{num(total.damage_normalised)} normalised · {pct(total.damage_team_share)} of team</div>
        </div>
        <div className="hud-card hud-corner p-5">
          <div className="text-xs font-mono-hud uppercase tracking-[0.2em] text-slate-400 mb-2">Avg Prot. · Disables</div>
          <div className="font-mono-hud text-3xl font-black text-[#00E676]">{num(total.protection)}</div>
          <div className="text-[10px] font-mono-hud text-slate-500 mt-1">{num(total.disables)} disables · score {num(total.score)} · {total.statGames} with stats</div>
        </div>
      </div>

      <div className="hud-card p-5">
        <h3 className="font-heading text-lg font-bold uppercase mb-1 flex items-center gap-2"><Flame className="w-4 h-4 text-[#FFB800]" /> Champions</h3>
        <div className="text-[10px] font-mono-hud text-slate-500 mb-4">
          Scoreboard numbers are per-round averages, over the games that had a scoreboard read. Click a champion for the details; click a heading to sort.
        </div>
        {rows.length === 0 ? (
          <div className="text-slate-500 text-sm font-mono-hud">{allGames.length ? "No games match these filters." : "No matches yet."}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm" data-testid="pool-table">
              <thead>
                <tr className="text-[10px] font-mono-hud uppercase tracking-wider text-slate-400 border-b border-[#1B2438]">
                  {COLUMNS.map((c) => (
                    <th key={c.key} title={c.title} onClick={() => sortBy(c.key)} data-testid={`pool-sort-${c.key}`}
                      className={`p-2 whitespace-nowrap cursor-pointer select-none hover:text-cyan-400 ${c.left ? "text-left" : "text-right"} ${sort.key === c.key ? "text-cyan-400" : ""}`}>
                      {c.label}{sort.key === c.key ? (sort.desc ? " ↓" : " ↑") : ""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Fragment key={r.champion}>
                    <tr onClick={() => setOpen(open === r.champion ? null : r.champion)} data-testid={`pool-row-${r.champion}`}
                      className={`border-b border-[#1B2438]/50 cursor-pointer hover:bg-[#121828]/60 ${open === r.champion ? "bg-[#121828]/60" : ""}`}>
                      {COLUMNS.map((c) => c.key === "champion" ? (
                        <td key={c.key} className="p-2">
                          <div className="flex items-center gap-2 whitespace-nowrap">
                            {open === r.champion ? <ChevronDown className="w-3.5 h-3.5 text-cyan-400" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-500" />}
                            <ChampionPortrait name={r.champion} role={r.role} size={28} disableHover linkToProfile={false} />
                            <span className="font-medium">{r.champion}</span>
                          </div>
                        </td>
                      ) : (
                        <td key={c.key} className="p-2 text-right font-mono-hud whitespace-nowrap">{cell(r, c)}</td>
                      ))}
                    </tr>
                    {open === r.champion && (
                      <tr>
                        <td colSpan={COLUMNS.length} className="p-0">
                          <ChampionDetail champion={r.champion} role={r.role} games={r.games} sum={r} others={baselineFor(r.champion)}
                            playerName={playerName} seasons={seasons} pid={id} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
