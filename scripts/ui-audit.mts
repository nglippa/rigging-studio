/**
 * Browser audit of the guided studio (docs/superpowers/plans/2026-11-20-guided-studio-ui.md). Each check is a named
 * function run against the dev server; any failure exits non-zero. Run with the app up: `npm run test:ui-audit`.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "playwright";
import { LocalProjectStore } from "../mcp/storage/localProjectStore";
import type { GeneratedCharacterProject } from "../src/character-generation/project/generatedCharacterProject";
import type { LocalProjectSnapshot } from "../src/project-storage/types";
import type { RigDefinition } from "../src/rigging/schema/types";
import type { AnimationLibrary } from "../src/tools/rig-editor/animation/types";
import { STEPS } from "../app/studio-ui/steps";

const APP_URL = process.env.RIG_STUDIO_APP_URL ?? "http://localhost:5177";
const ACTIVE_DISK_PROJECT_KEY = "rig-studio:active-disk-project:v1";
/** A rigged, animated project (the golden void ranger), installed on disk for the audit. */
const RIGGED = { id: "ui-audit-rigged", name: "UI AUDIT RIGGED" } as const;

async function installFixtures(): Promise<void> {
  const project = JSON.parse(await readFile("tests/fixtures/golden/void-ranger/project.json", "utf8")) as GeneratedCharacterProject;
  const rig = JSON.parse(await readFile("tests/fixtures/golden/void-ranger/rig.json", "utf8")) as RigDefinition;
  const animations = JSON.parse(await readFile("tests/fixtures/golden/void-ranger/animations.json", "utf8")) as AnimationLibrary;
  const named: RigDefinition = { ...rig, metadata: { ...rig.metadata, name: RIGGED.name } };
  const snapshot = {
    storageVersion: 1, localProjectId: RIGGED.id,
    project: { ...project, id: RIGGED.id, name: RIGGED.name, rigDefinition: named, skins: named.skins, updatedAt: new Date().toISOString() },
    rig: named, animations, selectedSkinId: named.defaultSkinId,
  } satisfies LocalProjectSnapshot;
  await new LocalProjectStore({ cwd: process.cwd() }).save(snapshot);
}

/** A fresh browser context whose remembered active project is `projectId` (as after a previous session). */
async function contextWithActiveProject(browser: Awaited<ReturnType<typeof chromium.launch>>, projectId: string): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(([key, id]) => { try { window.localStorage.setItem(key, id); } catch { /* storage blocked */ } }, [ACTIVE_DISK_PROJECT_KEY, projectId] as const);
  return context;
}

/** Opening Create with a rigged project remembered must stay on Create (it used to bounce to /?mode=animate). */
async function checkCreateStaysOnCreate(page: Page): Promise<void> {
  await page.goto(`${APP_URL}/create-character`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  assert.equal(new URL(page.url()).pathname, "/create-character", `Create bounced to ${page.url()}`);
}

/** Every step renders in one frame: one step bar with the five steps, one centred main button, nothing over the stage. */
async function checkShellOnEveryStep(page: Page): Promise<void> {
  for (const step of STEPS) {
    await page.goto(`${APP_URL}${step.href}`, { waitUntil: "domcontentloaded" });
    await page.locator(".step-shell").first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(800);
    const shape = await page.evaluate(() => {
      const nav = document.querySelectorAll(".step-nav");
      const labels = [...document.querySelectorAll(".step-nav button")].map((button) => button.textContent?.replace(/^[\d✓]\s*/, "").trim());
      const primary = document.querySelectorAll(".step-primary");
      const box = primary[0]?.getBoundingClientRect();
      const stage = document.querySelector(".step-stage")?.getBoundingClientRect();
      // Anything positioned over the stage that is not inside it (an overlay notice, a floating toolbar).
      const over = stage ? [...document.querySelectorAll("body *")].filter((element) => {
        if (element.closest(".step-stage") || element.contains(document.querySelector(".step-stage"))) return false;
        const style = getComputedStyle(element); if (style.position !== "fixed" && style.position !== "absolute") return false;
        const r = element.getBoundingClientRect(); if (!r.width || !r.height || style.visibility === "hidden" || style.display === "none") return false;
        return r.left < stage.right && r.right > stage.left && r.top < stage.bottom && r.bottom > stage.top;
      }).map((element) => `${element.tagName.toLowerCase()}.${String(element.className).split(" ")[0]}`) : ["no .step-stage"];
      return { shells: document.querySelectorAll(".step-shell").length, navs: nav.length, labels, primaries: primary.length, centre: box ? box.left + box.width / 2 : -1, width: innerWidth, over };
    });
    assert.equal(shape.shells, 1, `${step.label}: ${shape.shells} .step-shell`);
    assert.equal(shape.navs, 1, `${step.label}: ${shape.navs} step bars`);
    assert.deepEqual(shape.labels, STEPS.map((item) => item.label), `${step.label}: step bar reads ${shape.labels.join(", ")}`);
    assert.equal(shape.primaries, 1, `${step.label}: ${shape.primaries} main buttons`);
    assert.ok(Math.abs(shape.centre - shape.width / 2) <= 40, `${step.label}: main button centred at ${Math.round(shape.centre)} of ${shape.width}`);
    assert.deepEqual(shape.over, [], `${step.label}: over the stage: ${shape.over.join(", ")}`);
  }
}

const checks: readonly (readonly [string, (page: Page) => Promise<void>])[] = [
  ["Create stays on Create with a rigged project open", checkCreateStaysOnCreate],
  ["Every step renders in the shared frame", checkShellOnEveryStep],
];

await installFixtures();
const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? (existsSync(systemChrome) ? systemChrome : undefined) });
let failed = 0;
try {
  for (const [name, check] of checks) {
    const context = await contextWithActiveProject(browser, RIGGED.id);
    const page = await context.newPage();
    try { await check(page); console.log(`PASS  ${name}`); }
    catch (error: unknown) { failed += 1; console.log(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`); }
    finally { await context.close(); }
  }
} finally { await browser.close(); }
console.log(`${checks.length - failed} / ${checks.length} checks pass`);
if (failed) process.exit(1);
