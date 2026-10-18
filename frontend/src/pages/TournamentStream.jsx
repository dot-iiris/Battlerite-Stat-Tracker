import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { API } from "@/api";
import { Bracket, Standings, MatchCard, matchNames, stageText } from "@/components/TournamentParts";

// A tournament for a stream overlay (OBS Browser Source): no login, no menus, refreshes itself.
//   /stream/tournament/<id>?key=<stream key>&view=bracket|standings|next  &bg=transparent  &scale=1.25  &title=0
const REFRESH_MS = 10000;

export default function TournamentStream() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const view = params.get("view") || "bracket";
  const key = params.get("key") || "";
  const clear = params.get("bg") === "transparent";
  const scale = Math.min(3, Math.max(0.3, Number(params.get("scale")) || 1));
  const showTitle = params.get("title") !== "0";
  const [t, setT] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const r = await fetch(`${API}/tournaments/${id}?key=${encodeURIComponent(key)}`, { cache: "no-store" });
        if (!r.ok) throw new Error(r.status === 404 ? "Tournament not found" : "Couldn't load");
        const data = await r.json();
        if (!stop) { setT(data); setError(null); }
      } catch (e) {
        if (!stop) setError(e.message);   // keep showing the last good copy
      }
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => { stop = true; clearInterval(timer); };
  }, [id, key]);

  useEffect(() => {
    if (!clear) return undefined;
    const prev = document.body.style.background;
    document.body.style.background = "transparent";
    document.documentElement.style.background = "transparent";
    return () => { document.body.style.background = prev; document.documentElement.style.background = ""; };
  }, [clear]);

  const next = t ? t.matches.filter((m) => ["live", "ready"].includes(m.status)).sort((a, b) => (a.status === "live" ? -1 : 0) - (b.status === "live" ? -1 : 0)) : [];
  const names = t ? matchNames(t.matches) : {};

  return (
    <div className={`min-h-screen text-slate-100 p-6 ${clear ? "bg-transparent" : "bg-[#06080E]"}`} data-testid="tournament-stream">
      <div style={{ transform: `scale(${scale})`, transformOrigin: "top left" }} className="inline-block">
        {!t ? (
          <div className="text-cyan-400 font-mono-hud text-sm uppercase tracking-[0.3em]">{error || "Loading…"}</div>
        ) : (
          <div className="space-y-5">
            {showTitle && (
              <div className={clear ? "inline-block px-4 py-2 rounded bg-[#06080E]/85" : ""}>
                <div className="font-heading text-3xl font-black uppercase tracking-tight">{t.name}</div>
                <div className="text-xs font-mono-hud uppercase tracking-[0.25em] text-cyan-400">{stageText(t)}</div>
              </div>
            )}
            {view === "standings" || (view === "bracket" && t.league && !t.matches.some((m) => m.stage === "playoffs")) ? (
              <div className={`min-w-[40rem] ${clear ? "p-3 rounded bg-[#06080E]/85" : ""}`}><Standings t={t} big /></div>
            ) : view === "next" ? (
              <div className="flex flex-wrap gap-3" data-testid="stream-next">
                {next.length ? next.map((m) => <MatchCard key={m.id} m={m} names={names} />) :
                  <div className="text-sm text-slate-400">{t.champion_name ? `${t.champion_name} won the tournament` : "No matches to play right now"}</div>}
              </div>
            ) : (
              <div className={clear ? "p-3 rounded bg-[#06080E]/70" : ""}><Bracket t={t} /></div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
