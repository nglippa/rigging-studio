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

const checks: readonly (readonly [string, (page: Page) => Promise<void>])[] = [
  ["Create stays on Create with a rigged project open", checkCreateStaysOnCreate],
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
