/**
 * Browser audit of the guided studio (docs/superpowers/plans/2026-11-20-guided-studio-ui.md). Each check is a named
 * function run against the dev server; any failure exits non-zero. Run with the app up: `npm run test:ui-audit`.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { computeWorldTransforms } from "../src/rigging/runtime/worldTransforms";
import { createRestPose } from "../src/rigging/runtime/pose";
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
  // A landmark for the left shoulder, a little off its joint, so the expanded Rig view's "Snap to shoulder" has work to do.
  const shoulder = computeWorldTransforms(rig, createRestPose(rig))["left-upper-arm"];
  const pivotSources = { ...(rig.metadata.pivotSources as Record<string, unknown> | undefined), "left-upper-arm": { source: "landmark", confidence: .9, detail: "shoulder", point: { x: shoulder.x + 6, y: shoulder.y - 4 } } };
  const named: RigDefinition = { ...rig, metadata: { ...rig.metadata, name: RIGGED.name, pivotSources } };
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
async function checkEveryControl(page: Page, href: string, label: string, enter?: (page: Page) => Promise<void>): Promise<string[]> {
  const problems: string[] = [];
  const consoleErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error" && !/WebSocket|ERR_CONNECTION_REFUSED|Failed to load resource/.test(message.text())) consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(`${error.message}${error.stack ? ` @ ${error.stack.split("\n").slice(1, 4).map((line) => line.trim().replace(/https?:\/\/[^/]+/, "")).join(" < ")}` : ""}`));
  let sideEffects = 0;
  page.on("request", (request) => { if (!/\.(png|js|css|woff2?)(\?|$)|_next|@vite|hmr/.test(request.url())) sideEffects += 1; });
  page.on("filechooser", () => { sideEffects += 1; });
  page.on("download", () => { sideEffects += 1; });
  let nativeConfirms = 0;
  page.on("dialog", (dialog) => { sideEffects += 1; nativeConfirms += 1; void dialog.dismiss(); });
  // The golden fixture's images are large: a step can take a while to open in a fresh browser, so wait long and retry once.
  const open = async () => {
    for (let attempt = 0; ; attempt += 1) {
      try { await page.goto(`${APP_URL}${href}`, { waitUntil: "domcontentloaded" }); await page.locator(".step-shell").first().waitFor({ timeout: 90000 }); break; }
      catch (error) { if (attempt) throw error; }
    }
    await page.waitForTimeout(1500); if (enter) { await enter(page); await page.waitForTimeout(600); }
  };
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
    // Leaving the expanded view is checked on its own (it is the expanded view's main button).
    if (seen.has(control.text) || /^(Rig Studio home|RS)$/.test(control.text) || (enter && /^Done, back to/.test(control.text))) continue; seen.add(control.text);
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
    if (canvasOnly) { const stage = page.locator(".step-stage, .expanded-stage").first(); const box = await stage.boundingBox(); if (box) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, -600); await page.waitForTimeout(300); } }
    const stagePixels = async () => (await page.locator(".step-stage, .expanded-stage").first().screenshot({ type: "jpeg", quality: 40 }).catch(() => Buffer.alloc(0))).toString("base64");
    const pixelsBefore = canvasOnly ? await stagePixels() : "";
    // A resize handle works by dragging, from a fresh layout (an earlier click may have collapsed its panel).
    if (/^Resize/.test(control.text)) {
      // Panel collapse is remembered in the workspace preferences, so start from the default layout.
      await page.evaluate(() => { try { window.localStorage.removeItem("rigging-studio-workspace-v1"); } catch { /* none */ } });
      await open();
      await page.evaluate((wanted) => { const match = [...document.querySelectorAll(`[aria-label="${wanted}"]`)][0]; document.querySelectorAll("[data-audit-target]").forEach((element) => element.removeAttribute("data-audit-target")); match?.setAttribute("data-audit-target", "1"); }, control.text);
      await page.locator("[data-audit-target]").first().waitFor({ state: "visible", timeout: 40000 }).catch(() => undefined);
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
    if (new URL(page.url()).pathname + new URL(page.url()).search !== href || (enter && !(await page.locator(".step-shell.is-expanded").count()))) await open();
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

/** Opens a step's expanded view from the panel link whose text matches. */
const expandWith = (link: RegExp) => async (page: Page) => { const target = page.locator(".step-panel .panel-link").filter({ hasText: link }).first(); await target.waitFor({ state: "visible", timeout: 30000 }); await target.click(); await page.locator(".step-shell.is-expanded").waitFor({ timeout: 10000 }); };

