import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { LocalProjectStore } from "../../mcp/storage/localProjectStore";
import type { LocalProjectSnapshot } from "../../src/project-storage/types";
import type { RigDefinition } from "../../src/rigging/schema/types";
import type { AnimationLibrary } from "../../src/tools/rig-editor/animation/types";
import type { GeneratedCharacterProject } from "../../src/character-generation/project/generatedCharacterProject";

const output = path.resolve(process.env.ASTRA_EVIDENCE_ROOT ?? ".rigging-studio/diagnostics/astra-intelligence/2026-09-06T-live-development");
const projectRoot = "/tmp/rigging-studio-astra-benchmark-projects";
const load = async (file: string) => JSON.parse(await readFile(`tests/fixtures/golden/void-ranger/${file}`, "utf8"));
const rig = await load("rig.json") as RigDefinition; const animations = await load("animations.json") as AnimationLibrary; const project = await load("project.json") as GeneratedCharacterProject;
const snapshot: LocalProjectSnapshot = { storageVersion: 1, localProjectId: "astra-development-copy", project: { ...project, id: "astra-development-copy", name: "ASTRA DEVELOPMENT COPY" }, rig, animations, selectedSkinId: rig.defaultSkinId };
await new LocalProjectStore({ root: projectRoot, cwd: process.cwd() }).save(snapshot);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto("http://localhost:5177/?mode=animate", { waitUntil: "domcontentloaded" });
  const menu = page.locator("details.project-storage-menu"); await menu.waitFor(); await menu.evaluate((el) => { (el as HTMLDetailsElement).open = true; });
  await menu.locator(".recent-projects article").filter({ hasText: "ASTRA DEVELOPMENT COPY" }).getByRole("button", { name: "Open", exact: true }).click();
  await page.locator('.project-hydration-root[data-project-id="astra-development-copy"]').waitFor();
  await page.evaluate("globalThis.__name = (target) => target");
  const cases = await page.evaluate(async () => {
    const base = `${location.origin}/src/`;
    const { getRiggingCommandService } = await import(`${base}agent-control/index.ts`);
    const { canonicalProjectStateDigest } = await import(`${base}project-storage/digest.ts`);
    const { applyDoctorProposal } = await import(`${base}animation-doctor/commands.ts`);
    const { renderDoctorEvidence, renderDoctorSource } = await import(`${base}animation-doctor/evidence.ts`);
    const { runAnimationDoctor } = await import(`${base}animation-doctor/session.ts`);
    const { BridgeAnimationDoctorProvider } = await import(`${base}animation-doctor/provider.ts`);
    const { measureDoctorMotion } = await import(`${base}animation-doctor/metrics.ts`);
    const service = getRiggingCommandService(); const source = service.getDurableSnapshot();
    const caseSpecs = [
      { id: "dev-loop-endpoint", clipId: "game-walk", match: /torso.*rotation/i, key: "last", delta: 8, reasonCode: "loop_pop", description: "loop endpoint mismatch" },
      { id: "dev-elbow-rotation", clipId: "game-attack", match: /left-(forearm|upper-arm).*rotation/i, key: "middle", delta: 8, reasonCode: "over_rotation", description: "bad elbow rotation" },
      { id: "dev-head-counter", clipId: "game-idle", match: /head.*rotation/i, key: "middle", delta: 10, reasonCode: "over_rotation", description: "excessive head counter-rotation" },
    ] as const;
    const results: unknown[] = [];
    for (const spec of caseSpecs.slice(0, 1)) {
      const originalClip = source.animations!.animations.find((clip: { id: string; tracks: Array<{ boneId: string; property: string; keyframes: Array<{ time: number; value: number }> }> }) => clip.id === spec.clipId); if (!originalClip) throw new Error(`Missing clip ${spec.clipId}`);
      const track = originalClip.tracks.find((track: { boneId: string; property: string; keyframes: Array<{ time: number; value: number }> }) => spec.match.test(`${track.boneId}.${track.property}`)); if (!track) throw new Error(`Missing target track for ${spec.id}`);
      const key = spec.key === "last" ? track.keyframes.at(-1)! : track.keyframes[Math.floor(track.keyframes.length / 2)];
      const identity = service.captureMotionReviewIdentity(spec.clipId); const broken = applyDoctorProposal(source, { identity, edits: [{ id: `${spec.id}-injected`, boneId: track.boneId, property: track.property, time: key.time, currentValue: key.value, proposedValue: key.value + spec.delta, reasonCode: spec.reasonCode, expectedVisualEffect: "Evaluator-only controlled defect", confidence: 1, evidence: ["metrics"] }] }, identity);
      const brokenIdentity = { ...identity, beforeDigest: canonicalProjectStateDigest(broken) };
      const metrics = (state: typeof source) => measureDoctorMotion(state.rig!, state.animations!.animations.find((clip: { id: string }) => clip.id === spec.clipId)!, { contacts: [], grips: [] });
      const started = performance.now();
      try {
        const run = await runAnimationDoctor({ snapshot: broken, identity: brokenIdentity, provider: new BridgeAnimationDoctorProvider(), measurements: { contacts: [], grips: [] }, signal: new AbortController().signal, assertCurrent: () => {}, render: renderDoctorEvidence, renderSource: renderDoctorSource });
        const best = run.versions[run.bestVersion];
        results.push({ id: spec.id, clipId: spec.clipId, defect: spec.description, injectedTarget: `${track.boneId}.${track.property}@${key.time}`, injectedDelta: spec.delta, baselineMetric: metrics(broken), knownGoodMetric: metrics(source), detectedIssues: run.versions[0].review?.issues ?? [], proposedEdits: run.versions[0].review?.edits ?? [], bestVersion: run.bestVersion, iterations: run.versions.length - 1, toolCalls: run.toolCalls, renderRequests: run.renderRequests, latencyMs: Math.round(performance.now() - started), provider: run.provider, model: run.model, candidateVetoes: best.scorecard.vetoes, candidateAccepted: best.scorecard.accepted, sourceDigestUnchanged: canonicalProjectStateDigest(source) === identity.beforeDigest });
      } catch (error) {
        results.push({ id: spec.id, clipId: spec.clipId, defect: spec.description, injectedTarget: `${track.boneId}.${track.property}@${key.time}`, injectedDelta: spec.delta, latencyMs: Math.round(performance.now() - started), provider: "astra-local-agent", model: "gpt-6-astra", failed: error instanceof Error ? error.message : "Astra review failed", sourceDigestUnchanged: canonicalProjectStateDigest(source) === identity.beforeDigest });
      }
    }
    return results;
  });
  await writeFile(path.join(output, "development-results.json"), JSON.stringify({ phase: "development", model: "gpt-6-astra", cases }, null, 2));
  console.log(JSON.stringify({ phase: "development", cases }));
} finally { await browser.close(); }
