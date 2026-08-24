/* eslint-disable @typescript-eslint/no-explicit-any -- evidence schemas intentionally preserve heterogeneous browser JSON */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, join, resolve } from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright";

const ROOT = resolve(import.meta.dirname, "../..");
const OUTPUT_ROOT = join(ROOT, ".rigging-studio/diagnostics/ux-inspection");
const FIXTURE_IMAGE = join(ROOT, "public/rig-test/body-base.png");
const SCHEMA_VERSION = 1;
const DEFAULT_VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 900, height: 800 },
  { width: 760, height: 800 },
] as const;

type Viewport = { width: number; height: number };
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type RuntimeEvent = { at: string; state?: string; viewport?: string; type: string; text?: string; url?: string; method?: string; status?: number; initiator?: string };
type ClassifiedRuntimeEvent = RuntimeEvent & { classification: "EXPECTED_OPTIONAL_SERVICE" | "EXPECTED_RETRY" | "ACTIONABLE_EDITOR_DEFECT"; signature: string };
type StateDefinition = { id: string; section: "prepare" | "setup" | "animate"; prepare: (page: Page) => Promise<void> };

const isoRunId = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, "Z").replaceAll(":", "-");
const viewportId = ({ width, height }: Viewport): string => `${width}x${height}`;
const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const round = (value: number | null | undefined, precision = 2): number | null => value == null || !Number.isFinite(value) ? null : Number(value.toFixed(precision));
const writeJson = async (path: string, value: unknown): Promise<void> => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
const normalizedSignature = (value = ""): string => value.replace(/https?:\/\/[^\s)]+/g, "[URL]").replace(/\b\d+(?:\.\d+)?\b/g, "#").replace(/\s+/g, " ").trim();
const endpointFailureSignature = (event: RuntimeEvent): string => {
  let endpoint = event.url ?? "unknown";
  try { const url = new URL(endpoint); endpoint = `${event.method ?? "GET"} ${url.origin}${url.pathname}`; } catch { endpoint = `${event.method ?? "GET"} ${endpoint}`; }
  return `${endpoint} · ${event.status ?? (normalizedSignature(event.text) || event.type)}`;
};
const countedSignatures = (values: string[]): { signature: string; count: number }[] => Object.entries(values.reduce<Record<string, number>>((counts, value) => { counts[value] = (counts[value] ?? 0) + 1; return counts; }, {})).map(([signature, count]) => ({ signature, count })).sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));
const classifyRuntimeEvent = (event: RuntimeEvent, prior: readonly RuntimeEvent[] = []): ClassifiedRuntimeEvent => {
  const source = `${event.url ?? ""} ${event.text ?? ""}`;
  // Chromium emits an unattributed console error in addition to the attributed
  // requestfailed event. The endpoint event remains the authoritative defect
  // classification; the duplicate generic console line is browser noise.
  const optional = /ollama|11434|47831|local[- ]?ai|provider.*(?:status|capabil)|project-storage|image-production|character-generation|WebSocket connection to 'ws:\/\/|Failed to load resource: net::ERR_CONNECTION_REFUSED/i.test(source);
  const signature = event.type.startsWith("network") ? endpointFailureSignature(event) : `${event.type} · ${normalizedSignature(event.text)}`;
  const repeated = prior.some((candidate) => (candidate.type.startsWith("network") ? endpointFailureSignature(candidate) : `${candidate.type} · ${normalizedSignature(candidate.text)}`) === signature);
  return { ...event, signature, classification: optional ? "EXPECTED_OPTIONAL_SERVICE" : repeated ? "EXPECTED_RETRY" : "ACTIONABLE_EDITOR_DEFECT" };
};

function parseArgs(argv: readonly string[]) {
  const value = (name: string): string | undefined => {
    const inline = argv.find((item) => item.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const requestedViewports = value("--viewports")?.split(",").map((item) => {
    const match = /^(\d+)x(\d+)$/.exec(item.trim());
    return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
  }).filter((item): item is Viewport => Boolean(item));
  return {
    baseUrl: value("--url") ?? process.env.RIG_STUDIO_URL,
    headless: !argv.includes("--headed"),
    runId: value("--run-id") ?? isoRunId(),
    stateFilter: value("--states")?.split(",").map(slug),
    viewports: requestedViewports?.length ? requestedViewports : [...DEFAULT_VIEWPORTS],
  };
}

async function discoverBaseUrl(explicit?: string): Promise<{ url: string; evidence: Json[] }> {
  const evidence: Json[] = [];
  const candidates = [...new Set([
    explicit,
    ...Array.from({ length: 31 }, (_, index) => `http://localhost:${3000 + index}`),
    ...Array.from({ length: 21 }, (_, index) => `http://localhost:${5173 + index}`),
    "http://localhost:4173",
  ].filter((item): item is string => Boolean(item)).map((item) => item.replace(/\/$/, "")))];
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, { signal: AbortSignal.timeout(1_500) });
      const body = await response.text();
      const title = /<title[^>]*>([^<]+)/i.exec(body)?.[1]?.trim() ?? "";
      const matches = response.ok && /Rig Studio/i.test(`${title} ${body.slice(0, 40_000)}`);
      evidence.push({ candidate, status: response.status, title, matches });
      if (matches) return { url: candidate, evidence };
    } catch (error) {
      evidence.push({ candidate, result: error instanceof Error ? error.message : String(error) });
    }
  }
  throw new Error(`No reachable localhost page identified itself as Rig Studio. Start the app, pass --url, or set RIG_STUDIO_URL. Checked ${candidates.join(", ")}`);
}

async function findChromiumExecutable(): Promise<string | undefined> {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    chromium.executablePath(),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter((item): item is string => Boolean(item));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* continue */ }
  }
  return undefined;
}

function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const sensitive = /token|key|secret|auth|password|signature|credential|session/i;
    [...url.searchParams.keys()].forEach((key) => { if (sensitive.test(key)) url.searchParams.set(key, "[REDACTED]"); });
    url.username = ""; url.password = "";
    return url.toString();
  } catch { return raw.replace(/(authorization|token|secret|api[_-]?key)=([^&\s]+)/gi, "$1=[REDACTED]"); }
}

async function attachRuntimeCapture(page: Page, sink: RuntimeEvent[], state: string, viewport: string): Promise<void> {
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") sink.push({ at: new Date().toISOString(), state, viewport, type: `console.${message.type()}`, text: message.text() });
  });
  page.on("pageerror", (error) => sink.push({ at: new Date().toISOString(), state, viewport, type: "pageerror", text: error.message }));
  page.on("requestfailed", (request) => sink.push({ at: new Date().toISOString(), state, viewport, type: "network.failed", url: redactUrl(request.url()), method: request.method(), text: request.failure()?.errorText, initiator: request.resourceType() }));
  page.on("response", (response) => {
    if (response.status() >= 400) sink.push({ at: new Date().toISOString(), state, viewport, type: "network.http", url: redactUrl(response.url()), method: response.request().method(), status: response.status(), initiator: response.request().resourceType() });
  });
}

async function gotoReady(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  // tsx/esbuild preserves inferred function names through this helper. Playwright
  // serializes evaluate callbacks without module-scope helpers, so expose the
  // identity helper in the page realm before any callback with local functions.
  await page.evaluate("globalThis.__name = (target) => target");
  await page.locator(".studio-command-rail").waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForTimeout(450);
}

async function preparePartCutter(page: Page, baseUrl: string): Promise<void> {
  await gotoReady(page, `${baseUrl}/part-cutter`);
  const workspace = page.locator(".part-cutter-body");
  if (!await workspace.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Import character" }).waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForTimeout(350);
    await page.locator('input[type="file"][accept*="image/png"]').first().setInputFiles(FIXTURE_IMAGE);
    await workspace.waitFor({ state: "visible", timeout: 20_000 });
  }
  await page.waitForTimeout(600);
}

async function drawDisposableRegion(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Manual" }).click();
  await page.getByRole("button", { name: "Lasso Cut" }).click();
  const svg = page.locator(".cutter-canvas svg");
  const box = await svg.boundingBox();
  if (!box) throw new Error("Prepare canvas did not expose measurable SVG bounds");
  const center = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.42 };
  const rx = Math.max(10, box.width * 0.16); const ry = Math.max(14, box.height * 0.16);
  await page.mouse.move(center.x + rx, center.y);
  await page.mouse.down();
  for (let index = 1; index <= 24; index += 1) {
    const angle = index / 24 * Math.PI * 2;
    await page.mouse.move(center.x + Math.cos(angle) * rx, center.y + Math.sin(angle) * ry);
  }
  await page.mouse.up();
  const chooser = page.getByRole("dialog", { name: "Assign manual selection" });
  await chooser.waitFor({ state: "visible", timeout: 5_000 });
  await chooser.getByRole("button", { name: "Create Part" }).click();
  await page.locator("[data-region-id]").first().waitFor({ state: "attached", timeout: 10_000 });
  await page.waitForTimeout(250);
}

