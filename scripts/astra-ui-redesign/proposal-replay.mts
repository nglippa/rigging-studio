// UI state coverage only: replay a recorded Astra development proposal.
// This is not a live provider run or an animation-quality benchmark.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve('.rigging-studio/diagnostics/astra-ui-redesign/2026-09-06T-visual');
const source = '.rigging-studio/diagnostics/astra-intelligence/2026-09-06T-live-development-clean-v2/development-results.json';
const recorded = JSON.parse(await readFile(source, 'utf8')).cases[0];
const review = { issues: recorded.detectedIssues, edits: recorded.proposedEdits, visualScore: recorded.visualScore, expectedImprovement: recorded.expectedImprovement, rerenderRequired: true, requests: recorded.evidenceRequests };
const fixture = async (file: string) => JSON.parse(await readFile(`tests/fixtures/golden/void-ranger/${file}`, 'utf8'));
const [rig, animations, project] = await Promise.all([fixture('rig.json'), fixture('animations.json'), fixture('project.json')]);
const clip = animations.animations.find((clip: { id: string }) => clip.id === 'game-walk');
const track = clip.tracks.find((track: { boneId: string; property: string }) => track.boneId === 'torso' && track.property === 'rotation');
assert.equal(track.keyframes.at(-1).value, 2);
track.keyframes.at(-1).value = 10;
const snapshot = { storageVersion: 1, localProjectId: 'ui-proposal-replay', project: { ...project, id: 'ui-proposal-replay', name: 'Recorded proposal · UI replay' }, rig, animations, selectedSkinId: rig.defaultSkinId };
const saved = await fetch('http://127.0.0.1:47831/project-storage/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshot }) });
assert(saved.ok);
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let calls = 0;
try {
  await page.route('**/animation-doctor/review', route => {
    calls++;
    const packet = route.request().postDataJSON();
    const refs = new Set(packet.evidenceRefs.map((ref: { id: string }) => ref.id));
    // Replay only citations present in this packet. The recorded values,
    // issue, and edit remain unchanged; no new model assessment is invented.
    const available = <T extends { evidence: string[] }>(item: T) => ({ ...item, evidence: item.evidence.filter(ref => refs.has(ref)) });
    return route.fulfill({ json: { model: recorded.model, review: { ...review, issues: review.issues.map(available), edits: review.edits.map(available) } } });
  });
  // Keep replay audit records out of the real provider audit history.
  await page.route('**/animation-doctor/audit', route => route.fulfill({ json: { replay: true } }));
  await page.goto('http://localhost:3000/?mode=animate');
  await page.locator('.project-storage-menu>summary').click();
  await page.locator('.recent-projects article').filter({ hasText: 'Recorded proposal · UI replay' }).getByRole('button', { name: 'Open', exact: true }).click();
  await page.locator('.project-hydration-root[data-project-id="ui-proposal-replay"]').waitFor();
  await page.locator('.animation-picker select').selectOption('game-walk');
  await page.locator('.motion-review-entry').click();
  const panel = page.getByRole('region', { name: 'Animation Doctor' });
  await panel.getByRole('button', { name: 'Review Motion', exact: true }).click();
  await panel.getByRole('button', { name: 'Preview selected', exact: true }).click({ timeout: 60000 });
  await panel.locator('.motion-review-compare').waitFor();
  await page.evaluate(() => {
    const note = document.createElement('div');
    note.textContent = 'Recorded Astra proposal · UI replay · not a new benchmark';
    note.style.cssText = 'position:fixed;left:240px;top:112px;z-index:100;background:#19212c;color:#efc17e;padding:8px 12px;font:12px system-ui;border-left:2px solid #efc17e;pointer-events:none';
    document.body.appendChild(note);
  });
  await page.screenshot({ path: path.join(root, 'animate/doctor-proposal-replay.png') });
  await panel.screenshot({ path: path.join(root, 'animate/doctor-proposal-detail.png') });
  await panel.getByRole('slider', { name: 'Compare frame' }).fill('5');
  assert.match(await panel.innerText(), /Frame 6 \/ 6/);
  const metrics = await panel.locator('table').innerText();
  await panel.getByRole('button', { name: 'Reject', exact: true }).click();
  await writeFile(path.join(root, 'proposal-replay.json'), JSON.stringify({ kind: 'UI replay, not a live Astra run', source, recordedReview: review, calls, metrics, synchronizedScrub: true, rejectedAfterCapture: true, sourceFixtureUnchanged: true, note: 'Same recorded assessment replayed for comparison with unavailable image citations filtered out; its visual score is historical, not a fresh candidate evaluation. Metric deltas are computed by the production evaluator on the disposable defect copy.' }, null, 2));
} catch (error) {
  console.log(await page.locator('.motion-review').innerText());
  throw error;
} finally { await browser.close(); }
