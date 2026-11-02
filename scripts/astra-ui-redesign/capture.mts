import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page } from 'playwright';

const phase = process.argv[2] ?? 'before';
const root = path.resolve('.rigging-studio/diagnostics/astra-ui-redesign/2026-09-06T-visual');
const output = path.join(root, phase);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(12000);
const errors: string[] = [];
page.on('pageerror', e => errors.push(e.message));
const checks: Record<string, unknown> = {};
const shots: string[] = [];
async function shot(name: string) { await page.waitForTimeout(250); await page.screenshot({ path: path.join(output, `${name}.png`) }); shots.push(name); console.log(`captured ${phase}/${name}`); }
async function ready(p: Page, route: string) { await p.goto(`http://localhost:5177${route}`, { waitUntil: 'domcontentloaded' }); await p.locator('.studio-command-rail').waitFor(); await p.evaluate('globalThis.__name = (target) => target'); }
try {
  await ready(page, '/part-cutter');
  await shot('prepare-empty');
  await page.locator('input[type="file"][accept*="image/png"]').setInputFiles('public/rig-test/body-base.png');
  await page.locator('.cutter-canvas svg').waitFor();
  await shot('prepare-source');
  if (await page.getByRole('tab', { name: 'Guided Manual', exact: true }).isVisible()) await page.getByRole('tab', { name: 'Guided Manual', exact: true }).click();
  const guided = page.getByRole('region', { name: 'Guided Manual workflow' });
  await guided.waitFor();
  await shot('prepare-guided');
  const current = await guided.locator('header strong').innerText();
  await guided.getByRole('button', { name: /Skip/ }).click();
  assert.notEqual(await guided.locator('header strong').innerText(), current);
  await guided.getByRole('button', { name: /Back/ }).click();
  assert.equal(await guided.locator('header strong').innerText(), current);
  checks.skipBack = true;
  await guided.getByRole('button', { name: 'Use Guide', exact: true }).click();
  await page.locator('[data-region-id]').first().waitFor();
  checks.useGuide = true;
  await shot('prepare-ownership');
  await guided.getByRole('button', { name: 'add', exact: true }).click();
  assert.match(await guided.locator('header b').innerText(), /ADD/);
  await guided.getByRole('button', { name: 'remove', exact: true }).click();
  assert.match(await guided.locator('header b').innerText(), /REMOVE/);
  await guided.getByRole('button', { name: 'replace', exact: true }).click();
  checks.ownershipIntents = true;
  await page.locator('.primary-region-tools button').filter({ hasText: /^Lasso/ }).click();
  assert.equal(await page.locator('.cutter-canvas svg').getAttribute('data-tool'), 'lasso');
  // Use real guide bounds to draw a closed lasso on the disposable imported image.
  const zone = await page.locator('.anatomical-guide rect[data-current="true"]').boundingBox();
  if (zone) {
    await page.mouse.move(zone.x, zone.y); await page.mouse.down();
    for (const [x, y] of [[zone.x + zone.width, zone.y], [zone.x + zone.width, zone.y + zone.height], [zone.x, zone.y + zone.height], [zone.x, zone.y]]) await page.mouse.move(x, y, { steps: 8 });
    await page.mouse.up();
    checks.lasso = true;
  }
  await guided.getByRole('button', { name: /Finish Body/ }).click();
  await guided.getByRole('button', { name: /Review Character/ }).click();
  await page.locator('.guided-review').waitFor();
  await shot('prepare-review');
  await page.locator('.connection-cluster > summary').click();
  await shot('prepare-systems');
  await page.getByRole('button', { name: 'Local AI settings' }).click();
  await page.getByRole('dialog', { name: 'Local AI settings' }).waitFor();
  await shot('local-ai-settings');
  await page.keyboard.press('Escape');

  const fixture = async (file: string) => JSON.parse(await readFile(`tests/fixtures/golden/void-ranger/${file}`, 'utf8'));
  const [rig, animations, project] = await Promise.all([fixture('rig.json'), fixture('animations.json'), fixture('project.json')]);
  const snapshot = { storageVersion: 1, localProjectId: 'ui-redesign-void-ranger', project: { ...project, id: 'ui-redesign-void-ranger', name: 'Void Ranger · visual copy' }, rig, animations, selectedSkinId: rig.defaultSkinId };
  const save = await fetch('http://127.0.0.1:47831/project-storage/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshot }) });
  assert(save.ok, await save.text());
  await ready(page, '/?mode=setup');
  const menu = page.locator('details.project-storage-menu');
  await menu.locator('summary').click();
  await menu.locator('.recent-projects article').filter({ hasText: 'Void Ranger · visual copy' }).getByRole('button', { name: 'Open', exact: true }).click();
  await page.locator('.project-hydration-root[data-project-id="ui-redesign-void-ranger"]').waitFor();
  await page.locator('.editor-viewport canvas').waitFor();
  await page.waitForTimeout(900);
  await shot('setup-void-ranger');
  await page.locator('.semantic-group-trigger').filter({ hasText: /^Arms/ }).click();
  const arm = page.locator('.semantic-object').filter({ hasText: /Upper Arm/ }).first();
  if (await arm.count()) await arm.click(); else await page.locator('.semantic-object').first().click();
  await shot('setup-selected-arm');
  await page.locator('.setup-progress button').filter({ hasText: /pivots/i }).click();
  await shot('setup-selected-pivot');
  checks.setupSelection = true;
  await page.locator('.studio-mode-nav button[data-mode="animate"]').click();
  await page.locator('.animate-workspace').waitFor();
  await page.locator('.animation-picker select').selectOption('game-idle');
  await shot('animate-idle');
  await page.locator('.animation-picker select').selectOption('game-attack');
  await shot('animate-attack');
  await page.locator('.key-diamond:not(.summary)').first().click();
  await shot('animate-keyframe');
  checks.keyframe = true;
  await page.locator('.play-action').click();
  await page.getByRole('button', { name: /Pause/ }).waitFor();
  const fps = await page.evaluate(() => new Promise<number[]>(resolve => { const samples: number[] = []; let previous = performance.now(); function frame(now: number) { samples.push(now - previous); previous = now; if (samples.length < 90) requestAnimationFrame(frame); else resolve(samples.slice(1)); } requestAnimationFrame(frame); }));
  checks.frameIntervalsMs = fps;
  await shot('animate-playback');
  await page.locator('.play-action').click();
  checks.playback = true;
  await page.locator('.motion-review-entry').click();
  await shot('animation-doctor');
  checks.motionReviewEntry = await page.getByRole('region', { name: 'Animation Doctor' }).isVisible();
  for (const width of [1920, 1440, 1280, 900, 760]) {
    await page.setViewportSize({ width, height: width === 1920 ? 1080 : width === 1440 ? 900 : 800 });
    await shot(`animate-review-${width}`);
  }
  await writeFile(path.join(output, 'checks.json'), JSON.stringify({ checks, shots, errors }, null, 2));
} finally { await browser.close(); }
