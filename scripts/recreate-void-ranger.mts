import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import { LocalProjectStore } from "../mcp/storage/localProjectStore";
import { createGeneratedCharacterProject, type GeneratedCharacterProject } from "../src/character-generation/project/generatedCharacterProject";
import { extractPartPixels, type PixelImage } from "../src/character-generation/segmentation/partImageProcessor";
import { buildRigProposal } from "../src/character-generation/rigging/rigProposalBuilder";
import { runRigSmokeTest } from "../src/character-generation/testing/rigSmokeTest";
import { partCutToSegmentation } from "../src/part-cutter/operations";
import { SEMANTIC_TAXONOMY, type PartSemanticType } from "../src/part-cutter/semanticTaxonomy";
import type { PartCutRecord, PartCutterState } from "../src/part-cutter/schema";
import { AnimationPlayer } from "../src/rigging/animation/AnimationPlayer";
import { computeWorldTransforms } from "../src/rigging/runtime/worldTransforms";
import { RigRuntime } from "../src/rigging/runtime/RigRuntime";
import type { AnimationDefinition, AnimationTrack, Easing, RigDefinition } from "../src/rigging/schema/types";
import { validateRigDefinition } from "../src/rigging/validation/rig";
import { createAnimationLibrary } from "../src/tools/rig-editor/animation/library";
import type { AnimationLibrary } from "../src/tools/rig-editor/animation/types";
import { LOCAL_PROJECT_STORAGE_VERSION, type LocalProjectSnapshot } from "../src/project-storage/types";

const PROJECT_ID = "character-void-ranger-golden-v1";
const SOURCE_ID = "void-ranger-source-imagegen-v1";
const CREATED_AT = "2026-08-22T12:00:00.000Z";
const ROOT = path.resolve(process.cwd());
const SOURCE_PATH = path.join(ROOT, "public/assets/generated/void-ranger-sprite.png");
const ORIGINAL_PROMPT = [
  "Use case: stylized-concept",
  "Asset type: production-ready 2D game character sprite for skeletal rigging",
  "Primary request: create one original pixel-art sci-fi void ranger character, full body, designed for idle, walk, run, and melee attack animation",
  "Scene/backdrop: genuinely transparent background with no floor, shadow, frame, scenery, UI, or sprite-sheet grid",
  "Subject: a compact athletic humanoid ranger facing screen-right in a neutral ready stance; dark indigo armor, electric violet cloth accents, cyan visor and small cyan energy blade; head, torso, upper arms, forearms, hands, upper legs, lower legs, and feet must each have clean readable silhouettes; arms held slightly away from torso and legs slightly separated so joints can be cut and rigged; weapon compact and aligned with the forward hand without covering the body",
  "Style/medium: polished 32-bit-era pixel art, crisp intentional pixel clusters, limited game-ready palette, strong silhouette, controlled highlights, no anti-aliased painterly edges",
  "Composition/framing: one character only, centered, complete body visible with generous transparent padding, consistent side-view platformer perspective",
  "Lighting/mood: subtle cool rim light, energetic neon violet and cyan accents, readable at small gameplay scale",
  "Color palette: near-black navy, indigo, electric violet, cyan, small pale highlights",
  "Constraints: actual transparent alpha; one pose only; no animation frames; no text; no logo; no watermark; no cropped body parts; no detached floating parts; maintain clean joint boundaries and consistent pixel density",
  "Avoid: sprite sheet, multiple characters, background, ground shadow, photorealism, 3D render, smooth vector art, blurry pixels, excessive tiny detail, overlapping limbs, oversized weapon",
].join("\n");

type Point = { readonly x: number; readonly y: number };
type PartSpec = {
  readonly id: string;
  readonly label: string;
  readonly semanticType: PartSemanticType;
  readonly polygon: readonly Point[];
  readonly pivot: Point;
  readonly boneId: string;
  readonly zOrder: number;
  readonly layer: "front" | "body" | "back";
};

