import { Link, NavLink, useNavigate } from "react-router-dom";
import { prefetchPage } from "@/api";
import { useAuth } from "@/AuthContext";
import { EyeOff, ShieldCheck, Swords, Trophy, Users, Grid3x3, Sliders, Calendar, LayoutDashboard, PlusCircle, LogOut, Flame, FileBarChart2, Eye, Inbox, UserCircle, Settings2, Shuffle, Award, Scale } from "lucide-react";

const links = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, testid: "nav-dashboard" },
  { to: "/matches", label: "Matches", icon: Swords, testid: "nav-matches" },
  { to: "/log", label: "Log Match", icon: PlusCircle, testid: "nav-log", adminOnly: true },
  { to: "/pending", label: "Pending", icon: Inbox, testid: "nav-pending", adminOnly: true },
  { to: "/leaderboard", label: "Leaderboard", icon: Trophy, testid: "nav-leaderboard" },
  { to: "/players", label: "Players", icon: Users, testid: "nav-players" },
  { to: "/matrix", label: "PvP Matrix", icon: Grid3x3, testid: "nav-matrix" },
  { to: "/champions", label: "Champions", icon: Flame, testid: "nav-champions" },
  { to: "/matchmaking", label: "Matchmaking", icon: Sliders, testid: "nav-matchmaking" },
  { to: "/recap", label: "Recap", icon: FileBarChart2, testid: "nav-recap" },
  { to: "/seasons", label: "Seasons", icon: Calendar, testid: "nav-seasons" },
  { to: "/tournaments", label: "Tournaments", icon: Award, testid: "nav-tournaments", adminOnly: true },   // admin preview for now
  { to: "/tournament", label: "Make Teams", icon: Shuffle, testid: "nav-tournament", adminOnly: true },
  { to: "/balance-check", label: "Balance Check", icon: Scale, testid: "nav-balance-check", adminOnly: true },
  { to: "/settings", label: "Settings", icon: Settings2, testid: "nav-settings", adminOnly: true },
];

