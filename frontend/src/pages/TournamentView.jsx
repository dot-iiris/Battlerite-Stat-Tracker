import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import api, { API } from "@/api";
import { toast } from "sonner";
import { ArrowLeft, ChevronDown, Copy, Eye, EyeOff, Flag, Image as ImageIcon, Pencil, PlayCircle, PlusCircle, Trash2, Trophy, Tv, Check, X, SkipForward } from "lucide-react";
import { useAuth } from "@/AuthContext";
import MatchDetails from "@/components/MatchDetails";
import { Bracket, Standings, StatusChip, matchNames, rotationMembers, stageText, LEAGUE_NAMES, PLAYOFF_NAMES } from "@/components/TournamentParts";

const TABS = [
  { key: "bracket", label: "Bracket" },
  { key: "standings", label: "Standings" },
  { key: "matches", label: "Matches" },
  { key: "teams", label: "Teams" },
  { key: "stats", label: "Stats" },
];
const btn = "flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono-hud uppercase tracking-wider border rounded transition-colors";
const errText = (err, fallback) => err?.response?.data?.detail || fallback;

// A tournament game shaped like a logged match, for MatchDetails (sides A/B as it was entered)
const gameAsMatch = (g) => ({
  id: g.game_id, format: g.format, played_at: g.played_at, map: g.map, source: g.source, source_ref: g.source_ref,
  team_a_rounds: g.team_a_rounds, team_b_rounds: g.team_b_rounds, winner_team: g.winner_team,
  players: g.players.map((p) => ({ ...p, team: p.side })),
});