async function prepareStateDefinitions(baseUrl: string): Promise<StateDefinition[]> {
  const prepareBase = async (page: Page) => preparePartCutter(page, baseUrl);
  const setupBase = async (page: Page) => { await gotoReady(page, `${baseUrl}/?mode=setup`); await page.locator(".editor-body").waitFor({ state: "visible", timeout: 15_000 }); };
  const animateBase = async (page: Page) => { await gotoReady(page, `${baseUrl}/?mode=animate`); await page.locator(".animate-workspace").waitFor({ state: "visible", timeout: 15_000 }); };
  return [
    { id: "prepare-guided", section: "prepare", prepare: async (page) => { await prepareBase(page); await page.getByRole("tab", { name: "Guided" }).click(); await page.waitForTimeout(300); } },
    { id: "prepare-manual-lasso", section: "prepare", prepare: async (page) => { await prepareBase(page); await page.getByRole("tab", { name: "Manual" }).click(); await page.getByRole("button", { name: "Lasso Cut" }).click(); } },
    { id: "prepare-manual-selected-region", section: "prepare", prepare: async (page) => { await prepareBase(page); await drawDisposableRegion(page); } },
    { id: "prepare-review", section: "prepare", prepare: async (page) => { await prepareBase(page); await drawDisposableRegion(page); const action = page.locator(".prepare-rail-action"); if (await action.isEnabled()) await action.click(); await page.waitForTimeout(250); } },
    { id: "prepare-assist-offline", section: "prepare", prepare: async (page) => { await prepareBase(page); await page.getByRole("tab", { name: "Assist" }).click(); await page.waitForTimeout(400); } },
    { id: "prepare-ollama-status", section: "prepare", prepare: async (page) => { await prepareBase(page); await page.locator(".connection-cluster > summary").click(); await page.getByRole("button", { name: "Local AI settings" }).click(); await page.getByRole("dialog", { name: "Local AI settings" }).waitFor(); } },
    { id: "setup-no-selection", section: "setup", prepare: setupBase },
    { id: "setup-body-selected", section: "setup", prepare: async (page) => { await setupBase(page); await page.locator(".semantic-object").first().click(); } },
    { id: "setup-pivot-selected", section: "setup", prepare: async (page) => { await setupBase(page); await page.locator(".setup-progress button").filter({ hasText: /pivots/i }).click(); await page.locator(".semantic-object").first().click(); } },
    { id: "setup-equipment", section: "setup", prepare: async (page) => { await setupBase(page); await page.locator(".semantic-section-nav").getByRole("button", { name: "equipment", exact: true }).click(); } },
    { id: "animate-timeline", section: "animate", prepare: animateBase },
    { id: "animate-animation-selected", section: "animate", prepare: async (page) => { await animateBase(page); await page.locator(".animation-library-list button").nth(1).evaluate((element: HTMLElement) => element.click()); } },
    { id: "animate-keyframe-selected", section: "animate", prepare: async (page) => { await animateBase(page); await page.locator(".key-diamond:not(.summary)").first().evaluate((element: HTMLElement) => element.click()); } },
    { id: "animate-playback-active", section: "animate", prepare: async (page) => { await animateBase(page); await page.locator(".play-action").evaluate((element: HTMLElement) => element.click()); await page.waitForTimeout(200); } },
  ];
}

