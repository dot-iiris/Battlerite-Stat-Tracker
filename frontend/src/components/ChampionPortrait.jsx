import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { getChampionStats } from "@/lib/championStats";

// Role fallback colors used if the portrait image isn't available
const ROLE_COLORS = {
  Melee:   { from: "#FF4655", to: "#7A1A24", text: "#FFD9DD" },
  Ranged:  { from: "#00F0FF", to: "#003D45", text: "#001519" },
  Support: { from: "#00E676", to: "#0A4021", text: "#001B0C" },
};

const ROLE_RING = {
  Melee: "ring-[#FF4655]/60",
  Ranged: "ring-cyan-400/60",
  Support: "ring-[#00E676]/60",
};

const ROLE_TEXT = {
  Melee: "text-[#FF4655]",
  Ranged: "text-cyan-400",
  Support: "text-[#00E676]",
};

const slugify = (name) => name.toLowerCase().replace(/\s+/g, "-");

function PortraitVisual({ name, role, size, className, failed, onError }) {
  const src = `/portraits/${slugify(name)}.png`;
  const ring = ROLE_RING[role] || ROLE_RING.Melee;

  if (!failed) {
    return (
      <img
        src={src}
        alt={name}
        width={size}
        height={size}
        onError={onError}
        className={`inline-block flex-shrink-0 rounded ring-2 ring-inset ${ring} object-cover bg-[#121828] ${className}`}
        style={{ width: size, height: size }}
        title={`${name} (${role})`}
        loading="lazy"
        data-testid={`champion-portrait-${slugify(name)}`}
      />
    );
  }

  const c = ROLE_COLORS[role] || ROLE_COLORS.Melee;
  const initial = name[0]?.toUpperCase() || "?";
  const second = name[1]?.toLowerCase() || "";
  return (
    <div
      className={`inline-flex items-center justify-center relative flex-shrink-0 ${className}`}
      style={{
        width: size, height: size,
        background: `linear-gradient(135deg, ${c.from} 0%, ${c.to} 100%)`,
        clipPath: "polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)",
      }}
      title={`${name} (${role})`}
      data-testid={`champion-portrait-${slugify(name)}`}
    >
      <span
        className="font-heading font-black leading-none select-none"
        style={{
          color: c.text,
          fontSize: size * 0.48,
          textShadow: "0 1px 2px rgba(0,0,0,0.5)",
          letterSpacing: "-0.02em",
        }}
      >
        {initial}{second}
      </span>
    </div>
  );
}

export default function ChampionPortrait({ name, role, size = 32, className = "", disableHover = false, linkToProfile = true }) {
  const [failed, setFailed] = useState(false);
  const [stats, setStats] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || stats) return;
    let cancelled = false;
    getChampionStats().then((map) => {
      if (!cancelled) setStats(map[name] || { picks: 0, wins: 0, winrate: 0, role });
    });
    return () => { cancelled = true; };
  }, [open, name, role, stats]);

  if (!name) return null;

  const visual = (
    <PortraitVisual
      name={name} role={role} size={size} className={className}
      failed={failed} onError={() => setFailed(true)}
    />
  );

  // Wrap visual in a profile link when requested (default true).
  // Keeps hover-card trigger intact by using asChild → Link below.
  const Wrapper = linkToProfile ? Link : "span";
  const wrapperProps = linkToProfile
    ? { to: `/champions/${encodeURIComponent(name)}`, className: "inline-flex cursor-pointer" }
    : { className: "inline-flex" };

  if (disableHover) {
    return <Wrapper {...wrapperProps}>{visual}</Wrapper>;
  }

  const roleText = ROLE_TEXT[role] || "text-slate-300";

  return (
    <HoverCard openDelay={150} closeDelay={100} onOpenChange={setOpen}>
      <HoverCardTrigger asChild>
        <Wrapper {...wrapperProps}>{visual}</Wrapper>
      </HoverCardTrigger>
      <HoverCardContent
        side="top" align="center"
        className="w-56 bg-[#0C101B] border-[#1B2438] text-slate-100 p-3"
        data-testid={`champion-hover-${slugify(name)}`}
      >
        <div className="flex items-center gap-3">
          <PortraitVisual name={name} role={role} size={48} className="" failed={failed} onError={() => setFailed(true)} />
          <div className="min-w-0">
            <Link to={`/champions/${encodeURIComponent(name)}`} data-testid={`champion-hover-link-${slugify(name)}`}
              className="block font-heading text-base font-black uppercase tracking-tight truncate hover:text-cyan-400 transition-colors">
              {name} <span className="text-cyan-400/70 text-sm">→</span>
            </Link>
            <div className={`text-[10px] font-mono-hud uppercase tracking-[0.2em] ${roleText}`}>{role}</div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 mt-3 text-center">
          <div className="bg-[#121828]/60 border border-[#1B2438] rounded p-2">
            <div className="text-[9px] font-mono-hud uppercase tracking-wider text-slate-500">Picks</div>
            <div className="font-mono-hud text-lg font-black text-cyan-400">{stats?.picks ?? "…"}</div>
          </div>
          <div className="bg-[#121828]/60 border border-[#1B2438] rounded p-2">
            <div className="text-[9px] font-mono-hud uppercase tracking-wider text-slate-500">Winrate</div>
            <div className={`font-mono-hud text-lg font-black ${stats && stats.picks > 0 ? (stats.winrate >= 50 ? "text-[#00E676]" : "text-[#FF2E55]") : "text-slate-400"}`}>
              {stats?.picks ? `${stats.winrate}%` : "—"}
            </div>
          </div>
        </div>
        {stats && stats.picks > 0 && (
          <div className="mt-2 text-[10px] font-mono-hud text-slate-500 text-center">
            {stats.wins}W · {stats.picks - stats.wins}L across all seasons
          </div>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}