function MatchRow({ t, m, names, isAdmin, act, highlight, members, playerName }) {
  const open = ["ready", "live"].includes(m.status);
  const [openGame, setOpenGame] = useState(null);   // game id shown in full under the row
  const teamName = (id) => (id === m.team1 ? m.team1_name : id === m.team2 ? m.team2_name : null);
  const shown = m.game_list?.find((g) => g.game_id === openGame);
  const score = m.status === "bye" ? "" : m.status === "forfeit" ? (m.winner === m.team1 ? "W - FF" : "FF - W") : m.best_of > 1 ? `${m.wins1} - ${m.wins2}` : m.games ? `${m.rounds1} - ${m.rounds2}` : "vs";
  const side = (n) => {
    const won = m.done && m.winner && m.winner === m[`team${n}`];
    const cls = won ? "text-cyan-300 font-semibold" : m.done ? "text-slate-500" : "";
    const players = m[`team${n}`] && members?.(m[`team${n}`]);
    if (players) {   // player rotation: one player per line, so long teams aren't cut off
      return <span className={`flex flex-col min-w-0 ${n === 1 ? "text-right" : ""} ${cls}`}>{players.map((p, i) => <span key={i} className="truncate">{p}</span>)}</span>;
    }
    return <span className={`truncate ${cls}`}>{m[`team${n}_name`] || "TBD"}</span>;
  };
  return (
    <div id={`tm-${m.id}`} className={`rounded border px-3 py-2 space-y-1.5 ${highlight ? "border-cyan-400" : "border-[#1B2438]"}`} data-testid={`tmatch-${m.id}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[10px] font-mono-hud uppercase tracking-wider text-slate-500 w-40 truncate">{names[m.id]}{m.best_of > 1 ? ` · Bo${m.best_of}` : ""}</span>
        {m.status === "bye" ? (
          <span className="text-sm text-slate-400 flex-1">{m.team1_name} has a bye</span>
        ) : (
          <span className="flex items-center gap-2 text-sm flex-1 min-w-0">
            {side(1)}<span className="font-mono-hud text-slate-300 shrink-0">{score}</span>{side(2)}
          </span>
        )}
        <StatusChip m={m} />
        {isAdmin && open && m.team1 && m.team2 && (
          <span className="flex items-center gap-2">
            <Link to={`/log?tm=${t.id}:${m.id}`} className={`${btn} border-cyan-400/50 text-cyan-400 hover:bg-cyan-400/10`} data-testid={`tmatch-log-${m.id}`}>
              <PlusCircle className="w-3.5 h-3.5" /> Enter game {m.wins1 + m.wins2 + 1}
            </Link>
            <select value="" onChange={(e) => e.target.value && act(`/tournaments/${t.id}/matches/${m.id}/forfeit`, { winner: e.target.value }, "Forfeit recorded")}
              className="bg-[#121828] border border-[#1B2438] rounded px-2 py-1 text-xs" title="Give the series to one team (no-show etc.)" data-testid={`tmatch-ff-${m.id}`}>
              <option value="">Forfeit…</option>
              <option value={m.team1}>{m.team1_name} wins</option>
              <option value={m.team2}>{m.team2_name} wins</option>
            </select>
          </span>
        )}
        {isAdmin && m.status === "forfeit" && (
          <button onClick={() => act(`/tournaments/${t.id}/matches/${m.id}/forfeit`, { winner: null }, "Forfeit removed")} className={`${btn} border-[#1B2438] text-slate-400 hover:text-white`}>
            <X className="w-3.5 h-3.5" /> Undo forfeit
          </button>
        )}
      </div>
      {m.game_list?.length > 0 && (
        <div className="flex flex-wrap gap-2 pl-0 sm:pl-[10.75rem]">
          {m.game_list.map((g, i) => {
            const wName = g.winner === m.team1 ? m.team1_name : m.team2_name;
            return (
              <span key={g.game_id} data-testid={`tgame-${g.game_id}`}
                className={`inline-flex items-center gap-1.5 text-[11px] font-mono-hud px-2 py-0.5 rounded border ${openGame === g.game_id ? "border-cyan-400/60 text-cyan-300" : "border-[#1B2438] text-slate-400"}`}>
                <button type="button" onClick={() => setOpenGame(openGame === g.game_id ? null : g.game_id)} data-testid={`tgame-open-${g.game_id}`}
                  title={`${[m.team1, m.team2].map((tm) => g.players.filter((p) => p.team === tm).map((p) => p.champion).join(", ")).join("  vs  ")} - click for the scoreboard`}
                  className="inline-flex items-center gap-1 hover:text-cyan-300">
                  G{i + 1}: {wName} {g.rounds[m.team1]}-{g.rounds[m.team2]}
                  <ChevronDown className={`w-3 h-3 transition-transform ${openGame === g.game_id ? "rotate-180" : ""}`} />
                </button>
                {g.screenshot_id && (
                  <a href={`${API}/screenshots/${g.screenshot_id}`} target="_blank" rel="noreferrer" title="Open the scoreboard screenshot"
                    className="text-slate-500 hover:text-cyan-400" aria-label="Screenshot" data-testid={`tgame-shot-${g.game_id}`}><ImageIcon className="w-3 h-3" /></a>
                )}
                {isAdmin && (
                  <button onClick={() => window.confirm(`Delete game ${i + 1} of this series?`) && act(`/tournaments/${t.id}/games/${g.game_id}`, null, "Game deleted", "delete")}
                    className="text-slate-600 hover:text-[#FF2E55]" aria-label="Delete game" data-testid={`tgame-del-${g.game_id}`}><X className="w-3 h-3" /></button>
                )}
              </span>
            );
          })}
        </div>
      )}
      {shown && (
        <div className="px-1 pb-1" data-testid={`tgame-details-${shown.game_id}`}>
          <MatchDetails match={gameAsMatch(shown)} playerName={playerName} editable={false}
            statsPath={`/tournaments/${t.id}/games/${shown.game_id}/stats`}
            screenshotUrl={shown.screenshot_id ? `${API}/screenshots/${shown.screenshot_id}` : null}
            teamNames={{ A: teamName(shown.sides?.A), B: teamName(shown.sides?.B) }}
            showMmr={!!t.counts_for_mmr && shown.players.some((p) => p.elo_delta != null)} />
        </div>
      )}
    </div>
  );
}

