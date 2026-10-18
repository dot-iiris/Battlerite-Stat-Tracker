// Each page's code is its own file, downloaded the first time it's needed (then cached by the
// browser). Hovering a menu link starts the download early, and after the first page has loaded
// the rest are fetched quietly in the background.
export const PAGE_LOADERS = {
  "/login": () => import("@/pages/Login"),
  "/": () => import("@/pages/Dashboard"),
  "/matches": () => import("@/pages/Matches"),
  "/log": () => import("@/pages/LogMatch"),
  "/pending": () => import("@/pages/Pending"),
  "/me": () => import("@/pages/MyProfile"),
  "/leaderboard": () => import("@/pages/Leaderboard"),
  "/players": () => import("@/pages/Players"),
  "/players/:id": () => import("@/pages/PlayerProfile"),
  "/matrix": () => import("@/pages/Matrix"),
  "/champions": () => import("@/pages/ChampionMatrix"),
  "/champions/:name": () => import("@/pages/ChampionProfile"),
  "/matchmaking": () => import("@/pages/Matchmaking"),
  "/recap": () => import("@/pages/Recap"),
  "/seasons": () => import("@/pages/Seasons"),
  "/settings": () => import("@/pages/Settings"),
  "/tournament": () => import("@/pages/Tournament"),
  "/tournaments": () => import("@/pages/Tournaments"),
  "/tournaments/:id": () => import("@/pages/TournamentView"),
  "/stream/tournament/:id": () => import("@/pages/TournamentStream"),
};

export function preloadPageCode(path) {
  const load = PAGE_LOADERS[path];
  if (load) load().catch(() => {});   // a failed preload just means it loads on click
}

export function preloadAllPagesWhenIdle() {
  const run = () => Object.keys(PAGE_LOADERS).forEach(preloadPageCode);
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1));
  setTimeout(() => idle(run), 2500);
}