async function collectPageEvidence(page: Page, state: StateDefinition, viewport: Viewport) {
  return page.evaluate(({ stateId, section, viewport }) => {
    type Bounds = { x: number; y: number; width: number; height: number; right: number; bottom: number };
    const rounded = (value: number, precision = 2) => Number(value.toFixed(precision));
    const bounds = (element: Element): Bounds => {
      const rect = element.getBoundingClientRect();
      return { x: rounded(rect.x), y: rounded(rect.y), width: rounded(rect.width), height: rounded(rect.height), right: rounded(rect.right), bottom: rounded(rect.bottom) };
    };
    const selector = (element: Element): string => {
      if (element.id) return `#${CSS.escape(element.id)}`;
      const testId = element.getAttribute("data-testid");
      if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current !== document.body && parts.length < 5) {
        let part = current.tagName.toLowerCase();
        const stableClass = [...current.classList].find((name) => !/^(active|selected|is-|has-|mode-)/.test(name));
        if (stableClass) part += `.${CSS.escape(stableClass)}`;
        else if (current.parentElement) part += `:nth-child(${[...current.parentElement.children].indexOf(current) + 1})`;
        parts.unshift(part); current = current.parentElement;
      }
      return parts.join(" > ");
    };
    const style = (element: Element) => getComputedStyle(element);
    const isVisible = (element: Element): boolean => {
      const css = style(element); const rect = element.getBoundingClientRect();
      return css.display !== "none" && css.visibility !== "hidden" && Number(css.opacity) > 0 && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.left < innerWidth && rect.top < innerHeight;
    };
    const visibleText = (element: Element): string => (element.textContent ?? "").replace(/\s+/g, " ").trim();
    const accessibleName = (element: Element): string => {
      const labelledBy = element.getAttribute("aria-labelledby");
      if (labelledBy) {
        const value = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim()).filter(Boolean).join(" ");
        if (value) return value;
      }
      const explicit = element.getAttribute("aria-label") || element.getAttribute("alt") || element.getAttribute("title");
      if (explicit) return explicit.trim();
      if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
        const label = element.labels?.[0]?.textContent?.replace(/\s+/g, " ").trim();
        if (label) return label;
        if (element instanceof HTMLInputElement && ["button", "submit", "reset"].includes(element.type)) return element.value;
        return element.getAttribute("placeholder") ?? "";
      }
      return visibleText(element);
    };
    const role = (element: Element): string => element.getAttribute("role") || ({ BUTTON: "button", A: "link", INPUT: "input", SELECT: "combobox", TEXTAREA: "textbox", SUMMARY: "button" }[element.tagName] ?? "");
    const interactiveSelector = "button, a[href], input, select, textarea, summary, [role=button], [role=tab], [role=menuitem], [role=slider], [role=switch], [draggable=true]";
    const interactives = [...document.querySelectorAll(interactiveSelector)].filter(isVisible).map((element) => {
      const css = style(element); const box = bounds(element);
      return {
        selector: selector(element), tag: element.tagName.toLowerCase(), role: role(element), accessibleName: accessibleName(element), text: visibleText(element),
        aria: Object.fromEntries([...element.attributes].filter((attribute) => attribute.name.startsWith("aria-")).map((attribute) => [attribute.name, attribute.value])),
        disabled: element.matches(":disabled") || element.getAttribute("aria-disabled") === "true", pressed: element.getAttribute("aria-pressed"), checked: element.getAttribute("aria-checked"), current: element.getAttribute("aria-current"), expanded: element.getAttribute("aria-expanded"),
        bounds: box, zIndex: css.zIndex, display: css.display, visibility: css.visibility, opacity: css.opacity,
      };
    });

    const leafTextElements = [...document.querySelectorAll("body *")].filter((element) => isVisible(element) && [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim()));
    const typographyGroups = new Map<string, { count: number; example: string; fontFamily: string; fontSize: string; fontWeight: string; lineHeight: string; letterSpacing: string; textTransform: string; color: string }>();
    const typographyBuckets: Record<string, number> = { "<=10px": 0, "11px": 0, "12px": 0, "13px": 0, "14px": 0, "15px": 0, "16px": 0, "17px": 0, "18px+": 0 };
    leafTextElements.forEach((element) => {
      const css = style(element); const size = parseFloat(css.fontSize); const bucket = size <= 10 ? "<=10px" : size >= 18 ? "18px+" : `${Math.ceil(size)}px`;
      typographyBuckets[bucket] = (typographyBuckets[bucket] ?? 0) + 1;
      const key = [css.fontFamily, css.fontSize, css.fontWeight, css.lineHeight, css.letterSpacing, css.textTransform, css.color].join("|");
      const current = typographyGroups.get(key);
      if (current) current.count += 1;
      else typographyGroups.set(key, { count: 1, example: visibleText(element).slice(0, 120), fontFamily: css.fontFamily, fontSize: css.fontSize, fontWeight: css.fontWeight, lineHeight: css.lineHeight, letterSpacing: css.letterSpacing, textTransform: css.textTransform, color: css.color });
    });
    const microtextCount = typographyBuckets["<=10px"] + typographyBuckets["11px"];

    const buttons = [...document.querySelectorAll("button, [role=button], summary")].filter(isVisible).map((element) => {
      const css = style(element); const box = bounds(element); const html = element as HTMLElement;
      const label = accessibleName(element) || visibleText(element);
      const explicitRole = element.getAttribute("data-ux-role");
      const validRoles = new Set(["primary-action", "secondary-action", "tool", "mode", "status", "navigation", "destructive-action"]);
      const uxRole = explicitRole && validRoles.has(explicitRole) ? explicitRole
        : element.closest("nav") ? "navigation"
        : /danger|destructive/.test(String(element.className)) || /delete|remove|reject/i.test(label) ? "destructive-action"
        : element.matches("[aria-pressed], [role=tab]") ? "mode"
        : element.closest(".systems-popover,.system-status-row") || /status|issues|valid/i.test(element.className) ? "status"
        : element.matches(".primary,.rail-export,.prepare-rail-action,.stage-next-action,.build-rig") ? "primary-action"
        : /accept|continue|approve|enter animate|refine|create keyframe|new animation/i.test(label) ? "secondary-action"
        : "tool";
      return {
        selector: selector(element), label, uxRole, uxRoleSource: explicitRole && validRoles.has(explicitRole) ? "explicit" : "inferred", bounds: box, width: box.width, height: box.height,
        padding: `${css.paddingTop} ${css.paddingRight} ${css.paddingBottom} ${css.paddingLeft}`, fontSize: css.fontSize, borderRadius: css.borderRadius, background: css.backgroundColor, border: `${css.borderWidth} ${css.borderStyle} ${css.borderColor}`,
        disabled: element.matches(":disabled") || element.getAttribute("aria-disabled") === "true", active: element.matches(".active,.is-active,.selected,.is-selected") || element.getAttribute("aria-pressed") === "true" || element.getAttribute("aria-selected") === "true",
        flags: { heightUnder32: box.height < 32, widthUnder32: box.width < 32, textClipping: html.scrollWidth > html.clientWidth + 1, iconClipping: [...element.querySelectorAll("svg,img,i")].some((child) => { const rect = child.getBoundingClientRect(); return rect.left < box.x || rect.right > box.right || rect.top < box.y || rect.bottom > box.bottom; }) },
      };
    });
    const duplicateButtonLabels = Object.entries(buttons.reduce<Record<string, number>>((counts, button) => { const key = button.label.trim().toLowerCase(); if (key) counts[key] = (counts[key] ?? 0) + 1; return counts; }, {})).filter(([, count]) => count > 1).map(([label, count]) => ({ label, count }));

    buttons.forEach((button) => {
      const element = document.querySelector(button.selector); if (!element || button.disabled) return;
      const css = style(element); const bg = css.backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [];
      const saturation = bg.length >= 3 ? Math.max(bg[0], bg[1], bg[2]) - Math.min(bg[0], bg[1], bg[2]) : 0;
      const viewportRight = button.bounds.right > innerWidth * 0.68;
      const large = button.width >= 120 || button.height >= 40;
      const bold = Number(css.fontWeight) >= 600;
      const filled = css.backgroundColor !== "rgba(0, 0, 0, 0)" && css.backgroundColor !== "transparent";
      const score = Number(filled) + Number(saturation >= 35) + Number(viewportRight) + Number(large) + Number(bold);
      (button as typeof button & { heuristicScore?: number }).heuristicScore = score;
    });
    const scoredButtons = buttons.filter((button) => !button.disabled);
    const primaryCandidates = scoredButtons.filter((button) => button.uxRole === "primary-action").map((button) => ({ label: button.label, selector: button.selector, bounds: button.bounds, uxRole: button.uxRole, uxRoleSource: button.uxRoleSource, heuristicScore: (button as typeof button & { heuristicScore?: number }).heuristicScore ?? 0 }));
    const ctaCandidates = scoredButtons.filter((button) => button.uxRole === "primary-action" || button.uxRole === "secondary-action" || button.uxRole === "destructive-action").map((button) => ({ label: button.label, selector: button.selector, bounds: button.bounds, uxRole: button.uxRole, uxRoleSource: button.uxRoleSource, heuristicScore: (button as typeof button & { heuristicScore?: number }).heuristicScore ?? 0 }));

    const knownPanels: Record<string, string[]> = {
      topRail: [".studio-command-rail"], leftRail: [".cutter-left", ".editor-left-panel", ".animate-bones"], rightRail: [".cutter-right", ".editor-right-panel"],
      bottomRail: [".prepare-action-rail", ".setup-workflow-rail"], timeline: [".dope-sheet"], canvas: [".cutter-canvas-wrap", ".editor-viewport", ".animate-viewport-wrap"], canvasToolbar: [".cutter-toolbar", ".viewport-context-row", ".animation-toolbar"], stageRail: [".studio-mode-nav"],
      commandPalette: [".command-palette"], systemsPopover: [".systems-popover"], viewPopover: [".cutter-view-popover > div", ".canvas-popover > div"],
    };
    const panelEntries = Object.entries(knownPanels).map(([name, candidates]) => {
      const element = candidates.map((candidate) => document.querySelector(candidate)).find((candidate): candidate is Element => Boolean(candidate && isVisible(candidate)));
      if (!element) return [name, null] as const;
      const css = style(element); const box = bounds(element);
      const rows = [...element.querySelectorAll("button, li, [role=row], label")].filter(isVisible).map((row) => row.getBoundingClientRect().height).filter(Boolean);
      return [name, { selector: selector(element), bounds: box, position: css.position, zIndex: css.zIndex, background: css.backgroundColor, visibleRowCount: rows.length, averageRowHeight: rows.length ? rounded(rows.reduce((sum, value) => sum + value, 0) / rows.length) : null, smallestRowHeight: rows.length ? rounded(Math.min(...rows)) : null, textCharacters: visibleText(element).length, textDensity: box.width * box.height ? rounded(visibleText(element).length / (box.width * box.height) * 10_000, 3) : null, dividerCount: [...element.querySelectorAll("hr, [role=separator]")].length, boxedSurfaceCount: [...element.querySelectorAll("section, article, fieldset, details")].filter(isVisible).length, ctaCount: [...element.querySelectorAll("button, a[href]")].filter(isVisible).length }] as const;
    });
    const panels = Object.fromEntries(panelEntries);

    const bottomCandidates = [...document.querySelectorAll("body *")].filter((element) => {
      if (!isVisible(element)) return false;
      const rect = element.getBoundingClientRect(); const css = style(element);
      const hasBackground = css.backgroundColor !== "rgba(0, 0, 0, 0)" && css.backgroundColor !== "transparent";
      const positioned = ["fixed", "sticky", "absolute"].includes(css.position);
      const semanticBottom = element.matches("footer, [role=status], output, .dope-sheet, .timeline-toolbar");
      return rect.bottom > innerHeight - 140 && rect.top < innerHeight && (hasBackground || positioned || semanticBottom) && (rect.height <= 240 || positioned || semanticBottom);
    }).filter((element) => ![...element.children].some((child) => isVisible(child) && child.getBoundingClientRect().width >= element.getBoundingClientRect().width * .95 && child.getBoundingClientRect().height >= element.getBoundingClientRect().height * .95));
    const bottomSurfaces = bottomCandidates.map((element) => ({ selector: selector(element), name: accessibleName(element).slice(0, 100) || element.className || element.tagName.toLowerCase(), bounds: bounds(element), position: style(element).position, zIndex: style(element).zIndex, background: style(element).backgroundColor, text: visibleText(element).slice(0, 300), controlsContained: [...element.querySelectorAll(interactiveSelector)].filter(isVisible).length }));
    const verticalIntervals = bottomSurfaces.map((surface) => [Math.max(innerHeight - 140, surface.bounds.y), Math.min(innerHeight, surface.bounds.bottom)] as [number, number]).filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
    const mergedIntervals: [number, number][] = [];
    verticalIntervals.forEach(([start, end]) => { const last = mergedIntervals.at(-1); if (last && start <= last[1]) last[1] = Math.max(last[1], end); else mergedIntervals.push([start, end]); });
    const occupiedDepth = mergedIntervals.reduce((sum, [start, end]) => sum + end - start, 0);
    let bottomOverlaps = 0;
    for (let index = 0; index < bottomSurfaces.length; index += 1) for (let other = index + 1; other < bottomSurfaces.length; other += 1) {
      const a = bottomSurfaces[index].bounds; const b = bottomSurfaces[other].bounds;
      if (Math.min(a.right, b.right) > Math.max(a.x, b.x) && Math.min(a.bottom, b.bottom) > Math.max(a.y, b.y)) bottomOverlaps += 1;
    }

    const canvas = panels.canvas as { bounds: Bounds } | null;
    const canvasMetrics = canvas ? { bounds: canvas.bounds, visibleAreaRatio: rounded(Math.max(0, Math.min(canvas.bounds.right, innerWidth) - Math.max(0, canvas.bounds.x)) * Math.max(0, Math.min(canvas.bounds.bottom, innerHeight) - Math.max(0, canvas.bounds.y)) / (innerWidth * innerHeight), 4), widthRatio: rounded(canvas.bounds.width / innerWidth, 4), heightRatio: rounded(canvas.bounds.height / innerHeight, 4), obstructions: Object.entries(panels).filter(([name, value]) => name !== "canvas" && value && ["leftRail", "rightRail", "topRail", "bottomRail", "timeline", "commandPalette", "systemsPopover", "viewPopover"].includes(name)).map(([name, value]) => ({ name, bounds: (value as { bounds: Bounds }).bounds })) } : null;

    const spacingValues: number[] = [];
    [...document.querySelectorAll("body *")].filter(isVisible).forEach((element) => {
      const css = style(element);
      [css.gap, css.rowGap, css.columnGap, css.paddingTop, css.paddingRight, css.paddingBottom, css.paddingLeft, css.marginTop, css.marginRight, css.marginBottom, css.marginLeft].forEach((raw) => { const value = parseFloat(raw); if (Number.isFinite(value) && value >= 0) spacingValues.push(Math.round(value)); });
    });
    const spacingBuckets: Record<string, number> = { "4px": 0, "6px": 0, "8px": 0, "10px": 0, "12px": 0, "16px": 0, "20px": 0, "24px+": 0 };
    spacingValues.forEach((value) => { const key = value >= 24 ? "24px+" : `${value}px`; if (key in spacingBuckets) spacingBuckets[key] += 1; });
    const denseClusters: { first: string; second: string; gap: number }[] = [];
    const interactiveElements = [...document.querySelectorAll(interactiveSelector)].filter(isVisible);
    for (let index = 0; index < interactiveElements.length; index += 1) for (let other = index + 1; other < Math.min(interactiveElements.length, index + 12); other += 1) {
      const a = interactiveElements[index].getBoundingClientRect(); const b = interactiveElements[other].getBoundingClientRect();
      const horizontalOverlap = Math.min(a.right, b.right) > Math.max(a.left, b.left); const verticalOverlap = Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
      const gap = horizontalOverlap ? Math.max(0, Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom)) : verticalOverlap ? Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right)) : Infinity;
      if (gap < 4) denseClusters.push({ first: selector(interactiveElements[index]), second: selector(interactiveElements[other]), gap: rounded(gap) });
    }

    const overflow = [...document.querySelectorAll("body *")].filter(isVisible).flatMap((element) => {
      const html = element as HTMLElement; const css = style(element); const text = visibleText(element);
      const horizontal = html.scrollWidth > html.clientWidth + 1; const vertical = html.scrollHeight > html.clientHeight + 1;
      if (!horizontal && !vertical) return [];
      const expected = /(auto|scroll)/.test(`${css.overflow} ${css.overflowX} ${css.overflowY}`);
      const knownScrollable = element.matches(".dope-sheet,.time-ruler,.timeline-lanes,.semantic-tree,.animate-bone-list,.systems-popover,.command-results,.cutter-toolbar,.animation-command-row");
      const clippedText = Boolean(text && !expected && !knownScrollable && !element.getAttribute("title") && (css.textOverflow === "ellipsis" || css.overflow === "hidden" || css.overflowX === "hidden" || css.overflowY === "hidden"));
      const classification = expected || knownScrollable ? "EXPECTED_SCROLL" : clippedText ? "TEXT_CLIP" : html.clientWidth === 0 || html.clientHeight === 0 ? "UNKNOWN" : "LAYOUT_OVERFLOW";
      return [{ selector: selector(element), text: text.slice(0, 180), clientWidth: html.clientWidth, scrollWidth: html.scrollWidth, clientHeight: html.clientHeight, scrollHeight: html.scrollHeight, horizontal, vertical, classification, expectedScrollContainer: classification === "EXPECTED_SCROLL", clippedWithoutTooltip: clippedText }];
    });

    const overlapPairs: { first: string; second: string; rectangle: Bounds }[] = [];
    for (let index = 0; index < interactiveElements.length; index += 1) for (let other = index + 1; other < interactiveElements.length; other += 1) {
      const a = interactiveElements[index].getBoundingClientRect(); const b = interactiveElements[other].getBoundingClientRect();
      const left = Math.max(a.left, b.left); const top = Math.max(a.top, b.top); const right = Math.min(a.right, b.right); const bottom = Math.min(a.bottom, b.bottom);
      if (right - left > 2 && bottom - top > 2) overlapPairs.push({ first: selector(interactiveElements[index]), second: selector(interactiveElements[other]), rectangle: { x: rounded(left), y: rounded(top), width: rounded(right - left), height: rounded(bottom - top), right: rounded(right), bottom: rounded(bottom) } });
      if (overlapPairs.length >= 200) break;
    }

    const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
    const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    const invalidAriaReferences = [...document.querySelectorAll("[aria-labelledby], [aria-describedby], [aria-controls], [aria-owns]")].flatMap((element) => ["aria-labelledby", "aria-describedby", "aria-controls", "aria-owns"].flatMap((attribute) => (element.getAttribute(attribute) ?? "").split(/\s+/).filter(Boolean).filter((id) => !document.getElementById(id)).map((id) => ({ selector: selector(element), attribute, missingId: id }))));
    const missingButtonNames = [...document.querySelectorAll("button, [role=button]")].filter(isVisible).filter((element) => !accessibleName(element)).map(selector);
    const unlabeledInputs = [...document.querySelectorAll("input:not([type=hidden]), select, textarea")].filter(isVisible).filter((element) => !accessibleName(element)).map(selector);
    const zeroSizeFocusable = interactiveElements.filter((element) => { const rect = element.getBoundingClientRect(); return rect.width === 0 || rect.height === 0; }).map(selector);
    const lowHitTargets = interactives.flatMap((item) => {
      const element = document.querySelector(item.selector); if (!element || element.matches(".timeline-resize-handle")) return [];
      const label = element.closest("label"); const effective = label && isVisible(label) ? bounds(label) : item.bounds;
      return effective.width < 24 || effective.height < 24 ? [{ selector: item.selector, name: item.accessibleName, bounds: item.bounds, effectiveBounds: effective }] : [];
    });

    return {
      schemaVersion: 1, state: stateId, section, viewport: { ...viewport, pageWidth: document.documentElement.scrollWidth, pageHeight: document.documentElement.scrollHeight, devicePixelRatio },
      url: location.href, title: document.title, visibleText: visibleText(document.body), interactives,
      integrity: (globalThis as typeof globalThis & { __RIG_STUDIO_INTEGRITY__?: unknown }).__RIG_STUDIO_INTEGRITY__ ?? null,
      typography: { distinctStyles: [...typographyGroups.values()].sort((a, b) => b.count - a.count), sizeCounts: typographyBuckets, visibleTextNodeCount: leafTextElements.length, microtextCount, microtextPercent: leafTextElements.length ? rounded(microtextCount / leafTextElements.length * 100, 2) : 0 },
      buttons, duplicateButtonLabels, primaryCandidates, ctaCandidates,
      panels, panelDensity: { leftRail: panels.leftRail, rightRail: panels.rightRail }, spacing: { sampledValueCount: spacingValues.length, buckets: spacingBuckets, denseClusters: denseClusters.slice(0, 300) },
      bottomRail: { surfaces: bottomSurfaces, totalOccupiedVerticalDepth: rounded(occupiedDepth), occupiedIntervals: mergedIntervals.map(([start, end]) => ({ start: rounded(start), end: rounded(end), depth: rounded(end - start) })), overlappingSurfacePairs: bottomOverlaps, interactiveControlCount: bottomSurfaces.reduce((sum, surface) => sum + surface.controlsContained, 0), persistentMessageCount: bottomSurfaces.filter((surface) => /status|toast|message|output/i.test(`${surface.name} ${surface.selector}`)).length },
      canvas: canvasMetrics, overflow, interactiveOverlaps: overlapPairs,
      accessibility: { missingButtonNames, unlabeledInputs, zeroSizeFocusable, lowHitTargets, duplicateIds, invalidAriaReferences },
      activeStates: interactives.filter((item) => item.pressed === "true" || item.checked === "true" || item.current || item.selector.includes("active") || item.selector.includes("selected")),
    };
  }, { stateId: state.id, section: state.section, viewport });
}

