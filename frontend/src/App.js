import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider, useAuth } from "@/AuthContext";
import Layout from "@/components/Layout";
import Login from "@/pages/Login";
import Dashboard from "@/pages/Dashboard";
import LogMatch from "@/pages/LogMatch";
import Matches from "@/pages/Matches";
import Leaderboard from "@/pages/Leaderboard";
import Players from "@/pages/Players";
import PlayerProfile from "@/pages/PlayerProfile";
import Matrix from "@/pages/Matrix";
import ChampionMatrix from "@/pages/ChampionMatrix";
import ChampionProfile from "@/pages/ChampionProfile";
import Matchmaking from "@/pages/Matchmaking";
import Recap from "@/pages/Recap";
import Seasons from "@/pages/Seasons";
import Pending from "@/pages/Pending";
import MyProfile from "@/pages/MyProfile";

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
  return <Layout>{children}</Layout>;
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Toaster theme="dark" richColors position="top-right" />
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
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

export default App;
