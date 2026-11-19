/**
 * Generation profiles in Command Center's `cc-media-profile/1` format: a complete ComfyUI API graph (its model loaders,
 * LoRA loaders, ControlNets and any custom nodes already wired) plus named params whose values are written into chosen
 * node inputs. A profile is how a model + LoRA/ControlNet + custom-node setup is chosen and tuned without editing graphs.
 *
 * Profiles come from three places, later ones overriding earlier ones with the same id:
 *   1. built in: comfy-workflows/profiles/ (the sprite benchmark winners, copied from Command Center);
 *   2. COMFYUI_PROFILES_DIR: a live profile folder (on the Mac Studio, Command Center's cc-workflows);
 *   3. imported by the user: .rigging-studio/profiles/.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ImageProductionJson } from "../proposals/imageProposal";
import type { ComfyApiWorkflow } from "../workflows/workflowManifest";

const target = z.tuple([z.string().min(1), z.string().min(1)]);
const paramSchema = z.object({
  type: z.enum(["text", "int", "float", "bool", "enum", "image"]),
  label: z.string().optional(), required: z.boolean().optional(),
  min: z.number().optional(), max: z.number().optional(), multiple: z.number().optional(), max_len: z.number().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(), options: z.array(z.string()).optional(),
  targets: z.array(target).min(1),
}).passthrough();
const nodeSchema = z.object({ class_type: z.string().min(1), inputs: z.record(z.string(), z.unknown()) }).passthrough();
export const ccMediaProfileSchema = z.object({
  schema: z.literal("cc-media-profile/1"),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/), label: z.string().min(1), kind: z.string(),
  hints: z.record(z.string(), z.unknown()).optional(),
  requires: z.array(z.object({ folder: z.string(), file: z.string() }).passthrough()).optional(),
  params: z.record(z.string(), paramSchema),
  output: z.object({ node: z.string().min(1) }).passthrough(),
  graph: z.record(z.string(), nodeSchema),
}).passthrough();
export type CcMediaProfile = z.infer<typeof ccMediaProfileSchema>;
export type ProfileParam = z.infer<typeof paramSchema>;
export type ProfileSource = "built-in" | "studio" | "imported";
export type LoadedProfile = { readonly profile: CcMediaProfile; readonly source: ProfileSource; readonly file: string };

/**
 * What the sprite benchmark (Command Center, BENCH-sprites-and-print-20261117, characters) found for each profile, shown
 * to the user when choosing one. Ranked for gameplay characters; the first is the default.
 */
export const PROFILE_GUIDANCE: Readonly<Record<string, { readonly rank: number; readonly summary: string; readonly seconds: number }>> = {
  "klein2-4b-pixel-art": { rank: 1, seconds: 9, summary: "Best all-round pixel-art sprite: full body, plain white background, readable at 64 px." },
  "zimage-pixel-art": { rank: 2, seconds: 18, summary: "Crispest pixel art, but adds a frame or floor shadow about half the time." },
  "klein2-4b": { rank: 3, seconds: 9, summary: "HD 2D (painterly, not pixel art); clean background." },
  "qwen-image-2512-pixel-art": { rank: 4, seconds: 31, summary: "Richest detail and the best monsters; draws people as busts and needs a cut-out." },
};
export const DEFAULT_PROFILE_ID = "klein2-4b-pixel-art";

const BUILT_IN_DIR = path.join(process.cwd(), "comfy-workflows", "profiles");
const IMPORTED_DIR = path.join(process.cwd(), ".rigging-studio", "profiles");

async function readDirectory(directory: string, source: ProfileSource): Promise<LoadedProfile[]> {
  let names: string[];
  try { names = (await readdir(directory)).filter((name) => name.endsWith(".json")); } catch { return []; }
  const loaded: LoadedProfile[] = [];
  for (const name of names) {
    try {
      const parsed = ccMediaProfileSchema.safeParse(JSON.parse(await readFile(path.join(directory, name), "utf8")));
      if (parsed.success && parsed.data.kind === "image") loaded.push({ profile: parsed.data, source, file: path.join(directory, name) });
    } catch { /* unreadable files are skipped */ }
  }
  return loaded;
}

/** A text-to-image profile (makes a character from a description); profiles that take an image (cut-out, edit) do not. */
export const isTextToImage = (profile: CcMediaProfile): boolean => profile.params.prompt?.type === "text" && !Object.values(profile.params).some((param) => param.type === "image");
/** The profile that removes a generated character's background (RMBG-2.0, the cut-out winner of the sprite benchmark). */
export const CUTOUT_PROFILE_ID = "cutout-rmbg2";

/** Every usable generation profile, ranked: benchmark picks first, then by label. */
export async function listProfiles(options: { readonly builtInDir?: string; readonly studioDir?: string | null; readonly importedDir?: string } = {}): Promise<readonly LoadedProfile[]> {
  return (await listAllProfiles(options)).filter((item) => isTextToImage(item.profile));
}