const PARTS: readonly PartSpec[] = [
  { id: "cape", label: "Cape", semanticType: "cape", polygon: [{ x: 386, y: 300 }, { x: 462, y: 355 }, { x: 430, y: 495 }, { x: 360, y: 645 }, { x: 275, y: 790 }, { x: 195, y: 870 }, { x: 70, y: 855 }, { x: 62, y: 565 }, { x: 250, y: 430 }, { x: 330, y: 320 }], pivot: { x: 405, y: 330 }, boneId: "torso", zOrder: -30, layer: "back" },
  { id: "right-thigh", label: "Right Thigh", semanticType: "rightThigh", polygon: [{ x: 520, y: 620 }, { x: 650, y: 625 }, { x: 715, y: 760 }, { x: 700, y: 940 }, { x: 625, y: 985 }, { x: 545, y: 900 }, { x: 510, y: 735 }], pivot: { x: 570, y: 675 }, boneId: "pelvis", zOrder: -12, layer: "back" },
  { id: "right-lower-leg", label: "Right Lower Leg", semanticType: "rightLowerLeg", polygon: [{ x: 625, y: 915 }, { x: 720, y: 905 }, { x: 760, y: 1035 }, { x: 758, y: 1245 }, { x: 705, y: 1295 }, { x: 640, y: 1235 }, { x: 615, y: 1050 }], pivot: { x: 672, y: 945 }, boneId: "right-upper-leg", zOrder: -11, layer: "back" },
  { id: "right-foot", label: "Right Foot", semanticType: "rightFoot", polygon: [{ x: 690, y: 1215 }, { x: 770, y: 1215 }, { x: 790, y: 1305 }, { x: 865, y: 1365 }, { x: 865, y: 1430 }, { x: 730, y: 1440 }, { x: 665, y: 1380 }], pivot: { x: 735, y: 1260 }, boneId: "right-lower-leg", zOrder: -10, layer: "back" },
  { id: "left-upper-arm", label: "Left Upper Arm", semanticType: "leftUpperArm", polygon: [{ x: 335, y: 305 }, { x: 430, y: 310 }, { x: 475, y: 405 }, { x: 430, y: 540 }, { x: 340, y: 545 }, { x: 305, y: 430 }], pivot: { x: 395, y: 360 }, boneId: "torso", zOrder: -8, layer: "back" },
  { id: "left-forearm", label: "Left Forearm", semanticType: "leftForearm", polygon: [{ x: 325, y: 485 }, { x: 410, y: 500 }, { x: 385, y: 650 }, { x: 335, y: 760 }, { x: 260, y: 735 }, { x: 270, y: 575 }], pivot: { x: 360, y: 515 }, boneId: "left-upper-arm", zOrder: -7, layer: "back" },
  { id: "left-hand", label: "Left Hand", semanticType: "leftHand", polygon: [{ x: 275, y: 690 }, { x: 335, y: 700 }, { x: 360, y: 790 }, { x: 330, y: 865 }, { x: 265, y: 850 }, { x: 245, y: 765 }], pivot: { x: 300, y: 720 }, boneId: "left-lower-arm", zOrder: -6, layer: "back" },
  { id: "torso", label: "Torso", semanticType: "torso", polygon: [{ x: 415, y: 295 }, { x: 615, y: 300 }, { x: 680, y: 410 }, { x: 675, y: 570 }, { x: 645, y: 705 }, { x: 445, y: 715 }, { x: 395, y: 580 }, { x: 400, y: 400 }], pivot: { x: 535, y: 650 }, boneId: "pelvis", zOrder: 0, layer: "body" },
  { id: "left-thigh", label: "Left Thigh", semanticType: "leftThigh", polygon: [{ x: 380, y: 620 }, { x: 525, y: 620 }, { x: 550, y: 750 }, { x: 510, y: 925 }, { x: 450, y: 990 }, { x: 365, y: 955 }, { x: 350, y: 770 }], pivot: { x: 455, y: 675 }, boneId: "pelvis", zOrder: 2, layer: "body" },
  { id: "left-lower-leg", label: "Left Lower Leg", semanticType: "leftLowerLeg", polygon: [{ x: 370, y: 915 }, { x: 455, y: 920 }, { x: 465, y: 1080 }, { x: 420, y: 1260 }, { x: 350, y: 1300 }, { x: 285, y: 1245 }, { x: 305, y: 1040 }], pivot: { x: 410, y: 955 }, boneId: "left-upper-leg", zOrder: 3, layer: "body" },
  { id: "left-foot", label: "Left Foot", semanticType: "leftFoot", polygon: [{ x: 275, y: 1215 }, { x: 375, y: 1215 }, { x: 415, y: 1320 }, { x: 390, y: 1445 }, { x: 245, y: 1450 }, { x: 230, y: 1370 }], pivot: { x: 325, y: 1260 }, boneId: "left-lower-leg", zOrder: 4, layer: "body" },
  { id: "head", label: "Head", semanticType: "head", polygon: [{ x: 480, y: 70 }, { x: 620, y: 90 }, { x: 680, y: 200 }, { x: 660, y: 355 }, { x: 620, y: 425 }, { x: 480, y: 435 }, { x: 390, y: 345 }, { x: 365, y: 215 }], pivot: { x: 535, y: 350 }, boneId: "torso", zOrder: 6, layer: "body" },
  { id: "right-upper-arm", label: "Right Upper Arm", semanticType: "rightUpperArm", polygon: [{ x: 615, y: 390 }, { x: 680, y: 400 }, { x: 730, y: 505 }, { x: 700, y: 600 }, { x: 635, y: 585 }, { x: 600, y: 480 }], pivot: { x: 640, y: 420 }, boneId: "torso", zOrder: 8, layer: "front" },
  { id: "right-forearm", label: "Right Forearm", semanticType: "rightForearm", polygon: [{ x: 650, y: 535 }, { x: 715, y: 540 }, { x: 785, y: 670 }, { x: 765, y: 735 }, { x: 700, y: 725 }, { x: 640, y: 610 }], pivot: { x: 675, y: 560 }, boneId: "right-upper-arm", zOrder: 9, layer: "front" },
  { id: "right-hand", label: "Right Hand", semanticType: "rightHand", polygon: [{ x: 720, y: 665 }, { x: 790, y: 675 }, { x: 855, y: 730 }, { x: 865, y: 805 }, { x: 790, y: 820 }, { x: 730, y: 765 }], pivot: { x: 750, y: 700 }, boneId: "right-lower-arm", zOrder: 10, layer: "front" },
  { id: "main-hand-energy-blade", label: "Energy Blade", semanticType: "mainHandEquipment", polygon: [{ x: 785, y: 700 }, { x: 855, y: 710 }, { x: 1005, y: 835 }, { x: 1000, y: 885 }, { x: 900, y: 875 }, { x: 805, y: 805 }], pivot: { x: 815, y: 755 }, boneId: "right-hand", zOrder: 12, layer: "front" },
];

