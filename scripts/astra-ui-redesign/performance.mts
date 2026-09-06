import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
const root = path.resolve('.rigging-studio/diagnostics/astra-ui-redesign/2026-09-06T-visual');
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const timings: Record<string, number[]> = {};
const measure = async (name: string, work: () => Promise<unknown>) => { const start = performance.now(); await work(); (timings[name] ??= []).push(performance.now() - start); };
const summarize = (values: number[]) => { const sorted = [...values].sort((a,b) => a-b); return { samples: sorted.length, median: sorted[Math.floor(sorted.length/2)], p95: sorted[Math.floor(sorted.length*.95)], max: sorted.at(-1) }; };
try {
  await page.goto('http://localhost:3000/?mode=setup', { waitUntil: 'networkidle' });
  await page.evaluate('globalThis.__name = (target) => target');
  await page.locator('.project-storage-menu>summary').click();
  await page.locator('.recent-projects article').filter({ hasText: 'Guild Warrior · visual copy' }).getByRole('button', { name: 'Open', exact: true }).click();
  await page.locator('.project-hydration-root[data-project-id="ui-redesign-warrior"]').waitFor();
  await page.locator('.editor-viewport canvas').waitFor();
  for (let i=0;i<5;i++) {
    await measure('selectionAndInspector', async () => { await page.locator('.semantic-object').nth(i%2).click(); await page.locator('.inspector-heading').first().waitFor(); });
    await measure('stageToAnimate', async () => { await page.locator('[data-mode="animate"]').click(); await page.locator('.dope-sheet').waitFor(); });
    await measure('stageToSetup', async () => { await page.locator('[data-mode="setup"]').click(); await page.locator('.setup-progress').waitFor(); });
  }
  await page.locator('[data-mode="animate"]').click();
  await measure('reviewInspectorOpen', async () => { await page.locator('.motion-review-entry').click(); await page.locator('.motion-review').waitFor(); });
  for (let i=0;i<5;i++) await measure('timelineScrub', () => page.locator('.time-ruler').click({ position: { x: 35+i*5, y: 12 } }));
  await measure('playbackStart', () => page.locator('.play-action').click());
  const frames = await page.evaluate(() => new Promise<number[]>(resolve => { let previous = performance.now(); const values: number[] = []; function tick(now: number) { values.push(now-previous); previous=now; if (values.length<181) requestAnimationFrame(tick); else resolve(values.slice(1)); } requestAnimationFrame(tick); }));
  const before = JSON.parse(await readFile(path.join(root,'before/checks.json'),'utf8')).checks.frameIntervalsMs;
  const after = JSON.parse(await readFile(path.join(root,'after/checks.json'),'utf8')).checks.frameIntervalsMs;
  const concurrent = JSON.parse(await readFile(path.join(root,'performance.json'),'utf8'));
  await writeFile(path.join(root,'performance.json'), JSON.stringify({ environment: 'Headless Chrome, local development server, 1440×900. Latencies include Playwright dispatch/waits; not event-to-photon profiling.', limitations: 'rAF measures browser frame cadence during active Pixi playback, not a GPU render counter. Before/after action latency was not instrumented before edits. These samples do not establish performance on all hardware.', timings, summaries: Object.fromEntries(Object.entries(timings).map(([key,values])=>[key,summarize(values)])), playbackFrames: { raw:frames, summary:summarize(frames) }, matchedVoidRangerFrameCadence: { before:summarize(before), after:summarize(after) }, concurrentQA: concurrent }, null, 2));
} finally { await browser.close(); }
