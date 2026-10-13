import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import api from "@/api";
import { toast } from "sonner";
import { Trash2, Filter, Pencil, Search, Download, ChevronDown, Send } from "lucide-react";
import { useAuth } from "@/AuthContext";
import EditMatchDialog from "@/components/EditMatchDialog";
import ChampionPortrait from "@/components/ChampionPortrait";
import MmrChange from "@/components/MmrChange";
import MatchDetails from "@/components/MatchDetails";
import SeasonSelect, { savedSeason } from "@/components/SeasonSelect";
import FormatFilter, { MatchCode } from "@/components/FormatFilter";

const roleClass = (r) => r === "Melee" ? "role-bg-melee" : r === "Ranged" ? "role-bg-ranged" : "role-bg-support";

export default function Matches() {
  const [matches, setMatches] = useState([]);
  const [seasons, setSeasons] = useState([]);
  const [players, setPlayers] = useState([]);
  const [seasonFilter, setSeasonFilter] = useState(null);   // null until we know the current season
  const [playerFilter, setPlayerFilter] = useState("");
  const [formatFilter, setFormatFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState(null);
  const { user, isAdmin } = useAuth();
  const [params, setParams] = useSearchParams();
  const openId = params.get("match");
  const scrolledTo = useRef(null);
  const [logStatus, setLogStatus] = useState(null);   // admin: matches not yet in the Discord match log

  useEffect(() => {
    if (isAdmin) api.get("/admin/match-log/backfill").then((r) => setLogStatus(r.data)).catch(() => {});
  }, [isAdmin]);

  const backfill = async () => {
    if (!window.confirm(`Post ${logStatus.unposted} match${logStatus.unposted === 1 ? "" : "es"} to the Discord match log, oldest first? New matches carry on posting as normal afterwards.`)) return;
    try {
      const { data } = await api.post("/admin/match-log/backfill");
      toast.success(`Posting ${data.queued} match${data.queued === 1 ? "" : "es"} to Discord - about ${Math.ceil(data.seconds / 60)} min`);
      setLogStatus({ ...logStatus, unposted: 0, running: true });
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Couldn't start posting");
    }
  };

  const toggleOpen = (id) => {
    const next = new URLSearchParams(params);
    if (openId === id) next.delete("match"); else next.set("match", id);
    setParams(next, { replace: true });
  };

  // Arriving from a link like /matches?match=<id>: scroll to that match once it has loaded
  useEffect(() => {
    if (!openId || scrolledTo.current === openId || !matches.some((m) => m.id === openId)) return;
    scrolledTo.current = openId;
    requestAnimationFrame(() => {
      document.getElementById(`match-${openId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [openId, matches]);

  const load = useCallback(async () => {
    const params = {};
    if (seasonFilter) params.season_id = seasonFilter;
    if (playerFilter) params.player_id = playerFilter;
    if (formatFilter !== "all") params.format = formatFilter;
    const m = await api.get("/matches", { params });
    setMatches(m.data);
  }, [seasonFilter, playerFilter, formatFilter]);

  useEffect(() => {
    (async () => {
      const [s, p] = await Promise.all([api.get("/seasons"), api.get("/players")]);
      setSeasons(s.data);
      setPlayers(p.data);
      // the visitor's last pick (else All) - unless a link opened a match, which could be in any season
      setSeasonFilter((cur) => cur ?? (openId ? "" : savedSeason()));
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (seasonFilter !== null) load(); }, [seasonFilter, load]);

  const playerName = (id) => players.find((p) => p.id === id)?.name || "—";

  const del = async (id) => {
    if (!confirm("Delete this match? Season ELO will be recomputed.")) return;
    await api.delete(`/matches/${id}`);
    toast.success("Match deleted · ELO recomputed");
    load();
  };

  return (
    <div className="space-y-6" data-testid="matches-page">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="text-xs font-mono-hud uppercase tracking-[0.3em] text-cyan-400/70 mb-2">// History Feed</div>
          <h1 className="font-heading text-4xl sm:text-5xl font-black uppercase tracking-tight">Match History</h1>
        </div>
        <div className="flex flex-wrap gap-2">
        {isAdmin && logStatus?.configured && logStatus.unposted > 0 && !logStatus.running && (
          <button onClick={backfill} data-testid="matches-backfill-log"
            className="border border-cyan-400/60 text-cyan-400 hover:bg-cyan-400/10 font-mono-hud font-bold uppercase tracking-wider text-xs px-4 py-2.5 rounded flex items-center gap-2">
            <Send className="w-4 h-4" /> Post {logStatus.unposted} old to match log
          </button>
        )}
        {isAdmin && <a
          href={`${process.env.REACT_APP_BACKEND_URL}/api/exports/matches.csv?season_id=${seasonFilter || ""}${formatFilter !== "all" ? `&format=${formatFilter}` : ""}`}
          className="btn-glow bg-cyan-400 hover:bg-cyan-300 text-black font-mono-hud font-bold uppercase tracking-wider text-xs px-4 py-2.5 rounded flex items-center gap-2"
          data-testid="matches-export-csv"
        >
          <Download className="w-4 h-4" strokeWidth={3} /> Export CSV
        </a>}
        </div>
      </div>

      <div className="hud-card p-4 flex flex-wrap gap-3 items-center">
        <Filter className="w-4 h-4 text-cyan-400" />
        <FormatFilter value={formatFilter} onChange={setFormatFilter} testid="matches-filter-format" />
        <SeasonSelect seasons={seasons} value={seasonFilter} onChange={setSeasonFilter}
          className="bg-[#121828] border border-[#1B2438] rounded px-3 py-2 text-sm" data-testid="matches-filter-season" />
        <select value={playerFilter} onChange={(e) => setPlayerFilter(e.target.value)} className="bg-[#121828] border border-[#1B2438] rounded px-3 py-2 text-sm" data-testid="matches-filter-player">
          <option value="">All players</option>
          {players.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <div className="flex items-center gap-2 flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-cyan-400" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search players, champions, notes or match #..."
            className="flex-1 bg-[#121828] border border-[#1B2438] focus:border-cyan-400 focus:outline-none rounded px-3 py-2 text-sm"
            data-testid="matches-search" />
        </div>
      </div>

      {matches.length === 0 ? (
        <div className="hud-card p-12 text-center text-slate-500 font-mono-hud">No matches found.</div>
      ) : (
        <div className="space-y-3">
          {matches.filter((m) => {
            if (m.id === openId) return true;  // keep the linked match visible
            if (!search.trim()) return true;
            const q = search.trim().toLowerCase().replace(/^#/, "");
            if ([m.discord_match_id, ...(m.legacy_refs || [])].some((c) => (c || "").toLowerCase().includes(q))) return true;
            if ((m.notes || "").toLowerCase().includes(q)) return true;
            if (m.players.some((p) => p.champion.toLowerCase().includes(q))) return true;
            if (m.players.some((p) => (playerName(p.player_id) || "").toLowerCase().includes(q))) return true;
            return false;
          }).map((m) => {
            const teamA = m.players.filter((p) => p.team === "A");
            const teamB = m.players.filter((p) => p.team === "B");
            const aWon = m.winner_team === "A";
            const open = m.id === openId;
            return (
              <div key={m.id} id={`match-${m.id}`}
                className={`hud-card p-5 cursor-pointer transition-colors ${open ? "border-cyan-400/60 ring-1 ring-cyan-400/40" : "hover:border-cyan-400/30"}`}
                onClick={(e) => { if (!e.target.closest("a,button,input,select")) toggleOpen(m.id); }}
                data-testid={`match-row-${m.id}`}>
                <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                  <div className="flex items-center gap-3 flex-wrap">
                    <MatchCode match={m} className="text-xs" />
                    <span className="text-[10px] font-mono-hud uppercase tracking-[0.15em] px-2 py-1 bg-[#0C101B] border border-[#1B2438] rounded">{m.format}</span>
                    <span className="text-[10px] font-mono-hud uppercase text-slate-500">{new Date(m.played_at).toLocaleString()}</span>
                    {m.notes && <span className="text-xs text-slate-400 italic">"{m.notes}"</span>}
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => toggleOpen(m.id)} className="text-slate-400 hover:text-cyan-400 text-[10px] font-mono-hud uppercase tracking-wider flex items-center gap-1 p-1" data-testid={`match-open-${m.id}`}>
                      {open ? "Hide stats" : "Stats"} <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
                    </button>
                  {isAdmin && (
                    <>
                      <button onClick={() => setEditing(m)} className="text-slate-500 hover:text-cyan-400 text-xs flex items-center gap-1 p-1" data-testid={`match-edit-${m.id}`}><Pencil className="w-3.5 h-3.5" /></button>
                      <button onClick={() => del(m.id)} className="text-slate-500 hover:text-[#FF2E55] text-xs flex items-center gap-1 p-1" data-testid={`match-delete-${m.id}`}><Trash2 className="w-3.5 h-3.5" /></button>
                    </>
                  )}
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-4 items-center">
                  <div className={`p-3 rounded border ${aWon ? "border-[#00E676]/40 bg-[#00E676]/5" : "border-[#1B2438] bg-[#121828]/40"}`}>
                    {teamA.map((p) => (
                      <div key={`a-${p.player_id}-${p.champion}`} className="flex items-center justify-between gap-2 py-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <ChampionPortrait name={p.champion} role={p.role} size={26} />
                          <Link to={`/players/${p.player_id}`} className="text-sm font-medium hover:text-cyan-400 truncate">{playerName(p.player_id)}</Link>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className="text-xs font-mono-hud text-slate-400 hidden lg:inline">{p.champion}</span>
                          <MmrChange p={p} />
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="text-center">
                    <div className="font-mono-hud text-3xl md:text-4xl font-black">
                      <span className={aWon ? "text-[#00E676]" : "text-slate-400"}>{m.team_a_rounds}</span>
                      <span className="text-slate-600 mx-2">:</span>
                      <span className={!aWon ? "text-[#00E676]" : "text-slate-400"}>{m.team_b_rounds}</span>
                    </div>
                  </div>
                  <div className={`p-3 rounded border ${!aWon ? "border-[#00E676]/40 bg-[#00E676]/5" : "border-[#1B2438] bg-[#121828]/40"}`}>
                    {teamB.map((p) => (
                      <div key={`b-${p.player_id}-${p.champion}`} className="flex items-center justify-between gap-2 py-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <ChampionPortrait name={p.champion} role={p.role} size={26} />
                          <Link to={`/players/${p.player_id}`} className="text-sm font-medium hover:text-cyan-400 truncate">{playerName(p.player_id)}</Link>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className="text-xs font-mono-hud text-slate-400 hidden lg:inline">{p.champion}</span>
                          <MmrChange p={p} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                {open && (
                  <MatchDetails match={m} playerName={playerName} onChanged={load}
                    seasonName={seasons.find((s) => s.id === m.season_id)?.name} />
                )}
              </div>
            );
          })}
        </div>
      )}
      {editing && (
        <EditMatchDialog match={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}
    </div>
  );
}
