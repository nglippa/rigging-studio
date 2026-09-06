import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { LocalProjectStore } from '../../mcp/storage/localProjectStore';

const root = path.resolve('.rigging-studio/diagnostics/astra-ui-redesign/2026-09-06T-visual');
for (const dir of ['after', 'prepare', 'setup', 'animate', 'compact', 'compare']) await mkdir(path.join(root, dir), { recursive: true });
const sourceStore = new LocalProjectStore({ cwd: process.cwd(), root: path.resolve('.rigging-studio/diagnostics/wand-or-steel-rigging/astra-intelligence-2026-09-06/projects') });
const { snapshot } = await sourceStore.load('wand-or-steel-warrior');
const copy = { ...snapshot, localProjectId: 'ui-redesign-warrior', project: { ...snapshot.project!, id: 'ui-redesign-warrior', name: 'Guild Warrior · visual copy' } };
const saved = await fetch('http://127.0.0.1:47831/project-storage/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshot: copy }) });
assert(saved.ok, await saved.text());
const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
let page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(10000);
const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
const timings: Record<string, number[]> = {};
const screenshots: string[] = [];
const responsive: unknown[] = [];
const accessibility: unknown[] = [];
const checks: Record<string, unknown> = {};
async function measure(label: string, action: () => Promise<unknown>) { const start = performance.now(); await action(); (timings[label] ??= []).push(performance.now() - start); }
async function shot(name: string) { await page.waitForTimeout(250); await page.screenshot({ path: path.join(root, `${name}.png`) }); screenshots.push(name); console.log(`captured ${name}`); }
async function audit(state: string) {
  await page.addScriptTag({ path: '/tmp/rigging-ui-a11y/node_modules/axe-core/axe.min.js' });
  const result = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (options: unknown) => Promise<{ violations: Array<{ id: string; impact: string; help: string; nodes: Array<{ target: string[]; failureSummary: string }> }> }> } }).axe;
    const data = await axe.run({ runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } });
    return data.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map(n => ({ target: n.target, failure: n.failureSummary })) }));
  });
  accessibility.push({ state, violations: result });
  console.log(`axe ${state}: ${result.length} rules`);
}
async function geometry(state: string) {
  responsive.push(await page.evaluate(state => {
    const bounds = (selector: string) => { const r = document.querySelector(selector)?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom } : null; };
    return { state, viewport: [innerWidth, innerHeight], documentOverflow: document.documentElement.scrollWidth > innerWidth, canvas: bounds('.editor-viewport, .cutter-canvas-wrap'), timeline: bounds('.dope-sheet'), inspector: bounds('.animate-inspector, .cutter-right'), rail: bounds('.studio-command-rail') };
  }, state));
}
try {
  await page.goto('http://localhost:3000/?mode=setup', { waitUntil: 'domcontentloaded' });
  await page.evaluate('globalThis.__name = (target) => target');
  await page.locator('.project-storage-menu>summary').click();
  const open = page.locator('.recent-projects article').filter({ hasText: 'Guild Warrior · visual copy' }).getByRole('button', { name: 'Open', exact: true });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/project-storage/load', async route => { await gate; await route.continue(); });
  await open.click();
  await page.locator('.project-hydration-shell').waitFor();
  await shot('after/project-loading');
  checks.staleContentHiddenDuringLoad = await page.locator('.editor-viewport canvas').count() === 0;
  release();
  await page.locator('.project-hydration-root[data-project-id="ui-redesign-warrior"]').waitFor();
  await page.unroute('**/project-storage/load');
  await page.locator('.editor-viewport canvas').waitFor(); await page.waitForTimeout(600);
  await page.getByRole('button', { name: /Fit/, exact: false }).first().click();
  for (const [width, height] of [[1920,1080], [1440,900], [1280,800], [900,800], [760,800]]) {
    await page.setViewportSize({ width, height });
    await page.getByRole('button', { name: /Fit/, exact: false }).first().click();
    await shot(`setup/warrior-${width}`); await geometry(`setup-${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.semantic-group-trigger').filter({ hasText: /^Arms/ }).click();
  await page.locator('.semantic-group-trigger').filter({ hasText: /^Left/ }).click();
  await measure('boneSelection', async () => { await page.locator('.semantic-object').filter({ hasText: /Left Upper Arm/ }).click(); await page.locator('.inspector-heading strong').filter({ hasText: 'Left Upper Arm' }).waitFor(); });
  await page.getByRole('button', { name: /Fit/, exact: false }).first().click();
  await shot('setup/warrior-arm');
  await page.locator('.setup-progress button').filter({ hasText: /pivots/i }).click();
  await shot('setup/warrior-pivot');
  checks.pivotSelection = await page.locator('.editor-viewport').getAttribute('data-interaction-mode') === 'pivots';
  await audit('setup-pivot');
  await page.locator('.semantic-section-nav button').filter({ hasText: 'Equipment' }).click();
  await shot('setup/warrior-equipment');
  for (let i = 0; i < 3; i++) {
    await measure('stageSwitchToAnimate', async () => { await page.locator('.studio-mode-nav [data-mode="animate"]').click(); await page.locator('.dope-sheet').waitFor(); });
    await measure('stageSwitchToSetup', async () => { await page.locator('.studio-mode-nav [data-mode="setup"]').click(); await page.locator('.setup-progress').waitFor(); });
  }
  await page.locator('.studio-mode-nav [data-mode="animate"]').click();
  await page.locator('.animation-picker select').selectOption({ label: 'Idle' });
  await page.getByRole('button', { name: 'Fit character', exact: true }).click();
  await shot('animate/warrior-idle');
  await page.locator('.animation-picker select').selectOption({ label: 'Attack' });
  await shot('animate/warrior-attack');
  const ruler = await page.locator('.time-ruler').boundingBox(); assert(ruler);
  await measure('timelineScrub', async () => { await page.mouse.click(ruler.x + 60, ruler.y + 12); });
  checks.scrub = Number((await page.locator('.transport-time').innerText()).replace('s', '')) > 0;
  await page.locator('.key-diamond:not(.summary)').first().click();
  await page.getByRole('button', { name: 'Fit character', exact: true }).click();
  await shot('animate/warrior-keyframe');
  checks.keyHitArea = await page.locator('.key-diamond:not(.summary)').first().boundingBox();
  await audit('animate-keyframe');
  await page.locator('.animation-picker select').selectOption({ label: 'Idle' });
  await measure('playbackStart', () => page.locator('.play-action').click());
  checks.frameIntervals = await page.evaluate(() => new Promise<number[]>(resolve => { let previous = performance.now(); const times: number[] = []; function frame(now: number) { times.push(now - previous); previous = now; if (times.length < 121) requestAnimationFrame(frame); else resolve(times.slice(1)); } requestAnimationFrame(frame); }));
  await page.locator('.play-action').click();
  await page.locator('.motion-review-entry').click();
  await page.route('**/animation-doctor/review', route => route.abort('connectionrefused'));
  await page.getByRole('region', { name: 'Animation Doctor' }).getByRole('button', { name: 'Review Motion', exact: true }).click();
  await page.getByRole('region', { name: 'Animation Doctor' }).getByRole('alert').waitFor({ timeout: 30000 });
  await shot('animate/provider-unavailable');
  checks.providerUnavailable = true;
  for (const [width, height] of [[1920,1080], [1440,900], [1280,800], [900,800], [760,800]]) {
    await page.setViewportSize({ width, height });
    await page.getByRole('button', { name: 'Fit character', exact: true }).click();
    await shot(`compact/review-${width}`); await geometry(`animate-review-${width}`);
  }
  await audit('animate-compact-review');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Fit character', exact: true }).focus();
  checks.focus = await page.locator('.animation-fit-view').evaluate(el => ({ outline: getComputedStyle(el).outline, transitionDuration: getComputedStyle(el).transitionDuration }));
  await shot('compact/keyboard-focus-reduced-motion');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.close();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://localhost:3000/part-cutter', { waitUntil: 'networkidle' });
  await page.evaluate('globalThis.__name = (target) => target');
  await page.getByRole('button', { name: 'Import character', exact: true }).waitFor();
  // The server-rendered file input exists before React installs onChange.
  // Opening the chooser verifies hydration before providing the source file.
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import character', exact: true }).click();
  // A fresh imported WOS source uses only read-only source bytes, never the WOS project.
  await (await chooser).setFiles('/Users/nicholaslippa/wand-or-steel/public/assets/active/actors/guild-v1/warrior.png');
  await page.locator('.cutter-canvas svg').waitFor();
  if (await page.getByRole('tab', { name: 'Guided Manual', exact: true }).isVisible()) await page.getByRole('tab', { name: 'Guided Manual', exact: true }).click();
  await page.getByRole('region', { name: 'Guided Manual workflow' }).waitFor();
  await shot('prepare/warrior-guided');
  await page.getByRole('button', { name: 'Use Guide', exact: true }).click();
  await shot('prepare/warrior-owned');
  await audit('prepare-owned');
  for (const width of [1280,900,760]) { await page.setViewportSize({ width, height: 800 }); await shot(`prepare/warrior-${width}`); await geometry(`prepare-${width}`); }
  await audit('prepare-compact');
  checks.prepareCompactUseGuide = await page.getByRole('button', { name: 'Use Guide', exact: true }).isVisible();
} finally {
  await writeFile(path.join(root, 'responsive-results.json'), JSON.stringify(responsive,null,2));
  await writeFile(path.join(root, 'interaction-results.json'), JSON.stringify({ checks, errors, screenshots },null,2));
  await writeFile(path.join(root, 'accessibility.json'), JSON.stringify(accessibility,null,2));
  await writeFile(path.join(root, 'performance.json'), JSON.stringify({ timings, checks: { frameIntervals: checks.frameIntervals }, environment: 'Local headless Chrome; development server; not a production hardware benchmark' },null,2));
  await browser.close();
}
