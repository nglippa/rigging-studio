import { safeParseAnimationJson, safeParseRigJson } from "../schema/parsing";
import type { AnimationDefinition, RigDefinition } from "../schema/types";
import { failure, type ValidationResult } from "../validation/issues";

export type TextFetcher = (url: string) => Promise<{ readonly ok: boolean; readonly status: number; text(): Promise<string> }>;
const browserFetch: TextFetcher = (url) => fetch(url);

async function loadText(url: string, fetcher: TextFetcher): Promise<ValidationResult<string>> {
  try {
    const response = await fetcher(url);
    if (!response.ok) return failure("Asset", [{ code: "http_error", path: [], message: `Could not load "${url}" (HTTP ${response.status})` }]);
    return { success: true, data: await response.text() };
  } catch (error: unknown) {
    return failure("Asset", [{ code: "network_error", path: [], message: error instanceof Error ? error.message : `Could not load "${url}"` }]);
  }
}

export async function loadRigDefinition(url: string, fetcher = browserFetch): Promise<ValidationResult<RigDefinition>> {
  const result = await loadText(url, fetcher);
  return result.success ? safeParseRigJson(result.data) : result;
}
export async function loadAnimationDefinition(url: string, rig?: RigDefinition, fetcher = browserFetch): Promise<ValidationResult<AnimationDefinition>> {
  const result = await loadText(url, fetcher);
  return result.success ? safeParseAnimationJson(result.data, rig) : result;
}
