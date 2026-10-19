import { Suspense, lazy, useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider, useAuth } from "@/AuthContext";
import Layout from "@/components/Layout";
import { PAGE_LOADERS, preloadAllPagesWhenIdle } from "@/pageLoaders";

const Login = lazy(PAGE_LOADERS["/login"]);
const Dashboard = lazy(PAGE_LOADERS["/"]);
const LogMatch = lazy(PAGE_LOADERS["/log"]);
const Matches = lazy(PAGE_LOADERS["/matches"]);
const Leaderboard = lazy(PAGE_LOADERS["/leaderboard"]);
const Players = lazy(PAGE_LOADERS["/players"]);
const PlayerProfile = lazy(PAGE_LOADERS["/players/:id"]);
const Matrix = lazy(PAGE_LOADERS["/matrix"]);
const ChampionMatrix = lazy(PAGE_LOADERS["/champions"]);
const ChampionProfile = lazy(PAGE_LOADERS["/champions/:name"]);
const Matchmaking = lazy(PAGE_LOADERS["/matchmaking"]);
const Recap = lazy(PAGE_LOADERS["/recap"]);
const Seasons = lazy(PAGE_LOADERS["/seasons"]);
const Settings = lazy(PAGE_LOADERS["/settings"]);
const BalanceCheck = lazy(PAGE_LOADERS["/balance-check"]);
const Tournament = lazy(PAGE_LOADERS["/tournament"]);
const Tournaments = lazy(PAGE_LOADERS["/tournaments"]);
const TournamentView = lazy(PAGE_LOADERS["/tournaments/:id"]);
const TournamentStream = lazy(PAGE_LOADERS["/stream/tournament/:id"]);
const Pending = lazy(PAGE_LOADERS["/pending"]);
const MyProfile = lazy(PAGE_LOADERS["/me"]);

// shown for the moment a page's code is still downloading
const PageLoading = () => (
  <div className="py-24 text-center text-cyan-400/70 font-mono-hud text-xs uppercase tracking-[0.3em]">Loading…</div>
);

function Protected({ children, adminOnly }) {
  const { user, loading, isAdmin } = useAuth();
  if (loading || user === null) {
    return (
      <div className="min-h-screen bg-[#06080E] flex items-center justify-center text-cyan-400 font-mono-hud text-sm uppercase tracking-[0.3em]">
        Loading Terminal…
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  if (adminOnly && !isAdmin) return <Navigate to="/" replace />;
  return <Layout><Suspense fallback={<PageLoading />}>{children}</Suspense></Layout>;
}

function App() {
  useEffect(() => { preloadAllPagesWhenIdle(); }, []);
  return (
    <AuthProvider>
      <BrowserRouter>
        <Toaster theme="dark" richColors position="top-right" />
        <Suspense fallback={<PageLoading />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<Protected><Dashboard /></Protected>} />
          <Route path="/matches" element={<Protected><Matches /></Protected>} />
          <Route path="/log" element={<Protected adminOnly><LogMatch /></Protected>} />
          <Route path="/pending" element={<Protected adminOnly><Pending /></Protected>} />
          <Route path="/me" element={<Protected><MyProfile /></Protected>} />
          <Route path="/leaderboard" element={<Protected><Leaderboard /></Protected>} />
          <Route path="/players" element={<Protected><Players /></Protected>} />
          <Route path="/players/:id" element={<Protected><PlayerProfile /></Protected>} />
          <Route path="/matrix" element={<Protected><Matrix /></Protected>} />
          <Route path="/champions" element={<Protected><ChampionMatrix /></Protected>} />
          <Route path="/champions/:name" element={<Protected><ChampionProfile /></Protected>} />
          <Route path="/matchmaking" element={<Protected><Matchmaking /></Protected>} />
          <Route path="/recap" element={<Protected><Recap /></Protected>} />
          <Route path="/seasons" element={<Protected><Seasons /></Protected>} />
          <Route path="/settings" element={<Protected adminOnly><Settings /></Protected>} />
          <Route path="/balance-check" element={<Protected adminOnly><BalanceCheck /></Protected>} />
          <Route path="/tournament" element={<Protected adminOnly><Tournament /></Protected>} />
          <Route path="/tournaments" element={<Protected adminOnly><Tournaments /></Protected>} />
          <Route path="/tournaments/:id" element={<Protected adminOnly><TournamentView /></Protected>} />
          {/* stream overlays: no login (the link carries the tournament's stream key), no menus */}
          <Route path="/stream/tournament/:id" element={<TournamentStream />} />
        </Routes>
        </Suspense>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