/** Every image profile found, including image-input ones (the cut-out). */
export async function listAllProfiles(options: { readonly builtInDir?: string; readonly studioDir?: string | null; readonly importedDir?: string } = {}): Promise<readonly LoadedProfile[]> {
  const studioDir = options.studioDir === undefined ? process.env.COMFYUI_PROFILES_DIR ?? null : options.studioDir;
  const all = [
    ...await readDirectory(options.builtInDir ?? BUILT_IN_DIR, "built-in"),
    ...(studioDir ? await readDirectory(studioDir, "studio") : []),
    ...await readDirectory(options.importedDir ?? IMPORTED_DIR, "imported"),
  ];
  const byId = new Map<string, LoadedProfile>(); for (const item of all) byId.set(item.profile.id, item);
  const rank = (id: string) => PROFILE_GUIDANCE[id]?.rank ?? 99;
  return [...byId.values()].sort((a, b) => rank(a.profile.id) - rank(b.profile.id) || a.profile.label.localeCompare(b.profile.label));
}

export async function findProfile(id: string, options?: Parameters<typeof listProfiles>[0]): Promise<LoadedProfile> {
  const found = (await listAllProfiles(options)).find((item) => item.profile.id === id);
  if (!found) throw new Error(`Generation profile ${id} was not found`);
  return found;
}

/** Saves a profile the user imported (validated) so it is offered from then on. */
export async function importProfile(input: unknown, importedDir = IMPORTED_DIR): Promise<CcMediaProfile> {
  const parsed = ccMediaProfileSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Not a cc-media-profile/1 image profile: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  if (parsed.data.kind !== "image" || !isTextToImage(parsed.data)) throw new Error("Only text-to-image profiles (a text prompt param and no image input) can generate characters");
  if (!parsed.data.graph[parsed.data.output.node]) throw new Error(`The profile's output node ${parsed.data.output.node} is not in its graph`);
  await mkdir(importedDir, { recursive: true });
  await writeFile(path.join(importedDir, `${parsed.data.id}.json`), `${JSON.stringify(parsed.data, null, 2)}\n`);
  return parsed.data;
}

/** A param's value made safe: right type, within its limits, rounded to its step. Unknown or invalid values use the default. */
export function coerceParam(param: ProfileParam, value: unknown): ImageProductionJson | undefined {
  const fallback = param.default as ImageProductionJson | undefined;
  switch (param.type) {
    case "text": { const text = typeof value === "string" ? value : typeof fallback === "string" ? fallback : undefined; return text === undefined ? undefined : text.slice(0, param.max_len ?? 4000); }
    case "bool": return typeof value === "boolean" ? value : fallback;
    case "enum": return typeof value === "string" && (!param.options || param.options.includes(value)) ? value : fallback;
    case "int": case "float": {
      let number = typeof value === "number" && Number.isFinite(value) ? value : typeof fallback === "number" ? fallback : undefined;
      if (number === undefined) return undefined;
      if (param.min !== undefined) number = Math.max(param.min, number); if (param.max !== undefined) number = Math.min(param.max, number);
      if (param.type === "int") number = Math.round(number);
      if (param.multiple) number = Math.round(number / param.multiple) * param.multiple;
      return number;
    }
    case "image": return typeof value === "string" && value ? value : undefined; // the name of an image already uploaded to the engine
    default: return undefined;
  }
}

/** The profile's graph with every param written into its target node inputs. */
export function bindProfile(profile: CcMediaProfile, values: Readonly<Record<string, unknown>>): ComfyApiWorkflow {
  const graph = structuredClone(profile.graph) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  for (const [name, param] of Object.entries(profile.params)) {
    const value = coerceParam(param, values[name]);
    if (value === undefined) { if (param.required) throw new Error(`Profile ${profile.id} needs ${name}`); continue; }
    for (const [nodeId, field] of param.targets) {
      const node = graph[nodeId]; if (!node) throw new Error(`Profile ${profile.id} is broken: node ${nodeId} is missing`);
      node.inputs[field] = value;
    }
  }
  return graph as unknown as ComfyApiWorkflow;
}

/** Node classes and model files a profile needs, for the engine to check. */
export function profileRequirements(profile: CcMediaProfile): { readonly nodeClasses: readonly string[]; readonly files: readonly string[] } {
  return { nodeClasses: [...new Set(Object.values(profile.graph).map((node) => node.class_type))], files: (profile.requires ?? []).map((item) => item.file) };
}

/** Params a user can tune, for the UI (no node targets). Prompt is filled from the description; image params are not offered. */
export function tunableParams(profile: CcMediaProfile): readonly (Omit<ProfileParam, "targets"> & { readonly name: string })[] {
  return Object.entries(profile.params).filter(([name, param]) => name !== "prompt" && param.type !== "image" && param.type !== "text")
    .map(([name, param]) => { const { targets, ...rest } = param; void targets; return { name, ...rest }; });
}

/**
 * The description prompt adjusted for image models, which cannot draw transparency: asked for a transparent background
 * they paint a fake checkerboard (seen on Klein, and in Command Center's sprite benchmark). A plain white background
 * cuts out cleanly instead.
 */
export function profilePrompt(prompt: string): string {
  return prompt
    .replace(/Output one pose only on a genuinely transparent background[^.]*\./i, "Output one full-body pose only, on a plain white background, with no ground shadow under the feet.")
    .replace(/transparent background/gi, "plain white background")
    .replace(/suitable for transparent extraction/gi, "suitable for clean cut-out");
}
