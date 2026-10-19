import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import api from "@/api";
import { Scale, Search } from "lucide-react";

// Admins: why did a match get its teams, and how do the old (role spread) and new (role MMR) balancing
// compare on recent games. Read-only - everything is rebuilt from what was known before each match.
const sel = "bg-[#121828] border border-[#1B2438] focus:border-cyan-400 focus:outline-none rounded px-3 py-2 text-sm";
const R1 = { Melee: "M", Ranged: "R", Support: "S" };
const roleCls = (r) => (r === "Melee" ? "role-melee" : r === "Ranged" ? "role-ranged" : r === "Support" ? "role-support" : "text-slate-500");
const signed = (n) => `${n > 0 ? "+" : ""}${Math.round(n)}`;
const num = (n, d = 0) => (n == null ? "—" : Number(n).toFixed(d));

function Team({ ids, names, roles }) {
  return (
    <span>
      {ids.map((id, i) => (
        <span key={id}>
          {i > 0 && ", "}
          {names[id] || "?"}
          {roles && roles[id] && <span className={`ml-0.5 text-[10px] font-mono-hud ${roleCls(roles[id])}`}>{R1[roles[id]]}</span>}
        </span>
      ))}
    </span>
  );
}

function Tag({ children, tone = "cyan", title }) {
  const t = { cyan: "text-cyan-400 border-cyan-400/40 bg-cyan-400/10", amber: "text-[#FFB800] border-[#FFB800]/40 bg-[#FFB800]/10",
    slate: "text-slate-400 border-slate-500/40", red: "text-[#FF2E55] border-[#FF2E55]/40 bg-[#FF2E55]/10" }[tone];
  return <span title={title} className={`inline-block mr-1 px-1.5 py-0.5 text-[9px] font-mono-hud uppercase tracking-wider border rounded ${t}`}>{children}</span>;
}

// A plain-language reason for the new balancer's choice
function why(d, names) {
  const w = d.settings.hybrid_mmr_weight;
  const ss = d.splits;
  const pick = ss.find((s) => s.new_pick);
  const runner = ss.filter((s) => s !== pick).sort((a, b) => b.new.total - a.new.total)[0];
  const played = ss.find((s) => s.played);
  const team = (s) => `${s.team_a.map((i) => names[i]).join(", ")} vs ${s.team_b.map((i) => names[i]).join(", ")}`;
  const lines = [];
  if (d.match.mode !== "hybrid") lines.push(`This lobby used the "${d.match.mode}" mode, so only ${d.match.mode === "mmr" ? "MMR" : "roles"} counted.`);
  if (runner) {
    const dm = (pick.new.mmr_score - runner.new.mmr_score) * (d.match.mode === "hybrid" ? w : d.match.mode === "mmr" ? 1 : 0);
    const dr = (pick.new.role_score - runner.new.role_score) * (d.match.mode === "hybrid" ? 1 - w : d.match.mode === "synergy" ? 1 : 0);
    lines.push(`New balancing's top split was ${team(pick)} (score ${num(pick.new.total, 1)}), ${num(pick.new.total - runner.new.total, 1)} ahead of the next best, ${team(runner)}.`);
    lines.push(`Against that one: MMR ${dm >= 0 ? "helped" : "cost"} ${num(Math.abs(dm), 1)} (team gap ${num(pick.new.mmr_gap)} vs ${num(runner.new.mmr_gap)}), roles ${dr >= 0 ? "helped" : "cost"} ${num(Math.abs(dr), 1)} (line-up gap ${num(pick.new.lineup_gap)} vs ${num(runner.new.lineup_gap)}, role fit ${num(pick.new.skilled)} vs ${num(runner.new.skilled)}).`);
  }
  if (played.new_pick) lines.push("The teams played were that top split.");
  else if (played.repeats && ss.some((s) => s.new_pick && s.repeats)) lines.push(`The teams played were the ${played.new_rank}${["th", "st", "nd", "rd"][played.new_rank] || "th"} best: the top split repeated a team from these players' last games, so "avoid repeats" moved on.`);
  else if (ss.find((s) => s.new_pick)?.repeats) lines.push(`The top split repeated a recent team, so the lobby likely used the best fresh one${played.new_pick_fresh ? " - which is what was played" : ""}.`);
  else lines.push(`The teams played were ranked ${played.new_rank} of ${ss.length} by new balancing (${played.old_rank} by old) - they may have come from an earlier setting, a repeat being avoided (incl. unlogged lobby games), or teams set by hand.`);
  return lines;
}

