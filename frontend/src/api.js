import axios from "axios";

import { preloadPageCode } from "@/pageLoaders";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
export const MATCHES_PAGE = 30;   // matches per page on the Matches page
export const API = `${BACKEND_URL}/api`;

const api = axios.create({
  baseURL: API,
  withCredentials: true,
});

// ---- Short-lived cache for GET requests ----
// Lets a page show data instantly when it was prefetched (hovering its tab) or
// fetched a moment ago. Any change (POST/PUT/PATCH/DELETE) empties the cache, so
// nothing stale is shown after an edit.
const CACHE_MS = 15000;
const cache = new Map();

function cacheKey(url, config) {
  const params = config?.params || {};
  const clean = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null)
    .sort()
    .map((k) => [k, String(params[k])]);
  return `${url}?${JSON.stringify(clean)}`;
}

const rawGet = api.get.bind(api);
api.get = (url, config) => {
  const key = cacheKey(url, config);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  const promise = rawGet(url, config);
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.delete(key));
  return promise;
};

const isChange = (cfg) => (cfg?.method || "get").toLowerCase() !== "get";
api.interceptors.request.use((cfg) => {
  if (isChange(cfg)) cache.clear();
  return cfg;
});
api.interceptors.response.use(
  (res) => { if (isChange(res.config)) cache.clear(); return res; },
  (err) => { if (isChange(err.config)) cache.clear(); return Promise.reject(err); },
);

export function clearApiCache() {
  cache.clear();
}

// ---- Prefetch a page's first requests (called when its tab is hovered) ----
// Mirrors the requests each page makes when it opens, so they hit the cache.
const activeSeasonId = async () => {
  const s = await api.get("/seasons");
  return s.data.find((x) => x.active)?.id;
};

const PREFETCH = {
  "/": async () => {
    const sid = await activeSeasonId();
    api.get("/stats/leaderboard", { params: { season_id: sid } });
    api.get("/matches", { params: { season_id: sid } });
    api.get("/players");
    api.get("/stats/recap", { params: { days: 90, season_id: sid } });
  },
  "/matches": async () => {
    api.get("/players");
    api.get("/seasons");
    const { savedSeason } = await import("@/components/SeasonSelect");
    const sid = savedSeason();
    api.get("/matches", { params: { ...(sid ? { season_id: sid } : {}), limit: MATCHES_PAGE, offset: 0 } });
  },
  "/leaderboard": async () => {
    const sid = await activeSeasonId();
    if (sid) api.get("/stats/leaderboard", { params: { season_id: sid } });
  },
  "/players": ({ isAdmin }) => api.get(isAdmin ? "/admin/players" : "/players"),
  "/matrix": () => { api.get("/seasons"); api.get("/stats/matrix", { params: {} }); },
  "/champions": () => { api.get("/seasons"); api.get("/stats/champion-matrix", { params: {} }); },
  "/matchmaking": () => { api.get("/players"); api.get("/seasons"); },
  "/recap": () => { api.get("/seasons"); api.get("/stats/recap", { params: { days: 7 } }); },
  "/seasons": () => api.get("/seasons"),
  "/settings": () => api.get("/admin/settings"),
  "/pending": () => {
    ["/pending-matches", "/link-requests", "/players", "/champions", "/seasons"].forEach((u) => api.get(u));
  },
  "/log": () => { api.get("/seasons"); api.get("/players"); api.get("/champions"); },
  "/me": () => api.get("/me"),
};

export function prefetchPage(path, ctx = {}) {
  preloadPageCode(path);   // the page's code as well as its data
  const fn = PREFETCH[path];
  if (!fn) return;
  Promise.resolve()
    .then(() => fn(ctx))
    .catch(() => {});   // a failed prefetch just means the page loads normally
}

export default api;
