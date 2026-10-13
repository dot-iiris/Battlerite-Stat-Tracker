import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "@/api";
import { ScanEye } from "lucide-react";

const LABELS = {
  score: "Score", damage: "Damage", protection: "Protection", disables: "Disables",
  champion: "Champion", team: "Team / player match", rounds: "Round score",
};

const pctClass = (v) => (v === null ? "text-slate-500" : v >= 95 ? "text-[#00E676]" : v >= 80 ? "text-amber-400" : "text-[#FF2E55]");

function Table({ rows, first, firstLabel }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[420px] text-sm text-slate-100">
        <thead>
          <tr className="text-[10px] font-mono-hud uppercase tracking-wider text-slate-500">
            <th className="text-left font-normal py-1.5">{firstLabel}</th>
            {first === "resolution" && <th className="text-right font-normal py-1.5">Shots</th>}
            <th className="text-right font-normal py-1.5">Correct</th>
            <th className="text-right font-normal py-1.5">Wrong</th>
            <th className="text-right font-normal py-1.5">Missed</th>
            <th className="text-right font-normal py-1.5">Accuracy</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r[first]} className="border-t border-[#1B2438]">
              <td className="py-1.5">{LABELS[r[first]] || r[first]}</td>
              {first === "resolution" && <td className="py-1.5 text-right font-mono-hud">{r.screenshots}</td>}
              <td className="py-1.5 text-right font-mono-hud">{r.correct}</td>
              <td className="py-1.5 text-right font-mono-hud">{r.wrong}</td>
              <td className="py-1.5 text-right font-mono-hud">{r.missed}</td>
              <td className={`py-1.5 text-right font-mono-hud font-bold ${pctClass(r.accuracy)}`}>
                {r.accuracy === null ? "—" : `${r.accuracy}%`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// How often the screenshot reader's suggestions matched what admins logged.
export default function OcrAccuracy() {
  const [data, setData] = useState(null);

  useEffect(() => {
    api.get("/admin/ocr-accuracy").then((r) => setData(r.data)).catch(() => setData({ error: true }));
  }, []);

  return (
    <section className="space-y-3" data-testid="ocr-accuracy">
      <h2 className="flex items-center gap-2 font-heading text-xl font-black uppercase">
        <ScanEye className="w-5 h-5 text-cyan-400" /> Screenshot reading accuracy
      </h2>
      {!data ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : data.error ? (
        <div className="text-sm text-slate-500">Couldn't load accuracy stats.</div>
      ) : data.screenshots === 0 ? (
        <div className="text-sm text-slate-500">No matches logged from screenshots yet. Each one you log is compared with what the reader suggested.</div>
      ) : (
        <div className="hud-card p-5 space-y-5">
          <div className="text-xs text-slate-400">
            Based on {data.screenshots} logged screenshot{data.screenshots === 1 ? "" : "s"}: what the reader suggested vs what was logged.
            <span className="text-slate-500"> Missed = the reader left it blank.</span>
          </div>
          {data.streak !== undefined && (
            <div className="text-xs text-slate-400">
              <span className="font-mono-hud text-cyan-400">{data.streak}</span> screenshot{data.streak === 1 ? "" : "s"} in a row logged with no corrections.
              <span className="text-slate-500"> Any correction starts the count again.</span>
            </div>
          )}
          {data.storage && (
            <div className="text-xs text-slate-400">
              Screenshots stored: <span className="font-mono-hud text-cyan-400">{data.storage.used_mb} MB</span> of {data.storage.limit_mb} MB ({data.storage.count}).
              <span className="text-slate-500"> Oldest are deleted first once it's full; the champion portraits and accuracy data learned from them are kept.</span>
            </div>
          )}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Table rows={data.fields.filter((f) => f.correct + f.wrong + f.missed > 0)} first="field" firstLabel="Field" />
            <Table rows={data.resolutions} first="resolution" firstLabel="Resolution" />
          </div>
          {data.recent_corrections.length > 0 && (
            <div>
              <div className="text-[10px] font-mono-hud uppercase tracking-wider text-slate-500 mb-1.5">Recent corrections</div>
              <ul className="space-y-1 text-sm">
                {data.recent_corrections.map((c, i) => (
                  <li key={i} className="flex flex-wrap gap-x-2 text-slate-300">
                    <Link to={`/matches?match=${c.match_id}`} className="text-cyan-400 hover:underline">{new Date(c.at).toLocaleDateString()}</Link>
                    <span>{c.player ? `${c.player} · ` : ""}{LABELS[c.field] || c.field}:</span>
                    <span className="font-mono-hud">
                      {c.outcome === "missed" ? <span className="text-slate-500">not read</span> : <span className="text-[#FF2E55] line-through">{String(c.read)}</span>}
                      {" → "}<span className="text-[#00E676]">{String(c.final)}</span>
                    </span>
                    <span className="text-slate-500 text-xs self-center">({c.resolution})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
