import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { LocalProjectStore } from "../mcp/storage/localProjectStore";
import type { LocalProjectSnapshot } from "../src/project-storage/types";
import type { GeneratedCharacterProject } from "../src/character-generation/project/generatedCharacterProject";
import type { RigDefinition } from "../src/rigging/schema/types";
import type { AnimationLibrary } from "../src/tools/rig-editor/animation/types";

const APP_URL = process.env.RIG_STUDIO_APP_URL ?? "http://localhost:3000";
const ROOT = process.cwd();
const ids = ["hydration-project-a", "hydration-project-b", "hydration-project-c"] as const;

async function installFixtures(): Promise<void> {
  const project = JSON.parse(await readFile("tests/fixtures/golden/void-ranger/project.json", "utf8")) as GeneratedCharacterProject;
  const rig = JSON.parse(await readFile("tests/fixtures/golden/void-ranger/rig.json", "utf8")) as RigDefinition;
  const animations = JSON.parse(await readFile("tests/fixtures/golden/void-ranger/animations.json", "utf8")) as AnimationLibrary;
  const store = new LocalProjectStore({ cwd: ROOT });
  for (const [index, id] of ids.entries()) {
    const name = `HYDRATION PROJECT ${String.fromCharCode(65 + index)}`;
    const baseRig = structuredClone(rig);
    const sentinelBones: RigDefinition["bones"] = [
      { id: "COLLISION_BONE", parentId: baseRig.rootBoneId, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, length: 8, inheritRotation: true, inheritScale: true },
      ...(index === 0 ? [{ id: "A_ONLY_BONE", parentId: baseRig.rootBoneId, x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, length: 8, inheritRotation: true, inheritScale: true }] : []),
    ];
    const nextRig: RigDefinition = { ...baseRig, metadata: { ...baseRig.metadata, name }, bones: [...baseRig.bones, ...sentinelBones] };
    const baseAnimations = structuredClone(animations);
    const nextAnimations: AnimationLibrary = {
      ...baseAnimations,
      animations: [
        ...baseAnimations.animations,
        ...(index === 0 ? [{ schemaVersion: 1 as const, id: "A_ONLY_ANIM", name: "A_ONLY_ANIM", duration: 1, loop: true, tracks: [] }] : []),
      ],
    };
    const nextProject = { ...structuredClone(project), id, name, rigDefinition: nextRig, skins: nextRig.skins, updatedAt: new Date().toISOString() };
    const snapshot = { storageVersion: 1, localProjectId: id, project: nextProject, rig: nextRig, animations: nextAnimations, selectedSkinId: nextRig.defaultSkinId } satisfies LocalProjectSnapshot;
    await store.save(snapshot);
  }
}

async function openProject(page: Page, name: string, id: string): Promise<void> {
  const details = page.locator("details.project-storage-menu");
  if (await details.getAttribute("open") === null) await details.evaluate((element) => { (element as HTMLDetailsElement).open = true; });
  const project = details.locator(".recent-projects article").filter({ hasText: name });
  await project.waitFor();
  await project.getByRole("button", { name: "Open" }).click();
  await page.locator(`.project-hydration-root[data-project-id="${id}"]`).waitFor({ state: "attached" });
  await page.locator("main.rig-editor-shell").waitFor({ state: "visible" });
}

async function assertIdentity(page: Page, id: string, allowASentinel: boolean): Promise<void> {
  const root = page.locator(".project-hydration-root");
  assert.equal(await root.getAttribute("data-project-id"), id);
  assert.equal(await root.getAttribute("data-canvas-project-id"), id);
  assert.equal(await root.getAttribute("data-timeline-project-id"), id);
  assert.equal(await root.getAttribute("data-inspector-project-id"), id);
  await page.waitForFunction((expectedId) => {
    const identity = (window as Window & { __RIG_STUDIO_UI_IDENTITY__?: { activeProjectId: string | null; renderedRigProjectId: string | null } }).__RIG_STUDIO_UI_IDENTITY__;
    return identity?.activeProjectId === expectedId && identity.renderedRigProjectId === expectedId;
  }, id);
  const identity = await page.evaluate(() => (window as Window & { __RIG_STUDIO_UI_IDENTITY__?: { activeProjectId: string | null; renderedRigProjectId: string | null } }).__RIG_STUDIO_UI_IDENTITY__);
  assert.equal(identity?.activeProjectId, id); assert.equal(identity?.renderedRigProjectId, id);
  const sentinel = page.getByRole("button", { name: "A ONLY BONE", exact: true });
  if (allowASentinel) await sentinel.waitFor();
  assert.equal(await sentinel.count() > 0, allowASentinel);
}