function Explain({ code }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (!code) return;
    setD(null); setErr(null);
    api.get("/admin/balance/explain", { params: { match: code } }).then((r) => setD(r.data))
      .catch((e) => setErr(e?.response?.data?.detail || "Couldn't load that match"));
  }, [code]);
  if (!code) return null;
  if (err) return <div className="text-sm text-[#FF2E55]">{err}</div>;
  if (!d) return <div className="text-sm text-slate-500">Working it out…</div>;
  const names = Object.fromEntries(d.players.map((p) => [p.id, p.name]));
  const m = d.match;
  return (
    <div className="space-y-5" data-testid="bc-explain">
      <div className="hud-card p-5 space-y-2">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="font-heading text-2xl font-black">#{m.code || m.id.slice(0, 8)}</span>
          <span className="text-sm text-slate-400">{new Date(m.played_at).toLocaleString()} · {m.format} · {m.team_a_rounds}-{m.team_b_rounds}, Team {m.winner} won · mode {m.mode}</span>
        </div>
        <div className="text-xs text-slate-500">
          Settings used (current): Hybrid MMR weight {d.settings.hybrid_mmr_weight}, 2v2 support weight {d.settings.support_weight_2v2}, unproven-role penalty {d.settings.unproven_role_penalty}. Team A's win chance for the teams played: plain MMR {d.win_chance_a.mmr}%, role MMR {d.win_chance_a.role_mmr}%.
        </div>
        <ul className="text-sm text-slate-200 space-y-1 pt-1" data-testid="bc-why">
          {why(d, names).map((l, i) => <li key={i}>• {l}</li>)}
        </ul>
      </div>

      <div className="hud-card p-0 overflow-x-auto">
        <table className="w-full text-sm text-slate-100 min-w-[640px]">
          <thead>
            <tr className="text-[10px] font-mono-hud uppercase tracking-wider text-slate-500 text-right">
              <th className="px-3 py-2 text-left">Player</th><th className="px-3 py-2 text-left">Played</th>
              <th className="px-3 py-2">MMR</th>
              {["Melee", "Ranged", "Support"].map((r) => <th key={r} className="px-3 py-2" title="Role MMR (offset from MMR) · games in that role before this match">{r}</th>)}
              <th className="px-3 py-2 text-left" title="Most-played role (what old balancing used)">Main</th>
            </tr>
          </thead>
          <tbody>
            {d.players.map((p) => (
              <tr key={p.id} className="border-t border-[#1B2438] text-right">
                <td className="px-3 py-1.5 text-left font-semibold">{p.name}</td>
                <td className="px-3 py-1.5 text-left text-slate-400">Team {p.team} · <span className={roleCls(p.played_role)}>{p.played_role}</span></td>
                <td className="px-3 py-1.5 font-mono-hud">{num(p.mmr)}</td>
                {["Melee", "Ranged", "Support"].map((r) => (
                  <td key={r} className="px-3 py-1.5 font-mono-hud">
                    {num(p.role_mmr[r])} <span className={`text-xs ${p.role_offsets[r] >= 0 ? "text-[#00E676]" : "text-[#FF2E55]"}`}>({signed(p.role_offsets[r])})</span>
                    <span className="text-xs text-slate-500"> · {p.role_games[r]}g</span>
                  </td>
                ))}
                <td className={`px-3 py-1.5 text-left ${roleCls(p.main_role)}`}>{p.main_role}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="hud-card p-0 overflow-x-auto">
        <table className="w-full text-sm text-slate-100 min-w-[900px]">
          <thead>
            <tr className="text-[10px] font-mono-hud uppercase tracking-wider text-slate-500 text-right">
              <th className="px-2 py-2 text-left">#</th><th className="px-2 py-2 text-left">Teams (new balancing's roles)</th>
              <th className="px-2 py-2" title="Average MMR gap">MMR gap</th>
              <th className="px-2 py-2" title="Gap between the two best role line-ups">Line-up gap</th>
              <th className="px-2 py-2" title="100 - MMR gap / 4">MMR score</th>
              <th className="px-2 py-2" title="Half line-up fairness, half how well players suit their roles">Role score</th>
              <th className="px-2 py-2" title="New balancing (role MMR) total">New</th>
              <th className="px-2 py-2" title="Old balancing (role spread) total">Old</th>
              <th className="px-2 py-2 text-left"></th>
            </tr>
          </thead>
          <tbody>
            {d.splits.map((s) => (
              <tr key={s.team_a.join() + s.team_b.join()} className={`border-t border-[#1B2438] text-right ${s.played ? "bg-cyan-400/[0.06]" : ""}`} data-testid={s.played ? "bc-played" : undefined}>
                <td className="px-2 py-1.5 text-left font-mono-hud text-slate-500">{s.new_rank}</td>
                <td className="px-2 py-1.5 text-left"><Team ids={s.team_a} names={names} roles={s.new.roles} /> <span className="text-slate-500">vs</span> <Team ids={s.team_b} names={names} roles={s.new.roles} /></td>
                <td className="px-2 py-1.5 font-mono-hud">{num(s.new.mmr_gap)}</td>
                <td className="px-2 py-1.5 font-mono-hud">{num(s.new.lineup_gap)}</td>
                <td className="px-2 py-1.5 font-mono-hud text-slate-400">{num(s.new.mmr_score, 1)}</td>
                <td className="px-2 py-1.5 font-mono-hud text-slate-400" title={`fair ${num(s.new.fair, 1)} · role fit ${num(s.new.skilled, 1)}`}>{num(s.new.role_score, 1)}</td>
                <td className="px-2 py-1.5 font-mono-hud font-bold text-cyan-300">{num(s.new.total, 1)}</td>
                <td className="px-2 py-1.5 font-mono-hud text-slate-400">{num(s.old.total, 1)}</td>
                <td className="px-2 py-1.5 text-left whitespace-nowrap">
                  {s.played && <Tag>Played</Tag>}
                  {s.new_pick && <Tag tone="amber">New pick</Tag>}
                  {s.old_pick && <Tag tone="slate">Old pick</Tag>}
                  {s.new_pick_fresh && <Tag tone="amber" title="Best split that doesn't repeat a recent team">New, no repeat</Tag>}
                  {s.repeats && <Tag tone="red" title="Repeats a team from these players' last games in this format">Repeat</Tag>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Compare({ onExplain }) {
  const [games, setGames] = useState(10);
  const [d, setD] = useState(null);
  useEffect(() => {
    setD(null);
    api.get("/admin/balance/compare", { params: { games } }).then((r) => setD(r.data)).catch(() => setD({ error: true }));
  }, [games]);
  return (
    <section className="space-y-3" data-testid="bc-compare">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-heading text-xl font-black uppercase">Old vs new balancing</h2>
        <select value={games} onChange={(e) => setGames(Number(e.target.value))} className={sel}>
          {[5, 10, 20, 30].map((n) => <option key={n} value={n}>Last {n} ranked games</option>)}
        </select>
      </div>
      {!d ? <div className="text-sm text-slate-500">Working it out…</div> : d.error ? <div className="text-sm text-slate-500">Couldn't load.</div> : (
        ["3v3", "2v2"].map((fmt) => {
          const { games: rows, summary: s } = d[fmt];
          return (
            <div key={fmt} className="hud-card p-5 space-y-3" data-testid={`bc-${fmt}`}>
              <div className="font-heading text-lg font-black">{fmt}</div>
              {rows.length === 0 ? <div className="text-sm text-slate-500">No ranked games yet.</div> : <>
                <div className="text-xs text-slate-400 space-y-0.5">
                  <div>Played teams were the new pick in <b className="text-slate-200">{s.played_new}/{s.games}</b>, the old pick in <b className="text-slate-200">{s.played_old}/{s.games}</b>; both picked the same in {s.same_pick}/{s.games}. Average MMR gap of the picks: new {s.avg_gap_new}, old {s.avg_gap_old}.</div>
                  <div>Favourite won: plain MMR {s.favourite_won_mmr}, role MMR {s.favourite_won_role}. Prediction error (lower is better, 0.25 = coin flip): plain MMR {s.brier_mmr}, role MMR {s.brier_role}. Average round margin {s.avg_margin}.</div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-slate-100 min-w-[820px]">
                    <thead>
                      <tr className="text-[10px] font-mono-hud uppercase tracking-wider text-slate-500">
                        <th className="py-1.5 text-left">Match</th><th className="py-1.5 text-left">Played (A vs B)</th>
                        <th className="py-1.5 text-left">New would make</th><th className="py-1.5 text-right">A win: MMR / role</th><th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.match.id} className="border-t border-[#1B2438] align-top">
                          <td className="py-1.5 pr-2 whitespace-nowrap">
                            <div className="font-mono-hud text-cyan-400 text-xs">#{r.match.code || r.match.id.slice(0, 8)}</div>
                            <div className="text-[10px] text-slate-500">{new Date(r.match.played_at).toLocaleDateString()} · {r.match.team_a_rounds}-{r.match.team_b_rounds}</div>
                          </td>
                          <td className="py-1.5 pr-2"><Team ids={r.played.team_a} names={r.names} /> <span className="text-slate-500">vs</span> <Team ids={r.played.team_b} names={r.names} />
                            <div className="mt-0.5">{r.played_is_new && <Tag tone="amber">New pick</Tag>}{r.played_is_old && <Tag tone="slate">Old pick</Tag>}{!r.played_is_new && !r.played_is_old && <Tag tone="red">Neither</Tag>}</div></td>
                          <td className="py-1.5 pr-2 text-slate-300">{r.played_is_new ? <span className="text-slate-500">same</span> : <><Team ids={r.new_pick.team_a} names={r.names} roles={r.new_pick.new.roles} /> <span className="text-slate-500">vs</span> <Team ids={r.new_pick.team_b} names={r.names} roles={r.new_pick.new.roles} /></>}</td>
                          <td className="py-1.5 text-right font-mono-hud whitespace-nowrap">{Math.round(r.win_chance_a.mmr)}% / {Math.round(r.win_chance_a.role_mmr)}%</td>
                          <td className="py-1.5 pl-2 text-right"><button onClick={() => onExplain(r.match.code || r.match.id)} className="text-xs font-mono-hud uppercase text-cyan-400 hover:text-cyan-300" data-testid={`bc-why-${r.match.id}`}>Why?</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>}
            </div>
          );
        })
      )}
    </section>
  );
}

export default function BalanceCheck() {
  const [params, setParams] = useSearchParams();
  const code = params.get("match") || "";
  const [draft, setDraft] = useState(code);
  useEffect(() => setDraft(code), [code]);
  const explain = (c) => { setParams({ match: c }); window.scrollTo({ top: 0, behavior: "smooth" }); };
  return (
    <div className="space-y-6" data-testid="balance-check-page">
      <div>
        <div className="text-xs font-mono-hud uppercase tracking-[0.3em] text-cyan-400/70 mb-2">// Admin</div>
        <h1 className="font-heading text-4xl sm:text-5xl font-black uppercase tracking-tight flex items-center gap-3"><Scale className="w-8 h-8 text-cyan-400" /> Balance Check</h1>
        <p className="text-sm text-slate-400 mt-2 max-w-3xl">Why a match got its teams: every possible split, scored the way matchmaking does, using only what was known before that match (MMR going in, role MMR from earlier games). Nothing is changed.</p>
      </div>
      <form onSubmit={(e) => { e.preventDefault(); if (draft.trim()) explain(draft.trim()); }} className="flex gap-2 max-w-md">
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Match code, e.g. S1-3v3-bd98" className={`${sel} flex-1`} data-testid="bc-input" />
        <button className="flex items-center gap-1.5 px-4 py-2 text-xs font-mono-hud uppercase border border-cyan-400/50 text-cyan-400 rounded hover:bg-cyan-400/10" data-testid="bc-go"><Search className="w-3.5 h-3.5" /> Explain</button>
      </form>
      <Explain code={code} />
      <Compare onExplain={explain} />
    </div>
  );
}