/** Create's expanded view: every control works, and Done returns to the guided view. */
async function checkCreateExpanded(page: Page): Promise<void> {
  const problems = await checkEveryControl(page, "/create-character", "Create expanded", expandWith(/Tune this model/));
  await page.goto(`${APP_URL}/create-character`, { waitUntil: "domcontentloaded" }); await page.locator(".step-shell").first().waitFor({ timeout: 40000 });
  await expandWith(/Tune this model/)(page);
  await page.locator(".step-primary").click();
  assert.equal(await page.locator(".step-shell.is-expanded").count(), 0, "Done, back to Create did not leave the expanded view");
  assert.deepEqual(problems, [], `\n  ${problems.join("\n  ")}`);
}

/** Guided Parts: no cutting toolbars, the body by region, and the main button to cut or build. */
async function checkPartsGuided(page: Page): Promise<void> {
  await page.goto(`${APP_URL}/part-cutter`, { waitUntil: "domcontentloaded" }); await page.locator(".step-shell").first().waitFor({ timeout: 40000 }); await page.waitForTimeout(2000);
  assert.equal(await page.locator(".step-shell [role=tablist], .step-shell .cutter-toolbar").count(), 0, "the guided view still shows cutting toolbars");
  const rows = (await page.locator(".step-panel .panel-row").allTextContents()).map((text) => text.trim());
  for (const region of ["Head", "Body", "Arms", "Legs"]) assert.ok(rows.some((row) => row.startsWith(region)), `no ${region} row in the panel (rows: ${rows.join(" | ")})`);
  assert.match((await page.locator(".step-primary").textContent())?.trim() ?? "", /^(Build rig →|Cut all parts)$/);
}

/** The expanded cutter: every control works, the tool keys switch tools, and Done returns to the guided view. */
async function checkPartsExpanded(page: Page): Promise<void> {
  const problems = await checkEveryControl(page, "/part-cutter", "Parts expanded", expandWith(/Edit parts manually/));
  await page.goto(`${APP_URL}/part-cutter`, { waitUntil: "domcontentloaded" }); await page.locator(".step-shell").first().waitFor({ timeout: 90000 });
  await expandWith(/Edit parts manually/)(page);
  // Pick a part so Brush and Erase are available, then try each key.
  await page.locator(".expanded-left .part-row, .expanded-left [role=treeitem], .expanded-left button").filter({ hasText: /Torso/ }).first().click().catch(() => undefined);
  const pressed = async () => (await page.locator(".expanded-tools button[aria-pressed=true]").first().textContent())?.replace(/[A-Z]$/, "").trim();
  for (const [key, name] of [["l", "Lasso"], ["b", "Brush"], ["e", "Erase"]] as const) {
    await page.locator(".expanded-stage").first().click({ position: { x: 5, y: 5 } }).catch(() => undefined);
    await page.keyboard.press(key); await page.waitForTimeout(250);
    const active = await pressed(); if (!(key !== "l" && !(await page.locator(".expanded-tools button", { hasText: name }).first().isEnabled()))) assert.equal(active, name, `pressing ${key.toUpperCase()} left ${active} active`);
  }
  await page.locator(".step-primary").click();
  assert.equal(await page.locator(".step-shell.is-expanded").count(), 0, "Done, back to Parts did not leave the expanded view");
  assert.deepEqual(problems, [], `\n  ${problems.join("\n  ")}`);
}

/** Opens a rig step the way a person does: the project on Parts first, then the step in the step bar. */
async function openRigStep(page: Page, step: "Rig" | "Animate" | "Export"): Promise<void> {
  await page.goto(`${APP_URL}/part-cutter`, { waitUntil: "domcontentloaded" }); await page.locator(".step-shell").first().waitFor({ timeout: 90000 });
  await page.locator(".step-panel .panel-link").first().waitFor({ state: "visible", timeout: 60000 });
  await page.locator(".step-nav button").filter({ hasText: step }).first().click();
  await page.waitForURL(/mode=/, { timeout: 30000 }); await page.locator(".step-shell canvas").first().waitFor({ timeout: 90000 }); await page.waitForTimeout(4000);
}