await installFixtures();
const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? (existsSync(systemChrome) ? systemChrome : undefined);
const browser = await chromium.launch({ headless: true, executablePath });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.goto(`${APP_URL}/?mode=animate`, { waitUntil: "domcontentloaded" });
  await page.locator("details.project-storage-menu").waitFor();
  await openProject(page, "HYDRATION PROJECT A", ids[0]);
  await page.getByRole("button", { name: "A ONLY BONE", exact: true }).click();
  await page.locator(".animation-toolbar select").first().selectOption({ label: "A_ONLY_ANIM" });
  await page.getByRole("button", { name: /Play/ }).click();

  let releaseLoad!: () => void;
  const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
  let delayB = true;
  await page.route("http://127.0.0.1:47831/project-storage/load", async (route) => {
    const body = route.request().postDataJSON() as { projectId?: string };
    if (delayB && body.projectId === ids[1]) { delayB = false; await loadGate; }
    await route.continue();
  });
  const details = page.locator("details.project-storage-menu");
  await details.locator(":scope > summary").click();
  await details.locator(".recent-projects article").filter({ hasText: "HYDRATION PROJECT B" }).getByRole("button", { name: "Open" }).click();
  await page.locator(".project-hydration-shell[data-project-hydrating=true]").waitFor();
  const loadingText = await page.locator("body").innerText();
  assert(!loadingText.includes("A ONLY BONE")); assert(!loadingText.includes("A_ONLY_ANIM")); assert(!loadingText.includes("Pause"));
  releaseLoad();
  await page.locator(`.project-hydration-root[data-project-id="${ids[1]}"]`).waitFor();
  await assertIdentity(page, ids[1], false);

  await openProject(page, "HYDRATION PROJECT A", ids[0]);
  await page.getByRole("button", { name: "COLLISION BONE", exact: true }).click();
  await openProject(page, "HYDRATION PROJECT B", ids[1]);
  const collisionClass = await page.getByRole("button", { name: "COLLISION BONE", exact: true }).getAttribute("class");
  assert(!collisionClass?.includes("selected"), "same entity ID was selected across a project boundary");

  let seed = 0x5eed1234;
  for (let index = 0; index < 100; index += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const targetIndex = seed % ids.length; const id = ids[targetIndex];
    await openProject(page, `HYDRATION PROJECT ${String.fromCharCode(65 + targetIndex)}`, id);
    await assertIdentity(page, id, targetIndex === 0);
  }

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(`.project-hydration-root[data-project-id="${(await page.evaluate(() => window.localStorage.getItem("rig-studio:active-disk-project:v1"))) ?? ""}"]`).waitFor();
  const reloadId = await page.locator(".project-hydration-root").getAttribute("data-project-id");
  assert(ids.includes(reloadId as typeof ids[number]));
  await context.close();

  const fresh = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const freshPage = await fresh.newPage(); await freshPage.goto(`${APP_URL}/?mode=animate`, { waitUntil: "domcontentloaded" });
  await openProject(freshPage, "HYDRATION PROJECT A", ids[0]); await openProject(freshPage, "HYDRATION PROJECT C", ids[2]);
  await assertIdentity(freshPage, ids[2], false); await fresh.close();
  process.stdout.write(`${JSON.stringify({ result: "PASS", sentinelSwitch: true, sameIdCollision: true, switchDuringPlayback: true, deterministicSwitches: 100, freshContext: true, fullReload: true })}\n`);
} finally { await browser.close(); }
