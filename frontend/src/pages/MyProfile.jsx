import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "@/api";
import { toast } from "sonner";
import { Clock, Link2, UserCircle } from "lucide-react";
import StreakBadge from "@/components/StreakBadge";

function avatarUrl(user) {
  if (!user?.discord_id || !user?.discord_avatar) return null;
  return `https://cdn.discordapp.com/avatars/${user.discord_id}/${user.discord_avatar}.png?size=128`;
}

function Stat({ label, value }) {
  return (
    <div className="bg-[#121828]/60 border border-[#1B2438] rounded p-3">
      <div className="text-[10px] font-mono-hud uppercase tracking-[0.2em] text-slate-500">{label}</div>
      <div className="font-mono-hud text-2xl font-black text-slate-100 mt-1">{value}</div>
    </div>
  );
}

export default function MyProfile() {
  const [data, setData] = useState(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get("/me").then((r) => {
      setData(r.data);
      if (!r.data.player) setName(r.data.user?.name || "");
    });
  }, []);

  useEffect(() => { load(); }, [load]);

  const link = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { data: res } = await api.post("/me/link", { player_name: name });
      toast.success(res.linked ? `You're now ${res.player.name} on BR Stats` : `Asked an admin to link you to ${res.link_request.player_name}`);
      load();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Couldn't link");
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <div className="text-slate-400 font-mono-hud">Loading…</div>;
  const { user, player, link_request: req, stats } = data;
  const avatar = avatarUrl(user);

  return (
    <div className="space-y-6 max-w-3xl" data-testid="my-profile-page">
      <div className="flex items-center gap-4">
        {avatar
          ? <img src={avatar} alt="" className="w-16 h-16 rounded-full border border-[#1B2438]" />
          : <UserCircle className="w-16 h-16 text-slate-600" />}
        <div>
          <div className="text-xs font-mono-hud uppercase tracking-[0.3em] text-cyan-400/70 mb-1">// My Profile</div>
          <h1 className="font-heading text-4xl font-black uppercase tracking-tight">{player?.name || user.name}</h1>
          {user.discord_name && <div className="text-xs font-mono-hud text-slate-500">Discord: @{user.discord_name}</div>}
        </div>
      </div>

      {!user.discord_id ? (
        <div className="hud-card p-5 text-sm text-slate-400">
          You're signed in with an admin account. Log in with Discord to get a player profile.
        </div>
      ) : player ? (
        <div className="hud-card p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm text-slate-400">
              Linked to <span className="text-cyan-400 font-semibold">{player.name}</span>
              {player.ign && <> · in-game name <span className="text-slate-200">{player.ign}</span></>}
            </div>
            <Link to={`/players/${player.id}`} className="text-xs font-mono-hud uppercase text-cyan-400 hover:text-cyan-300">Full stats →</Link>
          </div>
          {stats && stats.matches ? (
            <>
              <div className="flex items-center gap-2 text-xs font-mono-hud uppercase tracking-wider text-slate-500">
                {stats.season} <StreakBadge streak={stats.streak} />
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Stat label="Rank" value={`#${stats.rank}`} />
                <Stat label="MMR" value={Math.round(stats.mmr)} />
                <Stat label="Record" value={`${stats.wins}-${stats.losses}`} />
                <Stat label="Winrate" value={`${stats.winrate}%`} />
              </div>
            </>
          ) : (
            <div className="text-sm text-slate-500">No ranked matches this season yet. Jump in with <span className="font-mono-hud text-slate-300">/join</span> in Discord.</div>
          )}
        </div>
      ) : req ? (
        <div className="hud-card p-5 flex items-start gap-3">
          <Clock className="w-5 h-5 text-amber-400 mt-0.5" />
          <div className="text-sm text-slate-300">
            Waiting for an admin to link you to <span className="text-cyan-400 font-semibold">{req.player_name}</span>.
            <div className="text-xs text-slate-500 mt-1">Wrong name? Pick another below - it replaces this request.</div>
          </div>
        </div>
      ) : null}

      {user.discord_id && !player && (
        <form onSubmit={link} className="hud-card p-5 space-y-3">
          <div className="flex items-center gap-2 font-heading text-lg font-black uppercase"><Link2 className="w-4 h-4 text-cyan-400" /> Choose your player</div>
          <p className="text-sm text-slate-400">
            Already on the leaderboard? Enter that exact name and an admin will confirm it's you.
            New here? Pick any name that isn't taken and you're in straight away.
          </p>
          <div className="flex gap-2">
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={30} required
              className="flex-1 bg-[#121828] border border-[#1B2438] focus:border-cyan-400 focus:outline-none rounded px-3 py-2 text-sm"
              placeholder="Player name" data-testid="me-link-name" />
            <button disabled={busy} className="btn-glow bg-cyan-400 hover:bg-cyan-300 text-black font-mono-hud font-bold uppercase tracking-wider px-4 py-2 rounded disabled:opacity-60" data-testid="me-link-submit">
              {busy ? "…" : "Link"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
