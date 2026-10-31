import { Trophy } from "lucide-react";

// Pieces shared by the tournament page and its stream overlay: the playoff bracket and the
// league table(s). Both only display what the website worked out (see backend/tournaments.py).

export const LEAGUE_NAMES = { round_robin: "Round robin", swiss: "Swiss", groups: "Groups", rotation: "Player rotation" };
export const PLAYOFF_NAMES = { single: "Single elimination", double: "Double elimination" };

// "Semifinals 2" etc. - how a match is referred to by the ones fed from it
export function matchNames(matches) {
  const count = {}, seen = {}, out = {};
  for (const m of matches) { const k = `${m.stage}|${m.group}|${m.bracket}|${m.round}`; count[k] = (count[k] || 0) + 1; }
  for (const m of matches) {
    const k = `${m.stage}|${m.group}|${m.bracket}|${m.round}`;
    seen[k] = (seen[k] || 0) + 1;
    const base = m.label || (m.group ? `Group ${m.group} · Round ${m.round}` : `Round ${m.round}`);
    out[m.id] = count[k] <= 1 ? base : m.stage === "league" ? `${base} · match ${seen[k]}` : `${base} ${seen[k]}`;
  }
  return out;
}

const srcText = (src, names) => {
  if (!src) return "TBD";
  if (src.seed) return `Seed ${src.seed}`;
  if (src.winner) return `Winner of ${names[src.winner] || src.winner}`;
  if (src.loser) return `Loser of ${names[src.loser] || src.loser}`;
  return "TBD";
};

export function StatusChip({ m }) {
  const map = {
    live: ["Live", "text-[#FF2E55] border-[#FF2E55]/50 bg-[#FF2E55]/10"],
    ready: ["Up next", "text-cyan-400 border-cyan-400/40 bg-cyan-400/10"],
    forfeit: ["Forfeit", "text-amber-400 border-amber-400/40 bg-amber-400/10"],
    bye: ["Bye", "text-slate-400 border-slate-500/40"],
    "not needed": ["Not needed", "text-slate-500 border-slate-600/40"],
  };
  const v = map[m.status];
  if (!v) return null;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-mono-hud uppercase tracking-wider border rounded ${v[1]}`}>
      {m.status === "live" && <span className="w-1.5 h-1.5 rounded-full bg-[#FF2E55] animate-pulse" />}{v[0]}
    </span>
  );
}

// one side of a series: wins in a best-of, else the round score of the game
const sideScore = (m, n) => {
  if (m.status === "bye" || m.status === "not needed") return "";
  if (m.status === "forfeit") return m.winner === m[`team${n}`] ? "W" : "FF";
  if (!m.games) return "";
  return m.best_of > 1 ? m[`wins${n}`] : m[`rounds${n}`];
};

export function MatchCard({ m, names, onClick, compact }) {
  const row = (n) => {
    const team = m[`team${n}`];
    const name = m[`team${n}_name`];
    const won = m.done && m.winner && m.winner === team;
    const lost = m.done && m.winner && m.winner !== team;
    return (
      <div className={`flex items-center justify-between gap-2 px-2.5 ${compact ? "py-1" : "py-1.5"} ${won ? "bg-cyan-400/10" : ""}`}>
        <span className={`truncate text-sm ${won ? "text-cyan-300 font-semibold" : lost ? "text-slate-500" : name ? "text-slate-100" : "text-slate-500 italic text-xs"}`}>
          {name || srcText(m[`src${n}`], names)}
        </span>
        <span className={`font-mono-hud text-sm font-bold ${won ? "text-cyan-300" : "text-slate-400"}`}>{sideScore(m, n)}</span>
      </div>
    );
  };
  const dim = m.status === "not needed";
  return (
    <div onClick={onClick} data-testid={`bracket-${m.id}`}
      className={`w-56 rounded border bg-[#0C101B]/95 ${m.status === "live" ? "border-[#FF2E55]/60" : m.status === "ready" ? "border-cyan-400/40" : "border-[#1B2438]"} ${dim ? "opacity-40" : ""} ${onClick ? "cursor-pointer hover:border-cyan-400" : ""}`}>
      <div className="flex items-center justify-between gap-2 px-2.5 pt-1 text-[9px] font-mono-hud uppercase tracking-wider text-slate-500">
        <span className="truncate">{names[m.id]}{m.best_of > 1 ? ` · Bo${m.best_of}` : ""}</span>
        <StatusChip m={m} />
      </div>
      {row(1)}
      <div className="border-t border-[#1B2438]" />
      {row(2)}
    </div>
  );
}

