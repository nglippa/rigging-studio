/**
 * A one-line note carried from one stage to the next across a page change (for example "this character has no rig
 * yet" when Rig sends the user back to Parts). Kept in sessionStorage because query parameters are stripped on load.
 */
export const STAGE_NOTICE_KEY = "rig-studio:stage-notice:v1";

/** Reads and clears the waiting note, if any. */
export function takeStageNotice(): string | null {
  try { const notice = window.sessionStorage.getItem(STAGE_NOTICE_KEY); if (notice) window.sessionStorage.removeItem(STAGE_NOTICE_KEY); return notice; }
  catch { return null; }
}
