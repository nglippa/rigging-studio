"use client";

import { useRef, useState, type ChangeEvent } from "react";

/** A generation profile as the bridge reports it (GET /image-generation/profiles). */
export type GenerationProfile = {
  readonly id: string; readonly label: string; readonly source: "built-in" | "studio" | "imported"; readonly available: boolean; readonly reason?: string;
  readonly missing: readonly string[]; readonly recommended: boolean; readonly benchRank?: number; readonly benchSummary?: string; readonly benchSeconds?: number;
  readonly bestFor?: string; readonly speed?: string; readonly requires: readonly string[]; readonly nodeClasses: readonly string[];
  readonly params: readonly { readonly name: string; readonly type: string; readonly label?: string; readonly min?: number; readonly max?: number; readonly multiple?: number; readonly default?: string | number | boolean; readonly options?: readonly string[] }[];
};
export type ProfileValues = Readonly<Record<string, string | number | boolean>>;

const plainName = (name: string): string => name.replace(/^lora_/, "LoRA: ").replaceAll("_", " ");

/**
 * Chooses how ComfyUI makes the character: a profile is a model with its LoRAs, ControlNets and custom nodes already
 * wired (Command Center's cc-media-profile format). The benchmark's ranking and notes are shown, and the profile's own
 * settings (LoRA strengths, size, seed) can be tuned. A new profile can be added from a file.
 */
export function ProfilePicker({ profiles, selectedId, values, onSelect, onValues, onImport, loading, error }: {
  readonly profiles: readonly GenerationProfile[]; readonly selectedId: string | null; readonly values: ProfileValues;
  readonly onSelect: (id: string) => void; readonly onValues: (values: ProfileValues) => void; readonly onImport: (profile: unknown) => Promise<void>;
  readonly loading: boolean; readonly error: string | null;
}) {
  const [tuning, setTuning] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const selected = profiles.find((profile) => profile.id === selectedId) ?? null;
  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
    try { await onImport(JSON.parse(await file.text())); setImportMessage(`Added ${file.name}`); }
    catch (reason: unknown) { setImportMessage(reason instanceof Error ? reason.message : "That file is not a profile"); }
  };
  if (loading && !profiles.length) return <div className="profile-picker"><p className="profile-note">Loading the Studio&apos;s profiles…</p></div>;
  if (!profiles.length) return <div className="profile-picker"><p className="profile-note" data-ready="false">{error ?? "No generation profiles found."}</p></div>;
  return <div className="profile-picker">
    <label><span>Style &amp; model</span>
      <select value={selectedId ?? ""} onChange={(event) => onSelect(event.target.value)}>
        {profiles.map((profile) => <option key={profile.id} value={profile.id} disabled={!profile.available && profile.missing.length > 0}>
          {profile.label}{profile.recommended ? " — recommended" : ""}{!profile.available && profile.missing.length ? " — missing files" : ""}
        </option>)}
      </select>
    </label>
    {selected && <p className="profile-note" data-ready={selected.available || !selected.missing.length}>
      {selected.benchSummary ?? selected.bestFor ?? selected.label}
      {selected.benchSeconds ? ` About ${selected.benchSeconds} s per image.` : selected.speed ? ` ${selected.speed}.` : ""}
      {selected.reason ? ` ${selected.reason}` : ""}
    </p>}
    <div className="profile-actions">
      {selected && <button type="button" className="link-button" aria-expanded={tuning} onClick={() => setTuning((value) => !value)}>{tuning ? "Hide settings" : "Tune this profile"}</button>}
      <button type="button" className="link-button" onClick={() => fileRef.current?.click()}>Add a profile…</button>
      <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(event) => void importFile(event)} />
      {importMessage && <small role="status">{importMessage}</small>}
    </div>
    {tuning && selected && <div className="profile-settings">
      {selected.params.map((param) => {
        const value = values[param.name] ?? param.default;
        const set = (next: string | number | boolean) => onValues({ ...values, [param.name]: next });
        if (param.type === "bool") return <label key={param.name} className="profile-setting"><span>{param.label ?? plainName(param.name)}</span><input type="checkbox" checked={Boolean(value)} onChange={(event) => set(event.target.checked)} /></label>;
        if (param.type === "enum" && param.options) return <label key={param.name} className="profile-setting"><span>{param.label ?? plainName(param.name)}</span><select value={String(value ?? "")} onChange={(event) => set(event.target.value)}>{param.options.map((option) => <option key={option}>{option}</option>)}</select></label>;
        const slider = param.type === "float" && param.min !== undefined && param.max !== undefined;
        return <label key={param.name} className="profile-setting"><span>{param.label ?? plainName(param.name)}</span>
          {slider
            ? <span className="profile-slider"><input type="range" min={param.min} max={param.max} step={.05} value={Number(value ?? 0)} onChange={(event) => set(Number(event.target.value))} /><output>{Number(value ?? 0).toFixed(2)}</output></span>
            : <input type="number" min={param.min} max={param.max} step={param.multiple ?? (param.type === "float" ? .05 : 1)} value={value === undefined ? "" : Number(value)} placeholder={param.name === "seed" ? "random" : undefined} onChange={(event) => event.target.value === "" ? onValues(Object.fromEntries(Object.entries(values).filter(([key]) => key !== param.name))) : set(Number(event.target.value))} />}
        </label>;
      })}
      <details className="profile-requires"><summary>What this profile runs</summary>
        <p>Model and LoRA files: {selected.requires.join(", ") || "none listed"}</p>
        <p>ComfyUI nodes: {selected.nodeClasses.join(", ")}</p>
        <p>Source: {selected.source === "built-in" ? "built in (from Command Center's sprite benchmark)" : selected.source === "studio" ? "the Studio's live Command Center profiles" : "added by you"}</p>
      </details>
    </div>}
  </div>;
}
