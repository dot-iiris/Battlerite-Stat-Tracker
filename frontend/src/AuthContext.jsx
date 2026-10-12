import { createContext, useContext, useEffect, useState } from "react";
import api from "@/api";

const AuthContext = createContext(null);

const GUEST_KEY = "arena_guest_mode";
const GUEST_USER = { id: "guest", email: "guest@public", name: "Guest", role: "guest" };
const VIEW_AS_USER_KEY = "brstats_view_as_user";   // admins previewing the site as a player

const readFlag = (k) => { try { return localStorage.getItem(k) === "1"; } catch { return false; } };
const writeFlag = (k, on) => { try { on ? localStorage.setItem(k, "1") : localStorage.removeItem(k); } catch { /* private mode */ } };

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null); // null = loading, false = anonymous
  const [loading, setLoading] = useState(true);
  const [viewAsUser, setViewAsUserState] = useState(() => readFlag(VIEW_AS_USER_KEY));
  const setViewAsUser = (on) => { writeFlag(VIEW_AS_USER_KEY, on); setViewAsUserState(on); };

  useEffect(() => {
    api.get("/auth/me")
      .then((res) => setUser(res.data))
      .catch(() => {
        // Fallback to previously-chosen guest mode
        if (typeof window !== "undefined" && localStorage.getItem(GUEST_KEY) === "1") {
          setUser(GUEST_USER);
        } else {
          setUser(false);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const login = async (email, password) => {
    const { data } = await api.post("/auth/login", { email, password });
    localStorage.removeItem(GUEST_KEY);
    setUser(data);
    return data;
  };

  const enterGuestMode = () => {
    localStorage.setItem(GUEST_KEY, "1");
    setUser(GUEST_USER);
    return GUEST_USER;
  };

  const logout = async () => {
    const wasGuest = user?.role === "guest";
    if (!wasGuest) {
      try {
        await api.post("/auth/logout");
      } catch (err) {
        console.warn("Logout request failed:", err?.message);
      }
    }
    localStorage.removeItem(GUEST_KEY);
    setUser(false);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        login,
        enterGuestMode,
        logout,
        setUser,
        // isAdmin drives what the site shows; while an admin is "viewing as user" it's false.
        // The server still checks the real role, so nothing is weakened by this.
        isAdmin: user?.role === "admin" && !viewAsUser,
        isRealAdmin: user?.role === "admin",
        viewAsUser: user?.role === "admin" && viewAsUser,
        setViewAsUser,
        isGuest: user?.role === "guest",
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