async function captureLocator(locator: Locator, path: string): Promise<boolean> {
  if (!await locator.first().isVisible().catch(() => false)) return false;
  await locator.first().screenshot({ path, animations: "disabled" });
  return true;
}

async function captureCrops(page: Page, screenshotDir: string, stateId: string, viewId: string): Promise<string[]> {
  const targets: [string, string][] = [
    ["top-rail", ".studio-command-rail"], ["left-navigator", ".cutter-left, .editor-left-panel, .animate-bones"], ["right-inspector", ".cutter-right, .editor-right-panel"],
    ["prepare-bottom-rail", ".prepare-action-rail"], ["canvas-toolbar", ".cutter-toolbar, .viewport-context-row, .animation-toolbar"], ["stage-rail", ".studio-mode-nav"], ["timeline", ".dope-sheet"],
    ["command-palette", ".command-palette"], ["systems-popover", ".systems-popover"], ["view-popover", ".cutter-view-popover > div, .canvas-popover > div"],
  ];
  const files: string[] = [];
  for (const [name, selector] of targets) {
    const filename = `${stateId}-${name}-${viewId}.png`;
    if (await captureLocator(page.locator(selector), join(screenshotDir, filename))) files.push(filename);
  }
  return files;
}

async function styleSnapshot(locator: Locator) {
  if (!await locator.first().isVisible().catch(() => false)) return null;
  return locator.first().evaluate((element) => {
    const css = getComputedStyle(element); const rect = element.getBoundingClientRect();
    return { bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, transform: css.transform, backgroundColor: css.backgroundColor, borderColor: css.borderColor, boxShadow: css.boxShadow, opacity: css.opacity, color: css.color, transitionDuration: css.transitionDuration, animationDuration: css.animationDuration };
  });
}

