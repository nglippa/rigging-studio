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
/** The same character with its art and parts but no rig yet. */
const UNRIGGED = { id: "ui-audit-unrigged", name: "UI AUDIT UNRIGGED" } as const;

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
  const unrigged = { storageVersion: 1, localProjectId: UNRIGGED.id, project: { ...project, id: UNRIGGED.id, name: UNRIGGED.name, stage: "prepare", rigDefinition: undefined, skins: [], updatedAt: new Date().toISOString() }, rig: null, animations: null, selectedSkinId: null } as unknown as LocalProjectSnapshot;
  await new LocalProjectStore({ cwd: process.cwd() }).save(unrigged);
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
        // Content of a closed <details> keeps its layout box but is not painted.
        const closed = element.closest("details:not([open])"); if (closed && !element.closest("summary")) return false;
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

/** A step that is not open yet sends you to the furthest open one, and says why in the instruction line. */
async function checkUnavailableStepRedirects(page: Page): Promise<void> {
  // As a person would be: the project is open (here on Parts) before they ask for a later step.
  await page.goto(`${APP_URL}/part-cutter`, { waitUntil: "domcontentloaded" });
  await page.locator(".step-shell").first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(3000);
  await page.goto(`${APP_URL}/?mode=animate`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
  const url = new URL(page.url());
  const landed = `${url.pathname}${url.search}`;
  assert.ok(landed === "/?mode=setup" || landed === "/part-cutter", `a project without a rig stayed on ${landed}`);
  const instruction = await page.locator(".step-instruction").first().textContent({ timeout: 10000 });
  assert.match(instruction ?? "", /Build the rig first|Cut the parts first/, `instruction reads "${instruction}"`);
}

/** What a click can observably change. Equal before and after means the control did nothing. */
async function fingerprint(page: Page): Promise<string> {
  return page.evaluate(() => {
    const shell = document.querySelector(".step-shell"); if (!shell) return location.href;
    const states = [...document.querySelectorAll("[aria-pressed],[aria-expanded],[aria-selected],[aria-checked],[aria-current],details,dialog,[role=dialog]")]
      .map((element) => `${element.getAttribute("aria-pressed")}${element.getAttribute("aria-expanded")}${element.getAttribute("aria-selected")}${element.getAttribute("aria-checked")}${element.getAttribute("aria-current")}${(element as HTMLDetailsElement).open ?? ""}`).join("");
    const values = [...document.querySelectorAll("input,select,textarea")].map((element) => { const input = element as HTMLInputElement; return `${input.value}:${input.checked}`; }).join("|");
    // Not focus or hover: a click focuses even a dead button, and hover restyles it.
    const text = shell.textContent ?? "";
    let hash = 0; for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0;
    const selected = [...shell.querySelectorAll(".is-active,.active,.is-selected,[data-selected=true],.is-current")].length;
    return [location.href, document.querySelectorAll("*").length, states, values, hash, selected].join("§");
  });
}

/** Actions that throw work away; a mode switch called "remove" (the lasso's add/remove) is not one. */
const DESTRUCTIVE = /archive|start over|remove part|delete|rebuild|discard|repaint/i;

/**
 * Clicks every visible, enabled control in the step and fails on any that changes nothing (a dead button), on console
 * errors, on destructive controls that act without asking, and on disabled controls that do not say why.
 */
async function checkEveryControl(page: Page, href: string, label: string): Promise<string[]> {
  const problems: string[] = [];
  const consoleErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error" && !/WebSocket|ERR_CONNECTION_REFUSED|Failed to load resource/.test(message.text())) consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  let sideEffects = 0;
  page.on("request", (request) => { if (!/\.(png|js|css|woff2?)(\?|$)|_next|@vite|hmr/.test(request.url())) sideEffects += 1; });
  page.on("filechooser", () => { sideEffects += 1; });
  page.on("download", () => { sideEffects += 1; });
  let nativeConfirms = 0;
  page.on("dialog", (dialog) => { sideEffects += 1; nativeConfirms += 1; void dialog.dismiss(); });
  const open = async () => { await page.goto(`${APP_URL}${href}`, { waitUntil: "domcontentloaded" }); await page.locator(".step-shell").first().waitFor({ timeout: 40000 }); await page.waitForTimeout(1500); };
  await open();
  const controls = await page.evaluate(() => [...document.querySelectorAll(".step-shell :is(button, a[href], [role=tab], select, input[type=checkbox], input[type=radio], summary)")].map((element, index) => {
    const r = element.getBoundingClientRect(); const style = getComputedStyle(element);
    const visible = r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none" && !element.closest("details:not([open])")?.matches(":not(summary)") || element.tagName === "SUMMARY";
    const text = (element.getAttribute("aria-label") || (element.tagName === "INPUT" ? element.closest("label")?.textContent : "") || element.textContent || element.getAttribute("title") || element.tagName).trim().replace(/\s+/g, " ").slice(0, 50);
    const disabled = (element as HTMLButtonElement).disabled || element.getAttribute("aria-disabled") === "true";
    const reason = element.getAttribute("title") || element.getAttribute("aria-description") || "";
    // Already on: the selected tool, tab, toggle or radio. Choosing it again is rightly a no-op.
    const alreadyOn = element.getAttribute("aria-pressed") === "true" || element.getAttribute("aria-selected") === "true" || element.matches(".active, .is-active") || ((element as HTMLInputElement).type === "radio" && (element as HTMLInputElement).checked);
    return { index, text, visible: visible && r.width > 0, disabled, reason, alreadyOn };
  }));
  for (const control of controls.filter((item) => item.visible && item.disabled)) if (!control.reason) problems.push(`${label} / "${control.text}": disabled without a reason`);
  const seen = new Set<string>();
  for (const control of controls.filter((item) => item.visible && !item.disabled && !item.alreadyOn)) {
    if (seen.has(control.text) || /^(Rig Studio home|RS)$/.test(control.text)) continue; seen.add(control.text);
    if (`${page.url()}`.indexOf(href) < 0) await open();
    // Found by its text at click time: positions shift as the page changes between clicks.
    const found = await page.evaluate((wanted) => {
      document.querySelectorAll("[data-audit-target]").forEach((element) => element.removeAttribute("data-audit-target"));
      const match = [...document.querySelectorAll(".step-shell :is(button, a[href], [role=tab], select, input[type=checkbox], input[type=radio], summary)")].find((element) => {
        const text = (element.getAttribute("aria-label") || (element.tagName === "INPUT" ? element.closest("label")?.textContent : "") || element.textContent || element.getAttribute("title") || element.tagName).trim().replace(/\s+/g, " ").slice(0, 50);
        const r = element.getBoundingClientRect();
        return text === wanted && r.width > 0 && r.height > 0 && !(element as HTMLButtonElement).disabled;
      });
      match?.setAttribute("data-audit-target", "1"); return Boolean(match);
    }, control.text);
    if (!found) continue;
    const target = page.locator("[data-audit-target]").first();
    // A view reset only shows on the canvas, and only if the view was moved first: zoom, then compare stage pixels.
    const canvasOnly = /^Fit/.test(control.text);
    if (canvasOnly) { const stage = page.locator(".step-stage").first(); const box = await stage.boundingBox(); if (box) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, -600); await page.waitForTimeout(300); } }
    const stagePixels = async () => (await page.locator(".step-stage").first().screenshot({ type: "jpeg", quality: 40 }).catch(() => Buffer.alloc(0))).toString("base64");
    const pixelsBefore = canvasOnly ? await stagePixels() : "";
    // A resize handle works by dragging, from a fresh layout (an earlier click may have collapsed its panel).
    if (/^Resize/.test(control.text)) {
      // Panel collapse is remembered in the workspace preferences, so start from the default layout.
      await page.evaluate(() => { try { window.localStorage.removeItem("rigging-studio-workspace-v1"); } catch { /* none */ } });
      await open();
      await page.evaluate((wanted) => { const match = [...document.querySelectorAll(`[aria-label="${wanted}"]`)][0]; document.querySelectorAll("[data-audit-target]").forEach((element) => element.removeAttribute("data-audit-target")); match?.setAttribute("data-audit-target", "1"); }, control.text);
      const handle = await page.locator("[data-audit-target]").first().boundingBox();
      const box = handle ? { ...handle, y: handle.y + Math.min(200, handle.height / 2) - handle.height / 2 } : null;
      const sizeOf = () => page.evaluate(() => [...document.querySelectorAll(".step-shell *")].slice(0, 3000).map((element) => { const r = element.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; }).join(","));
      const sizeBefore = await sizeOf();
      if (box) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 - 40, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(300); }
      if (await sizeOf() === sizeBefore) problems.push(`${label} / "${control.text}": dragging it resized nothing`);
      continue;
    }
    const before = await fingerprint(page); const effectsBefore = sideEffects; const confirmsBefore = nativeConfirms; const errorsBefore = consoleErrors.length;
    try {
      const tag = await target.evaluate((element) => element.tagName);
      if (tag === "SELECT") { const options = await target.locator("option").allTextContents(); if (options.length > 1) await target.selectOption({ index: 1 }); }
      else await target.click({ timeout: 3000 });
    } catch { continue; }
    await page.waitForTimeout(450);
    if (DESTRUCTIVE.test(control.text)) {
      const asked = await page.evaluate(() => [...document.querySelectorAll("[role=dialog], [role=alertdialog], dialog[open], .studio-dialog")].some((element) => { const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(element).visibility !== "hidden"; }));
      // Only a confirmation counts as asking; a request or a navigation means it acted straight away.
      if (!asked && nativeConfirms === confirmsBefore) problems.push(`${label} / "${control.text}": destructive action without a confirmation`);
      const cancel = page.getByRole("button", { name: /^(cancel|keep|no)/i }).first(); if (await cancel.isVisible().catch(() => false)) await cancel.click().catch(() => undefined);
    } else {
      const after = await fingerprint(page);
      const pixelsChanged = canvasOnly && await stagePixels() !== pixelsBefore;
      if (after === before && sideEffects === effectsBefore && !pixelsChanged) problems.push(`${label} / "${control.text}": nothing happened`);
    }
    if (consoleErrors.length > errorsBefore) problems.push(`${label} / "${control.text}": console error: ${consoleErrors.slice(errorsBefore).join(" ; ").slice(0, 160)}`);
    await page.keyboard.press("Escape").catch(() => undefined);
    if (new URL(page.url()).pathname + new URL(page.url()).search !== href) await open();
  }
  return problems;
}