function Columns({ title, matches, names, onPick }) {
  const rounds = [...new Set(matches.map((m) => m.round))].sort((a, b) => a - b);
  if (!rounds.length) return null;
  return (
    <div className="space-y-2">
      {title && <div className="text-[10px] font-mono-hud uppercase tracking-[0.25em] text-cyan-400/70">{title}</div>}
      <div className="flex gap-6 items-stretch">
        {rounds.map((r) => {
          const ms = matches.filter((m) => m.round === r).sort((a, b) => (a.index || 0) - (b.index || 0));
          return (
            <div key={r} className="flex flex-col shrink-0">
              <div className="text-[10px] font-mono-hud uppercase tracking-wider text-slate-400 mb-2 h-4">{ms[0]?.label || `Round ${r}`}</div>
              <div className="flex flex-col justify-around gap-3 flex-1">
                {ms.map((m) => <MatchCard key={m.id} m={m} names={names} onClick={onPick ? () => onPick(m) : undefined} />)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Bracket({ t, onPick }) {
  const po = t.matches.filter((m) => m.stage === "playoffs");
  const names = matchNames(t.matches);
  if (!po.length) {
    return (
      <div className="text-sm text-slate-400" data-testid="bracket-empty">
        {t.playoffs ? "The playoff bracket is drawn when the league stage is over." : "This tournament has no playoffs."}
      </div>
    );
  }
  const double = po.some((m) => m.bracket === "L");
  return (
    <div className="overflow-x-auto pb-2" data-testid="bracket">
      <div className="inline-flex flex-col gap-8 min-w-max">
        <div className="flex gap-6 items-center">
          <Columns title={double ? "Winners bracket" : null} matches={po.filter((m) => m.bracket === "W")} names={names} onPick={onPick} />
          {!double && <ChampionBox t={t} />}
        </div>
        {double && (
          <div className="flex gap-6 items-center">
            <Columns title="Losers bracket" matches={po.filter((m) => m.bracket === "L")} names={names} onPick={onPick} />
            <div className="flex gap-6 items-center">
              {po.filter((m) => m.bracket === "GF").map((m) => (
                <div key={m.id}>
                  <div className="text-[10px] font-mono-hud uppercase tracking-wider text-slate-400 mb-2">{m.label}</div>
                  <MatchCard m={m} names={names} onClick={onPick ? () => onPick(m) : undefined} />
                </div>
              ))}
              <ChampionBox t={t} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ChampionBox({ t }) {
  if (!t.champion_name) return null;
  return (
    <div className="flex flex-col items-center gap-1 px-4 py-3 rounded border border-[#FFB800]/50 bg-[#FFB800]/10 self-center" data-testid="bracket-champion">
      <Trophy className="w-6 h-6 text-[#FFB800]" />
      <div className="text-[10px] font-mono-hud uppercase tracking-[0.25em] text-[#FFB800]/80">Champion</div>
      <div className="font-heading text-lg font-black uppercase text-[#FFB800]">{t.champion_name}</div>
    </div>
  );
}

// how many from each table go through to the playoffs (highlighted)
const advancing = (t) => {
  if (!t.playoffs) return 0;
  if (t.league?.type === "groups") return t.league.advance_per_group || 2;
  return t.playoffs.teams || t.teams.length;
};

const signed = (n) => (n > 0 ? `+${n}` : String(n));

export function Standings({ t, big }) {
  if (!t.standings?.length) return <div className="text-sm text-slate-400">This tournament has no league stage.</div>;
  const swiss = t.league?.type === "swiss";
  const rotation = t.league?.type === "rotation";   // rows are players, not teams
  const through = advancing(t);
  const playoffsDrawn = t.matches.some((m) => m.stage === "playoffs");
  const td = big ? "px-3 py-2" : "px-2 py-1.5";
  return (
    <div className={`grid gap-6 ${t.standings.length > 1 ? "lg:grid-cols-2" : ""}`} data-testid="standings">
      {t.standings.map((tb) => (
        <div key={tb.group || "all"} className="hud-card p-0 overflow-x-auto">
          {tb.group && <div className="px-3 pt-3 font-heading font-black uppercase text-cyan-400">Group {tb.group}</div>}
          <table className={`w-full text-slate-100 ${big ? "text-base" : "text-sm"}`}>
            <thead>
              <tr className="text-[10px] font-mono-hud uppercase tracking-wider text-slate-500 text-right">
                <th className={`${td} text-left w-8`}>#</th>
                <th className={`${td} text-left`}>{rotation ? "Player" : "Team"}</th>
                <th className={td} title="Series played">P</th>
                <th className={td} title="Series won">W</th>
                <th className={td} title="Series lost">L</th>
                {swiss && <th className={td} title="Buchholz: the wins of the teams you've played (tie-break)">Opp W</th>}
                <th className={td} title="Games won - lost">Games</th>
                <th className={td} title="Rounds won - lost">Rounds</th>
                {rotation && <th className={td} title="Rounds sat out">Out</th>}
              </tr>
            </thead>
            <tbody>
              {tb.rows.map((r) => {
                const goes = through && r.rank <= through;
                return (
                  <tr key={r.team} className={`border-t border-[#1B2438] text-right ${goes ? "bg-cyan-400/[0.04]" : ""}`} data-testid={`standing-${r.team}`}>
                    <td className={`${td} text-left font-mono-hud ${goes ? "text-cyan-400 border-l-2 border-cyan-400" : "text-slate-500 border-l-2 border-transparent"}`}>{r.rank}</td>
                    <td className={`${td} text-left font-semibold text-slate-100 truncate max-w-[14rem]`}>{r.name}{r.team === t.champion && <Trophy className="inline w-3.5 h-3.5 ml-1.5 text-[#FFB800]" />}</td>
                    <td className={`${td} font-mono-hud text-slate-400`}>{r.played}</td>
                    <td className={`${td} font-mono-hud text-cyan-300 font-bold`}>{r.wins}</td>
                    <td className={`${td} font-mono-hud text-slate-400`}>{r.losses}</td>
                    {swiss && <td className={`${td} font-mono-hud text-slate-400`}>{r.buchholz}</td>}
                    <td className={`${td} font-mono-hud text-slate-300`}>{r.game_wins}-{r.game_losses} <span className="text-slate-500 text-xs">({signed(r.game_diff)})</span></td>
                    <td className={`${td} font-mono-hud text-slate-400`}>{signed(r.round_diff)}</td>
                    {rotation && <td className={`${td} font-mono-hud text-slate-500`}>{r.rests}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
      {through > 0 && !playoffsDrawn && (
        <div className="text-xs text-slate-500 lg:col-span-2">
          Highlighted: {t.league?.type === "groups" ? `the top ${through} of each group` : `the top ${through}`} go through to the playoffs.
        </div>
      )}
    </div>
  );
}

export function stageText(t) {
  if (t.status === "finished") return t.champion_name ? `Finished · ${t.champion_name} won` : "Finished";
  if (t.status === "playoffs") return "Playoffs";
  const total = t.league_rounds;
  // the round being played: the first with a series still open (Swiss rounds are drawn one at a time)
  const open = t.matches.filter((m) => m.stage === "league" && !m.done).map((m) => m.round);
  const now = open.length ? Math.min(...open) : Math.max(1, t.league_round);
  if (!open.length && t.league_done && t.playoffs) return "League finished · playoffs next";
  return total ? `League · round ${now} of ${total}` : "League";
}
