// Shared rank/tier definitions used across Leaderboard, PlayerProfile, and badges.
// Highest-first ordering for easy iteration from top rank.
export const TIERS = [
  { name: "Champion",    min: 1800, max: null, color: "text-[#FF2E55]", border: "border-[#FF2E55]", bg: "bg-[#FF2E55]/10",
    desc: "The absolute ceiling. Legend-tier operators." },
  { name: "Grandmaster", min: 1600, max: 1799, color: "text-[#FFB800]", border: "border-[#FFB800]", bg: "bg-[#FFB800]/10",
    desc: "Elite consistency. Rare air near the top." },
  { name: "Diamond",     min: 1450, max: 1599, color: "text-cyan-400",  border: "border-cyan-400",  bg: "bg-cyan-400/10",
    desc: "Advanced players — well above the pack." },
  { name: "Platinum",    min: 1300, max: 1449, color: "text-slate-200", border: "border-slate-300", bg: "bg-slate-300/10",
    desc: "Sharp fundamentals, climbing fast." },
  { name: "Gold",        min: 1150, max: 1299, color: "text-yellow-400",border: "border-yellow-400",bg: "bg-yellow-400/10",
    desc: "Solid competitive baseline. Everyone starts here at 1200 MMR." },
  { name: "Silver",      min: 0,    max: 1149, color: "text-slate-400", border: "border-slate-400", bg: "bg-slate-400/10",
    desc: "New players." },
];

export const tierFor = (mmr) =>
  TIERS.find((x) => mmr >= x.min) || TIERS[TIERS.length - 1];
