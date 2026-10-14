import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import api, { MATCHES_PAGE } from "@/api";
import { toast } from "sonner";
import { Trash2, Filter, Pencil, Search, Download, ChevronDown, Send, Link2, X } from "lucide-react";
import { useAuth } from "@/AuthContext";
import EditMatchDialog from "@/components/EditMatchDialog";
import ChampionPortrait from "@/components/ChampionPortrait";
import MmrChange from "@/components/MmrChange";
import MatchDetails from "@/components/MatchDetails";
import SeasonSelect, { savedSeason } from "@/components/SeasonSelect";
import FormatFilter, { MatchCode } from "@/components/FormatFilter";

// The list is loaded a page at a time (newest first). Search runs on the server, so it
// also finds matches that haven't been loaded yet. A link to one match (/matches?match=<id>,
// e.g. from the Discord match log) fetches that match on its own and pins it at the top,
// however old it is.
export default function Matches() {
  const [matches, setMatches] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [seasons, setSeasons] = useState([]);
  const [players, setPlayers] = useState([]);
  const [seasonFilter, setSeasonFilter] = useState(() => savedSeason());
  const [playerFilter, setPlayerFilter] = useState("");
  const [formatFilter, setFormatFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");          // search, once typing pauses
  const [editing, setEditing] = useState(null);
  const { isAdmin } = useAuth();
  const [params, setParams] = useSearchParams();
  const openId = params.get("match");
  const [linkedId, setLinkedId] = useState(openId);   // the match a link pointed at
  const [linked, setLinked] = useState(null);
  const scrolledTo = useRef(null);
  const request = useRef(0);                         // ignore replies to older requests
  const [logStatus, setLogStatus] = useState(null);   // admin: matches not yet in the Discord match log

  useEffect(() => {
    if (isAdmin) api.get("/admin/match-log/backfill").then((r) => setLogStatus(r.data)).catch(() => {});
  }, [isAdmin]);

  useEffect(() => {
    Promise.all([api.get("/seasons"), api.get("/players")]).then(([s, p]) => {
      setSeasons(s.data);
      setPlayers(p.data);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim().replace(/^#/, "")), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Same params (and order of building) as the Matches prefetch in api.js, so a hovered tab's data is reused
  const listParams = useCallback((offset, limit = MATCHES_PAGE) => {
    const p = {};
    if (seasonFilter) p.season_id = seasonFilter;
    if (playerFilter) p.player_id = playerFilter;
    if (formatFilter !== "all") p.format = formatFilter;
    if (query) p.q = query;
    p.limit = limit;
    p.offset = offset;
    return p;
  }, [seasonFilter, playerFilter, formatFilter, query]);

  // (Re)load from the top. keep=true keeps as many matches showing as before (after an edit).
  const load = useCallback(async (keep = 0) => {
    const id = ++request.current;
    const limit = Math.min(200, Math.max(MATCHES_PAGE, keep));
    try {
      const { data } = await api.get("/matches", { params: listParams(0, limit) });
      if (id !== request.current) return;
      setMatches(data.items);
      setTotal(data.total);
    } catch {
      if (id === request.current) toast.error("Couldn't load matches");
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [listParams]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const loadMore = async () => {
    const id = request.current;
    setLoadingMore(true);
    try {
      const { data } = await api.get("/matches", { params: listParams(matches.length) });
      if (id !== request.current) return;
      setMatches((cur) => {
        const seen = new Set(cur.map((m) => m.id));
        return [...cur, ...data.items.filter((m) => !seen.has(m.id))];
      });
      setTotal(data.total);
    } catch {
      toast.error("Couldn't load more matches");
    } finally {
      setLoadingMore(false);
    }
  };

  // A link to a match that isn't already in the list pins it (also when a new link is
  // followed while this page is open). Opening matches from the list doesn't.
  useEffect(() => {
    if (openId && openId !== linkedId && !matches.some((m) => m.id === openId)) setLinkedId(openId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);

  const loadLinked = useCallback(async () => {
    if (!linkedId) { setLinked(null); return; }
    try {
      const { data } = await api.get(`/matches/${encodeURIComponent(linkedId)}`);
      setLinked(data);
    } catch (err) {
      setLinked(null);
      setLinkedId(null);
      if (err?.response?.status === 404) toast.error("That match no longer exists");
    }
  }, [linkedId]);

  useEffect(() => { loadLinked(); }, [loadLinked]);

  // Arriving from a link: scroll to the match once it has loaded
  useEffect(() => {
    if (!linked || scrolledTo.current === linked.id) return;
    scrolledTo.current = linked.id;
    requestAnimationFrame(() => {
      document.getElementById(`match-${linked.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [linked]);

  const refresh = () => { load(matches.length); loadLinked(); };

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

  // Links may use an old id; the match's own id is what the list and the URL use from then on
  const isOpen = (m) => openId === m.id || (linked?.id === m.id && openId === linkedId);

  const toggleOpen = (m) => {
    const next = new URLSearchParams(params);
    if (isOpen(m)) next.delete("match"); else next.set("match", m.id);
    setParams(next, { replace: true });
  };

  const unpin = () => {
    const next = new URLSearchParams(params);
    if (linked && isOpen(linked)) next.delete("match");
    setParams(next, { replace: true });
    setLinkedId(null);
    setLinked(null);
  };

  const playerName = (id) => players.find((p) => p.id === id)?.name || "—";

  const del = async (id) => {
    if (!confirm("Delete this match? Season ELO will be recomputed.")) return;
    await api.delete(`/matches/${id}`);
    toast.success("Match deleted · ELO recomputed");
    if (linked?.id === id) unpin();
    load(matches.length);
  };

  const teamCard = (team, won) => (
    <div className={`p-3 rounded border ${won ? "border-[#00E676]/40 bg-[#00E676]/5" : "border-[#1B2438] bg-[#121828]/40"}`}>
      {team.map((p) => (
        <div key={`${p.team}-${p.player_id}-${p.champion}`} className="flex items-center justify-between gap-2 py-1">
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
  );

  const row = (m, pinned = false) => {
    const aWon = m.winner_team === "A";
    const open = isOpen(m);
    return (
      <div key={m.id} id={`match-${m.id}`}
        className={`hud-card p-5 cursor-pointer transition-colors ${open ? "border-cyan-400/60 ring-1 ring-cyan-400/40" : "hover:border-cyan-400/30"}`}
        onClick={(e) => { if (!e.target.closest("a,button,input,select")) toggleOpen(m); }}
        data-testid={pinned ? "match-linked" : `match-row-${m.id}`}>
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <div className="flex items-center gap-3 flex-wrap">
            {pinned && (
              <span className="text-[10px] font-mono-hud uppercase tracking-[0.15em] px-2 py-1 rounded border border-cyan-400/50 text-cyan-400 flex items-center gap-1">
                <Link2 className="w-3 h-3" /> Linked match
              </span>
            )}
            <MatchCode match={m} className="text-xs" />
            <span className="text-[10px] font-mono-hud uppercase tracking-[0.15em] px-2 py-1 bg-[#0C101B] border border-[#1B2438] rounded">{m.format}</span>
            <span className="text-[10px] font-mono-hud uppercase text-slate-500">{new Date(m.played_at).toLocaleString()}</span>
            {m.notes && <span className="text-xs text-slate-400 italic">"{m.notes}"</span>}
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => toggleOpen(m)} className="text-slate-400 hover:text-cyan-400 text-[10px] font-mono-hud uppercase tracking-wider flex items-center gap-1 p-1" data-testid={`match-open-${m.id}`}>
              {open ? "Hide stats" : "Stats"} <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
            </button>
            {isAdmin && (
              <>
                <button onClick={() => setEditing(m)} className="text-slate-500 hover:text-cyan-400 text-xs flex items-center gap-1 p-1" data-testid={`match-edit-${m.id}`}><Pencil className="w-3.5 h-3.5" /></button>
                <button onClick={() => del(m.id)} className="text-slate-500 hover:text-[#FF2E55] text-xs flex items-center gap-1 p-1" data-testid={`match-delete-${m.id}`}><Trash2 className="w-3.5 h-3.5" /></button>
              </>
            )}
            {pinned && (
              <button onClick={unpin} title="Unpin" className="text-slate-500 hover:text-cyan-400 p-1" data-testid="match-linked-unpin"><X className="w-3.5 h-3.5" /></button>
            )}
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-4 items-center">
          {teamCard(m.players.filter((p) => p.team === "A"), aWon)}
          <div className="text-center">
            <div className="font-mono-hud text-3xl md:text-4xl font-black">
              <span className={aWon ? "text-[#00E676]" : "text-slate-400"}>{m.team_a_rounds}</span>
              <span className="text-slate-600 mx-2">:</span>
              <span className={!aWon ? "text-[#00E676]" : "text-slate-400"}>{m.team_b_rounds}</span>
            </div>
          </div>
          {teamCard(m.players.filter((p) => p.team === "B"), !aWon)}
        </div>
        {open && (
          <MatchDetails match={m} playerName={playerName} onChanged={refresh}
            seasonName={seasons.find((s) => s.id === m.season_id)?.name} />
        )}
      </div>
    );
  };

  const listed = matches.filter((m) => m.id !== linked?.id);

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

      {linked && <div className="space-y-3">{row(linked, true)}</div>}

      {loading && matches.length === 0 ? (
        <div className="hud-card p-12 text-center text-slate-500 font-mono-hud">Loading matches...</div>
      ) : listed.length === 0 ? (
        <div className="hud-card p-12 text-center text-slate-500 font-mono-hud">No {linked ? "other " : ""}matches found.</div>
      ) : (
        <div className={`space-y-3 transition-opacity ${loading ? "opacity-60" : ""}`}>
          {listed.map((m) => row(m))}
        </div>
      )}

      {matches.length > 0 && (
        <div className="flex flex-col items-center gap-2 pb-4">
          <div className="text-[11px] font-mono-hud uppercase tracking-wider text-slate-500" data-testid="matches-count">
            Showing {matches.length} of {total}
          </div>
          {matches.length < total && (
            <button onClick={loadMore} disabled={loadingMore} data-testid="matches-load-more"
              className="border border-cyan-400/60 text-cyan-400 hover:bg-cyan-400/10 disabled:opacity-50 font-mono-hud font-bold uppercase tracking-wider text-xs px-5 py-2.5 rounded">
              {loadingMore ? "Loading..." : `Load ${Math.min(MATCHES_PAGE, total - matches.length)} more`}
            </button>
          )}
        </div>
      )}

      {editing && (
        <EditMatchDialog match={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />
      )}
    </div>
  );
}