/** Guided Rig: Facing once, joint groups, pose tests that move the character, and Make animations as the main button. */
async function checkRigGuided(page: Page): Promise<void> {
  await openRigStep(page, "Rig");
  const labels = (await page.locator(".step-panel .panel-label").allTextContents()).map((text) => text.trim().toLowerCase());
  for (const label of ["facing", "joints", "try a pose"]) assert.ok(labels.includes(label), `the Rig panel has no "${label}" section (has: ${labels.join(", ")})`);
  assert.equal(await page.locator(".step-shell [aria-label='Which way the character faces'], .step-shell .facing-ask").count(), 1, "Facing is asked more than once");
  assert.equal(await page.locator(".step-shell .editor-left-panel, .step-shell .editor-right-panel, .step-shell .stage-strip").count(), 0, "the guided Rig stage still shows editor panels or strips");
  assert.equal((await page.locator(".step-primary").textContent())?.trim(), "Make animations →");
  const before = await page.locator(".step-stage").screenshot();
  await page.locator(".step-panel button").filter({ hasText: /^Swing arms$/ }).click(); await page.waitForTimeout(900);
  const after = await page.locator(".step-stage").screenshot();
  assert.ok(!before.equals(after), "Swing arms did not change the stage");
  await page.locator(".step-panel button").filter({ hasText: /^Rest$/ }).click();
  await page.locator(".step-panel .panel-link").filter({ hasText: /Edit bones manually/ }).click();
  await page.locator(".step-shell.is-expanded").waitFor({ timeout: 15000 });
  assert.equal((await page.locator(".step-primary").textContent())?.trim(), "Done, back to Rig");
  await page.locator(".step-primary").click();
  assert.equal(await page.locator(".step-shell.is-expanded").count(), 0, "Done, back to Rig did not return to the guided view");
}

/** Expanded Rig: every control works; picking a bone selects it on the canvas; Snap is offered; the bend test moves the art. */
async function checkRigExpanded(page: Page): Promise<void> {
  const problems = await checkEveryControl(page, "/?mode=setup", "Rig expanded", expandWith(/Edit bones manually/));
  await page.goto(`${APP_URL}/?mode=setup`, { waitUntil: "domcontentloaded" }); await page.locator(".step-shell canvas").first().waitFor({ timeout: 90000 }); await page.waitForTimeout(3000);
  await expandWith(/Edit bones manually/)(page);
  const stage = page.locator(".expanded-stage");
  const before = await stage.screenshot();
  const shoulder = page.locator(".expanded-left section[aria-label='Left arm'] .ex-item").first();
  await shoulder.click(); await page.waitForTimeout(600);
  assert.equal(await shoulder.getAttribute("aria-pressed"), "true", "the picked bone is not marked as selected");
  assert.ok(!before.equals(await stage.screenshot()), "picking the left shoulder did not highlight anything on the canvas");
  const snap = page.locator(".expanded-right button").filter({ hasText: /^Snap to shoulder$/ });
  assert.ok(await snap.isEnabled(), "Snap to shoulder is not offered for the left upper arm");
  await page.locator(".expanded-right button").filter({ hasText: /^Set a bend range$/ }).click(); await page.waitForTimeout(300);
  const rest = await stage.screenshot();
  await page.locator("input[aria-label='Test the bend']").fill("60"); await page.waitForTimeout(800);
  assert.ok(!rest.equals(await stage.screenshot()), "the bend test did not move the arm");
  await snap.click(); await page.waitForTimeout(400);
  assert.ok(!(await snap.isEnabled()) || (await snap.count()) === 0, "Snap to shoulder still offered after snapping");
  await page.locator(".step-primary").click();
  assert.equal(await page.locator(".step-shell.is-expanded").count(), 0, "Done, back to Rig did not leave the expanded view");
  assert.deepEqual(problems, [], `\n  ${problems.join("\n  ")}`);
}

