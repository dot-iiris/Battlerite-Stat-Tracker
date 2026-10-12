import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "@/AuthContext";
import { Swords, Trophy, Users, Grid3x3, Sliders, Calendar, LayoutDashboard, PlusCircle, LogOut, Flame, FileBarChart2, Eye, Inbox, UserCircle } from "lucide-react";

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
  { to: "/me", label: "My Profile", icon: UserCircle, testid: "nav-me", discordOnly: true },
];

export default function Layout({ children }) {
  const { user, logout, isAdmin, isGuest } = useAuth();
  const nav = useNavigate();

  const visibleLinks = links.filter((l) => (!l.adminOnly || isAdmin) && (!l.discordOnly || user?.discord_id));

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
            {!isGuest && user?.email && (
              <span className="hidden md:inline font-mono-hud text-xs text-slate-400" data-testid="nav-user-email">{user.discord_id ? user.name : user.email}</span>
            )}
            {user?.role && (
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
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex gap-1 overflow-x-auto">
            {visibleLinks.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.to === "/"}
                data-testid={l.testid}
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
            ))}
          </div>
        </nav>
      </header>
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>
    </div>
  );
}
