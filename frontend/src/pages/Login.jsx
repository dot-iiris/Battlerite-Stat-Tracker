import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import api, { API } from "@/api";
import { useAuth } from "@/AuthContext";
import { Zap, Eye } from "lucide-react";
import { toast } from "sonner";

// The email/password (admin) form only shows at /admin-login - a direct link, not linked from the site.
export default function Login({ adminForm = false }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const { login, enterGuestMode } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [discordEnabled, setDiscordEnabled] = useState(false);

  useEffect(() => {
    api.get("/auth/discord/enabled").then((r) => setDiscordEnabled(r.data.enabled)).catch(() => {});
    const err = params.get("discord_error");
    if (err) {
      toast.error(err === "cancelled" ? "Discord login was cancelled" : "Discord login failed - please try again");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await login(email, password);
      toast.success("Access granted");
      nav("/");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  const guest = () => {
    enterGuestMode();
    toast.success("Welcome — exploring as guest");
    nav("/");
  };

  return (
    <div className="min-h-screen bg-[#06080E] flex items-center justify-center p-6 relative overflow-hidden">
      <div className="absolute inset-0 opacity-30 pointer-events-none" style={{ backgroundImage: "radial-gradient(circle at 20% 30%, rgba(0,240,255,0.15), transparent 50%), radial-gradient(circle at 80% 70%, rgba(255,184,0,0.1), transparent 50%)" }} />
      <div className="absolute inset-0 pointer-events-none opacity-[0.03]" style={{ backgroundImage: "linear-gradient(#00F0FF 1px, transparent 1px), linear-gradient(90deg, #00F0FF 1px, transparent 1px)", backgroundSize: "40px 40px" }} />

      <div className="hud-card hud-corner w-full max-w-md p-8 relative z-10 scanlines">
        <div className="flex items-center gap-3 mb-6">
          <img src="/logo.png" alt="BR Stats" className="w-12 h-12 object-contain" />
          <div>
            <div className="font-heading text-2xl font-black uppercase tracking-tight leading-none">BR <span className="text-cyan-400">Stats</span></div>
            <div className="text-[10px] font-mono-hud text-slate-500 uppercase tracking-[0.2em] leading-none mt-1">Access Terminal</div>
          </div>
        </div>

        <div className="mb-6">
          <h1 className="font-heading text-3xl font-black uppercase tracking-tight mb-1">Authenticate</h1>
        </div>

        {discordEnabled && (
          <>
            <a href={`${API}/auth/discord/login`}
              className="w-full flex items-center justify-center gap-2 bg-[#5865F2] hover:bg-[#4752C4] text-white font-mono-hud font-bold uppercase tracking-wider text-sm py-3 rounded transition-colors"
              data-testid="login-discord">
              <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor" aria-hidden="true"><path d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.6 1.3a18.3 18.3 0 0 0-5.6 0L8.6 3a19.7 19.7 0 0 0-4.9 1.5C.6 9.1-.3 13.6.1 18a19.9 19.9 0 0 0 6 3l1.3-2a12.9 12.9 0 0 1-2-1l.5-.4a14.2 14.2 0 0 0 12.2 0l.5.4c-.6.4-1.3.7-2 1l1.3 2a19.8 19.8 0 0 0 6-3c.5-5.1-.8-9.6-3.6-13.6ZM8 15.3c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Zm8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Z"/></svg>
              Log in with Discord
            </a>
            {adminForm && (
              <div className="flex items-center gap-3 my-5">
                <div className="h-px flex-1 bg-[#1B2438]" />
                <span className="text-[10px] font-mono-hud uppercase tracking-[0.25em] text-slate-500">admin login</span>
                <div className="h-px flex-1 bg-[#1B2438]" />
              </div>
            )}
          </>
        )}

        {adminForm && (
        <form onSubmit={submit} className="space-y-4 relative z-10">
          <div>
            <label className="block text-xs font-mono-hud uppercase tracking-[0.2em] text-cyan-400/80 mb-1.5">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-[#121828] border border-[#1B2438] focus:border-cyan-400 focus:outline-none rounded px-3 py-2.5 font-mono-hud text-sm text-slate-100"
              data-testid="login-email"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-mono-hud uppercase tracking-[0.2em] text-cyan-400/80 mb-1.5">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-[#121828] border border-[#1B2438] focus:border-cyan-400 focus:outline-none rounded px-3 py-2.5 font-mono-hud text-sm text-slate-100"
              data-testid="login-password"
              required
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="btn-glow w-full flex items-center justify-center gap-2 bg-cyan-400 hover:bg-cyan-300 text-black font-mono-hud font-bold uppercase tracking-wider text-sm py-3 rounded disabled:opacity-60"
            data-testid="login-submit"
          >
            <Zap className="w-4 h-4" strokeWidth={3} />
            {loading ? "Authenticating..." : "Initiate Session"}
          </button>
        </form>
        )}

        {(discordEnabled || adminForm) && (
          <div className="flex items-center gap-3 my-5">
            <div className="h-px flex-1 bg-[#1B2438]" />
            <span className="text-[10px] font-mono-hud uppercase tracking-[0.25em] text-slate-500">or</span>
            <div className="h-px flex-1 bg-[#1B2438]" />
          </div>
        )}

        <button
          type="button"
          onClick={guest}
          className="group w-full flex items-center justify-center gap-2 bg-[#121828] hover:bg-[#1B2438] border border-cyan-400/30 hover:border-cyan-400 text-cyan-400 font-mono-hud font-bold uppercase tracking-wider text-sm py-3 rounded transition-colors"
          data-testid="guest-show-stats"
        >
          <Eye className="w-4 h-4 group-hover:scale-110 transition-transform" strokeWidth={2.5} />
          Show Me The Stats!
        </button>
      </div>
    </div>
  );
}