async function screenshotCurrentBounds(page: Page, locator: Locator, path: string): Promise<void> {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport) return;
  const x = Math.max(0, box.x); const y = Math.max(0, box.y);
  const width = Math.max(1, Math.min(viewport.width - x, box.width)); const height = Math.max(1, Math.min(viewport.height - y, box.height));
  await page.screenshot({ path, clip: { x, y, width, height }, animations: "allow", timeout: 5_000 });
}

function styleDelta(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  if (!before || !after) return null;
  return Object.fromEntries(Object.keys(after).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key])).map((key) => [key, { before: before[key], after: after[key] }]));
}

async function inspectHoverAndPress(page: Page, locator: Locator, name: string, screenshotDir: string, viewId: string) {
  const target = locator.first();
  if (!await target.isVisible().catch(() => false) || !await target.isEnabled().catch(() => false)) return { name, available: false };
  const before = await styleSnapshot(target);
  await screenshotCurrentBounds(page, target, join(screenshotDir, `interaction-${slug(name)}-before-${viewId}.png`));
  await target.hover({ force: true, timeout: 3_000 }); await page.waitForTimeout(80);
  const hover = await styleSnapshot(target);
  await screenshotCurrentBounds(page, target, join(screenshotDir, `interaction-${slug(name)}-hover-${viewId}.png`));
  const box = await target.boundingBox();
  let pressed = null; let released = null;
  if (box) {
    await target.evaluate((element) => element.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); }, { capture: true, once: true }));
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.waitForTimeout(50);
    pressed = await styleSnapshot(target);
    await screenshotCurrentBounds(page, target, join(screenshotDir, `interaction-${slug(name)}-pressed-${viewId}.png`));
    await page.mouse.move(1, 1); await page.mouse.up(); await page.waitForTimeout(50); released = await styleSnapshot(target);
  }
  return { name, available: true, before, hover, pressed, released, hoverDelta: styleDelta(before, hover), pressedDelta: styleDelta(before, pressed), pressedVisiblyDistinct: Boolean(styleDelta(before, pressed) && Object.keys(styleDelta(before, pressed)!).some((key) => !["bounds", "transitionDuration", "animationDuration"].includes(key))) };
}

async function measureOpen(page: Page, trigger: Locator, target: Locator, name: string) {
  if (!await trigger.first().isVisible().catch(() => false)) return { name, available: false };
  const started = await page.evaluate(() => performance.now());
  await trigger.first().click();
  await target.first().waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
  let previous = ""; let stableFrames = 0;
  for (let index = 0; index < 60 && stableFrames < 3; index += 1) {
    await page.evaluate(() => new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame())));
    const current = JSON.stringify(await styleSnapshot(target));
    if (current === previous) stableFrames += 1; else stableFrames = 0;
    previous = current;
  }
  const ended = await page.evaluate(() => performance.now());
  return { name, available: await target.first().isVisible().catch(() => false), observedDurationMs: round(ended - started), stableFrames };
}

async function keyboardFlow(page: Page) {
  await page.locator("body").click({ position: { x: 2, y: 2 } }).catch(() => undefined);
  const sequence: { direction: string; tag: string; name: string; selectorHint: string; visible: boolean; bounds: { x: number; y: number; width: number; height: number } | null }[] = [];
  const snapshot = async (direction: string) => page.evaluate((direction) => {
    const element = document.activeElement as HTMLElement | null; const rect = element?.getBoundingClientRect();
    const text = (element?.getAttribute("aria-label") || element?.getAttribute("title") || element?.textContent || (element as HTMLInputElement | null)?.placeholder || "").replace(/\s+/g, " ").trim();
    const css = element ? getComputedStyle(element) : null;
    return { direction, tag: element?.tagName.toLowerCase() ?? "", name: text.slice(0, 120), selectorHint: element?.id ? `#${element.id}` : element?.className?.toString().split(/\s+/).filter(Boolean).map((name) => `.${name}`).join("") ?? "", visible: Boolean(rect && rect.width > 0 && rect.height > 0 && css?.display !== "none" && css?.visibility !== "hidden"), bounds: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null };
  }, direction);
  for (let index = 0; index < 25; index += 1) { await page.keyboard.press("Tab"); sequence.push(await snapshot("Tab")); }
  for (let index = 0; index < 5; index += 1) { await page.keyboard.press("Shift+Tab"); sequence.push(await snapshot("Shift+Tab")); }
  const beforeEnter = await snapshot("before Enter"); await page.keyboard.press("Enter"); await page.waitForTimeout(60); const afterEnter = await snapshot("after Enter");
  await page.keyboard.press("Escape"); await page.keyboard.press("Space").catch(() => undefined); await page.keyboard.press("Escape");
  const uniqueFocuses = new Set(sequence.map((item) => `${item.tag}|${item.name}|${item.selectorHint}`));
  return { sequence, beforeEnter, afterEnter, invisibleFocusCount: sequence.filter((item) => !item.visible).length, focusLossCount: sequence.filter((item) => item.tag === "body" || !item.tag).length, possibleTrap: uniqueFocuses.size <= 2 && sequence.length >= 10 };
}