/** Layout at a viewport: no sideways scroll and the main button visible without scrolling. */
async function layoutProblems(page: Page, href: string, label: string): Promise<string[]> {
  await page.goto(`${APP_URL}${href}`, { waitUntil: "domcontentloaded" }); await page.locator(".step-shell").first().waitFor({ timeout: 40000 }); await page.waitForTimeout(1500);
  const box = await page.evaluate(() => { const p = document.querySelector(".step-primary")!.getBoundingClientRect(); return { scrollWidth: document.documentElement.scrollWidth, width: innerWidth, height: innerHeight, top: p.top, bottom: p.bottom }; });
  const out: string[] = [];
  if (box.scrollWidth > box.width) out.push(`${label}: sideways scroll (${box.scrollWidth} > ${box.width})`);
  if (box.bottom > box.height || box.top < 0) out.push(`${label}: main button off screen`);
  return out;
}

async function checkEveryControlOnEveryStep(page: Page): Promise<void> {
  const problems: string[] = [];
  for (const step of STEPS) problems.push(...await checkEveryControl(page, step.href, step.label));
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const step of STEPS) problems.push(...await layoutProblems(page, step.href, `${step.label} at ${viewport.width}×${viewport.height}`));
  }
  assert.deepEqual(problems, [], `\n  ${problems.join("\n  ")}`);
}

