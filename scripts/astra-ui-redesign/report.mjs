import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve('.rigging-studio/diagnostics/astra-ui-redesign/2026-09-06T-visual');
const read = name => readFile(path.join(root,name),'utf8');
const json = async name => JSON.parse(await read(name));
const write = (name,value) => writeFile(path.join(root,name), JSON.stringify(value,null,2)+'\n');
const images = async dir => (await readdir(path.join(root,dir),{recursive:true})).filter(file=>file.endsWith('.png')).sort();
const [before,after,accessibility,interaction,matrix,performance,responsive] = await Promise.all([images('before'),images('after'),json('accessibility.json'),json('interaction-results.json'),json('matrix.json'),json('performance.json'),json('responsive-results.json')]);
const pairs = before.filter(file=>after.includes(file));
const supplemental = (await Promise.all(['prepare','setup','animate','compact'].map(images))).flat().length;
const full = await read('full-regression.log');
const hydration = JSON.parse((await read('hydration.log')).trim().split('\n').at(-1));
const wos = JSON.parse(await readFile('.rigging-studio/diagnostics/wand-or-steel-rigging/astra-ui-redesign-final-2026-09-06/baseline-summary.json','utf8'));
assert(full.includes('384 passed') && /pass 5/.test(full));
assert(!/error TS/.test(await read('typecheck.log')));
assert.equal((await read('changed-files-lint.log')).trim(),'');
assert(accessibility.every(state=>state.violations.length===0));
assert.equal(interaction.errors.length,0);
assert(matrix.length===40 && matrix.every(state=>!state.overflow && !state.errors.length));
assert(responsive.every(state=>!state.documentOverflow));
assert(hydration.result==='PASS' && hydration.deterministicSwitches===100);
assert.equal(execFileSync('git',['-C','/Users/nicholaslippa/wand-or-steel','status','--porcelain'],{encoding:'utf8'}).trim(),'');

