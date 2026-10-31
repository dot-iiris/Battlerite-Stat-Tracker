import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import api from "@/api";
import { toast } from "sonner";
import { Award, Plus, ChevronUp, ChevronDown, Download, Trophy, X } from "lucide-react";
import { useAuth } from "@/AuthContext";
import { LEAGUE_NAMES, PLAYOFF_NAMES } from "@/components/TournamentParts";

// Tournaments: the list for everyone, and (admins) setting a new one up. Teams are listed in seed
// order; the Make Teams page's last result can be brought in.
export const LAST_TEAMS_KEY = "brstats.lastTeams";
const sel = "bg-[#121828] border border-[#1B2438] focus:border-cyan-400 focus:outline-none rounded px-3 py-2 text-sm";
const lbl = "block text-xs font-mono-hud uppercase tracking-[0.2em] text-cyan-400/80 mb-1.5";
const norm = (s) => (s || "").trim().toLowerCase();
const BO = [1, 3, 5, 7];
const STATUS = { league: "League stage", playoffs: "Playoffs", finished: "Finished" };

const blankTeam = (n, size) => ({ name: `Team ${n}`, slots: Array.from({ length: size }, () => "") });

function CreateForm({ onDone, autoImport }) {
  const nav = useNavigate();
  const [players, setPlayers] = useState([]);
  const [name, setName] = useState("");
  const [format, setFormat] = useState("3v3");
  const [teams, setTeams] = useState([blankTeam(1, 3), blankTeam(2, 3)]);
  const [mmr, setMmr] = useState(false);
  const [league, setLeague] = useState("round_robin");   // "" = none
  const [lgBo, setLgBo] = useState(1);
  const [rounds, setRounds] = useState("");
  const [groups, setGroups] = useState(2);
  const [advance, setAdvance] = useState(2);
  const [playoffs, setPlayoffs] = useState("single");   // "" = none
  const [reset, setReset] = useState(true);
  const [through, setThrough] = useState("");
  const [bo, setBo] = useState(1);
  const [semisBo, setSemisBo] = useState(3);
  const [finalBo, setFinalBo] = useState(3);
  const [saving, setSaving] = useState(false);
  const [roster, setRoster] = useState([]);   // player rotation: player ids
  const [pick, setPick] = useState("");
  const [balance, setBalance] = useState(false);
  const size = format === "2v2" ? 2 : 3;
  const rotation = league === "rotation";

  useEffect(() => { api.get("/players").then((r) => setPlayers(r.data)).catch(() => toast.error("Couldn't load players")); }, []);
  const [imported, setImported] = useState(false);
  useEffect(() => {   // came from Make Teams: bring its teams in once the players are loaded
    if (autoImport && players.length && !imported) { setImported(true); importTeams(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoImport, players]);

  const find = (n) => players.find((p) => norm(p.name) === norm(n)) || players.find((p) => p.ign && norm(p.ign) === norm(n));
  const used = new Map();
  if (rotation) roster.forEach((id) => used.set(id, 1));
  else teams.forEach((t) => t.slots.forEach((s) => { const p = find(s); if (p) used.set(p.id, (used.get(p.id) || 0) + 1); }));
  const addPick = () => {
    const p = find(pick);
    if (!p) { toast.error("Pick a player who's on the site"); return; }
    if (!roster.includes(p.id)) setRoster([...roster, p.id]);
    setPick("");
  };
  const perRound = Math.floor(roster.length / (size * 2));
  const sitting = roster.length - perRound * size * 2;

  const changeFormat = (f) => {
    setFormat(f);
    const n = f === "2v2" ? 2 : 3;
    setTeams((cur) => cur.map((t) => ({ ...t, slots: Array.from({ length: n }, (_, i) => t.slots[i] || "") })));
  };
  const setTeam = (i, v) => setTeams((cur) => cur.map((t, j) => (j === i ? { ...t, ...v } : t)));
  const move = (i, d) => setTeams((cur) => {
    const n = [...cur]; const j = i + d;
    if (j < 0 || j >= n.length) return cur;
    [n[i], n[j]] = [n[j], n[i]]; return n;
  });

  const importTeams = () => {
    let last = null;
    try { last = JSON.parse(window.localStorage.getItem(LAST_TEAMS_KEY) || "null"); } catch { /* private window */ }
    if (!last?.teams?.length) { toast.error("Make some teams on the Make Teams page first"); return; }
    const byId = Object.fromEntries(players.map((p) => [p.id, p.name]));
    setFormat(last.format);
    if (rotation) {   // only the players matter: teams are made fresh every round
      setRoster([...new Set(last.teams.flatMap((t) => t.player_ids).filter((id) => byId[id]))]);
      toast.success("Players brought in");
      return;
    }
    setTeams(last.teams.map((t, i) => ({ name: t.name || `Team ${i + 1}`, slots: t.player_ids.map((id) => byId[id] || "") })));
    toast.success(`${last.teams.length} teams brought in, strongest first`);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (rotation) {
      if (roster.length < size * 2) { toast.error(`Pick at least ${size * 2} players`); return; }
      if (!rounds) { toast.error("How many rounds?"); return; }
      return create({ name, format, counts_for_mmr: mmr, players: roster, playoffs: null,
        league: { type: "rotation", best_of: lgBo, rounds: Number(rounds), balance_mmr: balance } });
    }
    const out = [];
    for (const t of teams) {
      const ids = t.slots.map(find);
      if (ids.some((p) => !p)) { toast.error(`${t.name}: pick ${size} players who are on the site`); return; }
      out.push({ name: t.name, player_ids: ids.map((p) => p.id) });
    }
    if ([...used.values()].some((n) => n > 1)) { toast.error("A player is in two teams"); return; }
    if (!league && !playoffs) { toast.error("Choose a league stage, playoffs, or both"); return; }
    const body = { name, format, counts_for_mmr: mmr, teams: out, league: null, playoffs: null };
    if (league) body.league = { type: league, best_of: lgBo, rounds: rounds ? Number(rounds) : null, groups: Number(groups), advance_per_group: Number(advance) };
    if (playoffs) body.playoffs = { type: playoffs, grand_reset: reset, best_of: bo, semis_best_of: semisBo, final_best_of: finalBo,
      teams: league && league !== "groups" && through ? Number(through) : null };
    return create(body);
  };

  const create = async (body) => {
    setSaving(true);
    try {
      const { data } = await api.post("/tournaments", body);
      toast.success("Tournament created");
      onDone();
      nav(`/tournaments/${data.id}`);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Couldn't create the tournament");
    } finally {
      setSaving(false);
    }
  };

  const boSelect = (v, set, testid) => (
    <select value={v} onChange={(e) => set(Number(e.target.value))} className={sel} data-testid={testid}>
      {BO.map((n) => <option key={n} value={n}>Best of {n}</option>)}
    </select>
  );

  return (
    <form onSubmit={submit} className="hud-card p-5 space-y-6" data-testid="tour-create">
      <div className="grid gap-4 md:grid-cols-3">
        <div>
          <label className={lbl}>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Autumn Cup" className={`${sel} w-full`} data-testid="tc-name" />
        </div>
        <div>
          <label className={lbl}>Format</label>
          <div className="flex gap-2">
            {["2v2", "3v3"].map((f) => (
              <button type="button" key={f} onClick={() => changeFormat(f)} data-testid={`tc-format-${f}`}
                className={`flex-1 px-3 py-2 font-mono-hud text-sm uppercase rounded border ${format === f ? "bg-cyan-400 text-black border-cyan-400 font-bold" : "bg-[#121828] border-[#1B2438] text-slate-300"}`}>{f}</button>
            ))}
          </div>
        </div>
        <div>
          <label className={lbl}>MMR</label>
          <label className="flex items-start gap-2 text-sm text-slate-300 cursor-pointer">
            <input type="checkbox" checked={mmr} onChange={(e) => setMmr(e.target.checked)} className="mt-1" data-testid="tc-mmr" />
            <span>Games count for MMR
              <span className="block text-xs text-slate-500">Each game moves the players' MMR in the active ranked season (no bonuses), shown on their MMR history as a tournament adjustment. Either way, the games stay out of the ranked and unranked stats - the tournament has its own.</span>
            </span>
          </label>
        </div>
      </div>

      {rotation ? (
        <div className="space-y-3" data-testid="tc-roster">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className={lbl + " mb-0"}>Players ({roster.length}) · new teams every round</div>
            <button type="button" onClick={importTeams} data-testid="tc-import"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono-hud uppercase border border-[#1B2438] hover:border-cyan-400 rounded">
              <Download className="w-3.5 h-3.5" /> From Make Teams
            </button>
          </div>
          <datalist id="tc-players">{players.filter((p) => !used.has(p.id)).map((p) => <option key={p.id} value={p.name} />)}</datalist>
          <div className="flex gap-2">
            <input value={pick} onChange={(e) => setPick(e.target.value)} list="tc-players" autoComplete="off" placeholder="Player…"
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addPick(); } }}
              className={`${sel} flex-1 max-w-sm py-1.5`} data-testid="tc-roster-input" />
            <button type="button" onClick={addPick} data-testid="tc-roster-add"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono-hud uppercase border border-[#1B2438] hover:border-cyan-400 rounded">
              <Plus className="w-3.5 h-3.5" /> Add
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {roster.map((id) => (
              <span key={id} className="inline-flex items-center gap-1.5 text-sm px-2 py-1 rounded border border-[#1B2438]">
                {players.find((p) => p.id === id)?.name || "?"}
                <button type="button" onClick={() => setRoster(roster.filter((x) => x !== id))} className="text-slate-500 hover:text-[#FF2E55]" aria-label="Remove player"><X className="w-3.5 h-3.5" /></button>
              </span>
            ))}
          </div>
          <div className="text-xs text-slate-500">
            {perRound ? `${perRound} match${perRound === 1 ? "" : "es"} a round${sitting ? ` · ${sitting} sit${sitting === 1 ? "s" : ""} out each round, taking turns` : ""}.` : `Pick at least ${size * 2} players.`}
            {" "}Each player gets their team's result; the table is ranked by wins, then fewest losses (so sitting out doesn't hurt), then round difference.
          </div>
        </div>
      ) : (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className={lbl + " mb-0"}>Teams ({teams.length}) · seed order, top = seed 1</div>
          <div className="flex gap-2">
            <button type="button" onClick={importTeams} data-testid="tc-import"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono-hud uppercase border border-[#1B2438] hover:border-cyan-400 rounded">
              <Download className="w-3.5 h-3.5" /> From Make Teams
            </button>
            <button type="button" onClick={() => setTeams([...teams, blankTeam(teams.length + 1, size)])} data-testid="tc-add-team"
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono-hud uppercase border border-[#1B2438] hover:border-cyan-400 rounded">
              <Plus className="w-3.5 h-3.5" /> Team
            </button>
          </div>
        </div>
        <datalist id="tc-players">{players.filter((p) => !used.has(p.id)).map((p) => <option key={p.id} value={p.name} />)}</datalist>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {teams.map((t, i) => (
            <div key={i} className="rounded border border-[#1B2438] p-3 space-y-2" data-testid={`tc-team-${i}`}>
              <div className="flex items-center gap-2">
                <span className="font-mono-hud text-xs text-cyan-400 w-6">#{i + 1}</span>
                <input value={t.name} onChange={(e) => setTeam(i, { name: e.target.value })} className={`${sel} flex-1 min-w-0 py-1.5`} data-testid={`tc-team-name-${i}`} />
                <button type="button" onClick={() => move(i, -1)} className="text-slate-500 hover:text-cyan-400" aria-label="Seed higher"><ChevronUp className="w-4 h-4" /></button>
                <button type="button" onClick={() => move(i, 1)} className="text-slate-500 hover:text-cyan-400" aria-label="Seed lower"><ChevronDown className="w-4 h-4" /></button>
                <button type="button" onClick={() => setTeams(teams.filter((_, j) => j !== i))} className="text-slate-500 hover:text-[#FF2E55]" aria-label="Remove team"><X className="w-4 h-4" /></button>
              </div>
              {t.slots.map((s, k) => {
                const p = find(s);
                return (
                  <input key={k} value={s} list="tc-players" autoComplete="off" placeholder="Player…"
                    onChange={(e) => setTeam(i, { slots: t.slots.map((x, j) => (j === k ? e.target.value : x)) })}
                    className={`${sel} w-full py-1.5 ${s.trim() && !p ? "border-amber-400/60" : p && used.get(p.id) > 1 ? "border-[#FF2E55]/70" : ""}`}
                    data-testid={`tc-slot-${i}-${k}`} />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-3">
          <label className={lbl}>League stage</label>
          <select value={league} onChange={(e) => setLeague(e.target.value)} className={`${sel} w-full`} data-testid="tc-league">
            <option value="">None - straight to playoffs</option>
            <option value="round_robin">Round robin - everyone plays everyone</option>
            <option value="swiss">Swiss - paired by record each round</option>
            <option value="groups">Groups - round robin in each group</option>
            <option value="rotation">Player rotation - new teams every round, players ranked</option>
          </select>
          {league && (
            <div className="flex flex-wrap gap-3 items-end">
              <div><div className="text-[10px] text-slate-500 mb-1">Series</div>{boSelect(lgBo, setLgBo, "tc-league-bo")}</div>
              {rotation && (
                <>
                  <div><div className="text-[10px] text-slate-500 mb-1">Rounds</div>
                    <input type="number" min="1" max="30" value={rounds} onChange={(e) => setRounds(e.target.value)} className={`${sel} w-28`} data-testid="tc-rot-rounds" /></div>
                  <label className="flex items-center gap-2 text-sm text-slate-300 pb-2 cursor-pointer" title="Teams are made from MMR in the active ranked season when the tournament is created">
                    <input type="checkbox" checked={balance} onChange={(e) => setBalance(e.target.checked)} data-testid="tc-rot-balance" /> Even teams by MMR
                  </label>
                </>
              )}
              {league === "swiss" && (
                <div><div className="text-[10px] text-slate-500 mb-1">Rounds (blank = auto)</div>
                  <input type="number" min="1" value={rounds} onChange={(e) => setRounds(e.target.value)} className={`${sel} w-28`} data-testid="tc-rounds" /></div>
              )}
              {league === "groups" && (
                <>
                  <div><div className="text-[10px] text-slate-500 mb-1">Groups</div>
                    <input type="number" min="2" value={groups} onChange={(e) => setGroups(e.target.value)} className={`${sel} w-20`} data-testid="tc-groups" /></div>
                  {playoffs && <div><div className="text-[10px] text-slate-500 mb-1">Through per group</div>
                    <input type="number" min="1" value={advance} onChange={(e) => setAdvance(e.target.value)} className={`${sel} w-20`} data-testid="tc-advance" /></div>}
                </>
              )}
            </div>
          )}
        </div>
        {rotation ? (
          <div className="text-xs text-slate-500 self-end">
            Teams spread partners and opponents as evenly as possible{balance ? ", and each match is as even by MMR as it can be" : ""}. No playoffs: the top of the table wins. Every round is drawn when the tournament is created.
          </div>
        ) : (
        <div className="space-y-3">
          <label className={lbl}>Playoffs</label>
          <select value={playoffs} onChange={(e) => setPlayoffs(e.target.value)} className={`${sel} w-full`} data-testid="tc-playoffs">
            <option value="">None - the league table decides</option>
            <option value="single">Single elimination</option>
            <option value="double">Double elimination</option>
          </select>
          {playoffs && (
            <div className="flex flex-wrap gap-3 items-end">
              <div><div className="text-[10px] text-slate-500 mb-1">Early rounds</div>{boSelect(bo, setBo, "tc-bo")}</div>
              <div><div className="text-[10px] text-slate-500 mb-1">Semifinals</div>{boSelect(semisBo, setSemisBo, "tc-semis-bo")}</div>
              <div><div className="text-[10px] text-slate-500 mb-1">Final(s)</div>{boSelect(finalBo, setFinalBo, "tc-final-bo")}</div>
              {league && league !== "groups" && (
                <div><div className="text-[10px] text-slate-500 mb-1">Teams through (blank = all)</div>
                  <input type="number" min="2" value={through} onChange={(e) => setThrough(e.target.value)} className={`${sel} w-28`} data-testid="tc-through" /></div>
              )}
              {playoffs === "double" && (
                <label className="flex items-center gap-2 text-sm text-slate-300 pb-2 cursor-pointer">
                  <input type="checkbox" checked={reset} onChange={(e) => setReset(e.target.checked)} data-testid="tc-reset" /> Grand final reset
                </label>
              )}
            </div>
          )}
          {playoffs === "double" && <div className="text-xs text-slate-500">With a reset, the team from the losers bracket has to win the grand final twice.</div>}
        </div>
        )}
      </div>

      <button type="submit" disabled={saving} data-testid="tc-submit"
        className="btn-glow bg-cyan-400 hover:bg-cyan-300 text-black font-mono-hud font-bold uppercase tracking-wider px-6 py-3 rounded flex items-center gap-2 disabled:opacity-60">
        <Trophy className="w-4 h-4" /> {saving ? "Creating…" : "Create tournament"}
      </button>
    </form>
  );
}

function Section({ title, items, empty, testid }) {
  return (
    <section className="space-y-3" data-testid={testid}>
      <h2 className="text-xs font-mono-hud uppercase tracking-[0.3em] text-cyan-400/70">{title}</h2>
      {items.length === 0 ? <div className="text-sm text-slate-500">{empty}</div> : (
        <div className="grid gap-3 md:grid-cols-2">
          {items.map((t) => (
            <Link key={t.id} to={`/tournaments/${t.id}${t.status === "finished" ? "?tab=stats" : ""}`} data-testid={`tour-item-${t.id}`}
              className="hud-card p-4 flex items-start gap-3 hover:border-cyan-400/50">
              <Award className={`w-8 h-8 shrink-0 ${t.status === "finished" ? "text-[#FFB800]" : "text-cyan-400"}`} />
              <div className="min-w-0 flex-1">
                <div className="font-heading text-xl font-black uppercase truncate">{t.name}</div>
                <div className="text-xs font-mono-hud uppercase tracking-wider text-slate-400 flex flex-wrap gap-x-3">
                  <span>{t.format}</span><span>{t.players != null ? `${t.players} players` : `${t.teams} teams`}</span>
                  {t.league && <span>{LEAGUE_NAMES[t.league]}</span>}
                  {t.playoffs && <span>{PLAYOFF_NAMES[t.playoffs]}</span>}
                  <span>{t.games} game{t.games === 1 ? "" : "s"}</span>
                  {t.counts_for_mmr && <span className="text-cyan-400">Counts for MMR</span>}
                </div>
                <div className={`text-sm mt-1 ${t.status === "finished" ? "text-[#FFB800]" : "text-cyan-300"}`}>
                  {t.status === "finished" ? <><Trophy className="inline w-3.5 h-3.5 mr-1" />{t.champion_name || "Finished"}</> : STATUS[t.status]}
                </div>
              </div>
              <span className="text-[10px] font-mono-hud text-slate-500">{new Date(t.finished_at || t.created_at).toLocaleDateString()}</span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

export default function Tournaments() {
  const { isAdmin } = useAuth();
  const [params, setParams] = useSearchParams();
  const [list, setList] = useState(null);
  const creating = isAdmin && params.get("new") === "1";
  const load = () => api.get("/tournaments").then((r) => setList(r.data)).catch(() => setList([]));
  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-6" data-testid="tournaments-page">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-xs font-mono-hud uppercase tracking-[0.3em] text-cyan-400/70 mb-2">// Competitions</div>
          <h1 className="font-heading text-4xl sm:text-5xl font-black uppercase tracking-tight">Tournaments</h1>
          <p className="text-sm text-slate-400 mt-2 max-w-3xl">Admin preview - only admins can see tournaments for now. Each one keeps its own games and stats, separate from ranked and unranked.</p>
        </div>
        {isAdmin && (
          <button onClick={() => setParams(creating ? {} : { new: "1" })} data-testid="tour-new"
            className="flex items-center gap-2 px-4 py-2 text-xs font-mono-hud uppercase tracking-wider border border-cyan-400/50 text-cyan-400 hover:bg-cyan-400/10 rounded">
            {creating ? <><X className="w-4 h-4" /> Cancel</> : <><Plus className="w-4 h-4" /> New tournament</>}
          </button>
        )}
      </div>

      {creating && <CreateForm onDone={load} autoImport={params.get("import") === "1"} />}

      {list === null ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : list.length === 0 ? (
        <div className="hud-card p-8 text-center text-slate-400">No tournaments yet.</div>
      ) : (
        <>
          <Section title="Current" items={list.filter((t) => t.status !== "finished")} empty="Nothing running right now." testid="tour-current" />
          <Section title="Past tournaments" items={list.filter((t) => t.status === "finished")} empty="No finished tournaments yet." testid="tour-past" />
        </>
      )}
    </div>
  );
}