function MatchesTab({ t, isAdmin, act, focus }) {
  const names = useMemo(() => matchNames(t.matches), [t.matches]);
  const members = useMemo(() => rotationMembers(t), [t]);
  const playerName = useMemo(() => {
    const byId = { ...(t.player_names || {}) };
    for (const x of t.teams) for (const p of x.players || []) byId[p.id] = p.name;
    return (id) => byId[id] || "?";
  }, [t]);
  const sections = [];
  for (const m of t.matches) {
    const key = m.stage === "league" ? (m.group ? `Group ${m.group} · Round ${m.round}` : `Round ${m.round}`) : m.label || "Playoffs";
    const title = m.stage === "league" ? `League · ${key}` : key;
    let s = sections.find((x) => x.title === title);
    if (!s) { s = { title, matches: [] }; sections.push(s); }
    s.matches.push(m);
  }
  useEffect(() => {
    if (focus) document.getElementById(`tm-${focus}`)?.scrollIntoView({ block: "center" });
  }, [focus]);
  return (
    <div className="space-y-5">
      {isAdmin && (
        <div className="text-xs text-slate-500">
          Players in Discord can <span className="font-mono-hud text-slate-300">/submit</span> each game of their next tournament match (when they're not in a lobby), or enter a game here. Games are kept with the tournament, out of the ranked and unranked stats{t.counts_for_mmr ? " - but they do move MMR (as labelled adjustments in the active ranked season), and deleting a game takes its MMR change back" : ""}.
        </div>
      )}
      {sections.map((s) => (
        <div key={s.title} className="space-y-2">
          <div className="text-[10px] font-mono-hud uppercase tracking-[0.25em] text-cyan-400/70">{s.title}</div>
          {t.rests?.[s.matches[0].round]?.length > 0 && s.matches[0].stage === "league" && (
            <div className="text-xs text-slate-500">Sitting out: {t.rests[s.matches[0].round].map((pid) => t.player_names?.[pid] || "?").join(", ")}</div>
          )}
          {s.matches.map((m) => <MatchRow key={m.id} t={t} m={m} names={names} isAdmin={isAdmin} act={act} highlight={m.id === focus} members={members} playerName={playerName} />)}
        </div>
      ))}
    </div>
  );
}

function TeamsTab({ t, isAdmin, reload }) {
  const [edit, setEdit] = useState(null);   // team id being renamed
  const [val, setVal] = useState("");
  const save = async (id) => {
    try {
      await api.patch(`/tournaments/${t.id}`, { team_names: { [id]: val } });
      setEdit(null); reload();
    } catch (err) { toast.error(errText(err, "Couldn't rename")); }
  };
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {[...t.teams].sort((a, b) => a.seed - b.seed).map((x) => (
        <div key={x.id} className="hud-card p-4" data-testid={`tteam-${x.id}`}>
          <div className="flex items-center gap-2 mb-2">
            <span className="font-mono-hud text-xs text-cyan-400">#{x.seed}</span>
            {edit === x.id ? (
              <>
                <input value={val} onChange={(e) => setVal(e.target.value)} className="flex-1 min-w-0 bg-[#121828] border border-[#1B2438] rounded px-2 py-1 text-sm" autoFocus />
                <button onClick={() => save(x.id)} className="text-cyan-400"><Check className="w-4 h-4" /></button>
                <button onClick={() => setEdit(null)} className="text-slate-500"><X className="w-4 h-4" /></button>
              </>
            ) : (
              <>
                <span className="font-heading font-black uppercase text-lg truncate flex-1">{x.name}</span>
                {x.id === t.champion && <Trophy className="w-4 h-4 text-[#FFB800]" />}
                {isAdmin && <button onClick={() => { setEdit(x.id); setVal(x.name); }} className="text-slate-500 hover:text-cyan-400" aria-label="Rename"><Pencil className="w-3.5 h-3.5" /></button>}
              </>
            )}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
            {(x.players || []).map((p) => <Link key={p.id} to={`/players/${p.id}`} className="text-slate-300 hover:text-cyan-400">{p.name}</Link>)}
          </div>
        </div>
      ))}
    </div>
  );
}

