import { useEffect, useState } from "react";
import api from "@/api";
import { toast } from "sonner";
import { Settings2, RotateCcw, X, Plus, Bot } from "lucide-react";
import { Switch } from "@/components/ui/switch";

// Settings admins can change without a redeploy. A saved value replaces the .env value until it's
// reset; secrets (tokens, passwords, webhooks) are only ever in the .env files.

const input = "bg-[#121828] border border-[#1B2438] focus:border-cyan-400 focus:outline-none rounded px-3 py-2 text-sm";
const chip = "inline-flex items-center gap-1.5 text-xs font-mono-hud px-2 py-1 rounded border border-[#1B2438] bg-[#0C101B]";

const num = (v) => (typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v);

function nameOf(list, id, prefix) {
  const hit = (list || []).find((x) => x.id === String(id));
  return hit ? `${prefix}${hit.name}` : `${prefix}${id}`;
}

function show(row, v, bot) {
  if (v === null || v === undefined) return "unknown";
  switch (row.type) {
    case "bool": return v ? "On" : "Off";
    case "choice": return (row.choices.find(([k]) => k === v) || [v, v])[1];
    case "role": return v ? nameOf(bot?.roles, v, "@") : "Off";
    case "roles": return v.length ? v.map((x) => nameOf(bot?.roles, x, "@")).join(", ") : "None";
    case "channels": return v.length ? v.map((x) => nameOf(bot?.channels, x, "#")).join(", ") : "Any channel";
    case "maps": return `${v.length} map${v.length === 1 ? "" : "s"}`;
    default: return String(num(v));
  }
}

function NumberControl({ row, onSave }) {
  const [draft, setDraft] = useState(String(num(row.value) ?? ""));
  useEffect(() => { setDraft(String(num(row.value) ?? "")); }, [row.value]);
  const dirty = draft !== String(num(row.value) ?? "");
  return (
    <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (dirty) onSave(draft); }}>
      <input type="number" value={draft} min={row.min} max={row.max} step={row.type === "int" ? 1 : "any"}
        onChange={(e) => setDraft(e.target.value)} className={`${input} w-28`} data-testid={`setting-input-${row.key}`} />
      {dirty && (
        <button type="submit" className="text-xs font-mono-hud uppercase text-cyan-400 border border-cyan-400 px-2.5 py-1.5 rounded hover:bg-cyan-400/10"
          data-testid={`setting-save-${row.key}`}>Save</button>
      )}
    </form>
  );
}

function IdListControl({ row, options, prefix, onSave }) {
  // roles / channels: chips, plus a picker of the server's roles or channels (or a typed ID)
  const [typed, setTyped] = useState("");
  const value = row.value || [];
  const left = (options || []).filter((o) => !value.includes(o.id));
  return (
    <div className="flex flex-wrap items-center gap-1.5 justify-end">
      {value.map((id) => (
        <span key={id} className={chip}>
          {nameOf(options, id, prefix)}
          <button type="button" onClick={() => onSave(value.filter((x) => x !== id))} className="text-slate-500 hover:text-[#FF2E55]"
            aria-label="Remove"><X className="w-3 h-3" /></button>
        </span>
      ))}
      {options?.length ? (
        <select value="" onChange={(e) => e.target.value && onSave([...value, e.target.value])} className={`${input} py-1.5`}
          data-testid={`setting-add-${row.key}`}>
          <option value="">+ Add…</option>
          {left.map((o) => <option key={o.id} value={o.id}>{prefix}{o.name}</option>)}
        </select>
      ) : (
        <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) { onSave([...value, typed.trim()]); setTyped(""); } }}>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="ID" className={`${input} w-44 py-1.5`} />
          <button type="submit" className="text-cyan-400"><Plus className="w-4 h-4" /></button>
        </form>
      )}
    </div>
  );
}

// "Mount Araz (Night)" -> ["Mount Araz", "Night"]
function splitMap(m) {
  const hit = /^(.*?)\s*\((Day|Night)\)$/i.exec(m);
  return hit ? [hit[1], hit[2][0].toUpperCase() + hit[2].slice(1).toLowerCase()] : [m, m];
}