/** Guided Animate: the Look switch, side-by-side previews, a status per clip, a lost job with Retry, and Redrawn off without the bridge. */
async function checkAnimateGuided(page: Page): Promise<void> {
  const bridge = "http://127.0.0.1:47831";
  // A bridge that knows nothing yet and then loses the job (as when Rigging Studio restarts mid-redraw).
  await page.route(`${bridge}/studio/queue`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.route(`${bridge}/bake/redraws/lookup`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ clips: [] }) }));
  await page.route(`${bridge}/bake/jobs`, (route) => route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ jobId: "bake-00000000-0000-0000-0000-000000000000", status: "queued", progress: { done: 0, total: 4, clip: null } }) }));
  await page.route(`${bridge}/bake/jobs/*`, (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Bake does not exist" }) }));
  await page.goto(`${APP_URL}/?mode=animate`, { waitUntil: "domcontentloaded" }); await page.locator(".step-panel .clip-pick").first().waitFor({ timeout: 90000 }); await page.waitForTimeout(1500);
  assert.equal(await page.locator(".step-panel [aria-label='Export look'] button").count(), 2, "no Look switch with Rigged and Redrawn");
  await page.locator(".step-panel [aria-label='Export look'] button").filter({ hasText: /^Redrawn$/ }).click(); await page.waitForTimeout(800);
  const captions = (await page.locator(".look-compare figcaption").allTextContents()).map((text) => text.trim());
  assert.ok(captions.length === 2 && /^Rigged · ▶/.test(captions[0]) && /^Redrawn · ▶/.test(captions[1]), `the Redrawn look does not show two labelled previews (${captions.join(" | ")})`);
  const rows = await page.locator(".step-panel .clip-pick").count(); const statuses = await page.locator(".step-panel .clip-pick-status").count();
  assert.ok(rows > 0 && statuses === rows, `${rows} animations but ${statuses} statuses`);
  assert.equal((await page.locator(".step-primary").textContent())?.trim(), "Redraw the rest");
  // Start one clip's redraw from its row's status line: the bridge loses it, so the row says so and offers Retry.
  const first = page.locator(".step-panel .clip-pick").first();
  await page.locator(".step-primary").click();
  await first.locator(".clip-pick-status").filter({ hasText: /Lost: Rigging Studio restarted/ }).waitFor({ timeout: 15000 });
  assert.equal(await first.locator(".clip-pick-status button").filter({ hasText: /^Retry$/ }).count(), 1, "a lost redraw offers no Retry");
  // No bridge at all: Redrawn cannot be chosen, and says why.
  const offline = await page.context().newPage();
  await offline.route(`${bridge}/**`, (route) => route.abort("connectionrefused"));
  await offline.goto(`${APP_URL}/?mode=animate`, { waitUntil: "domcontentloaded" }); await offline.locator(".step-panel .clip-pick").first().waitFor({ timeout: 90000 }); await offline.waitForTimeout(2500);
  const redrawn = offline.locator(".step-panel [aria-label='Export look'] button").filter({ hasText: /^Redrawn$/ });
  if (await redrawn.getAttribute("aria-pressed") !== "true") {
    assert.ok(await redrawn.isDisabled(), "Redrawn can be chosen with the Mac Studio unreachable");
    assert.match(await redrawn.getAttribute("title") ?? "", /isn't reachable/);
  } else assert.match(await offline.locator(".step-instruction").textContent() ?? "", /isn't reachable/);
  await offline.close();
}

/** Expanded Animate: every control works, the timeline stays inside the centre column, and K keys the selected bone. */
async function checkAnimateExpanded(page: Page): Promise<void> {
  const problems = await checkEveryControl(page, "/?mode=animate", "Animate expanded", expandWith(/Edit keyframes manually/));
  await page.goto(`${APP_URL}/?mode=animate`, { waitUntil: "domcontentloaded" }); await page.locator(".step-panel .clip-pick").first().waitFor({ timeout: 90000 }); await page.waitForTimeout(1500);
  await expandWith(/Edit keyframes manually/)(page); await page.waitForTimeout(1200);
  const centre = await page.locator(".expanded-center").boundingBox(); const timeline = await page.locator(".expanded-bottom").boundingBox();
  assert.ok(centre && timeline && timeline.x >= centre.x - 1 && timeline.x + timeline.width <= centre.x + centre.width + 1, "the timeline is wider than the centre column");
  const pauseButton = page.locator(".expanded-tools button[aria-label='Pause']"); if (await pauseButton.count()) await pauseButton.click();
  await page.locator(".clip-bones button").first().click();
  for (let step = 0; step < 3; step += 1) await page.keyboard.press("ArrowRight");
  const before = await page.locator(".key-diamond").count();
  await page.keyboard.press("k"); await page.waitForTimeout(500);
  assert.ok(await page.locator(".key-diamond").count() > before, "K did not add a key at the playhead");
  await page.locator(".step-primary").click();
  assert.equal(await page.locator(".step-shell.is-expanded").count(), 0, "Done, back to Animate did not leave the expanded view");
  assert.deepEqual(problems, [], `\n  ${problems.join("\n  ")}`);
}

/** Export: no dialog anywhere; the Rigged look's button downloads the sheet; the Redrawn look waits for missing redraws, saying why. */
async function checkExport(page: Page): Promise<void> {
  // Earlier checks may have saved another look to the disk project; start from the fixture as installed.
  await installFixtures();
  const bridge = "http://127.0.0.1:47831"; const jobId = "bake-00000000-0000-0000-0000-0000000000e1";
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const sheetJson = JSON.stringify({ format: "rigging-studio-sheet/1", cell: { w: 1, h: 1 }, pivot: { x: 0, y: 1 }, clips: [{ id: "idle", name: "Idle", loop: true, frames: [{ x: 0, y: 0, w: 1, h: 1, durationMs: 100 }] }] });
  const job = { jobId, mode: "rig", status: "completed", progress: { done: 1, total: 1, clip: null }, result: { sheet: `/bake/assets/${jobId}/sheet.png`, json: `/bake/assets/${jobId}/sheet.json`, drawings: 1, polished: 0, keptFromRig: 0 } };
  await page.route(`${bridge}/studio/queue`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.route(`${bridge}/bake/redraws/lookup`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ clips: [] }) }));
  await page.route(`${bridge}/bake/jobs`, (route) => route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify(job) }));
  await page.route(`${bridge}/bake/jobs/*`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(job) }));
  await page.route(`${bridge}/bake/assets/**`, (route) => route.request().url().endsWith(".png")
    ? route.fulfill({ status: 200, contentType: "image/png", headers: { "Content-Disposition": 'attachment; filename="sheet.png"' }, body: png })
    : route.fulfill({ status: 200, contentType: "application/json", headers: { "Content-Disposition": 'attachment; filename="sheet.json"' }, body: sheetJson }));
  await page.goto(`${APP_URL}/?mode=export`, { waitUntil: "domcontentloaded" }); await page.locator(".step-panel [aria-label='Export format']").waitFor({ timeout: 90000 });
  assert.equal(await page.locator(".export-for-game, .studio-dialog.export-for-game").count(), 0, "the old export dialog is still on the page");
  const primary = page.locator(".step-primary");
  await page.waitForFunction(() => document.querySelector(".step-primary")?.textContent?.trim() === "Download sprite sheet", undefined, { timeout: 30000 })
    .catch(async () => { throw new Error(`Export's button never read "Download sprite sheet": "${await primary.textContent()}" · ${await page.locator(".step-instruction").textContent()} · ${(await page.locator(".step-panel").innerText()).replace(/\n+/g, " | ").slice(0, 300)}`); });
  await page.waitForFunction(() => !(document.querySelector(".step-primary") as HTMLButtonElement | null)?.disabled, undefined, { timeout: 30000 });
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), primary.click()]);
  assert.match(download.suggestedFilename(), /sheet\.(png|json)$/);
  // Redrawn look with nothing redrawn yet: the button waits, and says why.
  await page.locator(".step-nav button").filter({ hasText: "Animate" }).click(); await page.locator(".step-panel [aria-label='Export look']").waitFor({ timeout: 60000 });
  await page.locator(".step-panel [aria-label='Export look'] button").filter({ hasText: /^Redrawn$/ }).click(); await page.waitForTimeout(500);
  await page.locator(".step-nav button").filter({ hasText: "Export" }).click(); await page.locator(".step-panel [aria-label='Export format']").waitFor({ timeout: 60000 }); await page.waitForTimeout(1500);
  assert.ok(await primary.isDisabled(), `Download sprite sheet is offered while animations are not redrawn (button "${await primary.textContent()}", title "${await primary.getAttribute("title")}", instruction "${await page.locator(".step-instruction").textContent()}", note "${await page.locator(".step-panel .panel-note").first().textContent()}")`);
  assert.match(await primary.getAttribute("title") ?? "", /redrawn yet; finish them in Animate/);
}

