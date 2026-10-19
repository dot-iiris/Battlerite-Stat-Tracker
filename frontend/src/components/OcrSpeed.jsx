import { useEffect, useState } from "react";
import api from "@/api";
import { Timer } from "lucide-react";

const KIND = { rounds: "Round score", full: "Whole scoreboard" };
const SOURCE = { discord: "Discord", website: "Log Match", pending: "Pending" };
const secs = (ms) => (ms == null ? "—" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const speedClass = (kind, ms) => {
  if (ms == null) return "text-slate-500";
  const [ok, slow] = kind === "rounds" ? [1500, 4000] : [6000, 15000];
  return ms <= ok ? "text-[#00E676]" : ms <= slow ? "text-amber-400" : "text-[#FF2E55]";
};

// How long screenshot reads take on the server (logged for 30 days).
export default function OcrSpeed() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState(null);

  useEffect(() => {
    setData(null);
    api.get("/admin/ocr-speed", { params: { days } }).then((r) => setData(r.data)).catch(() => setData({ error: true }));
  }, [days]);

  return (
    <section className="space-y-3" data-testid="ocr-speed">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-heading text-xl font-black uppercase">
          <Timer className="w-5 h-5 text-cyan-400" /> Screenshot reading speed
        </h2>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} data-testid="ocr-speed-days"
          className="bg-[#121828] border border-[#1B2438] rounded px-2 py-1 text-xs">
          <option value={1}>Last 24 hours</option>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
        </select>
      </div>
      {!data ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : data.error ? (
        <div className="text-sm text-slate-500">Couldn't load speed stats.</div>
      ) : data.reads === 0 ? (
        <div className="text-sm text-slate-500">No screenshots read in this period. Each read from now on is timed.</div>
      ) : (
        <div className="hud-card p-5 space-y-5">
          <div className="text-xs text-slate-400">
            {data.reads} read{data.reads === 1 ? "" : "s"}. Whole scoreboards are read one at a time
            ({data.threads} OCR thread{data.threads === 1 ? "" : "s"} each); round scores have their own lane and don't wait for them.{" "}
            {data.waited > 0
              ? <><span className="font-mono-hud text-amber-400">{data.waited}</span> read{data.waited === 1 ? "" : "s"} waited a noticeable time for another to finish (longest {secs(data.max_wait_ms)}).</>
              : <>No read had to wait noticeably for another.</>}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm text-slate-100">
              <thead>
                <tr className="text-[10px] font-mono-hud uppercase tracking-wider text-slate-500">
                  <th className="text-left font-normal py-1.5">Read</th>
                  <th className="text-left font-normal py-1.5">Resolution</th>
                  <th className="text-right font-normal py-1.5">Reads</th>
                  <th className="text-right font-normal py-1.5" title="Half of reads were faster than this">Typical</th>
                  <th className="text-right font-normal py-1.5" title="9 in 10 reads were faster than this">Slow (1 in 10)</th>
                  <th className="text-right font-normal py-1.5">Slowest</th>
                  <th className="text-right font-normal py-1.5" title="Typical wait for another read to finish first">Wait</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={`${r.kind}-${r.resolution}`} className="border-t border-[#1B2438]" data-testid={`ocr-speed-${r.kind}-${r.resolution}`}>
                    <td className="py-1.5">{KIND[r.kind] || r.kind}</td>
                    <td className="py-1.5 text-slate-300">{r.resolution}</td>
                    <td className="py-1.5 text-right font-mono-hud">{r.reads}{r.failed > 0 && <span className="text-[#FF2E55]"> ({r.failed} failed)</span>}</td>
                    <td className={`py-1.5 text-right font-mono-hud font-bold ${speedClass(r.kind, r.median_ms)}`}>{secs(r.median_ms)}</td>
                    <td className={`py-1.5 text-right font-mono-hud ${speedClass(r.kind, r.p90_ms)}`}>{secs(r.p90_ms)}</td>
                    <td className="py-1.5 text-right font-mono-hud text-slate-400">{secs(r.max_ms)}</td>
                    <td className="py-1.5 text-right font-mono-hud text-slate-400">{secs(r.median_wait_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.slowest.length > 0 && (
            <div>
              <div className="text-[10px] font-mono-hud uppercase tracking-wider text-slate-500 mb-1.5">Slowest recent reads</div>
              <ul className="space-y-1 text-sm">
                {data.slowest.map((d, i) => (
                  <li key={i} className="flex flex-wrap gap-x-2 text-slate-300">
                    <span className="text-slate-500">{new Date(d.at).toLocaleString()}</span>
                    <span>{KIND[d.kind] || d.kind} · {SOURCE[d.source] || d.source} · {d.width && d.height ? `${d.width}×${d.height}` : d.resolution}</span>
                    <span className="font-mono-hud">{secs(d.run_ms)}{d.wait_ms >= 250 && <span className="text-amber-400"> + {secs(d.wait_ms)} waiting</span>}</span>
                    {!d.ok && <span className="text-[#FF2E55]">failed</span>}
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