async function captureInteractionPacket(browser: Browser, baseUrl: string, runDir: string) {
  const screenshotDir = join(runDir, "screenshots/interactions"); const interactionsDir = join(runDir, "interactions");
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" });
  const page = await context.newPage();
  await gotoReady(page, `${baseUrl}/?mode=setup`); await page.locator(".editor-body").waitFor();
  const hoverPress = [
    await inspectHoverAndPress(page, page.locator(".studio-mode-nav button[aria-current]").first(), "stage step", screenshotDir, "1440x900"),
    await inspectHoverAndPress(page, page.locator(".semantic-object").first(), "navigator row", screenshotDir, "1440x900"),
    await inspectHoverAndPress(page, page.locator(".canvas-tool-group button").first(), "toolbar button", screenshotDir, "1440x900"),
    await inspectHoverAndPress(page, page.locator(".stage-next-action"), "primary CTA", screenshotDir, "1440x900"),
  ];
  await page.getByRole("button", { name: "Search commands" }).click(); await page.getByRole("dialog", { name: "Command palette" }).waitFor();
  hoverPress.push(await inspectHoverAndPress(page, page.locator(".command-results button").first(), "menu item", screenshotDir, "1440x900"));
  await page.keyboard.press("Escape");
  if (await page.locator(".command-palette-backdrop").isVisible().catch(() => false)) await page.locator(".command-palette-backdrop").click({ position: { x: 2, y: 2 }, force: true });
  await page.locator(".command-palette-backdrop").waitFor({ state: "hidden", timeout: 3_000 });
  const activeComparisons: unknown[] = [];
  const select = page.locator(".canvas-tool-group button").nth(0); const pan = page.locator(".canvas-tool-group button").nth(1);
  const selectBefore = await styleSnapshot(select); const panBefore = await styleSnapshot(pan); await pan.click();
  activeComparisons.push({ name: "Select / Pan", before: { select: selectBefore, pan: panBefore }, after: { select: await styleSnapshot(select), pan: await styleSnapshot(pan) } });
  await page.locator(".semantic-object").first().click();
  activeComparisons.push({ name: "semantic region selection", selected: await styleSnapshot(page.locator(".semantic-object.is-selected")) });
  const keyboard = await keyboardFlow(page);
  const motion: unknown[] = [];
  motion.push(await measureOpen(page, page.getByRole("button", { name: "Search commands" }), page.getByRole("dialog", { name: "Command palette" }), "command palette open"));
  await page.keyboard.press("Escape");
  motion.push(await measureOpen(page, page.locator(".connection-cluster > summary"), page.locator(".systems-popover"), "systems popover open"));
  await page.keyboard.press("Escape");
  motion.push(await measureOpen(page, page.locator(".canvas-popover > summary"), page.locator(".canvas-popover > div"), "view popover open"));
  await page.keyboard.press("Escape");
  const collapse = page.getByRole("button", { name: "Collapse setup navigator" });
  if (await collapse.isVisible()) {
    const before = await styleSnapshot(page.locator(".editor-left-panel")); const started = await page.evaluate(() => performance.now()); await collapse.click();
    await page.locator(".restore-left").waitFor(); const ended = await page.evaluate(() => performance.now());
    motion.push({ name: "panel collapse", available: true, observedDurationMs: round(ended - started), before, after: await styleSnapshot(page.locator(".restore-left")) });
    const expandStarted = await page.evaluate(() => performance.now()); await page.locator(".restore-left").click(); await page.getByRole("button", { name: "Collapse setup navigator" }).waitFor(); const expandEnded = await page.evaluate(() => performance.now());
    motion.push({ name: "panel expand", available: true, observedDurationMs: round(expandEnded - expandStarted), after: await styleSnapshot(page.locator(".editor-left-panel")) });
  }
  const stageStarted = await page.evaluate(() => performance.now()); await page.locator('.studio-mode-nav button[data-mode="animate"]').evaluate((element: HTMLElement) => element.click()); await page.locator(".animate-workspace").waitFor(); const stageEnded = await page.evaluate(() => performance.now());
  motion.push({ name: "stage switch Setup to Animate", available: true, observedDurationMs: round(stageEnded - stageStarted) });
  await context.close();

  const animateContext = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const animate = await animateContext.newPage();
  await gotoReady(animate, `${baseUrl}/?mode=animate`); await animate.locator(".animate-workspace").waitFor();
  hoverPress.push(await inspectHoverAndPress(animate, animate.locator(".key-diamond:not(.summary)").first(), "timeline key", screenshotDir, "1440x900"));
  await animate.locator(".key-diamond:not(.summary)").first().click(); activeComparisons.push({ name: "selected keyframe", selected: await styleSnapshot(animate.locator(".key-diamond.selected").first()) });
  await animateContext.close();

  const prepareContext = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const prepare = await prepareContext.newPage();
  await preparePartCutter(prepare, baseUrl); await prepare.getByRole("tab", { name: "Guided" }).click();
  const guided = await styleSnapshot(prepare.getByRole("tab", { name: "Guided" })); const manualInactive = await styleSnapshot(prepare.getByRole("tab", { name: "Manual" })); await prepare.getByRole("tab", { name: "Manual" }).click();
  activeComparisons.push({ name: "Guided / Manual / Assist", guidedActive: guided, manualInactive, manualActive: await styleSnapshot(prepare.getByRole("tab", { name: "Manual" })), guidedInactive: await styleSnapshot(prepare.getByRole("tab", { name: "Guided" })) });
  await drawDisposableRegion(prepare); hoverPress.push(await inspectHoverAndPress(prepare, prepare.locator("[data-region-id]").first(), "selected semantic region", screenshotDir, "1440x900"));
  await prepareContext.close();

  const reducedContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" }); const reduced = await reducedContext.newPage();
  await gotoReady(reduced, `${baseUrl}/?mode=setup`); const reducedTrigger = reduced.locator(".canvas-popover > summary").first(); const reducedTarget = reduced.locator(".canvas-popover > div").first(); const reducedBefore = await styleSnapshot(reducedTrigger); await reducedTrigger.click(); await reducedTarget.waitFor();
  const reducedAnimations = await reduced.evaluate(() => [...document.querySelectorAll("body *")].filter((element) => { const css = getComputedStyle(element); const duration = css.animationDuration.split(",").reduce((sum, item) => sum + (item.endsWith("ms") ? parseFloat(item) : parseFloat(item) * 1000), 0); return duration > 100; }).map((element) => ({ selector: element.id ? `#${element.id}` : element.className?.toString(), animationDuration: getComputedStyle(element).animationDuration })).slice(0, 100));
  await reduced.screenshot({ path: join(screenshotDir, "reduced-motion-setup-view-popover-1440x900.png"), animations: "allow" });
  const reducedMotion = { functionalStateChange: await reducedTarget.isVisible(), triggerBefore: reducedBefore, targetAfter: await styleSnapshot(reducedTarget), animationsOver100ms: reducedAnimations };
  await reducedContext.close();
  await writeJson(join(interactionsDir, "hover-press-active.json"), { hoverPress, activeComparisons });
  await writeJson(join(interactionsDir, "motion.json"), { observed: motion, unsupported: ["timeline open/close (timeline is persistently open in current UI)"] });
  await writeJson(join(interactionsDir, "keyboard.json"), keyboard);
  await writeJson(join(interactionsDir, "reduced-motion.json"), reducedMotion);
  return { hoverPress, activeComparisons, motion, keyboard, reducedMotion };
}

async function captureRepresentativePopovers(page: Page, screenshotDir: string, stateId: string, viewId: string) {
  const files: string[] = [];
  const commandButton = page.getByRole("button", { name: "Search commands" });
  if (await commandButton.isVisible().catch(() => false)) {
    await commandButton.click(); await page.getByRole("dialog", { name: "Command palette" }).waitFor();
    const filename = `${stateId}-command-palette-${viewId}.png`; await page.screenshot({ path: join(screenshotDir, filename), animations: "disabled" }); files.push(filename);
    const crop = `${stateId}-command-palette-crop-${viewId}.png`; if (await captureLocator(page.locator(".command-palette"), join(screenshotDir, crop))) files.push(crop);
    await page.keyboard.press("Escape");
  }
  const systems = page.locator(".connection-cluster > summary");
  if (await systems.isVisible().catch(() => false)) {
    await systems.click(); await page.locator(".systems-popover").waitFor();
    const filename = `${stateId}-systems-popover-${viewId}.png`; await page.screenshot({ path: join(screenshotDir, filename), animations: "disabled" }); files.push(filename);
    const crop = `${stateId}-systems-popover-crop-${viewId}.png`; if (await captureLocator(page.locator(".systems-popover"), join(screenshotDir, crop))) files.push(crop);
    await page.keyboard.press("Escape");
  }
  const view = page.locator(".cutter-view-popover > summary, .canvas-popover > summary").first();
  if (await view.isVisible().catch(() => false)) {
    await view.click(); const target = page.locator(".cutter-view-popover > div, .canvas-popover > div").first(); await target.waitFor();
    const filename = `${stateId}-view-popover-${viewId}.png`; await page.screenshot({ path: join(screenshotDir, filename), animations: "disabled" }); files.push(filename);
    const crop = `${stateId}-view-popover-crop-${viewId}.png`; if (await captureLocator(target, join(screenshotDir, crop))) files.push(crop);
    await page.keyboard.press("Escape");
  }
  return files;
}