const boundsFor = (points: readonly Point[]) => {
  const left = Math.floor(Math.min(...points.map((point) => point.x)));
  const top = Math.floor(Math.min(...points.map((point) => point.y)));
  const right = Math.ceil(Math.max(...points.map((point) => point.x)));
  const bottom = Math.ceil(Math.max(...points.map((point) => point.y)));
  return { x: left, y: top, width: right - left, height: bottom - top };
};

const contains = (point: Point, polygon: readonly Point[]): boolean => {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    if ((currentPoint.y > point.y) !== (previousPoint.y > point.y) && point.x < (previousPoint.x - currentPoint.x) * (point.y - currentPoint.y) / (previousPoint.y - currentPoint.y) + currentPoint.x) inside = !inside;
  }
  return inside;
};

const pngDataUrl = (image: PixelImage): string => {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data);
  return `data:image/png;base64,${PNG.sync.write(png).toString("base64")}`;
};

const loadSource = async () => {
  const bytes = await readFile(SOURCE_PATH);
  const png = PNG.sync.read(bytes);
  if (png.width !== 1024 || png.height !== 1536) throw new Error(`Unexpected source dimensions ${png.width}x${png.height}`);
  const alpha = Array.from({ length: png.width * png.height }, (_, index) => png.data[index * 4 + 3]);
  const transparentPixels = alpha.filter((value) => value === 0).length;
  const translucentPixels = alpha.filter((value) => value > 0 && value < 255).length;
  if (!transparentPixels || !translucentPixels) throw new Error("Source does not contain the expected transparent alpha channel");
  const image: PixelImage = { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
  return { bytes, image, dataUrl: `data:image/png;base64,${bytes.toString("base64")}`, transparentPixels, translucentPixels, sha256: createHash("sha256").update(bytes).digest("hex") };
};

const sourceProject = async (): Promise<GeneratedCharacterProject> => {
  const source = await loadSource();
  const base = createGeneratedCharacterProject("Void Ranger", ORIGINAL_PROMPT, CREATED_AT);
  const sourceImage = {
    generationId: SOURCE_ID,
    image: source.dataUrl,
    width: 1024,
    height: 1536,
    generationPrompt: ORIGINAL_PROMPT,
    generationSettings: { useCase: "stylized-concept", assetType: "2d-game-character", transparentBackground: true },
    providerMetadata: { provider: "imagegen", sourceSha256: source.sha256, recoveredFrom: "public/assets/generated/void-ranger-sprite.png" },
    warnings: [],
    generationMode: "imported_external" as const,
    novelArtwork: true,
    provider: "imagegen",
    sourceArtifact: "public/assets/generated/void-ranger-sprite.png",
  };
  return {
    ...base,
    id: PROJECT_ID,
    stage: "prepare",
    generationPrompt: ORIGINAL_PROMPT,
    generationMetadata: { provider: "imagegen", sourceSha256: source.sha256, durableRecreation: true },
    generationHistory: [sourceImage],
    sourceImage,
    suitability: { usable: true, score: .94, summary: "Surviving source is transparent, full-body, and supports the proven 16-part manual cut.", issues: [] },
    warnings: ["Manual masks intentionally retain modest joint overlap for animation padding."],
  };
};

const prepareProject = async (project: GeneratedCharacterProject): Promise<GeneratedCharacterProject> => {
  const source = await loadSource();
  const records: PartCutRecord[] = [];
  const extractedParts: Array<GeneratedCharacterProject["extractedParts"][number]> = [];
  for (const spec of PARTS) {
    const bounds = boundsFor(spec.polygon);
    const alpha = Array.from({ length: bounds.width * bounds.height }, (_, index) => {
      const x = index % bounds.width;
      const y = Math.floor(index / bounds.width);
      return contains({ x: bounds.x + x + .5, y: bounds.y + y + .5 }, spec.polygon) ? 255 : 0;
    });
    if (!alpha.some(Boolean)) throw new Error(`${spec.label} mask is empty`);
    const mask = { width: bounds.width, height: bounds.height, alpha };
    const extracted = extractPartPixels({ source: source.image, bounds, mask, padding: 0 });
    if (!Array.from({ length: extracted.width * extracted.height }, (_, index) => extracted.data[index * 4 + 3]).some(Boolean)) throw new Error(`${spec.label} extracted asset is empty`);
    records.push({
      partId: spec.id,
      label: spec.label,
      semanticType: spec.semanticType,
      mask,
      boundingBox: bounds,
      sourceBoundingBox: bounds,
      sourceCanvasSize: { width: 1024, height: 1536 },
      pivot: spec.pivot,
      suggestedParent: spec.boneId,
      suggestedSlot: `${spec.id}-slot`,
      zOrder: spec.zOrder,
      layer: spec.layer,
      confidence: 1,
      confidenceSource: "heuristic",
      articulated: SEMANTIC_TAXONOMY[spec.semanticType].articulated,
      equipment: SEMANTIC_TAXONOMY[spec.semanticType].equipment,
      occlusionState: "complete",
      provenance: "manual",
      accepted: true,
      notes: ["Manual source-aligned polygon mask; intentional joint overlap retained."],
    });
    extractedParts.push({ partId: spec.id, image: pngDataUrl(extracted), width: extracted.width, height: extracted.height, padding: 0, status: "accepted" });
  }
  const state: PartCutterState = { stateVersion: 1, sourceImageId: SOURCE_ID, sourceCanvasSize: { width: 1024, height: 1536 }, mode: "manual", parts: records, proposals: [], ignoredRegions: [], finalized: true, updatedAt: new Date().toISOString() };
  return { ...project, stage: "prepare", partCutterState: state, segmentationData: partCutToSegmentation(state), extractedParts, updatedAt: new Date().toISOString() };
};

const setupProject = (project: GeneratedCharacterProject): { readonly project: GeneratedCharacterProject; readonly rig: RigDefinition } => {
  if (!project.partCutterState) throw new Error("Prepare state is missing");
  const images = Object.fromEntries(project.extractedParts.map((part) => [part.partId, part.image]));
  const segmentation = partCutToSegmentation(project.partCutterState);
  const proposal = buildRigProposal({ name: project.name, parts: segmentation.parts, imageWidth: 1024, imageHeight: 1536, resolvedImages: images, partCutterState: project.partCutterState });
  const rig: RigDefinition = { ...proposal.rig, metadata: { ...proposal.rig.metadata, anatomyProfile: "humanoid", sourceAlignedSetup: true, sourceSha256: project.generationMetadata.sourceSha256 ?? "unknown", manualJointOverlap: true } };
  const issues = validateRigDefinition(rig);
  const smoke = runRigSmokeTest(rig);
  if (issues.length || !smoke.passed) throw new Error(`Rig validation failed: ${issues.map((issue) => issue.message).join("; ")} ${smoke.checks.filter((check) => !check.passed).map((check) => check.message).join("; ")}`);
  return { project: { ...project, stage: "rig", rigDefinition: rig, skins: rig.skins, updatedAt: new Date().toISOString() }, rig };
};

const frame = (time: number, value: number, easing: Easing = "easeInOut") => ({ time, value, easing });
const track = (boneId: string, property: AnimationTrack["property"], keyframes: AnimationTrack["keyframes"]): AnimationTrack => ({ boneId, property, keyframes });
const animation = (id: string, name: string, duration: number, loop: boolean, tracks: readonly AnimationTrack[]): AnimationDefinition => ({ schemaVersion: 1, id, name, duration, loop, tracks });

const createAnimations = (rig: RigDefinition): AnimationLibrary => {
  const clips = [
    animation("game-idle", "Game Idle", 1.6, true, [
      track("torso", "y", [frame(0, 0), frame(.8, -5), frame(1.6, 0)]),
      track("head", "rotation", [frame(0, 1), frame(.8, -2), frame(1.6, 1)]),
      track("right-hand", "rotation", [frame(0, 0), frame(.8, 2), frame(1.6, 0)]),
    ]),
    animation("game-walk", "Game Walk", .9, true, [
      track("pelvis", "y", [frame(0, 0), frame(.225, -6), frame(.45, 0), frame(.675, -6), frame(.9, 0)]),
      track("torso", "rotation", [frame(0, 2), frame(.45, -2), frame(.9, 2)]),
      track("left-upper-arm", "rotation", [frame(0, -22), frame(.45, 22), frame(.9, -22)]),
      track("right-upper-arm", "rotation", [frame(0, 22), frame(.45, -22), frame(.9, 22)]),
      track("left-upper-leg", "rotation", [frame(0, 25), frame(.45, -25), frame(.9, 25)]),
      track("right-upper-leg", "rotation", [frame(0, -25), frame(.45, 25), frame(.9, -25)]),
      track("left-lower-leg", "rotation", [frame(0, 5), frame(.225, 30), frame(.45, 5), frame(.9, 5)]),
      track("right-lower-leg", "rotation", [frame(0, 5), frame(.45, 5), frame(.675, 30), frame(.9, 5)]),
      track("left-foot", "rotation", [frame(0, -8), frame(.45, 10), frame(.9, -8)]),
      track("right-foot", "rotation", [frame(0, 10), frame(.45, -8), frame(.9, 10)]),
    ]),
    animation("game-run", "Game Run", .62, true, [
      track("pelvis", "y", [frame(0, 0), frame(.155, -12), frame(.31, 0), frame(.465, -12), frame(.62, 0)]),
      track("torso", "rotation", [frame(0, 7), frame(.31, 3), frame(.62, 7)]),
      track("left-upper-arm", "rotation", [frame(0, -42), frame(.31, 42), frame(.62, -42)]),
      track("right-upper-arm", "rotation", [frame(0, 42), frame(.31, -42), frame(.62, 42)]),
      track("left-upper-leg", "rotation", [frame(0, 43), frame(.31, -43), frame(.62, 43)]),
      track("right-upper-leg", "rotation", [frame(0, -43), frame(.31, 43), frame(.62, -43)]),
      track("left-lower-leg", "rotation", [frame(0, 8), frame(.155, 48), frame(.31, 8), frame(.62, 8)]),
      track("right-lower-leg", "rotation", [frame(0, 8), frame(.31, 8), frame(.465, 48), frame(.62, 8)]),
      track("left-foot", "rotation", [frame(0, -12), frame(.31, 15), frame(.62, -12)]),
      track("right-foot", "rotation", [frame(0, 15), frame(.31, -12), frame(.62, 15)]),
    ]),
    animation("game-attack", "Game Attack", .78, false, [
      track("torso", "rotation", [frame(0, 0, "easeOut"), frame(.14, -9, "easeIn"), frame(.38, 14, "easeOut"), frame(.78, 0)]),
      track("right-upper-arm", "rotation", [frame(0, 0, "easeOut"), frame(.14, 35, "easeIn"), frame(.38, -62, "easeOut"), frame(.78, 0)]),
      track("right-lower-arm", "rotation", [frame(0, 0, "easeOut"), frame(.14, 28, "easeIn"), frame(.38, -48, "easeOut"), frame(.78, 0)]),
      track("right-hand", "rotation", [frame(0, 0, "easeOut"), frame(.14, 18, "easeIn"), frame(.38, -25, "easeOut"), frame(.78, 0)]),
      track("left-upper-arm", "rotation", [frame(0, 0), frame(.38, 12), frame(.78, 0)]),
      track("pelvis", "x", [frame(0, 0), frame(.38, 10, "easeOut"), frame(.78, 0)]),
    ]),
  ];
  return { ...createAnimationLibrary(rig.id, clips), metadata: { authoringIntent: "Void Ranger game-ready baseline", playbackTested: true, sourceAlignedRig: true } };
};

const snapshot = (project: GeneratedCharacterProject, rig: RigDefinition | null = project.rigDefinition ?? null, animations: AnimationLibrary | null = null): LocalProjectSnapshot => ({
  storageVersion: LOCAL_PROJECT_STORAGE_VERSION,
  localProjectId: PROJECT_ID,
  project,
  rig,
  animations,
  selectedSkinId: rig?.defaultSkinId ?? null,
});

const verifyRotationAnchors = (rig: RigDefinition): void => {
  const major = ["left-upper-arm", "right-upper-arm", "left-upper-leg", "right-upper-leg"];
  for (const boneId of major) for (const angle of [-20, 0, 20]) {
    const runtime = new RigRuntime(rig);
    runtime.updateBonePose(boneId, { rotation: angle });
    const world = computeWorldTransforms(rig, runtime.getPose());
    const target = world[boneId];
    if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y)) throw new Error(`${boneId} failed ${angle} degree world-transform test`);
    const slot = rig.slots.find((candidate) => candidate.boneId === boneId);
    const attachment = slot ? rig.attachments.find((candidate) => candidate.id === slot.attachmentId) : undefined;
    if (!slot || !attachment || slot.pivotX < 0 || slot.pivotY < 0 || slot.pivotX > attachment.width || slot.pivotY > attachment.height) throw new Error(`${boneId} attachment pivot failed at ${angle} degrees`);
  }
};

