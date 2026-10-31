// A team's players as they're shown everywhere: Melee, then Ranged, then Support (anything else
// last); players with the same role keep the order they were logged in.
const ORDER = { Melee: 0, Ranged: 1, Support: 2 };
const rank = (p) => ORDER[p.role] ?? 3;

export function teamPlayers(players, team) {
  return players.filter((p) => p.team === team).sort((a, b) => rank(a) - rank(b));
}
