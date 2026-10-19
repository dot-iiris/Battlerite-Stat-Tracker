import { useCallback, useEffect, useState } from "react";
import api from "@/api";
import { toast } from "sonner";
import { CheckCircle2, Link2, XCircle } from "lucide-react";
import OcrAccuracy from "@/components/OcrAccuracy";
import OcrSpeed from "@/components/OcrSpeed";

export default function Pending() {
  const [links, setLinks] = useState([]);

  const load = useCallback(async () => {
    const lr = await api.get("/link-requests");
    setLinks(lr.data);
  }, []);

  useEffect(() => { load(); }, [load]);

  const decide = async (req, approve) => {
    try {
      await api.post(`/link-requests/${req.id}/decision`, { approve });
      toast.success(approve ? `Linked ${req.discord_name} to ${req.player_name}` : "Request denied");
      load();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed");
    }
  };

  return (
    <div className="space-y-8" data-testid="pending-page">
      <div>
        <div className="text-xs font-mono-hud uppercase tracking-[0.3em] text-cyan-400/70 mb-2">// Discord Inbox</div>
        <h1 className="font-heading text-4xl sm:text-5xl font-black uppercase tracking-tight">Pending</h1>
        <p className="text-sm text-slate-400 mt-2">Players who log in with Discord and ask to be linked to a player wait here for an admin.</p>
      </div>

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 font-heading text-xl font-black uppercase"><Link2 className="w-5 h-5 text-cyan-400" /> Discord link requests</h2>
        {links.length === 0 ? (
          <div className="text-sm text-slate-500">No link requests waiting.</div>
        ) : links.map((r) => (
          <div key={r.id} className="hud-card p-4 flex flex-wrap items-center gap-3">
            <span className="font-semibold">{r.discord_name}</span>
            <span className="text-slate-500 text-sm">wants to be</span>
            <span className="font-semibold text-cyan-400">{r.player_name}</span>
            {r.new_player && (
              <span className="text-[10px] font-mono-hud uppercase tracking-wider px-1.5 py-0.5 border border-amber-400/50 text-amber-400 rounded" title="No player with this name yet - approving creates them">new player</span>
            )}
            <span className="text-xs text-slate-500">{new Date(r.created_at).toLocaleString()}</span>
            <div className="flex-1" />
            <button onClick={() => decide(r, false)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono-hud uppercase border border-[#1B2438] hover:border-[#FF2E55] hover:text-[#FF2E55] rounded"><XCircle className="w-3.5 h-3.5" /> Deny</button>
            <button onClick={() => decide(r, true)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono-hud uppercase bg-cyan-400 text-black font-bold rounded"><CheckCircle2 className="w-3.5 h-3.5" /> Approve</button>
          </div>
        ))}
      </section>

      <OcrAccuracy />
      <OcrSpeed />
    </div>
  );
}