const files = {
  'app/studio-ui/workstation.css': 'Shared graphite/cyan/violet tokens; surfaces, controls, canvas, guides, timeline, inspector, feedback, responsive presentation.',
  'app/studio-ui/StudioIcon.tsx': 'Small consistent SVG icon family; no dependency.',
  'app/studio-ui/TopCommandRail.tsx': 'Rig mark, search, Undo and Redo use shared glyphs.',
  'app/page.tsx': 'Load shared presentation layer after workspace styles.',
  'app/rig-editor/page.tsx': 'Load shared presentation layer on compatibility route.',
  'app/part-cutter/page.tsx': 'Load shared presentation layer for Prepare.',
  'app/part-cutter/PartCutterWorkspace.tsx': 'Named guide groups, focusable canvas region, small visual guide points over unchanged transparent landmark hit circles.',
  'app/rig-editor/CanvasControls.tsx': 'Consistent Select, Pan, and Fit icons with explicit labels.',
  'app/rig-editor/EditorViewport.tsx': 'Thin grid/bones; concentric selected nodes and quarter-turn pivot ticks; transparent renderer clear over the CSS chamber; valid viewport region role.',
  'app/rig-editor/SemanticNavigator.tsx': 'Use group semantics for the existing disclosure/button navigator instead of an invalid ARIA tree.',
  'app/rig-editor/AnimateWorkspace.tsx': 'Fit character action calls the existing viewport reset method. Existing Animation Doctor additions predate this pass.',
  'app/rig-editor/DopeSheet.tsx': 'Visual clip range derives from actual duration and loop state.',
  'app/rig-editor/rig-editor.css': 'Remove conflicting legacy key-diamond paint rules. Existing Motion Review rules predate this pass.'
};
const unchanged = 'Prepare ownership, lasso geometry, auto-rig, hierarchy data, transforms, pivot hit testing, bindings, animation evaluation, persistence, project isolation, ZIP, validators, Animation Doctor and provider logic were not rewritten. Existing dirty Animation Doctor/provider files and generated tsconfig.tsbuildinfo are separate from this pass. No package dependencies added.';
await write('changed-surfaces.json',{ productionFiles:Object.entries(files).map(([file,change])=>({file:path.resolve(file),change})), scope:unchanged });
const css = await readFile('app/studio-ui/workstation.css','utf8');
const tokens = Object.fromEntries([...css.matchAll(/(--(?:ws-|glow-)[\w-]+):\s*([^;]+);/g)].filter(match=>!match[2].includes('var(')).map(match=>[match[1],match[2].trim()]));
await write('design-tokens.json',{tokens,motion:{fast:'100ms',normal:'160ms',panel:'200ms',easing:'cubic-bezier(.2,.8,.2,1)',source:'Existing app/globals.css tokens retained',reducedMotion:'Existing global policy plus explicit loading/press overrides'},semantics:{primary:'violet proposals and key selection',secondary:'cyan active editing and guidance',success:'mint',warning:'amber',error:'rose'},fonts:'Local system sans and local UI monospace; no downloads'});
const regression = { result:'PASS', unit:{files:52,tests:384,log:'full-regression.log',coverage:['Prepare/Guided Manual','ownership and lasso','adaptive guide','rigging/hierarchy/pivots','animation editor/player','Animation Doctor','persistence and project lifecycle','project integrity/isolation','Void Ranger golden','MCP/provider contracts']},renderedHTML:{tests:5,result:'PASS'},productionBuild:'PASS',typecheck:'PASS',changedFilesLint:'PASS',repositoryLint:{result:'EXISTING_FAILURE',errors:2,warnings:4,errorFile:'scripts/deterministic-cut-arbitration/finalize.mts',log:'lint.log'},hydration,wos,wosClean:true,behavior:'capture.mts, verify.mts, matrix.mts and proposal-replay.mts passed',doctorCaveat:'Proposal state uses a labeled recorded-output UI replay; no new live Astra benchmark was run. The earlier animation intelligence benchmark result is not upgraded by this visual pass.' };
await write('regression-results.json',regression);
const summary = {result:'ASTRA UI REDESIGN PASS',direction:'Precision holographic animation workstation: graphite depth, cyan editing signals, restrained violet proposals',productionFiles:Object.keys(files),screenshots:{before:before.length,after:after.length,paired:pairs.length,supplemental,totalRedesigned:after.length+supplemental},viewports:[[1920,1080],[1440,900],[1280,800],[900,800],[760,800]],accessibility:{auditedStates:accessibility.length,violations:0,scope:'Automated WCAG A/AA plus focused keyboard, hit-area and reduced-motion checks; not a certification'},regression:'PASS',repositoryLint:'2 existing errors, 4 existing warnings; changed files clean',evidence:root,productQuestion:'Yes. The core stages now read as a distinctive precision animation workstation, with stronger canvas, rig, and timeline identity. Advanced legacy surfaces and source-fixture fidelity remain less polished.'};
await write('summary.json',summary);
const cad = performance.matchedVoidRangerFrameCadence;
const latency = Object.entries(performance.summaries).map(([key,s])=>`${key}: median ${s.median.toFixed(1)} ms (${s.samples} samples)`).join('; ');
const fileList=Object.entries(files).map(([file,change])=>`- [${file}](${path.resolve(file)}): ${change}`).join('\n');
const table=responsive.filter(s=>s.state.startsWith('animate')).map(s=>`| ${s.viewport.join(' × ')} | ${s.canvas.width} × ${s.canvas.height} | ${s.timeline.width} × ${s.timeline.height} | ${s.inspector.width} |`).join('\n');
await writeFile(path.join(root,'report.md'),`# ASTRA UI REDESIGN PASS

## 1. Result
Substantial visual transformation completed. Functional regression gates pass. The full-repository lint exceptions are unchanged and identified below.

## 2. Overall visual direction
Precision holographic animation workstation: recessed graphite chamber, atmospheric depth, fine cyan editing signals and selective violet emphasis. The result is quieter than the original heavily filled purple interface, while retaining a recognizable instrument-like identity.

## 3. Primary design principles
Canvas first; light communicates state; compact but readable controls; precise selection; truthful readouts; fast bounded motion; retain the editor's architecture.

## 4. Most transformed surfaces
Command rail, canvas/grid, rig joints/pivots, timeline keys/playhead, Guided Manual target panel, and compact inspectors. See [interactive comparison](compare/index.html).

## 5. Prepare improvements
Prominent semantic target with real body count; restrained guide/ownership tints; smaller visible landmark points with original hit circles preserved; crisp source pixels; compact Add/Remove/Replace, Use Guide/Component, Skip/Back and Undo/Redo. At narrow widths the source fits the canvas width and the action inspector remains available. Canvas scrolling is keyboard accessible.

## 6. Setup improvements
Quieter semantic hierarchy, thin selected-row signal, clearer inspector grouping and compact numbers. Existing body, pivot and equipment workflows remain. Real WOS arm/pivot/equipment states were exercised.

## 7. Animate improvements
Compact clip selector and transport; more deliberate separation of editing and diagnostic controls; restrained Review Motion entry. Fit character reuses the existing camera reset to reframe after opening an inspector.

## 8. Timeline improvements
8 px diamond visuals on 24 × 24 px interactive targets replace the malformed legacy slashes. Selected keys use violet; hover/focus use cyan. Fine cyan playhead, real clip-duration strip, quiet hierarchy and readable timing. No generated/edited/warning key states are invented.

## 9. Canvas/rig visualization improvements
Recessed atmospheric viewport, faint technical grid, segmented luminous corners, thin bone chains, compact concentric selected joints and quarter-turn rotation ticks. Artwork textures are not filtered. Existing trajectory computation is retained; no unsupported velocity data is added.

## 10. Inspector improvements
Readable property hierarchy, monospace numeric fields, subdued containers and clear focus. Context panels preserve a usable 280 px width in compact Animate. Long diagnostic content scrolls.

## 11. Motion/microinteraction improvements
Reuse existing 100/160/200 ms motion tokens, restrained hover edges, pressed brightness, key hover emission, and a thin hydration sweep. Reduced-motion disables the new sweep and press movement. No new ambient animation loop or blur stack.

## 12. AI/Animation Doctor visual treatment
Small waveform entry, subordinate violet signal, concise severity/proposal presentation, paired Baseline/Proposal frames, synchronized scrub and actual deterministic metric deltas. [Proposal replay](animate/doctor-proposal-replay.png) is explicitly labeled as a UI replay of the recorded Astra development loop-seam proposal. The historical assessment is reused, unavailable citations are filtered, and the 48.774 → 0.000 loop metric is computed by the production evaluator on a disposable copy. It is **not a new live model comparison or benchmark success**. Reject was tested; no proposal was accepted into source. Provider unavailable state uses explicit network fault injection. Production provider logic was untouched.

## 13. Responsive behavior
All five requested sizes visually inspected. Forty matched Setup/Animate states passed the matrix with no page overflow or uncaught browser exceptions. The 1280 px command-rail overlap found during review was corrected. Secondary navigation collapses; editing labels retain size. Prepare reserves 260 px for guided actions at 900/760 px.

| Viewport | Animate canvas with review | Timeline content | Inspector width |
| --- | --- | --- | --- |
${table}

The canvas remains the largest individual editing region. These are measured bounds; the 36 px timeline header is separate from its 220 px content region.

## 14. Accessibility
${accessibility.length} tested states have zero axe WCAG 2 A/AA and 2.1 AA rule violations: Setup pivot, Animate keyframe, compact motion review, Prepare ownership, compact Prepare. Fixed invalid navigator/viewport/landmark roles, low-contrast metadata and focusability of the scrollable cutting canvas. Existing input labels and hit logic remain. Key targets are 24 × 24 px. Keyboard focus and reduced-motion were inspected. This is scoped automated and manual verification, not a whole-product accessibility certification or screen-reader audit.

## 15. Performance impact
Matched Void Ranger browser frame cadence: median ${cad.before.median.toFixed(1)} → ${cad.after.median.toFixed(1)} ms; p95 ${cad.before.p95.toFixed(1)} → ${cad.after.p95.toFixed(1)} ms; maximum ${cad.before.max.toFixed(1)} → ${cad.after.max.toFixed(1)} ms. Median/p95 stayed stable; the after sample includes one longer frame. No broad performance improvement is claimed.

Final serial local measurements: ${latency}. See [raw performance data](performance.json), which retains the slower concurrent QA timings separately. rAF measures browser cadence during Pixi playback, not a GPU frame counter. Latencies include Playwright dispatch/waits. No pre-edit action latency baseline was collected; hardware-wide or production performance equivalence is not established. No fake FPS or latency is shown in the product.

## 16. Exact production files changed
${fileList}

${unchanged}

The new QA/report helpers are under scripts/astra-ui-redesign/. Diagnostics are under this evidence directory. No commit or deployment was performed.

## 17. Exact regressions
- Unit: 52 files / 384 tests passed, including Prepare, ownership, rigging, animation, persistence, integrity/isolation, Void Ranger golden and Animation Doctor tests.
- Production build: passed.
- Rendered HTML: 5 tests passed.
- Typecheck: passed.
- Changed production and QA files lint: passed.
- Full repository lint: 2 pre-existing explicit-any errors in scripts/deterministic-cut-arbitration/finalize.mts, plus 4 pre-existing warnings. See lint.log.
- Playwright: Guided Manual Skip/Back, Use Guide, ownership intents, lasso drawing, review, settings, Setup selection/pivots/equipment, clip selection, key selection, timeline scrub, playback, Review Motion entry/failure, proposal preview scrub/reject, stale-content loading and compact controls passed.
- 100-switch hydration: sentinel, same-ID collision, switch during playback, 100 deterministic switches, fresh context and full reload passed.
- WOS: all 10 fixtures passed core, semantics, hierarchy, pivots, rotation integrity, z-order, equipment, pose, animation, persistence, determinism and reopen checks.
- git diff --check: passed.

Baseline capture harness note: the original ux:inspect captured all 40 requested baseline states, then stopped in its unrelated interaction packet on obsolete Guided/Manual labels. Current behavior verification uses the dedicated passing scripts. Early selector/hydration harness failures were corrected; final results above are from completed runs.

## 18. WOS cleanliness
git status --porcelain is empty for /Users/nicholaslippa/wand-or-steel. Read-only source assets were imported into disposable local browser/project copies. WOS regression evidence: .rigging-studio/diagnostics/wand-or-steel-rigging/astra-ui-redesign-final-2026-09-06/.

## 19. Before/after screenshot count
${before.length} before; ${after.length} in after/; ${pairs.length} exact filename pairs. Another ${supplemental} redesigned workflow/compact/detail screenshots live in prepare/, setup/, animate/ and compact/, for ${after.length+supplemental} redesigned images total. Some supplemental views overlap paired states. Playback poses are time-dependent. The historical setup-selected-arm filenames actually contain the fixture's fallback Head selection; real selected-arm evidence is setup/warrior-arm.png.

## 20. Evidence directory
${root}

Includes report, summary, tokens, changed surfaces, responsive/interaction/accessibility/performance/regression JSON, raw logs, paired screenshots and interactive comparison.

## 21. Top five visual improvements
1. Recessed character chamber and restrained luminous corners.
2. Thin rig instrumentation with precise concentric joints and rotation ticks.
3. Clean diamond timeline keys, real range strip and cyan playhead.
4. Strong Guided Manual target hierarchy, crisp artwork and compact action access.
5. Calm command rail and contextual inspectors across desktop and compact widths.

## 22. Top three remaining visual weaknesses
1. The existing Void Ranger golden rig renders fragmented/duplicated artwork, visible before this pass. Its source/rig fidelity limits visual polish and was not repaired in a presentation-only task.
2. Very small WOS sprites still appear small after Setup's existing capped Fit operation; user zoom helps. Camera fit math was preserved.
3. Advanced legacy dialogs/review controls are less unified than the main stages, and long proposal metrics need inspector scrolling. This pass improves the core workstation more than every historical utility surface.

## Final product question
**Yes.** The main workspaces now look and feel like a distinctive precision character-animation instrument, with a coherent luminous canvas, rig and timeline language. The remaining fixture fidelity and legacy-surface weaknesses keep this from being uniformly polished everywhere. The earlier Animation Doctor intelligence benchmark remains a separate, unchanged result.
`);