export default function Layout({ children }) {
  const { user, logout, isAdmin, isGuest, isRealAdmin, viewAsUser, setViewAsUser } = useAuth();
  const nav = useNavigate();

  const visibleLinks = links.filter((l) => (!l.adminOnly || isAdmin) && (!l.discordOnly || user?.discord_id));
  const mainLinks = visibleLinks.filter((l) => !l.adminOnly);
  const adminLinks = visibleLinks.filter((l) => l.adminOnly);

  const tab = (l) => (
    <NavLink
      key={l.to}
      to={l.to}
      end={l.to === "/"}
      data-testid={l.testid}
      onMouseEnter={() => prefetchPage(l.to, { isAdmin })}
      onFocus={() => prefetchPage(l.to, { isAdmin })}
      onTouchStart={() => prefetchPage(l.to, { isAdmin })}
      className={({ isActive }) =>
        `flex items-center gap-2 px-4 py-3 text-xs font-mono-hud uppercase tracking-wider whitespace-nowrap border-b-2 transition-colors ${
          isActive
            ? "text-cyan-400 border-cyan-400"
            : "text-slate-400 border-transparent hover:text-slate-100"
        }`
      }
    >
      <l.icon className="w-3.5 h-3.5" />
      {l.label}
    </NavLink>
  );

  return (
    <div className="min-h-screen bg-[#06080E] text-slate-100 flex flex-col">
      <header className="sticky top-0 z-30 backdrop-blur-xl bg-[#06080E]/80 border-b border-[#1B2438]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between h-16">
          <div className="flex items-center gap-3">
            <img src="/logo.png" alt="BR Stats" className="w-8 h-8 object-contain" />
            <div>
              <div className="font-heading text-lg font-black uppercase tracking-tight leading-none">BR <span className="text-cyan-400">Stats</span></div>
              <div className="text-[10px] font-mono-hud text-slate-500 uppercase tracking-[0.2em] leading-none mt-0.5">Battlerite Tracker</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!isGuest && user?.discord_id ? (
              // My profile: goes straight to your player page (or to linking, if not linked yet)
              <Link to="/me" title="My profile" data-testid="nav-me"
                onMouseEnter={() => prefetchPage("/me")} onFocus={() => prefetchPage("/me")}
                className="flex items-center gap-1.5 px-2 py-1 rounded font-mono-hud text-xs text-slate-300 hover:text-cyan-400 border border-transparent hover:border-[#1B2438] transition-colors">
                <UserCircle className="w-4 h-4" />
                <span className="hidden sm:inline max-w-[10rem] truncate">{user.name}</span>
              </Link>
            ) : !isGuest && user?.email && (
              <span className="hidden md:inline font-mono-hud text-xs text-slate-400" data-testid="nav-user-email">{user.email}</span>
            )}
            {isRealAdmin ? (
              // admins: switch between the admin view and what players see
              <button type="button" onClick={() => setViewAsUser(!viewAsUser)} data-testid="nav-view-as-user"
                title={viewAsUser ? "Back to the admin view" : "See the site the way players do"}
                className={`text-[10px] font-mono-hud uppercase tracking-wider px-2 py-0.5 border rounded flex items-center gap-1 transition-colors ${
                  viewAsUser ? "text-cyan-400 border-cyan-400/40 bg-cyan-400/10 hover:border-[#FFB800]/60"
                  : "text-[#FFB800] border-[#FFB800]/50 bg-[#FFB800]/10 hover:bg-[#FFB800]/20"
                }`}>
                {viewAsUser ? <><Eye className="w-3 h-3" /> player view</> : <><ShieldCheck className="w-3 h-3" /> admin</>}
              </button>
            ) : user?.role && (
              <span
                className={`text-[10px] font-mono-hud uppercase tracking-wider px-2 py-0.5 border rounded flex items-center gap-1 ${
                  isAdmin ? "text-[#FFB800] border-[#FFB800]/50 bg-[#FFB800]/10"
                  : isGuest ? "text-slate-300 border-slate-500/50 bg-slate-500/10"
                  : "text-cyan-400 border-cyan-400/40 bg-cyan-400/10"
                }`}
                data-testid="nav-user-role"
              >
                {isGuest && <Eye className="w-3 h-3" />} {user.role}
              </span>
            )}
            <button
              onClick={async () => { await logout(); nav("/login"); }}
              className="flex items-center gap-2 px-3 py-1.5 text-xs font-mono-hud uppercase tracking-wider text-slate-300 border border-[#1B2438] hover:border-crimson-500 hover:text-[#FF2E55] rounded transition-colors"
              data-testid="nav-logout"
            >
              <LogOut className="w-3.5 h-3.5" /> {isGuest ? "Exit" : "Logout"}
            </button>
          </div>
        </div>
        <nav className="border-t border-[#1B2438]">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-wrap gap-x-1">
            {mainLinks.map(tab)}
          </div>
        </nav>
        {viewAsUser && (
          <div className="border-t border-[#FFB800]/30 bg-[#FFB800]/[0.06]" data-testid="view-as-user-banner">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-1.5 flex items-center justify-between gap-3 text-xs font-mono-hud">
              <span className="text-[#FFB800]/90 flex items-center gap-1.5"><Eye className="w-3.5 h-3.5" /> Viewing as a player - admin tools are hidden</span>
              <button type="button" onClick={() => setViewAsUser(false)} className="uppercase tracking-wider text-[#FFB800] hover:text-white flex items-center gap-1">
                <ShieldCheck className="w-3.5 h-3.5" /> Back to admin view
              </button>
            </div>
          </div>
        )}
        {adminLinks.length > 0 && (
          <nav className="border-t border-[#1B2438] bg-[#FFB800]/[0.03]" data-testid="nav-admin">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-wrap items-center gap-x-1">
              <span className="pr-2 text-[10px] font-mono-hud uppercase tracking-[0.2em] text-[#FFB800]/70">Admin</span>
              {adminLinks.map(tab)}
              <button type="button" onClick={() => setViewAsUser(true)} data-testid="nav-admin-view-as-user"
                className="ml-auto flex items-center gap-1.5 px-3 py-3 text-xs font-mono-hud uppercase tracking-wider text-slate-500 hover:text-slate-200">
                <EyeOff className="w-3.5 h-3.5" /> View as user
              </button>
            </div>
          </nav>
        )}
      </header>
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>
    </div>
  );
}