function MapsControl({ row, mapNames, onSave }) {
  // one row per arena, with a button for each of its Day / Night versions - lit = in the pool
  const value = row.value || [];
  const have = new Set(value);
  const groups = [];
  for (const m of mapNames) {
    const [base, variant] = splitMap(m);
    let g = groups.find((x) => x.base === base);
    if (!g) groups.push((g = { base, items: [] }));
    g.items.push({ name: m, variant });
  }
  const toggle = (m) => {
    if (have.has(m)) {
      if (value.length > 1) onSave(value.filter((x) => x !== m));
    } else {
      onSave(mapNames.filter((x) => have.has(x) || x === m));
    }
  };
  const btn = (on, last) => `text-xs font-mono-hud uppercase tracking-wider px-2.5 py-1 rounded border transition-colors ${on
    ? "border-cyan-400 bg-cyan-400/15 text-cyan-300 hover:bg-cyan-400/25"
    : "border-[#1B2438] text-slate-500 hover:border-slate-500 hover:text-slate-300"} ${last ? "cursor-not-allowed" : ""}`;
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {groups.map((g) => (
        <div key={g.base} className="flex items-center justify-between gap-3 rounded border border-[#1B2438] bg-[#0C101B] px-3 py-2"
          data-testid={`map-group-${row.key}-${g.base}`}>
          <span className={`text-sm truncate ${g.items.some((i) => have.has(i.name)) ? "text-slate-200" : "text-slate-500"}`}>{g.base}</span>
          <div className="flex gap-1.5 flex-shrink-0">
            {g.items.map(({ name, variant }) => {
              const on = have.has(name);
              const last = on && value.length === 1;
              return (
                <button key={name} type="button" onClick={() => toggle(name)} aria-pressed={on} className={btn(on, last)}
                  title={last ? "Keep at least one map" : `${on ? "Remove" : "Add"} ${name}`} data-testid={`map-toggle-${row.key}-${name}`}>
                  {variant}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function Control({ row, bot, mapNames, onSave }) {
  switch (row.type) {
    case "int":
    case "float":
      return <NumberControl row={row} onSave={onSave} />;
    case "bool":
      return <Switch checked={!!row.value} onCheckedChange={(v) => onSave(v)} data-testid={`setting-switch-${row.key}`}
        className="data-[state=checked]:bg-cyan-400 data-[state=unchecked]:bg-[#1B2438]" />;
    case "choice":
      return (
        <select value={row.value ?? ""} onChange={(e) => onSave(e.target.value)} className={input} data-testid={`setting-select-${row.key}`}>
          {row.choices.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
      );
    case "role":
      return bot?.roles?.length ? (
        <select value={row.value || ""} onChange={(e) => onSave(e.target.value || "off")} className={input} data-testid={`setting-select-${row.key}`}>
          <option value="">Off</option>
          {row.value && !bot.roles.some((r) => r.id === row.value) && <option value={row.value}>Unknown role ({row.value})</option>}
          {bot.roles.map((r) => <option key={r.id} value={r.id}>@{r.name}</option>)}
        </select>
      ) : <NumberLikeText row={row} onSave={onSave} />;
    case "roles":
      return <IdListControl row={row} options={bot?.roles} prefix="@" onSave={onSave} />;
    case "channels":
      return <IdListControl row={row} options={bot?.channels} prefix="#" onSave={onSave} />;
    case "maps":
      return <MapsControl row={row} mapNames={mapNames} onSave={onSave} />;
    default:
      return null;
  }
}

function NumberLikeText({ row, onSave }) {
  // a role ID typed in by hand (before the bot has told the website the server's roles)
  const [draft, setDraft] = useState(row.value || "");
  useEffect(() => { setDraft(row.value || ""); }, [row.value]);
  return (
    <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); onSave(draft.trim() || "off"); }}>
      <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Role ID (empty = off)" className={`${input} w-52`} />
      {draft !== (row.value || "") && <button type="submit" className="text-xs font-mono-hud uppercase text-cyan-400 border border-cyan-400 px-2.5 py-1.5 rounded">Save</button>}
    </form>
  );
}

function SettingRow({ row, bot, mapNames, onSave, onReset }) {
  const wide = row.type === "maps";
  return (
    <div className={`py-4 border-t border-[#1B2438] first:border-t-0 first:pt-0 ${wide ? "space-y-3" : "flex flex-col md:flex-row md:items-start md:justify-between gap-3"}`}
      data-testid={`setting-${row.key}`}>
      <div className="min-w-0 md:max-w-[55%]">
        <div className="font-medium text-sm flex items-center gap-2 flex-wrap">
          {row.label}
          {row.app === "bot" && <span className="text-[9px] font-mono-hud uppercase tracking-wider px-1.5 py-0.5 rounded border border-slate-600 text-slate-400">bot</span>}
          {row.overridden && <span className="text-[9px] font-mono-hud uppercase tracking-wider px-1.5 py-0.5 rounded border border-[#FFB800]/50 text-[#FFB800]">changed</span>}
        </div>
        <div className="text-xs text-slate-400 mt-0.5">{row.help}</div>
        <div className="text-[11px] font-mono-hud text-slate-500 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>Default: {row.default === null || row.default === undefined
            ? (row.app === "bot" ? "shown once the bot connects" : "unknown")
            : row.type === "maps" ? row.default.join(", ") : show(row, row.default, bot)}</span>
          {row.overridden && (
            <>
              <span>Changed by {row.updated_by || "an admin"}{row.updated_at ? ` · ${new Date(row.updated_at).toLocaleString()}` : ""}</span>
              <button onClick={onReset} className="text-cyan-400 hover:text-cyan-300 flex items-center gap-1" data-testid={`setting-reset-${row.key}`}>
                <RotateCcw className="w-3 h-3" /> Reset to default
              </button>
            </>
          )}
        </div>
      </div>
      <div className={wide ? "" : "md:flex-shrink-0 md:max-w-[45%]"}>
        <Control row={row} bot={bot} mapNames={mapNames} onSave={onSave} />
      </div>
    </div>
  );
}

export default function Settings() {
  const [data, setData] = useState(null);

  const load = () => api.get("/admin/settings").then((r) => setData(r.data)).catch(() => toast.error("Couldn't load the settings"));
  useEffect(() => { load(); }, []);

  const replaceRow = (row) => setData((d) => ({ ...d, settings: d.settings.map((x) => (x.key === row.key ? { ...x, ...row } : x)) }));

  const save = async (row, value) => {
    try {
      const { data: saved } = await api.put(`/admin/settings/${row.key}`, { value });
      replaceRow(saved);
      toast.success(`${saved.label}: ${show(saved, saved.value, data.bot)}`);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Couldn't save");
    }
  };

  const reset = async (row) => {
    try {
      const { data: saved } = await api.delete(`/admin/settings/${row.key}`);
      replaceRow(saved);
      toast.success(`${saved.label} is back to its default`);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Couldn't reset");
    }
  };

  return (
    <div className="space-y-6" data-testid="settings-page">
      <div>
        <div className="text-xs font-mono-hud uppercase tracking-[0.3em] text-cyan-400/70 mb-2">// Admin</div>
        <h1 className="font-heading text-4xl sm:text-5xl font-black uppercase tracking-tight flex items-center gap-3">
          <Settings2 className="w-8 h-8 text-cyan-400" /> Settings
        </h1>
        <p className="text-sm text-slate-400 mt-2 max-w-3xl">
          Changes apply straight away{data?.bot ? " - the bot picks them up within a minute" : ""}. A changed setting replaces
          the value in the .env file until it's reset. Tokens, passwords and webhooks are only in the .env files.
        </p>
      </div>

      {data?.bot && !data.bot.seen_at && (
        <div className="hud-card p-4 text-sm text-[#FFB800] flex items-center gap-2" data-testid="settings-bot-missing">
          <Bot className="w-4 h-4" /> The bot hasn't connected since settings were added - its defaults, roles and channels show once it starts.
        </div>
      )}

      {!data ? (
        <div className="hud-card p-12 text-center text-slate-500 font-mono-hud">Loading settings...</div>
      ) : data.groups.map((g) => (
        <section key={g} className="hud-card p-5" data-testid={`settings-group-${g}`}>
          <h2 className="font-heading text-lg font-bold uppercase mb-4">{g}</h2>
          {data.settings.filter((r) => r.group === g).map((r) => (
            <SettingRow key={r.key} row={r} bot={data.bot} mapNames={data.map_names || []}
              onSave={(v) => save(r, v)} onReset={() => reset(r)} />
          ))}
        </section>
      ))}
    </div>
  );
}
