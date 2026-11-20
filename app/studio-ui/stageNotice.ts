/**
 * A one-line note carried from one stage to the next across a page change (for example "this character has no rig
 * yet" when Rig sends the user back to Parts). Kept in sessionStorage because query parameters are stripped on load.
 */
export const STAGE_NOTICE_KEY = "rig-studio:stage-notice:v1";

/** How long a note taken on arrival is still handed out: a page can mount twice while its project loads. */
const HOLD_MS = 8000;
let held: { readonly text: string; readonly at: number } | null = null;

/** Reads the waiting note (and clears it from storage); the same note is returned for a few seconds after arrival. */
export function takeStageNotice(now = Date.now()): string | null {
  try {
    const notice = window.sessionStorage.getItem(STAGE_NOTICE_KEY);
    if (notice) { window.sessionStorage.removeItem(STAGE_NOTICE_KEY); held = { text: notice, at: now }; return notice; }
  } catch { /* storage blocked: only the held note, if any */ }
  return held && now - held.at < HOLD_MS ? held.text : null;
}