const data=JSON.stringify(pairs);
await writeFile(path.join(root,'compare/index.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Rigging Studio — before / after</title><style>body{margin:0;background:#080b10;color:#e9eef6;font:14px system-ui}header{padding:22px;display:flex;gap:18px;flex-wrap:wrap;align-items:center}h1{font-size:18px;margin:0}select{max-width:95vw;background:#19212c;color:#e9eef6;padding:9px;border:1px solid #50647c}a{color:#68e1ef}main{position:relative;margin:0 20px 20px;border:1px solid #283341}img{display:block;width:100%;height:auto}#after{position:absolute;inset:0;clip-path:inset(0 0 0 50%)}#line{position:absolute;top:0;bottom:0;left:50%;width:2px;background:#68e1ef;pointer-events:none}footer{padding:0 22px 22px;color:#b0bbcc}input{width:240px;accent-color:#68e1ef}:focus-visible{outline:2px solid #68e1ef;outline-offset:3px}</style><header><h1>Rigging Studio · visual comparison</h1><label>State <select id="state"></select></label><label>Before / After <input id="split" type="range" min="0" max="100" value="50"></label><a href="../report.md">Full report</a></header><main><img id="before" alt="Baseline interface"><img id="after" alt="Redesigned interface"><div id="line"></div></main><footer>${pairs.length} matched states · Left: baseline · Right: redesign. Drag the divider or use arrow keys. Playback poses may differ. Selected-arm fixture filenames use Head fallback; WOS arm evidence is separate.</footer><script>const states=${data};const select=document.getElementById('state');for(const name of states){const o=document.createElement('option');o.value=name;o.textContent=name.replaceAll('-',' ').replace('.png','');select.appendChild(o)}select.value='matrix/animate-timeline-1440x900.png';function render(){document.getElementById('before').src='../before/'+select.value;document.getElementById('after').src='../after/'+select.value}select.onchange=render;document.getElementById('split').oninput=e=>{document.getElementById('after').style.clipPath='inset(0 0 0 '+e.target.value+'%)';document.getElementById('line').style.left=e.target.value+'%'};render();</script></html>`);
console.log(JSON.stringify(summary,null,2));
