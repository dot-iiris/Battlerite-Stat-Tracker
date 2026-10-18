import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import api, { API } from "@/api";
import { toast } from "sonner";
import { PlusCircle, Swords, Trash2, ImagePlus, AlertTriangle, X, Award } from "lucide-react";
import { invalidateChampionStats } from "@/lib/championStats";

const STAT_FIELDS = ["score", "damage", "protection", "disables"];
const SHORT = { score: "score", damage: "dmg", protection: "prot", disables: "disables" };
const emptySlot = () => ({ name: "", player_id: "", champion: "", score: "", damage: "", protection: "", disables: "" });
const norm = (s) => (s || "").trim().toLowerCase();

const roleClass = (r) => r === "Melee" ? "role-bg-melee" : r === "Ranged" ? "role-bg-ranged" : "role-bg-support";

export default function LogMatch() {
  const [seasons, setSeasons] = useState([]);
  const [players, setPlayers] = useState([]);
  const [champions, setChampions] = useState([]);
  const [format, setFormat] = useState("2v2");
  const [seasonId, setSeasonId] = useState("");
  const [teamARounds, setTeamARounds] = useState(3);
  const [teamBRounds, setTeamBRounds] = useState(2);
  const [teamA, setTeamA] = useState([emptySlot(), emptySlot()]);
  const [teamB, setTeamB] = useState([emptySlot(), emptySlot()]);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [shot, setShot] = useState(null);       // what /screenshots/read returned
  const [reading, setReading] = useState(false);
  const fileRef = useRef(null);
  const [params] = useSearchParams();
  const nav = useNavigate();
  const tmId = params.get("tm");   // a game of a tournament match
  const [tm, setTm] = useState(null);   // {t, m}

  const dropShot = () => {
    if (shot) api.delete(`/screenshots/${shot.screenshot_id}`).catch(() => {});
    setShot(null);
  };

  // Read the scoreboard. With every player picked, it's matched to them; otherwise the players
  // are found by name among everyone on the site (unknown names become new players).
  const readShot = async (file) => {
    if (!file) return;
    const all = [...teamA, ...teamB];
    const picked = all.every((s) => s.player_id);
    const form = new FormData();
    form.append("file", file);
    if (picked) {
      form.append("team_a", teamA.map((s) => s.player_id).join(","));
      form.append("team_b", teamB.map((s) => s.player_id).join(","));
    }
    setReading(true);
    try {
      const { data } = await api.post("/screenshots/read", form);
      dropShot();
      if (data.detected) {
        const toSlot = (d) => {
          const p = players.find((x) => x.id === d.player_id);
          const out = { ...emptySlot(), name: p ? p.name : (d.ocr_name || ""), player_id: p ? p.id : "", champion: d.champion || "" };
          for (const f of STAT_FIELDS) out[f] = d.stats?.[f] == null ? "" : String(d.stats[f]);
          return out;
        };
        setFormat(data.format);
        setTeamA(data.slots.A.map(toSlot));
        setTeamB(data.slots.B.map(toSlot));
        if (data.team_a_rounds != null && data.team_b_rounds != null) { setTeamARounds(data.team_a_rounds); setTeamBRounds(data.team_b_rounds); }
        setShot(data);
        const fresh = [...data.slots.A, ...data.slots.B].filter((d) => !d.player_id).length;
        toast.success(`Players found from the screenshot${fresh ? ` (${fresh} new)` : ""} - check them before recording`);
        return;
      }
      const fill = (slot) => {
        const r = data.players[slot.player_id] || {};
        const out = { ...slot, champion: r.champion || slot.champion };
        for (const f of STAT_FIELDS) out[f] = r.stats?.[f] == null ? "" : String(r.stats[f]);
        return out;
      };
      const filled = all.map(fill);   // (picked players keep their names)
      const teamOf = (s, i) => data.teams?.[s.player_id] || (i < teamA.length ? "A" : "B");
      const a = filled.filter((s, i) => teamOf(s, i) === "A");
      const b = filled.filter((s, i) => teamOf(s, i) === "B");
      if (a.length === b.length) { setTeamA(a); setTeamB(b); } else { setTeamA(filled.slice(0, teamA.length)); setTeamB(filled.slice(teamA.length)); }
      if (data.team_a_rounds != null && data.team_b_rounds != null) { setTeamARounds(data.team_a_rounds); setTeamBRounds(data.team_b_rounds); }
      setShot(data);
      toast.success("Filled in from the screenshot - check it before recording");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Couldn't read that screenshot");
    } finally {
      setReading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  useEffect(() => {
    (async () => {
      const [s, p, c] = await Promise.all([
        api.get("/seasons"), api.get("/players"), api.get("/champions"),
      ]);
      setSeasons(s.data);
      const active = s.data.find((x) => x.active) || s.data[0];
      setSeasonId(active?.id || "");
      setPlayers(p.data);
      setChampions(c.data);
      if (tmId) {
        const [tid, mid] = tmId.split(":");
        try {
          const t = (await api.get(`/tournaments/${tid}`)).data;
          const m = t.matches.find((x) => x.id === mid);
          if (!m || !m.team1 || !m.team2) throw new Error("gone");
          const side = (team) => t.teams.find((x) => x.id === team).players.map((pl) => ({ ...emptySlot(), name: pl.name, player_id: pl.id }));
          setFormat(t.format);
          setTeamA(side(m.team1));
          setTeamB(side(m.team2));
          setTm({ t, m });
        } catch {
          toast.error("That tournament match can't be found");
        }
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyFormat = (fmt) => {
    setFormat(fmt);
    const size = { "1v1": 1, "2v2": 2, "3v3": 3 }[fmt];
    setTeamA(Array.from({ length: size }, emptySlot));
    setTeamB(Array.from({ length: size }, emptySlot));
  };

  const getChampRole = (name) => champions.find((c) => c.name === name)?.role || "";

  // How many times each player is picked in the match (to flag doubles)
  const usedPlayers = new Map();
  for (const s of [...teamA, ...teamB]) if (s.player_id) usedPlayers.set(s.player_id, (usedPlayers.get(s.player_id) || 0) + 1);
  // Champions already picked per team (same-team mirror forbidden)
  const usedChampsA = new Set(teamA.map((s) => s.champion).filter(Boolean));
  const usedChampsB = new Set(teamB.map((s) => s.champion).filter(Boolean));

  // A typed name picks the player with that name (or in-game name); anything else is a new player
  const findPlayer = (name) => players.find((p) => norm(p.name) === norm(name)) || players.find((p) => p.ign && norm(p.ign) === norm(name));

  const setSlot = (team, idx, key, val) => {
    const setter = team === "A" ? setTeamA : setTeamB;
    const arr = team === "A" ? [...teamA] : [...teamB];
    const before = arr[idx].player_id;
    arr[idx] = key === "name" ? { ...arr[idx], name: val, player_id: findPlayer(val)?.id || "" } : { ...arr[idx], [key]: val };
    setter(arr);
    // a screenshot matched to picked players no longer fits once they change (fixing a detected one is fine)
    if (key === "name" && shot && !shot.detected && arr[idx].player_id !== before) {
      dropShot();
      toast("Players changed - read the screenshot again");
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (teamARounds === teamBRounds) { toast.error("Rounds cannot be tied"); return; }
    let allSlots = [...teamA.map((s) => ({ ...s, team: "A" })), ...teamB.map((s) => ({ ...s, team: "B" }))];
    for (const s of allSlots) {
      if (!s.name.trim() || !s.champion) { toast.error("Fill all player/champion slots"); return; }
    }
    const keys = allSlots.map((s) => s.player_id || `new:${norm(s.name)}`);
    if (new Set(keys).size !== keys.length) { toast.error("A player can only appear once per match"); return; }
    const fresh = allSlots.filter((s) => !s.player_id);
    if (fresh.length) {
      if (!window.confirm(`Create ${fresh.length === 1 ? "a new player" : `${fresh.length} new players`}: ${fresh.map((s) => s.name.trim()).join(", ")}?`)) return;
      try {
        const made = {};
        for (const s of fresh) made[norm(s.name)] = (await api.post("/players", { name: s.name.trim() })).data;
        setPlayers((cur) => [...cur, ...Object.values(made)].sort((a, b) => a.name.localeCompare(b.name)));
        allSlots = allSlots.map((s) => (s.player_id ? s : { ...s, player_id: made[norm(s.name)].id }));
      } catch (err) {
        toast.error(err?.response?.data?.detail || "Couldn't create the new players");
        return;
      }
    }
    for (const label of ["A", "B"]) {
      const champs = allSlots.filter((s) => s.team === label).map((s) => s.champion);
      if (new Set(champs).size !== champs.length) { toast.error(`Team ${label} cannot pick the same champion twice`); return; }
    }
    setSubmitting(true);
    try {
      const payload = {
        season_id: seasonId,
        tournament_match_id: tm ? tmId : null,
        format,
        team_a_rounds: Number(teamARounds),
        team_b_rounds: Number(teamBRounds),
        notes,
        screenshot_id: shot?.screenshot_id || null,
        players: allSlots.map((s) => {
          const has = STAT_FIELDS.some((f) => s[f] !== "" && s[f] != null);
          return {
            player_id: s.player_id,
            champion: s.champion,
            role: getChampRole(s.champion),
            team: s.team,
            stats: has ? Object.fromEntries(STAT_FIELDS.map((f) => [f, s[f] === "" || s[f] == null ? null : Number(s[f])])) : null,
          };
        }),
      };
      await api.post("/matches", payload);
      invalidateChampionStats();
      toast.success(tm ? "Game logged to the tournament" : shot ? "Match logged with its screenshot" : "Match logged");
      setShot(null);   // attached now
      if (tm) { nav(`/tournaments/${tm.t.id}?tab=matches&m=${tm.m.id}`); return; }
      // Reset
      applyFormat(format);
      setTeamARounds(3); setTeamBRounds(2); setNotes("");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to log match");
    } finally {
      setSubmitting(false);
    }
  };

  const renderTeam = (label, roster, side, color) => (
    <div className={`hud-card p-5 ${side === "A" ? "" : ""}`}>
      <h3 className={`font-heading text-lg font-black uppercase tracking-wide mb-4 ${color}`}>Team {label}</h3>
      <div className="space-y-3">
        {roster.map((slot, i) => (
          <div key={`${side}-${i}`} className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="min-w-0">
              <input
                value={slot.name}
                onChange={(e) => setSlot(side, i, "name", e.target.value)}
                list="log-players" placeholder="Player name…" autoComplete="off"
                className={`w-full bg-[#121828] border focus:border-cyan-400 focus:outline-none rounded px-2 py-2 text-sm ${
                  slot.name.trim() && !slot.player_id ? "border-amber-400/60" : "border-[#1B2438]"}`}
                data-testid={`slot-player-${side}-${i}`}
              />
              {slot.name.trim() && !slot.player_id && (
                <div className="text-[10px] font-mono-hud text-amber-400 mt-0.5" data-testid={`slot-new-${side}-${i}`}>New player - created when you record</div>
              )}
              {slot.player_id && usedPlayers.get(slot.player_id) > 1 && (
                <div className="text-[10px] font-mono-hud text-[#FF2E55] mt-0.5">Already in this match</div>
              )}
            </div>
            <select
              value={slot.champion}
              onChange={(e) => setSlot(side, i, "champion", e.target.value)}
              className="bg-[#121828] border border-[#1B2438] focus:border-cyan-400 focus:outline-none rounded px-2 py-2 text-sm"
              data-testid={`slot-champion-${side}-${i}`}
            >
              <option value="">Champion…</option>
              {champions.map((c) => {
                const teamChamps = side === "A" ? usedChampsA : usedChampsB;
                const dup = c.name !== slot.champion && teamChamps.has(c.name);
                return <option key={c.name} value={c.name} disabled={dup}>{c.name} ({c.role}){dup ? " · already in team" : ""}</option>;
              })}
            </select>
            {slot.champion && (
              <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-mono-hud uppercase tracking-wider border rounded col-span-full sm:col-span-1 justify-self-start ${roleClass(getChampRole(slot.champion))}`}>
                {getChampRole(slot.champion)}
              </span>
            )}
            <div className="col-span-full grid grid-cols-4 gap-1.5">
              {STAT_FIELDS.map((f) => (
                <input key={f} type="number" min="0" placeholder={SHORT[f]} title={`${f} (round average, optional)`} value={slot[f]}
                  onChange={(e) => setSlot(side, i, f, e.target.value)}
                  className="bg-[#0C101B] border border-[#1B2438] focus:border-cyan-400 focus:outline-none rounded px-1.5 py-1 text-xs font-mono-hud min-w-0"
                  data-testid={`slot-${f}-${side}-${i}`} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="space-y-6" data-testid="log-match-page">
      <div>
        <div className="text-xs font-mono-hud uppercase tracking-[0.3em] text-cyan-400/70 mb-2">// Match Recorder</div>
        <h1 className="font-heading text-4xl sm:text-5xl font-black uppercase tracking-tight">Log Match</h1>
      </div>

      {tm && (
        <div className="hud-card p-4 flex flex-wrap items-center gap-3 border-cyan-400/40" data-testid="log-tournament">
          <Award className="w-5 h-5 text-cyan-400" />
          <div className="text-sm">
            <div className="font-semibold">{tm.t.name} · {tm.m.label || `Round ${tm.m.round}`} · game {tm.m.wins1 + tm.m.wins2 + 1}{tm.m.best_of > 1 ? ` (best of ${tm.m.best_of}, ${tm.m.wins1}-${tm.m.wins2} so far)` : ""}</div>
            <div className="text-xs text-slate-400">Team A is {tm.m.team1_name}, Team B is {tm.m.team2_name} (swap them if the screenshot has them the other way round). It's kept with the tournament only - no MMR change, and it isn't in the ranked or unranked stats.</div>
          </div>
          <Link to={`/tournaments/${tm.t.id}?tab=matches`} className="ml-auto text-xs font-mono-hud uppercase text-slate-400 hover:text-cyan-400">Back to the tournament</Link>
        </div>
      )}
      <form onSubmit={submit} className="space-y-6">
        <div className="hud-card p-5 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className={tm ? "hidden" : ""}>
            <label className="block text-xs font-mono-hud uppercase tracking-[0.2em] text-cyan-400/80 mb-1.5">Season</label>
            <select value={seasonId} onChange={(e) => setSeasonId(e.target.value)} className="w-full bg-[#121828] border border-[#1B2438] focus:border-cyan-400 focus:outline-none rounded px-3 py-2.5 text-sm" data-testid="log-season">
              {seasons.map((s) => <option key={s.id} value={s.id}>{s.name}{s.active ? " (active)" : ""}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-mono-hud uppercase tracking-[0.2em] text-cyan-400/80 mb-1.5">Format</label>
            <div className="flex gap-2">
              {["2v2", "3v3"].map((fmt) => (
                <button type="button" key={fmt} onClick={() => applyFormat(fmt)} disabled={!!tm}
                  className={`flex-1 px-3 py-2 font-mono-hud text-sm uppercase tracking-wider rounded border transition-colors ${format === fmt ? "bg-cyan-400 text-black border-cyan-400 font-bold" : "bg-[#121828] border-[#1B2438] text-slate-300 hover:border-cyan-400/40"}`}
                  data-testid={`format-${fmt}`}
                >{fmt}</button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs font-mono-hud uppercase tracking-[0.2em] text-cyan-400/80 mb-1.5">Notes (optional)</label>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full bg-[#121828] border border-[#1B2438] focus:border-cyan-400 focus:outline-none rounded px-3 py-2.5 text-sm" data-testid="log-notes" />
          </div>
        </div>

        <div className="hud-card p-4 flex flex-wrap items-start gap-4">
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
            onChange={(e) => readShot(e.target.files?.[0])} data-testid="log-shot-input" />
          {shot ? (
            <>
              <a href={`${API}/screenshots/${shot.screenshot_id}`} target="_blank" rel="noreferrer" className="block w-40 shrink-0" title="Open full size">
                <img src={`${API}/screenshots/${shot.screenshot_id}`} alt="Scoreboard" className="w-full rounded border border-[#1B2438]" />
              </a>
              <div className="text-xs space-y-1 flex-1 min-w-0">
                <div className="text-cyan-400">Filled in from this screenshot - check it, fix anything wrong, then record.</div>
                <div className="text-slate-500">It's saved with the match; anything you change counts as a correction for the reader.</div>
                {(shot.warnings || []).map((w, i) => (
                  <div key={i} className="flex items-start gap-1 text-amber-400"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {w}</div>
                ))}
                <button type="button" onClick={dropShot} className="text-slate-500 hover:text-[#FF2E55] flex items-center gap-1 uppercase font-mono-hud text-[11px] pt-1">
                  <X className="w-3 h-3" /> Don't use this screenshot
                </button>
              </div>
            </>
          ) : (
            <div className="flex items-center gap-3 flex-wrap text-xs text-slate-400">
              <button type="button" disabled={reading} onClick={() => fileRef.current?.click()}
                className="px-3 py-2 border border-[#1B2438] hover:border-cyan-400/60 rounded font-mono-hud uppercase tracking-wider text-slate-200 flex items-center gap-2 disabled:opacity-50"
                data-testid="log-read-shot">
                <ImagePlus className="w-4 h-4" /> {reading ? "Reading…" : "Fill from screenshot"}
              </button>
              <span>Optional: add the final scoreboard (Average Total tab) to fill in the players, champions, stats and score. Picking the players first makes the match by name more reliable.</span>
            </div>
          )}
        </div>

        <datalist id="log-players">
          {players.filter((p) => !usedPlayers.has(p.id)).map((p) => <option key={p.id} value={p.name} />)}
        </datalist>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {renderTeam("A", teamA, "A", "text-cyan-400")}
          {renderTeam("B", teamB, "B", "text-[#FF2E55]")}
        </div>

        <div className="hud-card hud-corner p-5">
          <div className="flex items-center justify-center gap-6 flex-wrap">
            <div className="text-center">
              <div className="text-xs font-mono-hud uppercase tracking-[0.2em] text-cyan-400 mb-2">Team A rounds</div>
              <input type="number" min="0" max="20" value={teamARounds}
                onChange={(e) => setTeamARounds(Number(e.target.value))}
                className="w-24 bg-[#121828] border border-[#1B2438] focus:border-cyan-400 focus:outline-none rounded px-2 py-2 font-mono-hud text-3xl font-black text-center text-cyan-400"
                data-testid="rounds-team-a" />
            </div>
            <div className="font-mono-hud text-4xl font-black text-slate-600 self-end pb-2">:</div>
            <div className="text-center">
              <div className="text-xs font-mono-hud uppercase tracking-[0.2em] text-[#FF2E55] mb-2">Team B rounds</div>
              <input type="number" min="0" max="20" value={teamBRounds}
                onChange={(e) => setTeamBRounds(Number(e.target.value))}
                className="w-24 bg-[#121828] border border-[#1B2438] focus:border-cyan-400 focus:outline-none rounded px-2 py-2 font-mono-hud text-3xl font-black text-center text-[#FF2E55]"
                data-testid="rounds-team-b" />
            </div>
          </div>
        </div>

        <button type="submit" disabled={submitting} className="btn-glow bg-cyan-400 hover:bg-cyan-300 text-black font-mono-hud font-bold uppercase tracking-wider px-6 py-3 rounded flex items-center gap-2 disabled:opacity-60" data-testid="log-submit">
          <PlusCircle className="w-4 h-4" strokeWidth={3} />
          {submitting ? "Recording..." : "Record Match"}
        </button>
      </form>
    </div>
  );
}