/** A new character on Create: model cards ranked by the benchmark, a description, and Generate as the main button. */
async function checkCreateGuided(page: Page): Promise<void> {
  await page.addInitScript(() => { try { window.localStorage.removeItem("rig-studio:active-disk-project:v1"); } catch { /* none */ } });
  await page.goto(`${APP_URL}/create-character`, { waitUntil: "domcontentloaded" });
  await page.locator(".step-shell").first().waitFor({ timeout: 20000 });
  // Start a blank character so Create shows its first view.
  await page.evaluate(() => { const start = [...document.querySelectorAll("button")].find((button) => /^new character$/i.test(button.textContent?.trim() ?? "")); start?.click(); });
  await page.locator(".model-cards .choice").first().waitFor({ timeout: 20000 });
  const first = page.locator(".model-cards .choice").first();
  assert.match(await first.textContent() ?? "", /Best match/, "the first model card is not the benchmark's best match");
  const second = page.locator(".model-cards .choice:not([disabled])").nth(1);
  if (await second.count()) { await second.click(); assert.equal(await second.getAttribute("aria-pressed"), "true", "clicking a model card does not select it"); }
  assert.equal((await page.locator(".step-primary").textContent())?.trim(), "Generate");
  assert.ok(await page.locator(".step-stage textarea").count(), "no description box on the stage");
}

/** With the bridge unreachable, Create says so in the model list, and the step bar still works. */
async function checkCreateOffline(page: Page): Promise<void> {
  await page.route("http://127.0.0.1:47831/**", (route) => route.abort());
  await page.goto(`${APP_URL}/create-character`, { waitUntil: "domcontentloaded" });
  await page.locator(".step-shell").first().waitFor({ timeout: 20000 });
  await page.locator(".model-cards").getByText("The Mac Studio isn't reachable").waitFor({ timeout: 20000 });
  assert.ok(await page.locator(".model-cards").getByRole("button", { name: "Retry" }).isVisible(), "no Retry when the Studio is unreachable");
  assert.equal(await page.locator(".step-nav button").count(), 5);
}

const checks: readonly (readonly [string, (page: Page) => Promise<void>, string?])[] = [
  ["Create stays on Create with a rigged project open", checkCreateStaysOnCreate],
  ["Every step renders in the shared frame", checkShellOnEveryStep],
  ["A step that is not open yet redirects with its reason", checkUnavailableStepRedirects, UNRIGGED.id],
  ["Create: model cards, description, Generate", checkCreateGuided],
  ["Create: says when the Mac Studio is unreachable", checkCreateOffline],
  ["Every control on every step does something", checkEveryControlOnEveryStep],
];

await installFixtures();
const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? (existsSync(systemChrome) ? systemChrome : undefined) });
let failed = 0;
try {
  // ONLY=<text> runs just the checks whose name contains it.
  for (const [name, check, projectId] of checks.filter(([name]) => !process.env.ONLY || name.includes(process.env.ONLY))) {
    const context = await contextWithActiveProject(browser, projectId ?? RIGGED.id);
    const page = await context.newPage();
    try { await check(page); console.log(`PASS  ${name}`); }
    catch (error: unknown) { failed += 1; console.log(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`); }
    finally { await context.close(); }
  }
} finally { await browser.close(); }
const ran = checks.filter(([name]) => !process.env.ONLY || name.includes(process.env.ONLY)).length;
console.log(`${ran - failed} / ${ran} checks pass`);
if (failed) process.exit(1);