function aggregateCaptures(captures: any[], runtimeEvents: RuntimeEvent[], run: Record<string, unknown>, interactions: any) {
  const successful = captures.filter((capture) => capture.evidence);
  const typographyCounts: Record<string, number> = { "<=10px": 0, "11px": 0, "12px": 0, "13px": 0, "14px": 0, "15px": 0, "16px": 0, "17px": 0, "18px+": 0 };
  successful.forEach((capture) => Object.entries(capture.evidence.typography.sizeCounts as Record<string, number>).forEach(([key, count]) => { typographyCounts[key] = (typographyCounts[key] ?? 0) + count; }));
  const buttons = successful.flatMap((capture) => capture.evidence.buttons.map((button: unknown) => ({ state: capture.state, viewport: capture.viewport, ...(button as object) })));
  const primaryCandidates = successful.flatMap((capture) => capture.evidence.primaryCandidates.map((candidate: unknown) => ({ state: capture.state, viewport: capture.viewport, ...(candidate as object) })));
  const ctaCandidates = successful.flatMap((capture) => (capture.evidence.ctaCandidates ?? []).map((candidate: unknown) => ({ state: capture.state, viewport: capture.viewport, ...(candidate as object) })));
  const bottomSurfaces = successful.flatMap((capture) => capture.evidence.bottomRail.surfaces.map((surface: unknown) => ({ state: capture.state, viewport: capture.viewport, ...(surface as object) })));
  const overflow = successful.flatMap((capture) => capture.evidence.overflow.map((item: unknown) => ({ state: capture.state, viewport: capture.viewport, ...(item as object) })));
  const accessibility = successful.flatMap((capture) => {
    const value = capture.evidence.accessibility;
    return [
      ...value.missingButtonNames.map((selector: string) => ({ state: capture.state, viewport: capture.viewport, type: "button-without-name", selector })),
      ...value.unlabeledInputs.map((selector: string) => ({ state: capture.state, viewport: capture.viewport, type: "input-without-label", selector })),
      ...value.zeroSizeFocusable.map((selector: string) => ({ state: capture.state, viewport: capture.viewport, type: "zero-size-focusable", selector })),
      ...value.lowHitTargets.map((item: object) => ({ state: capture.state, viewport: capture.viewport, type: "low-hit-target", ...item })),
      ...value.duplicateIds.map((id: string) => ({ state: capture.state, viewport: capture.viewport, type: "duplicate-id", id })),
      ...value.invalidAriaReferences.map((item: object) => ({ state: capture.state, viewport: capture.viewport, type: "invalid-aria-reference", ...item })),
    ];
  });
  const viewports = Object.fromEntries(successful.map((capture) => [`${capture.state}@${capture.viewport}`, capture.evidence.viewport]));
  const canvas = Object.fromEntries(successful.map((capture) => [`${capture.state}@${capture.viewport}`, capture.evidence.canvas]));
  const panels = Object.fromEntries(successful.map((capture) => [`${capture.state}@${capture.viewport}`, capture.evidence.panels]));
  const bottomRail = Object.fromEntries(successful.map((capture) => [`${capture.state}@${capture.viewport}`, capture.evidence.bottomRail]));
  const console = runtimeEvents.filter((event) => event.type.startsWith("console") || event.type === "pageerror");
  const network = runtimeEvents.filter((event) => event.type.startsWith("network"));
  const classifiedRuntime = runtimeEvents.map((event, index) => classifyRuntimeEvent(event, runtimeEvents.slice(0, index)));
  return {
    schemaVersion: SCHEMA_VERSION, run, states: [...new Set(captures.map((capture) => capture.state))], viewports, canvas, panels, bottomRail,
    typography: { sizeCounts: typographyCounts, captureCount: successful.length }, buttons, primaryCandidates, ctaCandidates, bottomSurfaces,
    motion: interactions.motion, reducedMotion: interactions.reducedMotion, overflow,
    console, consoleSummary: { total: console.length, uniqueCount: countedSignatures(console.map((event) => `${event.type} · ${normalizedSignature(event.text)}`)).length, signatures: countedSignatures(console.map((event) => `${event.type} · ${normalizedSignature(event.text)}`)) },
    network, networkSummary: { total: network.length, uniqueCount: countedSignatures(network.map(endpointFailureSignature)).length, endpointFailures: countedSignatures(network.map(endpointFailureSignature)) }, accessibility,
    integrity: Object.fromEntries(successful.map((capture) => [`${capture.state}@${capture.viewport}`, capture.evidence.integrity])),
    runtimeClassification: {
      expectedOptionalService: classifiedRuntime.filter((event) => event.classification === "EXPECTED_OPTIONAL_SERVICE"),
      expectedRetry: classifiedRuntime.filter((event) => event.classification === "EXPECTED_RETRY"),
      actionableEditorDefects: classifiedRuntime.filter((event) => event.classification === "ACTIONABLE_EDITOR_DEFECT"),
    },
    keyboard: interactions.keyboard, captures: captures.map((capture) => { const result = { ...capture }; delete result.evidence; return result; }),
  };
}

function markdownTable(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const safe = (value: string | number | null | undefined) => String(value ?? "—").replaceAll("|", "\\|").replaceAll("\n", " ");
  return [`| ${headers.map(safe).join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.map(safe).join(" | ")} |`)].join("\n");
}

