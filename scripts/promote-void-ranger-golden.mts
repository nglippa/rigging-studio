import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { LocalProjectStore } from "../mcp/storage/localProjectStore";
import type { GeneratedCharacterProject } from "../src/character-generation/project/generatedCharacterProject";
import type { RigDefinition } from "../src/rigging/schema/types";

const ROOT = path.resolve(process.cwd());
const OUTPUT = path.join(ROOT, "tests/fixtures/golden/void-ranger");
const SOURCE = "public/assets/generated/void-ranger-sprite.png";
const PROJECT_ID = "character-void-ranger-golden-v1";
const FIXTURE_TIMESTAMP = "2026-08-22T12:00:00.000Z";
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const loaded = await new LocalProjectStore({ cwd: ROOT }).load(PROJECT_ID);
if (!loaded.snapshot.project || !loaded.snapshot.rig || !loaded.snapshot.animations) throw new Error("The durable Void Ranger is not complete");
if (loaded.snapshot.project.partCutterState?.parts.length !== 16 || loaded.snapshot.animations.animations.length !== 4) throw new Error("The durable Void Ranger does not meet the golden contract");

const rig: RigDefinition = {
  ...structuredClone(loaded.snapshot.rig),
  attachments: loaded.snapshot.rig.attachments.map((attachment) => ({ ...attachment, imagePath: `/${SOURCE}#${attachment.id}` })),
  metadata: { ...loaded.snapshot.rig.metadata, fixture: "void-ranger-v1", generatedAt: FIXTURE_TIMESTAMP },
};
const compactImage = (image: NonNullable<GeneratedCharacterProject["sourceImage"]>) => ({ ...image, image: `/${SOURCE}` });
const project: GeneratedCharacterProject = {
  ...structuredClone(loaded.snapshot.project),
  id: "golden-void-ranger-v1",
  rigDefinition: rig,
  skins: rig.skins,
  sourceImage: compactImage(loaded.snapshot.project.sourceImage!),
  generationHistory: loaded.snapshot.project.generationHistory.map(compactImage),
  partCutterState: {
    ...loaded.snapshot.project.partCutterState!,
    parts: loaded.snapshot.project.partCutterState!.parts.map((part) => ({ ...part, mask: { width: 1, height: 1, alpha: [255] }, notes: ["Golden semantic mask sentinel; production mask remains in the editable disk project."] })),
    updatedAt: FIXTURE_TIMESTAMP,
  },
  segmentationData: loaded.snapshot.project.segmentationData ? {
    ...loaded.snapshot.project.segmentationData,
    parts: loaded.snapshot.project.segmentationData.parts.map((part) => ({ ...part, mask: { width: 1, height: 1, alpha: [255] }, fixtureImagePath: `/${SOURCE}` })),
  } : undefined,
  extractedParts: [],
  createdAt: FIXTURE_TIMESTAMP,
  updatedAt: FIXTURE_TIMESTAMP,
};
const animations = { ...structuredClone(loaded.snapshot.animations), rigId: rig.id, metadata: { ...loaded.snapshot.animations.metadata, fixture: "void-ranger-v1" } };
const sourceBytes = await readFile(path.join(ROOT, SOURCE));
const requiredBones = ["root", "pelvis", "torso", "head", "left-upper-arm", "left-lower-arm", "left-hand", "right-upper-arm", "right-lower-arm", "right-hand", "left-upper-leg", "left-lower-leg", "left-foot", "right-upper-leg", "right-lower-leg", "right-foot"];
const expectedContract = {
  fixtureVersion: 1,
  source: { path: SOURCE, width: 1024, height: 1536, sha256: createHash("sha256").update(sourceBytes).digest("hex"), requiresTransparentAlpha: true },
  project: { name: "Void Ranger", stage: "edit", valid: true, partCount: 16, cuttingMode: "manual" },
  requiredSemanticTypes: ["head", "torso", "leftUpperArm", "leftForearm", "leftHand", "rightUpperArm", "rightForearm", "rightHand", "leftThigh", "leftLowerLeg", "leftFoot", "rightThigh", "rightLowerLeg", "rightFoot", "cape", "mainHandEquipment"],
  requiredBones,
  equipment: { cape: { attachmentId: "cape", boneId: "torso" }, energyBlade: { attachmentId: "main-hand-energy-blade", boneId: "right-hand" } },
  animations: ["Game Idle", "Game Walk", "Game Run", "Game Attack"],
  rotationChecksDegrees: [-20, 0, 20],
};
const manifest = {
  fixtureFormat: "rig-studio-golden-project",
  fixtureVersion: 1,
  id: "void-ranger-v1",
  name: "Void Ranger",
  source: SOURCE,
  files: { project: "project.json", rig: "rig.json", animations: "animations.json", expectedContract: "expected-contract.json" },
  provenance: { provider: "imagegen", originalProjectId: PROJECT_ID, promotedAfter: ["prepare-restart", "setup-restart", "animate-restart", "clean-profile-reopen", "zip-round-trip"] },
};

await mkdir(OUTPUT, { recursive: true });
await Promise.all([
  writeFile(path.join(OUTPUT, "manifest.json"), json(manifest)),
  writeFile(path.join(OUTPUT, "project.json"), json(project)),
  writeFile(path.join(OUTPUT, "rig.json"), json(rig)),
  writeFile(path.join(OUTPUT, "animations.json"), json(animations)),
  writeFile(path.join(OUTPUT, "expected-contract.json"), json(expectedContract)),
]);
process.stdout.write(`${json({ output: OUTPUT, files: Object.values(manifest.files), source: SOURCE, partCount: project.partCutterState?.parts.length, animationCount: animations.animations.length })}`);
