// Format pills shown above every match list: All (default), 3v3, 2v2
export const FORMATS = [
  { k: "all", label: "All" },
  { k: "3v3", label: "3v3" },
  { k: "2v2", label: "2v2" },
];

export const byFormat = (format) => (m) => format === "all" || m.format === format;

export default function FormatFilter({ value, onChange, testid = "format-filter", small = false }) {
  return (
    <div className="flex gap-1" data-testid={testid}>
      {FORMATS.map((f) => (
        <button key={f.k} type="button" onClick={() => onChange(f.k)} data-testid={`${testid}-${f.k}`}
          className={`${small ? "px-2.5 py-1 text-[10px]" : "px-3 py-2 text-xs"} font-mono-hud uppercase tracking-wider rounded border transition-colors ${
            value === f.k
              ? "bg-cyan-400 text-black border-cyan-400 font-bold"
              : "bg-[#121828] border-[#1B2438] text-slate-300 hover:border-cyan-400/40"
          }`}>
          {f.label}
        </button>
      ))}
    </div>
  );
}

// The match's code, e.g. #S2-3v3-a1f9
export function MatchCode({ match, className = "" }) {
  if (!match?.discord_match_id) return null;
  return <span className={`font-mono-hud text-[10px] tracking-wider text-cyan-400/80 ${className}`}
    title="Match code: season · format · id">#{match.discord_match_id}</span>;
}