function buildReport(summary: any): string {
  const captures = summary.captures as any[]; const successful = captures.filter((capture) => capture.status === "captured");
  const bySection = (section: string) => successful.filter((capture) => capture.section === section);
  const stateRows = (section: string) => bySection(section).map((capture) => {
    const key = `${capture.state}@${capture.viewport}`; const canvas = summary.canvas[key]; const panels = summary.panels[key];
    return [capture.state, capture.viewport, canvas?.visibleAreaRatio ?? null, panels?.leftRail?.bounds?.width ?? null, panels?.rightRail?.bounds?.width ?? null, panels?.bottomRail?.bounds?.height ?? null, panels?.timeline?.bounds?.height ?? null];
  });
  const primary1440 = summary.primaryCandidates.filter((item: any) => item.viewport === "1440x900");
  const failed = captures.filter((capture) => capture.status !== "captured");
  const consoleErrors = summary.console.filter((event: RuntimeEvent) => event.type === "console.error" || event.type === "pageerror");
  const consoleWarnings = summary.console.filter((event: RuntimeEvent) => event.type === "console.warning");
  const unexpectedOverflow = summary.overflow.filter((item: any) => item.classification !== "EXPECTED_SCROLL");
  return `# Rig Studio localhost UX inspection

This report records rendered evidence and numeric heuristics. It does not assign subjective quality judgments.

## Run Metadata

${markdownTable(["Field", "Value"], [
  ["Run ID", summary.run.id], ["Started", summary.run.startedAt], ["Completed", summary.run.completedAt], ["Localhost URL", summary.run.baseUrl], ["Page identity", summary.run.pageTitle], ["Browser", summary.run.browser], ["Reduced-motion pass", "prefers-reduced-motion: reduce"], ["Successful captures", successful.length], ["Failed captures", failed.length],
])}

## Prepare

${markdownTable(["State", "Viewport", "Canvas area / viewport", "Left rail", "Right rail", "Bottom rail", "Timeline"], stateRows("prepare"))}

## Setup

${markdownTable(["State", "Viewport", "Canvas area / viewport", "Left rail", "Right rail", "Bottom rail", "Timeline"], stateRows("setup"))}

## Animate

${markdownTable(["State", "Viewport", "Canvas area / viewport", "Left rail", "Right rail", "Bottom rail", "Timeline"], stateRows("animate"))}

## Typography

Rendered visible text-node counts aggregated across captures:

${markdownTable(["Size bucket", "Count"], Object.entries(summary.typography.sizeCounts))}

Microtext prevalence is reported numerically in every styles artifact under \`typography.microtextPercent\`.

## Buttons

${markdownTable(["Metric", "Count"], [["Visible button observations", summary.buttons.length], ["Height under 32px", summary.buttons.filter((button: any) => button.flags.heightUnder32).length], ["Width under 32px", summary.buttons.filter((button: any) => button.flags.widthUnder32).length], ["Text clipping detections", summary.buttons.filter((button: any) => button.flags.textClipping).length], ["Icon clipping detections", summary.buttons.filter((button: any) => button.flags.iconClipping).length]])}

Duplicate labels are recorded per state in each styles artifact. Labels emphasized by the brief (Accept, Continue, Review, Cut, Setup) remain searchable in \`summary.json\`.

## CTA Semantics

Explicit or inferred primary actions at 1440×900. The heuristic score remains evidence, but semantic category determines candidacy:

${primary1440.length ? markdownTable(["State", "Label", "Score"], primary1440.map((item: any) => [item.state, item.label, item.heuristicScore])) : "No simultaneous candidate met at least four of the five recorded heuristic signals."}

## Bottom Rail

Each state artifact contains surfaces intersecting the bottom 140px, their bounds, positioning, z-index, text, control count, total occupied depth, and overlap count. The run contains ${summary.bottomSurfaces.length} bottom-surface observations.

## Canvas Dominance

Canvas visible-area, width, and height ratios are listed above and stored for every capture in \`summary.json.canvas\`. Obstruction bounds are recorded without treating any ratio as preferable.

## Motion

${markdownTable(["Transition", "Available", "Observed duration (ms)"], summary.motion.map((item: any) => [item.name, item.available, item.observedDurationMs]))}

Pressed and hover computed-style deltas, before/hover/pressed screenshots, active/inactive comparisons, and reduced-motion evidence are stored under \`interactions/\` and \`screenshots/interactions/\`.

## Responsive

The viewport table rows in Prepare, Setup, and Animate contain all requested sizes. Compact-layout clipping and overflow evidence is retained per capture rather than inferred from screenshots alone.

## Accessibility

${markdownTable(["Check", "Findings"], [["Buttons without accessible names", summary.accessibility.filter((item: any) => item.type === "button-without-name").length], ["Inputs without labels", summary.accessibility.filter((item: any) => item.type === "input-without-label").length], ["Focusable zero-size bounds", summary.accessibility.filter((item: any) => item.type === "zero-size-focusable").length], ["Hit targets under 24px", summary.accessibility.filter((item: any) => item.type === "low-hit-target").length], ["Duplicate IDs", summary.accessibility.filter((item: any) => item.type === "duplicate-id").length], ["Invalid ARIA references", summary.accessibility.filter((item: any) => item.type === "invalid-aria-reference").length], ["Invisible focus steps", summary.keyboard.invisibleFocusCount], ["Possible keyboard trap", summary.keyboard.possibleTrap]])}

## Console / Network

${markdownTable(["Signal", "Total", "Unique signatures"], [["console.error / uncaught", consoleErrors.length, summary.consoleSummary.uniqueCount], ["console.warn", consoleWarnings.length, "included above"], ["failed / 4xx / 5xx network events", summary.networkSummary.total, summary.networkSummary.uniqueCount]])}

Exact messages and redacted URLs are stored in \`console/events.json\` and \`network/failures.json\`. Authorization headers are never collected; sensitive query values are replaced with \`[REDACTED]\`.

Runtime classification: ${summary.runtimeClassification.expectedOptionalService.length} optional-service events, ${summary.runtimeClassification.expectedRetry.length} repeated retry events, and ${summary.runtimeClassification.actionableEditorDefects.length} actionable editor events. Each capture also records the published state digest and canonical validator problems under \`summary.json.integrity\`.

## Notable Evidence

- ${successful.length} full-window state/viewport screenshots were captured across ${summary.states.length} named states.
- Prepare at 1440×900 exposed ${primary1440.filter((item: any) => item.state.startsWith("prepare")).length} semantically classified primary-action observations across the captured states.
- ${unexpectedOverflow.length} visible overflow observations were classified as TEXT_CLIP, LAYOUT_OVERFLOW, or UNKNOWN rather than EXPECTED_SCROLL.
- Ollama/provider status was read from the UI only; the harness did not install Ollama or send an arbitrary model request.
- Every scenario ran in a fresh, disposable browser context using the bundled ${basename(FIXTURE_IMAGE)} fixture where Prepare required source art.
${failed.length ? `- Capture failures were retained as evidence: ${failed.map((item) => `${item.state}@${item.viewport}: ${item.error}`).join("; ")}.` : "- All requested capture jobs completed."}
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2)); const startedAt = new Date().toISOString();
  const runDir = join(OUTPUT_ROOT, options.runId);
  await mkdir(OUTPUT_ROOT, { recursive: true });
  try { await access(runDir); throw new Error(`Refusing to overwrite existing run directory: ${runDir}`); } catch (error) { if (error instanceof Error && error.message.startsWith("Refusing")) throw error; }
  for (const directory of [runDir, "screenshots", "screenshots/crops", "screenshots/interactions", "dom", "styles", "console", "network", "interactions"].slice(1)) await mkdir(join(runDir, directory), { recursive: true });
  const discovery = await discoverBaseUrl(options.baseUrl); const executablePath = await findChromiumExecutable();
  const browser = await chromium.launch({ headless: options.headless, ...(executablePath ? { executablePath } : {}) });
  const identityContext = await browser.newContext({ viewport: { width: 1280, height: 800 } }); const identityPage = await identityContext.newPage(); await identityPage.goto(discovery.url, { waitUntil: "domcontentloaded" });
  const pageTitle = await identityPage.title(); const identityText = (await identityPage.locator("body").innerText()).slice(0, 2_000); await identityContext.close();
  if (!/Rig Studio/i.test(`${pageTitle} ${identityText}`)) throw new Error(`Detected URL did not verify as Rig Studio: ${discovery.url}`);
  const definitions = (await prepareStateDefinitions(discovery.url)).filter((definition) => !options.stateFilter?.length || options.stateFilter.includes(definition.id));
  if (!definitions.length) throw new Error("--states did not match any known state IDs");
  const captures: any[] = []; const runtimeEvents: RuntimeEvent[] = [];
  try {
    for (const definition of definitions) {
      for (const viewport of options.viewports) {
        const viewId = viewportId(viewport); const context = await browser.newContext({ viewport, reducedMotion: "no-preference" }); const page = await context.newPage();
        await attachRuntimeCapture(page, runtimeEvents, definition.id, viewId);
        const runtimeStart = runtimeEvents.length;
        const capture: any = { state: definition.id, section: definition.section, viewport: viewId, status: "failed", screenshot: null, domArtifact: null, styleArtifact: null, cropScreenshots: [] };
        try {
          await definition.prepare(page); await page.waitForTimeout(180);
          const evidence = await collectPageEvidence(page, definition, viewport); const base = `${definition.id}-${viewId}`;
          const screenshot = `${base}.png`; await page.screenshot({ path: join(runDir, "screenshots", screenshot), fullPage: false, animations: "disabled" });
          const domArtifact = `${base}.json`; await writeJson(join(runDir, "dom", domArtifact), { schemaVersion: SCHEMA_VERSION, state: definition.id, viewport: evidence.viewport, url: evidence.url, title: evidence.title, visibleText: evidence.visibleText, interactives: evidence.interactives, activeStates: evidence.activeStates });
          const styleArtifact = `${base}.json`; const styleEvidence: any = { ...evidence }; delete styleEvidence.visibleText; delete styleEvidence.interactives; delete styleEvidence.activeStates; await writeJson(join(runDir, "styles", styleArtifact), styleEvidence);
          const cropScreenshots = viewId === "1440x900" ? await captureCrops(page, join(runDir, "screenshots/crops"), definition.id, viewId) : [];
          const popoverScreenshots = viewId === "1440x900" && ["prepare-guided", "setup-no-selection"].includes(definition.id) ? await captureRepresentativePopovers(page, join(runDir, "screenshots"), definition.id, viewId) : [];
          const runtimeDelta = runtimeEvents.slice(runtimeStart).map((event, index, delta) => classifyRuntimeEvent(event, [...runtimeEvents.slice(0, runtimeStart), ...delta.slice(0, index)]));
          const integrity = evidence.integrity as { digest?: string; problems?: unknown[] } | null;
          Object.assign(capture, { status: "captured", screenshot, domArtifact, styleArtifact, cropScreenshots, popoverScreenshots, stateDigest: integrity?.digest ?? null, validatorProblems: integrity?.problems ?? [], runtimeDelta, evidence });
          process.stdout.write(`captured ${definition.id} @ ${viewId}\n`);
        } catch (error) {
          capture.error = error instanceof Error ? error.message : String(error);
          const failureName = `${definition.id}-${viewId}-failure.png`; await page.screenshot({ path: join(runDir, "screenshots", failureName), fullPage: false }).catch(() => undefined); capture.failureScreenshot = failureName;
          process.stderr.write(`failed ${definition.id} @ ${viewId}: ${capture.error}\n`);
        } finally { captures.push(capture); await context.close(); }
      }
    }
    const interactions = await captureInteractionPacket(browser, discovery.url, runDir);
    const completedAt = new Date().toISOString(); const version = (await readFile(join(ROOT, "node_modules/playwright/package.json"), "utf8").then((source) => JSON.parse(source).version).catch(() => "unknown"));
    const run = { id: options.runId, startedAt, completedAt, baseUrl: discovery.url, pageTitle, browser: `Chromium via Playwright ${version}`, browserExecutable: executablePath ?? "Playwright default", headless: options.headless, fixture: basename(FIXTURE_IMAGE), disposableContexts: true, discoveryEvidence: discovery.evidence };
    const summary = aggregateCaptures(captures, runtimeEvents, run, interactions);
    await writeJson(join(runDir, "summary.json"), summary);
    await writeJson(join(runDir, "console/events.json"), summary.console);
    await writeJson(join(runDir, "network/failures.json"), summary.network);
    await writeJson(join(runDir, "interactions/runtime-classification.json"), summary.runtimeClassification);
    await writeJson(join(runDir, "interactions/state-transitions.json"), { states: captures.map((capture) => ({ state: capture.state, viewport: capture.viewport, status: capture.status, error: capture.error ?? null })) });
    await writeFile(join(runDir, "report.md"), `${buildReport(summary).trim()}\n`, "utf8");
    const screenshotCount = (await import("node:fs/promises")).readdir(join(runDir, "screenshots"), { recursive: true }).then((files) => files.filter((file) => file.endsWith(".png")).length);
    const [domFiles, styleFiles] = await Promise.all([(await import("node:fs/promises")).readdir(join(runDir, "dom")), (await import("node:fs/promises")).readdir(join(runDir, "styles"))]);
    process.stdout.write(`${JSON.stringify({ runDirectory: runDir, baseUrl: discovery.url, captured: captures.filter((capture) => capture.status === "captured").length, failed: captures.filter((capture) => capture.status !== "captured").length, screenshotCount: await screenshotCount, domStyleArtifactCount: domFiles.length + styleFiles.length }, null, 2)}\n`);
    if (captures.some((capture) => capture.status !== "captured")) process.exitCode = 2;
  } finally { await browser.close(); }
}

await main();