const STATS = [["score", "Score"], ["damage", "Damage"], ["protection", "Protection"], ["disables", "Disables"]];

function StatsTab({ tid }) {
  const [s, setS] = useState(null);
  useEffect(() => { api.get(`/tournaments/${tid}/stats`).then((r) => setS(r.data)).catch(() => setS({ error: true })); }, [tid]);
  if (!s) return <div className="text-sm text-slate-500">Loading…</div>;
  if (s.error) return <div className="text-sm text-slate-400">Couldn't load the stats.</div>;
  if (!s.games) return <div className="text-sm text-slate-400">No games played yet.</div>;
  const hasTeams = s.players.some((r) => r.team);   // a player rotation has none
  return (
    <div className="space-y-6" data-testid="tour-stats">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {STATS.map(([k, label]) => (
          <div key={k} className="hud-card p-4">
            <div className="text-[10px] font-mono-hud uppercase tracking-[0.25em] text-cyan-400/70 mb-2">Top {label} <span className="text-slate-500 normal-case tracking-normal">(avg / round)</span></div>
            {(s.leaders[k] || []).length === 0 ? <div className="text-xs text-slate-500">No stats read yet.</div> :
              s.leaders[k].map((r, i) => (
                <div key={r.player_id} className="flex justify-between text-sm">
                  <span className={i === 0 ? "text-[#FFB800] font-semibold" : "text-slate-300"}>{r.name}</span>
                  <span className="font-mono-hud text-slate-300">{r[k]}</span>
                </div>
              ))}
          </div>
        ))}
      </div>
      <div className="hud-card p-0 overflow-x-auto">
        <table className="w-full text-sm text-slate-100">
          <thead>
            <tr className="text-[10px] font-mono-hud uppercase tracking-wider text-slate-500 text-right">
              <th className="px-3 py-2 text-left">Player</th>{hasTeams && <th className="px-3 py-2 text-left">Team</th>}
              <th className="px-3 py-2">Games</th><th className="px-3 py-2">Win %</th>
              {s.players.some((r) => r.mmr_change != null) && <th className="px-3 py-2">MMR</th>}
              {STATS.map(([k, l]) => <th key={k} className="px-3 py-2">{l}</th>)}
              <th className="px-3 py-2 text-left">Champions</th>
            </tr>
          </thead>
          <tbody>
            {s.players.map((r) => (
              <tr key={r.player_id} className="border-t border-[#1B2438] text-right">
                <td className="px-3 py-1.5 text-left"><Link to={`/players/${r.player_id}`} className="hover:text-cyan-400">{r.name}</Link></td>
                {hasTeams && <td className="px-3 py-1.5 text-left text-slate-400">{r.team}</td>}
                <td className="px-3 py-1.5 font-mono-hud">{r.games}</td>
                <td className="px-3 py-1.5 font-mono-hud">{r.winrate == null ? "-" : `${r.winrate}%`}</td>
                {r.mmr_change != null && <td className={`px-3 py-1.5 font-mono-hud ${r.mmr_change > 0 ? "text-cyan-300" : r.mmr_change < 0 ? "text-[#FF2E55]" : "text-slate-400"}`}>{r.mmr_change > 0 ? "+" : ""}{r.mmr_change}</td>}
                {STATS.map(([k]) => <td key={k} className="px-3 py-1.5 font-mono-hud text-slate-300">{r[k] ?? "-"}</td>)}
                <td className="px-3 py-1.5 text-left text-xs text-slate-400">{r.champions.slice(0, 3).map(([c, n]) => `${c} ×${n}`).join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="hud-card p-4">
        <div className="text-[10px] font-mono-hud uppercase tracking-[0.25em] text-cyan-400/70 mb-2">Champion picks · {s.games} games</div>
        <div className="flex flex-wrap gap-2">
          {s.champions.map(([c, n]) => <span key={c} className="text-xs px-2 py-1 rounded border border-[#1B2438]">{c} <span className="font-mono-hud text-cyan-400">{n}</span></span>)}
        </div>
      </div>
    </div>
  );
}

function StreamLinks({ id, league, streamKey }) {
  const base = `${window.location.origin}/stream/tournament/${id}?key=${streamKey}`;
  const links = [["Bracket", `${base}&view=bracket`], ...(league ? [["Standings", `${base}&view=standings`]] : []),
    ["Up next", `${base}&view=next`], ["Bracket (no background)", `${base}&view=bracket&bg=transparent`]];
  const copy = async (u) => {
    try { await navigator.clipboard.writeText(u); toast.success("Link copied"); } catch { window.prompt("Copy this link", u); }
  };
  return (
    <div className="hud-card p-4 space-y-2" data-testid="stream-links">
      <div className="flex items-center gap-2 text-[10px] font-mono-hud uppercase tracking-[0.25em] text-cyan-400/70"><Tv className="w-3.5 h-3.5" /> Stream overlays</div>
      <div className="text-xs text-slate-500">Add one as a Browser Source in OBS. They need no login and refresh themselves every few seconds. Each link has this tournament's private key in it - anyone with the link can see the overlay, so only give it to whoever's streaming.</div>
      <div className="flex flex-wrap gap-2">
        {links.map(([l, u]) => (
          <span key={l} className="flex items-center gap-1">
            <a href={u} target="_blank" rel="noreferrer" className={`${btn} border-[#1B2438] text-slate-300 hover:border-cyan-400`}>{l}</a>
            <button onClick={() => copy(u)} className="text-slate-500 hover:text-cyan-400 p-1" aria-label={`Copy ${l} link`}><Copy className="w-3.5 h-3.5" /></button>
          </span>
        ))}
      </div>
    </div>
  );
}

export default function TournamentView() {
  const { id } = useParams();
  const nav = useNavigate();
  const { isAdmin } = useAuth();
  const [params, setParams] = useSearchParams();
  const [t, setT] = useState(null);
  const [missing, setMissing] = useState(false);
  const [renaming, setRenaming] = useState(null);

  const load = () => api.get(`/tournaments/${id}`).then((r) => setT(r.data)).catch((e) => { if (e?.response?.status === 404) setMissing(true); });
  useEffect(() => {
    load();
    const timer = setInterval(load, 20000);   // results come in from Discord too
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const hasBracket = t && (t.playoffs || t.matches.some((m) => m.stage === "playoffs"));
  const rotation = t?.league?.type === "rotation";   // teams change every match: no Teams tab
  const tabs = TABS.filter((x) => (x.key !== "bracket" || hasBracket) && (x.key !== "standings" || t?.league) && (x.key !== "teams" || !rotation));
  const tab = tabs.find((x) => x.key === params.get("tab"))?.key ||
    (t && t.status === "league" ? "standings" : hasBracket ? "bracket" : "standings");
  const setTab = (k) => setParams({ tab: k });

  const act = async (url, body, done, method = "post") => {
    try {
      const { data } = method === "delete" ? await api.delete(url) : await api.post(url, body);
      setT(data);
      if (done) toast.success(done);
    } catch (err) {
      toast.error(errText(err, "That didn't work"));
    }
  };

  if (missing) return <div className="text-slate-400">Tournament not found. <Link to="/tournaments" className="text-cyan-400">All tournaments</Link></div>;
  if (!t) return <div className="text-sm text-slate-500">Loading…</div>;

  const league = t.matches.filter((m) => m.stage === "league");
  const playoffsDrawn = t.matches.some((m) => m.stage === "playoffs");
  const canStartPlayoffs = isAdmin && t.playoffs && !playoffsDrawn && t.league;
  const canNextRound = isAdmin && t.league?.type === "swiss" && t.status === "league" && league.length > 0 &&
    league.every((m) => m.done) && t.league_round < t.league_rounds;

  const startPlayoffs = () => {
    if (!t.league_done && !window.confirm("The league stage isn't finished. Draw the playoffs from the table as it is now?")) return;
    act(`/tournaments/${t.id}/start-playoffs`, {}, "Playoffs drawn").then(() => setTab("bracket"));
  };
  const rename = async () => {
    try { const { data } = await api.patch(`/tournaments/${t.id}`, { name: renaming }); setT(data); setRenaming(null); }
    catch (err) { toast.error(errText(err, "Couldn't rename")); }
  };
  const setVisible = async () => {
    try {
      const { data } = await api.patch(`/tournaments/${t.id}`, { visible: !t.visible });
      setT(data);
      toast.success(data.visible ? "Players can see this tournament now" : "Hidden from players");
    } catch (err) { toast.error(errText(err, "Couldn't change that")); }
  };
  const remove = async () => {
    if (!window.confirm(`Delete ${t.name}? Its games and stats are deleted with it.`)) return;
    try { await api.delete(`/tournaments/${t.id}`); toast.success("Tournament deleted"); nav("/tournaments"); }
    catch (err) { toast.error(errText(err, "Couldn't delete")); }
  };

  return (
    <div className="space-y-6" data-testid="tournament-view">
      <div className="space-y-2">
        <Link to="/tournaments" className="inline-flex items-center gap-1 text-xs font-mono-hud uppercase text-slate-500 hover:text-cyan-400"><ArrowLeft className="w-3.5 h-3.5" /> Tournaments</Link>
        {isAdmin && (
          <button type="button" onClick={setVisible} data-testid="tv-visibility"
            title={t.visible ? "Players can see this tournament. Click to hide it." : "Only admins can see this tournament. Click to show it to players."}
            className={`ml-3 inline-flex items-center gap-1 text-[10px] font-mono-hud uppercase tracking-wider px-1.5 py-0.5 border rounded transition-colors ${t.visible
              ? "text-cyan-400 border-cyan-400/50 bg-cyan-400/10 hover:bg-cyan-400/20" : "text-[#FFB800] border-[#FFB800]/50 bg-[#FFB800]/10 hover:bg-[#FFB800]/20"}`}>
            {t.visible ? <><Eye className="w-3 h-3" /> Visible to players</> : <><EyeOff className="w-3 h-3" /> Hidden from players</>}
          </button>
        )}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            {renaming !== null ? (
              <div className="flex items-center gap-2">
                <input value={renaming} onChange={(e) => setRenaming(e.target.value)} className="bg-[#121828] border border-[#1B2438] rounded px-3 py-2 text-2xl font-heading font-black uppercase" autoFocus />
                <button onClick={rename} className="text-cyan-400"><Check className="w-5 h-5" /></button>
                <button onClick={() => setRenaming(null)} className="text-slate-500"><X className="w-5 h-5" /></button>
              </div>
            ) : (
              <h1 className="font-heading text-4xl sm:text-5xl font-black uppercase tracking-tight flex items-center gap-3" data-testid="tv-name">
                {t.name}
                {isAdmin && <button onClick={() => setRenaming(t.name)} className="text-slate-600 hover:text-cyan-400" aria-label="Rename"><Pencil className="w-4 h-4" /></button>}
              </h1>
            )}
            <div className="text-xs font-mono-hud uppercase tracking-wider text-slate-400 flex flex-wrap gap-x-3 mt-1">
              <span>{t.format}</span><span>{rotation ? `${t.players.length} players` : `${t.teams.length} teams`}</span>
              {t.league && <span>{LEAGUE_NAMES[t.league.type]}{t.league.best_of > 1 ? ` (Bo${t.league.best_of})` : ""}</span>}
              {t.playoffs && <span>{PLAYOFF_NAMES[t.playoffs.type]}{t.playoffs.type === "double" && t.playoffs.grand_reset ? " + reset" : ""}</span>}
              <span title={t.counts_for_mmr ? "Each game moves MMR in the active ranked season (as a labelled adjustment); the games stay out of the ranked and unranked stats" : "Games don't change MMR"}>{t.counts_for_mmr ? "Counts for MMR" : "No MMR"}</span>
              <span className="text-cyan-300" data-testid="tv-stage">{stageText(t)}</span>
            </div>
          </div>
          {isAdmin && (
            <div className="flex flex-wrap gap-2">
              {canStartPlayoffs && <button onClick={startPlayoffs} className={`${btn} border-cyan-400/50 text-cyan-400 hover:bg-cyan-400/10`} data-testid="tv-start-playoffs"><PlayCircle className="w-3.5 h-3.5" /> Draw playoffs</button>}
              {canNextRound && <button onClick={() => act(`/tournaments/${t.id}/next-round`, {}, "Next round drawn")} className={`${btn} border-cyan-400/50 text-cyan-400 hover:bg-cyan-400/10`} data-testid="tv-next-round"><SkipForward className="w-3.5 h-3.5" /> Next round</button>}
              <button onClick={remove} className={`${btn} border-[#1B2438] text-slate-400 hover:border-[#FF2E55] hover:text-[#FF2E55]`} data-testid="tv-delete"><Trash2 className="w-3.5 h-3.5" /> Delete</button>
            </div>
          )}
        </div>
      </div>

      {t.champion_name && (
        <div className="hud-card p-4 flex items-center gap-3 border-[#FFB800]/40" data-testid="tv-champion">
          <Trophy className="w-7 h-7 text-[#FFB800]" />
          <div>
            <div className="text-[10px] font-mono-hud uppercase tracking-[0.25em] text-[#FFB800]/80">Champion</div>
            <div className="font-heading text-2xl font-black uppercase text-[#FFB800]">{t.champion_name}</div>
          </div>
          <div className="text-sm text-slate-300 ml-2">{(t.teams.find((x) => x.id === t.champion)?.players || []).map((p) => p.name).join(" · ")}</div>
        </div>
      )}

      <div className="flex flex-wrap gap-x-1 border-b border-[#1B2438]">
        {tabs.map((x) => (
          <button key={x.key} onClick={() => setTab(x.key)} data-testid={`tv-tab-${x.key}`}
            className={`px-4 py-2.5 text-xs font-mono-hud uppercase tracking-wider border-b-2 ${tab === x.key ? "text-cyan-400 border-cyan-400" : "text-slate-400 border-transparent hover:text-slate-100"}`}>
            {x.label}
          </button>
        ))}
      </div>

      {tab === "bracket" && <Bracket t={t} onPick={(m) => setParams({ tab: "matches", m: m.id })} />}
      {tab === "standings" && <Standings t={t} />}
      {tab === "matches" && <MatchesTab t={t} isAdmin={isAdmin} act={act} focus={params.get("m")} />}
      {tab === "teams" && <TeamsTab t={t} isAdmin={isAdmin} reload={load} />}
      {tab === "stats" && <StatsTab tid={t.id} />}

      {isAdmin && t.stream_key && <StreamLinks id={t.id} league={!!t.league} streamKey={t.stream_key} />}
      {isAdmin && t.status !== "finished" && tab !== "matches" && (
        <div className="text-xs text-slate-500 flex items-center gap-1.5"><Flag className="w-3.5 h-3.5" /> Results, forfeits and "Enter game" are on the Matches tab.</div>
      )}
    </div>
  );
}
