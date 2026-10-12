import { useEffect, useState } from "react";
import api from "@/api";
import { toast } from "sonner";
import { X, Save, Unlink, GitMerge } from "lucide-react";
import PlayerMmrEditor from "@/components/PlayerMmrEditor";

const inputCls = "w-full bg-[#121828] border border-[#1B2438] focus:border-cyan-400 focus:outline-none rounded px-3 py-2 text-sm";
const labelCls = "block text-xs font-mono-hud uppercase tracking-[0.2em] text-cyan-400/80 mb-1.5";

// Admin: rename a player, set their in-game name, and link / change / remove their Discord account.
export default function EditPlayerDialog({ player, players = [], onClose, onSaved, onMmrChanged }) {
  const [name, setName] = useState(player.name);
  const [ign, setIgn] = useState(player.ign || "");
  const [accounts, setAccounts] = useState([]);
  const [discordId, setDiscordId] = useState(player.discord_id || "");
  const [manual, setManual] = useState(false);
  const [mergeId, setMergeId] = useState("");
  const [preview, setPreview] = useState(null);

  const previewMerge = async (id) => {
    setMergeId(id);
    setPreview(null);
    if (!id) return;
    try {
      const { data } = await api.post("/admin/players/merge", { source_id: id, target_id: player.id, dry_run: true });
      setPreview(data);
    } catch (err) {
      setPreview({ error: err?.response?.data?.detail || "Can't merge these players" });
    }
  };

  const doMerge = async () => {
    if (!window.confirm(`Merge ${preview.source} into ${player.name}? ${preview.source} will be removed. This can't be undone.`)) return;
    setBusy(true);
    try {
      await api.post("/admin/players/merge", { source_id: mergeId, target_id: player.id });
      toast.success(`${preview.source} merged into ${player.name}`);
      onSaved();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Merge failed");
    } finally {
      setBusy(false);
    }
  };
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get("/admin/discord-accounts").then((r) => setAccounts(r.data)).catch(() => {});
  }, []);

  const chosen = accounts.find((a) => a.discord_id === discordId);
  const takenBy = chosen?.linked_player_id && chosen.linked_player_id !== player.id ? chosen.linked_player : null;
  const linkChanged = (discordId || "") !== (player.discord_id || "");

  const save = async (e) => {
    e.preventDefault();
    if (takenBy && !window.confirm(`That Discord account is linked to ${takenBy}. Move the link to ${name}? ${takenBy} will be unlinked.`)) return;
    setBusy(true);
    try {
      await api.patch(`/players/${player.id}`, { name, ign });
      if (linkChanged) {
        await api.put(`/players/${player.id}/discord`, {
          discord_id: discordId.trim() || null,
          discord_name: chosen?.discord_name || null,
          move: !!takenBy,
        });
      }
      toast.success("Player updated");
      onSaved();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Couldn't save");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-start sm:items-center justify-center p-4 overflow-y-auto" onClick={onClose} data-testid="edit-player-dialog">
      <div className="hud-card hud-corner w-full max-w-lg p-6 relative my-8" onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} className="absolute top-3 right-3 text-slate-500 hover:text-white p-1"><X className="w-5 h-5" /></button>
        <h2 className="font-heading text-2xl font-black uppercase tracking-tight mb-4">Edit Player</h2>
        <form onSubmit={save} className="space-y-4">
          <div>
            <label className={labelCls}>Name on the website</label>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={30} required className={inputCls} data-testid="edit-player-name" />
          </div>
          <div>
            <label className={labelCls}>In-game name (optional)</label>
            <input value={ign} onChange={(e) => setIgn(e.target.value)} maxLength={40} placeholder="Only if different - helps read screenshots" className={inputCls} data-testid="edit-player-ign" />
          </div>
          <div>
            <label className={labelCls}>Discord account</label>
            <select value={manual ? "__manual" : discordId}
              onChange={(e) => {
                const v = e.target.value;
                setManual(v === "__manual");
                setDiscordId(v === "__manual" ? "" : v);
              }}
              className={inputCls} data-testid="edit-player-discord">
              <option value="">Not linked</option>
              {accounts.map((a) => (
                <option key={a.discord_id} value={a.discord_id}>
                  @{a.discord_name || a.discord_id}
                  {a.display_name && a.display_name !== a.discord_name ? ` (${a.display_name})` : ""}
                  {a.linked_player ? (a.linked_player_id === player.id ? " · this player" : ` · linked to ${a.linked_player}`) : ""}
                </option>
              ))}
              <option value="__manual">Enter a Discord user ID…</option>
            </select>
            {manual && (
              <input value={discordId} onChange={(e) => setDiscordId(e.target.value.replace(/\D/g, ""))} autoFocus
                placeholder="Discord user ID (right-click user > Copy User ID)" className={`${inputCls} mt-2 font-mono-hud`} data-testid="edit-player-discord-id" />
            )}
            <div className="text-[11px] text-slate-500 mt-1.5">
              The list shows accounts that have logged in with Discord or used /link. Players are linked automatically when they log in with Discord.
            </div>
            {takenBy && <div className="text-xs text-amber-400 mt-1">Saving moves this Discord account from {takenBy} to this player.</div>}
            {player.discord_id && (
              <button type="button" onClick={() => { setManual(false); setDiscordId(""); }} className="mt-2 flex items-center gap-1.5 text-xs font-mono-hud uppercase text-slate-400 hover:text-[#FF2E55]">
                <Unlink className="w-3.5 h-3.5" /> Unlink Discord
              </button>
            )}
          </div>
          <div className="pt-3 border-t border-[#1B2438]">
            <PlayerMmrEditor player={player} onChanged={onMmrChanged} />
          </div>
          <div className="pt-3 border-t border-[#1B2438]">
            <label className={labelCls}>Merge a duplicate into this player</label>
            <select value={mergeId} onChange={(e) => previewMerge(e.target.value)} className={inputCls} data-testid="merge-source">
              <option value="">Choose the duplicate player…</option>
              {players.filter((p) => p.id !== player.id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {preview?.error && <div className="text-xs text-[#FF2E55] mt-2">{preview.error}</div>}
            {preview && !preview.error && (
              <div className="mt-2 text-xs text-slate-300 space-y-1 bg-[#121828]/60 border border-[#1B2438] rounded p-3" data-testid="merge-preview">
                <div>{preview.source_matches} match{preview.source_matches === 1 ? "" : "es"} from <b>{preview.source}</b> move to <b>{preview.target}</b> ({preview.target_matches} already). All match and champion stats combine; <b>{preview.source}</b> is then removed.</div>
                {preview.seasons.map((s) => (
                  <div key={s.season_id}>MMR in {s.season}: keeps <b className="text-cyan-400">{s.mmr_kept_from}</b>'s (played more recently)</div>
                ))}
                <div className="text-slate-500">Discord: {preview.discord}</div>
                <button type="button" onClick={doMerge} disabled={busy}
                  className="mt-2 flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono-hud uppercase font-bold rounded bg-amber-400 text-black disabled:opacity-60" data-testid="merge-confirm">
                  <GitMerge className="w-3.5 h-3.5" /> Merge into {player.name}
                </button>
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-3 border-t border-[#1B2438]">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm font-mono-hud uppercase border border-[#1B2438] rounded hover:border-slate-400">Cancel</button>
            <button type="submit" disabled={busy} className="btn-glow bg-cyan-400 hover:bg-cyan-300 text-black font-mono-hud font-bold uppercase tracking-wider px-4 py-2 rounded flex items-center gap-2 disabled:opacity-60" data-testid="edit-player-save">
              <Save className="w-4 h-4" strokeWidth={3} /> {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