const verifyAnimations = (rig: RigDefinition, library: AnimationLibrary): void => {
  const boneIds = new Set(rig.bones.map((bone) => bone.id));
  for (const clip of library.animations) {
    if (clip.tracks.some((candidate) => !boneIds.has(candidate.boneId))) throw new Error(`${clip.name} targets a missing bone`);
    const runtime = new RigRuntime(rig);
    const player = new AnimationPlayer(runtime);
    player.play(clip);
    player.update(Math.min(.2, clip.duration / 3));
    player.seek(clip.duration * .66);
    if (player.currentTime < 0 || player.currentTime > clip.duration) throw new Error(`${clip.name} playback failed`);
  }
};

const store = new LocalProjectStore({ cwd: ROOT });
const command = process.argv[2] ?? "verify";

if (command === "source") {
  const project = await sourceProject();
  const result = await store.save(snapshot(project, null, null));
  const reloaded = await new LocalProjectStore({ cwd: ROOT }).load(PROJECT_ID);
  if (!reloaded.snapshot.project?.sourceImage?.image.startsWith("data:image/png;base64,")) throw new Error("Durable source reload failed");
  process.stdout.write(`${JSON.stringify({ command, result, source: await loadSource() }, (key, value) => key === "bytes" || key === "image" || key === "dataUrl" ? undefined : value, 2)}\n`);
} else if (command === "prepare") {
  const loaded = await new LocalProjectStore({ cwd: ROOT }).load(PROJECT_ID);
  if (!loaded.snapshot.project) throw new Error("Source project was not restored from disk");
  const project = await prepareProject(loaded.snapshot.project);
  const result = await store.save(snapshot(project, null, null), { expectedModifiedAt: loaded.summary.modifiedAt });
  const milestone = await store.exportSnapshot(PROJECT_ID);
  const reloaded = await new LocalProjectStore({ cwd: ROOT }).load(PROJECT_ID);
  if (reloaded.snapshot.project?.partCutterState?.parts.length !== 16 || reloaded.snapshot.project.extractedParts.length !== 16) throw new Error("Prepare restart verification failed");
  process.stdout.write(`${JSON.stringify({ command, result, milestone, parts: project.partCutterState?.parts.map((part) => part.label) }, null, 2)}\n`);
} else if (command === "setup") {
  const loaded = await new LocalProjectStore({ cwd: ROOT }).load(PROJECT_ID);
  if (!loaded.snapshot.project) throw new Error("Prepared project was not restored from disk");
  const built = setupProject(loaded.snapshot.project);
  verifyRotationAnchors(built.rig);
  const result = await store.save(snapshot(built.project, built.rig, null), { expectedModifiedAt: loaded.summary.modifiedAt });
  const milestone = await store.exportSnapshot(PROJECT_ID);
  const reloaded = await new LocalProjectStore({ cwd: ROOT }).load(PROJECT_ID);
  if (!reloaded.snapshot.rig || validateRigDefinition(reloaded.snapshot.rig).length) throw new Error("Setup restart verification failed");
  process.stdout.write(`${JSON.stringify({ command, result, milestone, smoke: runRigSmokeTest(built.rig), bones: built.rig.bones.map((bone) => bone.id) }, null, 2)}\n`);
} else if (command === "animate") {
  const loaded = await new LocalProjectStore({ cwd: ROOT }).load(PROJECT_ID);
  if (!loaded.snapshot.project || !loaded.snapshot.rig) throw new Error("Setup project was not restored from disk");
  const animations = createAnimations(loaded.snapshot.rig);
  verifyAnimations(loaded.snapshot.rig, animations);
  const project = { ...loaded.snapshot.project, stage: "edit" as const, updatedAt: new Date().toISOString() };
  const result = await store.save(snapshot(project, loaded.snapshot.rig, animations), { expectedModifiedAt: loaded.summary.modifiedAt });
  const milestone = await store.exportSnapshot(PROJECT_ID);
  const reloaded = await new LocalProjectStore({ cwd: ROOT }).load(PROJECT_ID);
  if (reloaded.snapshot.animations?.animations.length !== 4) throw new Error("Animate restart verification failed");
  verifyAnimations(reloaded.snapshot.rig!, reloaded.snapshot.animations);
  process.stdout.write(`${JSON.stringify({ command, result, milestone, animations: animations.animations.map((clip) => ({ name: clip.name, duration: clip.duration, tracks: clip.tracks.length })) }, null, 2)}\n`);
} else if (command === "verify") {
  const loaded = await new LocalProjectStore({ cwd: ROOT }).load(PROJECT_ID);
  if (!loaded.snapshot.project || !loaded.snapshot.rig || !loaded.snapshot.animations) throw new Error("Final durable state is incomplete");
  verifyRotationAnchors(loaded.snapshot.rig);
  verifyAnimations(loaded.snapshot.rig, loaded.snapshot.animations);
  const source = await loadSource();
  process.stdout.write(`${JSON.stringify({ command, summary: loaded.summary, source: { width: source.image.width, height: source.image.height, transparentPixels: source.transparentPixels, translucentPixels: source.translucentPixels, sha256: source.sha256 }, smoke: runRigSmokeTest(loaded.snapshot.rig), partCount: loaded.snapshot.project.partCutterState?.parts.length, animations: loaded.snapshot.animations.animations.map((clip) => clip.name) }, null, 2)}\n`);
} else {
  throw new Error(`Unknown command ${command}`);
}
