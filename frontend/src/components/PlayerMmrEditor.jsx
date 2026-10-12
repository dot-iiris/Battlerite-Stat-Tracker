import { useCallback, useEffect, useState } from "react";
import api from "@/api";
import { toast } from "sonner";
import { Gauge, Undo2 } from "lucide-react";

const inputCls = "w-full bg-[#121828] border border-[#1B2438] focus:border-cyan-400 focus:outline-none rounded px-3 py-2 text-sm";
const labelCls = "block text-xs font-mono-hud uppercase tracking-[0.2em] text-cyan-400/80 mb-1.5";

const signed = (n) => `${n > 0 ? "+" : ""}${Math.round(n * 10) / 10}`;

// Admin: set or nudge a player's MMR in a ranked season. Adjustments are kept as
// their own records, so they survive recalculations and can be undone.
export default function PlayerMmrEditor({ player, onChanged }) {
  const [data, setData] = useState(null);
  const [seasonId, setSeasonId] = useState("");
  const [mode, setMode] = useState("set");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data: d } = await api.get(`/admin/players/${player.id}/mmr`);
    setData(d);
    setSeasonId((cur) => cur || (d.seasons.find((s) => s.active) || d.seasons[0] || {}).season_id || "");
  }, [player.id]);

  useEffect(() => { load().catch(() => setData({ seasons: [], adjustments: [] })); }, [load]);

  if (!data) return <div className="text-xs text-slate-500">Loading MMR…</div>;
  if (!data.seasons.length) return <div className="text-xs text-slate-500">No ranked seasons yet.</div>;

  const season = data.seasons.find((s) => s.season_id === seasonId);
  const num = value === "" ? null : Number(value);
  const valid = num !== null && Number.isFinite(num) && (mode === "add" ? num !== 0 : num >= 0);
  const result = !valid || !season ? null : mode === "set" ? num : season.mmr + num;

  const apply = async () => {
    setBusy(true);
    try {
      const body = { season_id: seasonId, reason, ...(mode === "set" ? { set_to: num } : { delta: num }) };
      const { data: a } = await api.post(`/admin/players/${player.id}/mmr`, body);
      toast.success(`${player.name}: ${Math.round(a.mmr_before)} → ${Math.round(a.mmr_after)} MMR`);
      setValue(""); setReason("");
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Couldn't change MMR");
    } finally {
      setBusy(false);
    }
  };

  const undo = async (a) => {
    if (!window.confirm(`Undo the ${signed(a.delta)} MMR change from ${new Date(a.at).toLocaleDateString()}?`)) return;
    try {
      await api.delete(`/admin/mmr-adjustments/${a.id}`);
      toast.success("Adjustment undone");
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Couldn't undo");
    }
  };

  return (
    <div className="space-y-2" data-testid="mmr-editor">
      <label className={labelCls}><Gauge className="inline w-3.5 h-3.5 -mt-0.5 mr-1" />MMR</label>
      <div className="grid grid-cols-2 gap-2">
        <select value={seasonId} onChange={(e) => setSeasonId(e.target.value)} className={inputCls} data-testid="mmr-season">
          {data.seasons.map((s) => (
            <option key={s.season_id} value={s.season_id}>{s.season}{s.active ? " (current)" : ""} · {Math.round(s.mmr)}</option>
          ))}
        </select>
        <div className="flex rounded border border-[#1B2438] overflow-hidden text-xs font-mono-hud uppercase">
          {[["set", "Set to"], ["add", "Add / remove"]].map(([k, l]) => (
            <button key={k} type="button" onClick={() => { setMode(k); setValue(""); }}
              className={`flex-1 px-2 ${mode === k ? "bg-cyan-400 text-black font-bold" : "text-slate-400 hover:text-white"}`}>{l}</button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-[1fr_2fr] gap-2">
        <input type="number" step="1" value={value} onChange={(e) => setValue(e.target.value)}
          placeholder={mode === "set" ? String(Math.round(season?.mmr ?? 1200)) : "e.g. -50"}
          className={`${inputCls} font-mono-hud`} data-testid="mmr-value" />
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200}
          placeholder="Reason (optional)" className={inputCls} data-testid="mmr-reason" />
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-slate-400">
          {result === null ? `Now ${Math.round(season?.mmr ?? 0)} MMR in ${season?.season}.`
            : <>Now {Math.round(season.mmr)} → <b className="text-cyan-400">{Math.round(result)}</b> ({signed(result - season.mmr)})</>}
        </div>
        <button type="button" onClick={apply} disabled={!valid || busy || (result !== null && Math.round(result * 100) === Math.round(season.mmr * 100))}
          className="px-3 py-1.5 text-xs font-mono-hud uppercase font-bold rounded bg-cyan-400 text-black disabled:opacity-40" data-testid="mmr-apply">
          {busy ? "…" : "Apply"}
        </button>
      </div>
      <div className="text-[11px] text-slate-500">Changes the rating from now on. Later matches build on the new number; earlier results stay as they were.</div>
      {data.adjustments.length > 0 && (
        <ul className="text-xs space-y-1 pt-1" data-testid="mmr-adjustments">
          {data.adjustments.map((a) => (
            <li key={a.id} className="flex items-center gap-2 text-slate-300">
              <span className={`font-mono-hud font-bold ${a.delta >= 0 ? "text-[#00E676]" : "text-[#FF2E55]"}`}>{signed(a.delta)}</span>
              <span className="truncate flex-1">
                {a.season} · {new Date(a.at).toLocaleDateString()}{a.by ? ` · ${a.by}` : ""}{a.reason ? ` · ${a.reason}` : ""}
              </span>
              <button type="button" onClick={() => undo(a)} title="Undo" className="text-slate-500 hover:text-white p-0.5"><Undo2 className="w-3.5 h-3.5" /></button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