const checks: readonly (readonly [string, (page: Page) => Promise<void>, string?])[] = [
  ["Create stays on Create with a rigged project open", checkCreateStaysOnCreate],
  ["Every step renders in the shared frame", checkShellOnEveryStep],
  ["A step that is not open yet redirects with its reason", checkUnavailableStepRedirects, UNRIGGED.id],
  ["Create: model cards, description, Generate", checkCreateGuided],
  ["Create: says when the Mac Studio is unreachable", checkCreateOffline],
  ["Create: expanded view works and returns", checkCreateExpanded],
  ["Parts: guided view with regions", checkPartsGuided],
  ["Parts: expanded cutter works and returns", checkPartsExpanded],
  ["Rig: guided view with joints and pose tests", checkRigGuided],
  ["Rig: expanded view (skeleton, joint, bend test)", checkRigExpanded],
  ["Animate: Look switch, previews, redraw status", checkAnimateGuided],
  ["Animate: expanded keyframe editor", checkAnimateExpanded],
  ["Export: downloads, and waits for missing redraws", checkExport],
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
    catch (error: unknown) { failed += 1; console.log(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`); if (process.env.DEBUG && error instanceof Error) console.log(error.stack?.split("\n").slice(1, 6).join("\n")); }
    finally { await context.close(); }
  }
} finally { await browser.close(); }
const ran = checks.filter(([name]) => !process.env.ONLY || name.includes(process.env.ONLY)).length;
console.log(`${ran - failed} / ${ran} checks pass`);
if (failed) process.exit(1);
