import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve('.rigging-studio/diagnostics/astra-ui-redesign/2026-09-06T-visual');
const baseline = path.resolve('.rigging-studio/diagnostics/ux-inspection/astra-ui-before-2026-09-06/screenshots');
const states = ['setup-no-selection', 'setup-body-selected', 'setup-pivot-selected', 'setup-equipment', 'animate-timeline', 'animate-animation-selected', 'animate-keyframe-selected', 'animate-playback-active'];
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const results = [];
await mkdir(path.join(root, 'before/matrix'), { recursive: true });
await mkdir(path.join(root, 'after/matrix'), { recursive: true });
try {
  for (const [width, height] of [[1920,1080],[1440,900],[1280,800],[900,800],[760,800]]) for (const state of states) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    const mode = state.startsWith('setup') ? 'setup' : 'animate';
    await page.goto(`http://localhost:5177/?mode=${mode}`, { waitUntil: 'networkidle' });
    await page.locator('.editor-viewport canvas').waitFor();
    if (state === 'setup-body-selected') await page.locator('.semantic-object').first().click();
    if (state === 'setup-pivot-selected') { await page.locator('.setup-progress button').filter({ hasText: /pivots/i }).click(); await page.locator('.semantic-object').first().click(); }
    if (state === 'setup-equipment') await page.locator('.semantic-section-nav').getByRole('button', { name: 'equipment', exact: true }).click();
    // Match the original capture harness's state setup. These DOM clicks are
    // screenshot preparation only; real input behavior is tested by verify.mts.
    if (state === 'animate-animation-selected') await page.locator('.animation-library-list button').nth(1).evaluate((el: HTMLElement) => el.click());
    if (state === 'animate-keyframe-selected') await page.locator('.key-diamond:not(.summary)').first().evaluate((el: HTMLElement) => el.click());
    if (state === 'animate-playback-active') await page.locator('.play-action').click();
    await page.waitForTimeout(300);
    const name = `${state}-${width}x${height}.png`;
    await copyFile(path.join(baseline, name), path.join(root, 'before/matrix', name));
    await page.screenshot({ path: path.join(root, 'after/matrix', name) });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    results.push({ name, errors, overflow });
    console.log(name);
    await page.close();
  }
  await writeFile(path.join(root, 'matrix.json'), JSON.stringify(results, null, 2));
  assert(results.every(r => !r.overflow && r.errors.length === 0));
} finally { await browser.close(); }
