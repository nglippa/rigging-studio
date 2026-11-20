"use client";

import type { GenerationProfile } from "./ProfilePicker";

const rankBadge = (profile: GenerationProfile, index: number): string | null => {
  if (profile.benchRank === 1 || (index === 0 && profile.recommended)) return "Best match";
  if (!profile.benchRank) return null;
  const n = profile.benchRank; const suffix = n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th";
  return `${n}${suffix}`;
};

/**
 * The Studio's generation models as cards to click: ranked by Command Center's sprite benchmark (best first), each with
 * what it is good for and roughly how long it takes. A model the Studio can't run is shown but can't be picked.
 */
export function ModelCards({ profiles, selectedId, onSelect, error, loading, onRetry }: {
  readonly profiles: readonly GenerationProfile[]; readonly selectedId: string | null; readonly onSelect: (id: string) => void;
  readonly error?: string | null; readonly loading?: boolean; readonly onRetry?: () => void;
}) {
  if (!profiles.length && error) return <div className="model-cards" role="status">
    <p className="panel-note">The Mac Studio isn&apos;t reachable, so its models can&apos;t be listed.</p>
    {onRetry && <button type="button" className="panel-button" onClick={onRetry}>Retry</button>}
  </div>;
  if (!profiles.length) return <div className="model-cards"><p className="panel-note">{loading ? "Loading the Studio's models…" : "The Studio has no generation models yet."}</p></div>;
  const ranked = [...profiles].sort((a, b) => (a.benchRank ?? Number.POSITIVE_INFINITY) - (b.benchRank ?? Number.POSITIVE_INFINITY) || Number(b.recommended) - Number(a.recommended));
  return <div className="model-cards" role="group" aria-label="Model">
    {ranked.map((profile, index) => {
      const usable = profile.available || !profile.missing.length;
      const badge = usable ? rankBadge(profile, index) : profile.missing.length ? "Model missing" : null;
      const time = profile.benchSeconds ? `about ${profile.benchSeconds} s` : profile.speed;
      const subtitle = !usable ? profile.missing.length ? "Install it from Command Center" : profile.reason ?? "Not available on the Studio" : [profile.bestFor, time].filter(Boolean).join(" · ");
      return <button key={profile.id} type="button" className="choice" aria-pressed={profile.id === selectedId} disabled={!usable}
        title={usable ? undefined : subtitle} aria-description={usable ? undefined : subtitle} onClick={() => onSelect(profile.id)}>
        <span className="choice-head"><span>{profile.label}</span>{badge && <span className={`choice-badge${usable ? "" : " is-warn"}`}>{badge}</span>}</span>
        {subtitle && <small>{subtitle}</small>}
      </button>;
    })}
  </div>;
}
