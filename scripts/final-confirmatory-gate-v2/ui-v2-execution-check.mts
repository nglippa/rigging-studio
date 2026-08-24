import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page } from "playwright";

const ROOT = process.cwd();
const RUN_ID = process.env.RIG_STUDIO_FINAL_GATE_RUN_ID;
if (!RUN_ID) throw new Error("RIG_STUDIO_FINAL_GATE_RUN_ID is required");
const OUT = path.join(ROOT, ".rigging-studio/diagnostics/final-confirmatory-gates/v2-execution", RUN_ID);
const APP_URL = process.env.RIG_STUDIO_APP_URL ?? "http://localhost:3000";
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

type CharacterResult = {
  readonly executionOrder: number;
  readonly gateId: string;
  readonly character: string;
  readonly projectId?: string;
  readonly rig: { readonly canonicalValid: boolean };
  readonly animations: { readonly allFourPresent: boolean };
};

async function openProject(page: Page, character: CharacterResult): Promise<void> {
  const details = page.locator("details.project-storage-menu");
  if (await details.getAttribute("open") === null) await details.evaluate((element) => { (element as HTMLDetailsElement).open = true; });
  const article = details.locator(".recent-projects article").filter({ hasText: character.character }).first();
  await article.waitFor({ state: "visible" });
  await article.getByRole("button", { name: "Open" }).click();
  await page.locator(`.project-hydration-root[data-project-id="${character.projectId}"]`).waitFor({ state: "attached" });
  assert.equal(await page.locator(".project-hydration-root").getAttribute("data-project-id"), character.projectId);
}

async function exerciseClip(page: Page, label: string): Promise<{ passed: boolean; selectedLabel: string | null; scrubbed: boolean; replayed: boolean }> {
  const select = page.locator(".animation-toolbar select").first();
  const options = await select.locator("option").allTextContents();
  const selectedLabel = options.find((candidate) => candidate.trim().toLowerCase() === label.toLowerCase())
    ?? options.find((candidate) => candidate.toLowerCase().includes(label.toLowerCase()))
    ?? null;
  if (!selectedLabel) return { passed: false, selectedLabel: null, scrubbed: false, replayed: false };
  await select.selectOption({ label: selectedLabel });
  const play = page.getByRole("button", { name: /Play/ }).first();
  await play.click();
  await page.waitForTimeout(180);
  const pause = page.getByRole("button", { name: /Pause/ }).first();
  if (await pause.count()) await pause.click();
  const range = page.locator('.timeline-shell input[type="range"], .animation-toolbar input[type="range"]').first();
  let scrubbed = false;
  if (await range.count()) {
    await range.evaluate((element) => {
      const input = element as HTMLInputElement;
      const minimum = Number(input.min || 0);
      const maximum = Number(input.max || 1);
      input.value = String(minimum + (maximum - minimum) * .5);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    scrubbed = true;
  }
  await page.getByRole("button", { name: /Play/ }).first().click();
  await page.waitForTimeout(120);
  const secondPause = page.getByRole("button", { name: /Pause/ }).first();
  if (await secondPause.count()) await secondPause.click();
  return { passed: scrubbed, selectedLabel, scrubbed, replayed: true };
}

const primary = JSON.parse(await readFile(path.join(OUT, "primary-results.json"), "utf8")) as { characters: CharacterResult[] };
await mkdir(path.join(OUT, "screenshots"), { recursive: true });
const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? (existsSync(systemChrome) ? systemChrome : undefined);
const browser = await chromium.launch({ headless: true, executablePath });
const results = [];
const freshContextResults = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.goto(`${APP_URL}/?mode=animate`, { waitUntil: "domcontentloaded" });
  await page.locator("details.project-storage-menu").waitFor();
  for (const character of primary.characters.sort((left, right) => left.executionOrder - right.executionOrder)) {
    if (!character.projectId || !character.rig.canonicalValid || !character.animations.allFourPresent) {
      results.push({ gateId: character.gateId, character: character.character, attempted: false, passed: false, status: "NOT REACHED", reason: "No canonical rig/four-clip library exists" });
      continue;
    }
    try {
      await openProject(page, character);
      const clips = [];
      for (const label of ["Idle", "Walk", "Run", "Attack"]) clips.push({ label, ...await exerciseClip(page, label) });
      const screenshot = path.join(OUT, "screenshots", `${String(character.executionOrder).padStart(2, "0")}-${character.gateId}-animate.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      results.push({ gateId: character.gateId, character: character.character, attempted: true, passed: clips.every((clip) => clip.passed), projectIdentityVerified: true, clips, screenshot: path.relative(OUT, screenshot) });
    } catch (error: unknown) {
      results.push({ gateId: character.gateId, character: character.character, attempted: true, passed: false, error: error instanceof Error ? error.message : "UI playback failed" });
    }
  }
  await context.close();

  for (const character of primary.characters.filter((entry) => entry.projectId && entry.rig.canonicalValid && entry.animations.allFourPresent).slice(0, 3)) {
    const fresh = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await fresh.newPage();
    try {
      await page.goto(`${APP_URL}/?mode=animate`, { waitUntil: "domcontentloaded" });
      await page.locator("details.project-storage-menu").waitFor();
      await openProject(page, character);
      const idle = await exerciseClip(page, "Idle");
      freshContextResults.push({ gateId: character.gateId, character: character.character, passed: idle.passed, projectIdentityVerified: true });
    } catch (error: unknown) {
      freshContextResults.push({ gateId: character.gateId, character: character.character, passed: false, error: error instanceof Error ? error.message : "fresh-context check failed" });
    } finally {
      await fresh.close();
    }
  }
} finally {
  await browser.close();
}

const viable = results.filter((result) => result.attempted);
const output = {
  completedAt: new Date().toISOString(),
  appUrl: APP_URL,
  characters: results,
  viableCharacterCount: viable.length,
  passedViableCharacterCount: viable.filter((result) => result.passed).length,
  freshContextRequired: Math.min(3, viable.length),
  freshContextResults,
  actualUIPlaybackPassed: viable.every((result) => result.passed),
  projectIsolationPassed: viable.every((result) => result.passed && result.projectIdentityVerified),
};
await writeFile(path.join(OUT, "ui-playback.json"), json(output));
process.stdout.write(json(output));
