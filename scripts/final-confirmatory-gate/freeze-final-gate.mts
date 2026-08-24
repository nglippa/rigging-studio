import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PNG } from "pngjs";

const ROOT = process.cwd();
const RUN_ID = process.env.RIG_STUDIO_FINAL_GATE_RUN_ID ?? "2026-08-23T15-42-41Z";
const OUT = path.join(ROOT, ".rigging-studio/diagnostics/final-confirmatory-gates", RUN_ID);
const SOURCE_DIR = path.join(OUT, "sources");
const sha = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const definitions = [
  { index: 1, file: "01-desert-duelist.png", name: "Desert Duelist", archetype: "standard humanoid melee", topology: "humanoid", equipment: "curved saber, round buckler", details: "head wrap, asymmetrical shoulder armor" },
  { index: 2, file: "02-iron-bastion.png", name: "Iron Bastion", archetype: "heavy armored humanoid", topology: "humanoid", equipment: "oversized war axe", details: "layered plate and large pauldrons" },
  { index: 3, file: "03-frost-oracle.png", name: "Frost Oracle", archetype: "robed/caped caster", topology: "humanoid", equipment: "crystal staff", details: "split cape, robe panels, long braid" },
  { index: 4, file: "04-rooftop-scout.png", name: "Rooftop Scout", archetype: "thin agile humanoid", topology: "humanoid", equipment: "dual daggers", details: "thin limbs, light jacket and belt accessories" },
  { index: 5, file: "05-jackal-beast.png", name: "Jackal Beast", archetype: "digitigrade creature", topology: "digitigrade", equipment: "unarmed", details: "hocks, paws, tail and long ears" },
  { index: 6, file: "06-gnome-guardian.png", name: "Gnome Guardian", archetype: "short/broad chibi", topology: "custom chibi", equipment: "stone hammer", details: "oversized head, broad torso, tiny limbs" },
  { index: 7, file: "07-crossbow-ranger.png", name: "Crossbow Ranger", archetype: "ranged/two-handed weapon user", topology: "humanoid", equipment: "two-handed crossbow", details: "quiver, capelet, asymmetric shoulder plate" },
  { index: 8, file: "08-dune-sentinel.png", name: "Dune Sentinel", archetype: "asymmetric equipment character", topology: "humanoid", equipment: "crescent shield, hooked blade", details: "left-only pauldron and large offset shield" },
  { index: 9, file: "09-storm-envoy.png", name: "Storm Envoy", archetype: "hair/cape/detail-heavy character", topology: "humanoid", equipment: "ceremonial wand", details: "long braids, feathered split cape, hanging ornaments" },
  { index: 10, file: "10-mycene-knight.png", name: "Mycene Knight", archetype: "visually unusual/extreme chibi silhouette", topology: "extreme chibi", equipment: "wooden club", details: "single eye, mushroom-cap helmet, tiny limbs" },
] as const;

async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(target) : [target];
  }));
  return nested.flat();
}

const sourceRecords = [];
for (const definition of definitions) {
  const filePath = path.join(SOURCE_DIR, definition.file);
  const bytes = await readFile(filePath);
  const image = PNG.sync.read(bytes);
  let transparentPixels = 0;
  let opaquePixels = 0;
  let foregroundPixels = 0;
  for (let index = 3; index < image.data.length; index += 4) {
    const alpha = image.data[index]!;
    if (alpha === 0) transparentPixels += 1;
    if (alpha === 255) opaquePixels += 1;
    if (alpha > 8) foregroundPixels += 1;
  }
  const corners = [3, (image.width - 1) * 4 + 3, (image.height - 1) * image.width * 4 + 3, (image.width * image.height - 1) * 4 + 3].map((index) => image.data[index]);
  sourceRecords.push({
    ...definition,
    sha256: sha(bytes),
    width: image.width,
    height: image.height,
    alpha: true,
    transparentBackground: transparentPixels > image.width * image.height * .2 && corners.every((value) => value === 0),
    transparentPixels,
    opaquePixels,
    foregroundPixels,
    representativeSourceAccepted: image.width >= 512 && image.height >= 512 && foregroundPixels > image.width * image.height * .08,
    priorTuningUse: false,
    noveltyBasis: "Generated as a new one-off source for this frozen gate; hash absent from pre-gate projects and named tuning fixtures.",
  });
}

const productionRoots = ["app", "src", "mcp"];
const productFiles = (await Promise.all(productionRoots.map((root) => filesBelow(path.join(ROOT, root))))).flat()
  .filter((file) => !/\.(map|tsbuildinfo)$/.test(file))
  .sort();
const supportingFiles = ["package.json", "package-lock.json", "tsconfig.json"].map((file) => path.join(ROOT, file));
const fileDigests = [];
for (const file of [...productFiles, ...supportingFiles]) fileDigests.push({ file: path.relative(ROOT, file), sha256: sha(await readFile(file)) });
const productionTreeSha256 = sha(fileDigests.map((entry) => `${entry.file}\0${entry.sha256}`).join("\n"));
const goldenPath = path.join(ROOT, ".rigging-studio/projects/void-ranger--character-void-ranger-golden-v1/project.json");

const freeze = {
  runId: RUN_ID,
  frozenAt: new Date().toISOString(),
  gateCharacterOneStarted: false,
  productionAlgorithmsFrozen: true,
  allowedMidGateChanges: "evaluation harness only; product behavior must remain byte-identical",
  gitHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
  gitStatusAtFreeze: execFileSync("git", ["status", "--porcelain=v1"], { cwd: ROOT, encoding: "utf8" }).trim().split("\n").filter(Boolean),
  productionTreeSha256,
  productFileCount: fileDigests.length,
  productFileDigests: fileDigests,
  voidRangerSha256: sha(await readFile(goldenPath)),
  sourceListFrozen: true,
  sourceSelectionPolicy: "Ten predefined required archetypes generated before execution as one source cohort; no original torture character or Void Ranger included.",
  sources: sourceRecords,
};

if (sourceRecords.length !== 10 || sourceRecords.some((source) => !source.transparentBackground || !source.representativeSourceAccepted)) throw new Error("Source cohort failed quality/alpha freeze checks");
await writeFile(path.join(OUT, "source-manifest.json"), json({ runId: RUN_ID, frozenAt: freeze.frozenAt, sources: sourceRecords }));
await writeFile(path.join(OUT, "algorithm-freeze.json"), json(freeze));
process.stdout.write(json({ runId: RUN_ID, sources: sourceRecords.map(({ index, file, name, sha256, width, height, transparentBackground }) => ({ index, file, name, sha256, width, height, transparentBackground })), productionTreeSha256, productFileCount: fileDigests.length, voidRangerSha256: freeze.voidRangerSha256 }));
