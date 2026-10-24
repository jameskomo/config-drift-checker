import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TOOL = new URL('../tools/eval-dashboard.mjs', import.meta.url).pathname;

const kase = (dir, scores) => ({
  dir, name: dir,
  arms: { with: scores.map((score, i) => ({ runIndex: i, score, numTurns: 4, costUsd: 0.1, durationMs: 5000, model: 'm1', isError: false, toolUses: [{ tool: 'Bash', input: '{}' }], graders: [] })) },
  summary: { score: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null },
});
const result = (cases, { at, cc, track = 'pinned' }) => ({
  schemaVersion: '1.1', track, shim: true, generatedAt: at, suite: { name: 'fixture' },
  harness: { name: 'claude-code', version: cc },
  cases: Object.entries(cases).map(([dir, scores]) => kase(dir, scores)),
  aggregates: { overallScore: 1, erroredRuns: 0, totalRuns: 9, costUsd: 0.9, resolvedModels: ['m1'] },
});

const LONG = 'spring-controller-follows-conventions-and-more';

// 20 pinned runs over distinct Claude Code versions. Case LONG sits at 1.00 throughout; case b has a
// flaky baseline (runs [1,1,0.7] → band 0.3) and drops to 0.73 in the last run → noisy, not regressed.
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dash-'));
  const hist = path.join(dir, 'history');
  await fs.mkdir(hist);
  for (let i = 0; i < 20; i++) {
    const cc = `2.1.${240 + i}`;
    const last = i === 19;
    const r = result({ [LONG]: [1, 1, 1], b: last ? [1, 0.6, 0.6] : [1, 1, 1] }, { at: `2026-08-${String(i + 1).padStart(2, '0')}T10:00:00Z`, cc });
    await fs.writeFile(path.join(hist, `202608${String(i + 1).padStart(2, '0')}T100000Z-cc${cc}-shim-pinned.json`), JSON.stringify(r));
  }
  const base = path.join(dir, 'baseline.json');
  await fs.writeFile(base, JSON.stringify(result({ [LONG]: [1, 1, 1], b: [1, 1, 0.7] }, { at: '2026-07-01T10:00:00Z', cc: '2.1.230' })));
  const out = path.join(dir, 'index.html');
  const r = spawnSync('node', [TOOL, hist, '--baseline', base, '--out', out, '--title', 'fixture'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return fs.readFile(out, 'utf8');
}

test('dashboard: a drop inside the noise band is amber noisy, never red', async () => {
  const html = await fixture();
  assert.match(html, /noisy: within the historical band/);
  assert.match(html, /class="cell noisy /, 'ribbon cell is amber');
  assert.doesNotMatch(html, /class="cell regressed /);
  assert.match(html, /<tr class="st-noisy">/, 'runs table row is noisy');
  assert.doesNotMatch(html, /<tr class="st-regressed">/);
  assert.match(html, /<td class="num case noisy">0\.73<\/td>/);
});

test('dashboard: x-axis labels are thinned, never overlapping; the last version stays', async () => {
  const html = await fixture();
  const shown = [...html.matchAll(/<text x="([\d.]+)" y="[^"]*" class="tick" text-anchor="(?:middle|end)">(2\.1\.\d+)<\/text>/g)];
  assert.equal(shown.length, 10, 'greedy 56px thinning keeps 9 even labels + the swapped-in last');
  const xs = shown.map((m) => Number(m[1]));
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= 56, `labels ${i - 1} and ${i} are ${xs[i] - xs[i - 1]}px apart`);
  assert.equal(shown.at(-1)[2], '2.1.259', 'the newest version is always labelled');
  assert.ok(!shown.some((m) => m[2] === '2.1.258'), 'its colliding predecessor is dropped');
  assert.match(html, /text-anchor="end">2\.1\.259</, 'the last label is end-anchored so it cannot clip the chart edge');
});

test('dashboard: legend wraps below the chart with full case names', async () => {
  const html = await fixture();
  const legend = html.match(/<div class="legend">([\s\S]*?)<\/div>/)?.[1] ?? '';
  assert.ok(legend.includes(LONG), 'full name, not truncated');
  assert.doesNotMatch(legend, /…/);
  assert.doesNotMatch(html, /class="lbl"/, 'no clipped right-edge labels any more');
});

test('drift wire: verdicts.json, Atom feed and the adopter badge are emitted next to the page', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wire-'));
  const hist = path.join(dir, 'history');
  await fs.mkdir(hist);
  for (const [i, cc] of [[1, '2.1.250'], [2, '2.1.251'], [3, '2.1.252']]) {
    const red = cc === '2.1.252';
    const r = result({ a: red ? [0.2, 0.2, 0.2] : [1, 1, 1] }, { at: `2026-09-0${i}T10:00:00Z`, cc });
    await fs.writeFile(path.join(hist, `2026090${i}T100000Z-cc${cc}-shim-pinned.json`), JSON.stringify(r));
  }
  const base = path.join(dir, 'baseline.json');
  await fs.writeFile(base, JSON.stringify(result({ a: [1, 1, 1] }, { at: '2026-08-30T10:00:00Z', cc: '2.1.249' })));
  const out = path.join(dir, 'index.html');
  const r = spawnSync('node', [TOOL, hist, '--baseline', base, '--out', out, '--title', 'wiresuite', '--page-url', 'https://x.example/drift'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const v = JSON.parse(await fs.readFile(path.join(dir, 'verdicts.json'), 'utf8'));
  assert.equal(v.verdicts[0].claudeCode, '2.1.252', 'newest first');
  assert.equal(v.verdicts[0].verdict, 'drift');
  assert.deepEqual(v.verdicts[0].casesMoved, ['a']);
  assert.equal(v.verdicts[1].verdict, 'held');
  const feed = await fs.readFile(path.join(dir, 'feed.xml'), 'utf8');
  assert.match(feed, /Claude Code 2\.1\.252: drift on a/);
  assert.match(feed, /Claude Code 2\.1\.251: behaviour held/);
  assert.match(feed, /rel="self" href="https:\/\/x\.example\/drift\/feed\.xml"/);
  const badge = await fs.readFile(path.join(dir, 'status.svg'), 'utf8');
  assert.match(badge, /drift on cc2\.1\.252/, 'red drift badge names the version');
  assert.match(badge, /#f85149/);
  const html = await fs.readFile(out, 'utf8');
  assert.match(html, /Subscribe to the verdicts feed/);
});

test('hero tiles and the verdict timeline render with status colors and per-version tooltips', async () => {
  const html = await fixture();
  assert.match(html, /class="tiles"/);
  assert.match(html, /releases clean/);
  assert.match(html, /versions covered/);
  assert.match(html, /Verdict per Claude Code release/);
  assert.match(html, /<title>cc2\.1\.259 · held · b/, 'the tooltip names the wobbling case');
  assert.match(html, /fill="var\(--warn\)"><title>cc2\.1\.259/, 'an in-band wobble wears the warn status color, not red');
  assert.match(html, /fill="var\(--pass\)"><title>cc2\.1\.250/, 'clean versions are green');
});

// ---- setup health: format drift per Claude Code release ----
const skillsDoc = ({ errors = 0, warnings = 0, findings = [] } = {}) => ({ schemaVersion: 1, pluginDir: 'p', skills: 3, errors, warnings, findings });
const suiteDoc = ({ status = 'ok', version = null, cases = 4, failed = 0, findings = [], reason = null } = {}) => ({
  pluginDir: 'p', evalDir: 'evals', cases, fixApplied: false, fixed: [], findings,
  live: status === 'ok' ? { status, version, loadErrors: [], notes: [], failedCount: failed, runsStarted: 0, costUsd: 0, loaded: cases - failed } : { status, reason },
  summary: { errors: findings.filter((f) => f.level === 'ERROR').length, warnings: findings.filter((f) => f.level === 'WARN').length, fixed: 0, fixable: findings.filter((f) => f.fixable).length },
});
const sdFinding = (level, n, extra = {}) => ({ level, rule: 'r', case: `case-${n}`, file: 'case.yaml', key: 'k', message: `${level.toLowerCase()} message ${n}`, fix: `fix ${n}`, fixable: false, ...extra });

// writes one pinned run per entry ([cc, preflight|undefined]) and renders the page
async function healthFixture(entries) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'health-'));
  const hist = path.join(dir, 'history');
  await fs.mkdir(hist);
  for (const [i, [cc, preflight]] of entries.entries()) {
    const r = result({ a: [1, 1, 1] }, { at: `2026-09-${String(i + 1).padStart(2, '0')}T10:00:00Z`, cc });
    if (preflight !== undefined) r.preflight = preflight;
    await fs.writeFile(path.join(hist, `202609${String(i + 1).padStart(2, '0')}T100000Z-cc${cc}-shim-pinned.json`), JSON.stringify(r));
  }
  const out = path.join(dir, 'index.html');
  const r = spawnSync('node', [TOOL, hist, '--out', out, '--title', 'healthsuite'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return { html: await fs.readFile(out, 'utf8'), verdicts: JSON.parse(await fs.readFile(path.join(dir, 'verdicts.json'), 'utf8')) };
}
const segments = (html) => [...html.matchAll(/<rect class="fd" [^>]*fill="var\(--(\w+)\)"><title>([^<]*)<\/title>/g)].map((m) => ({ tone: m[1], tip: m[2] }));

test('setup health: no preflight anywhere renders nothing new and verdicts.json has no health key', async () => {
  const { html, verdicts } = await healthFixture([['2.1.250'], ['2.1.251', {}], ['2.1.252', null]]);
  assert.doesNotMatch(html, /Setup health/);
  assert.doesNotMatch(html, /Format drift/);
  assert.doesNotMatch(html, /class="fd"|\.hfp|\.fdg/, 'no extra markup or CSS');
  assert.ok(!('health' in verdicts));
  assert.deepEqual(Object.keys(verdicts), ['suite', 'generatedAt', 'pageUrl', 'streak', 'verdicts']);
});

test('setup health: mixed history draws a format segment only for versions with preflight data', async () => {
  const { html } = await healthFixture([
    ['2.1.250'],
    ['2.1.251', { skills: skillsDoc(), suite: suiteDoc({ version: '2.1.251' }) }],
    ['2.1.252'],
    ['2.1.253', { suite: suiteDoc({ version: '2.1.253' }) }],
    ['2.1.254'],
  ]);
  assert.match(html, /<h2>Setup health<\/h2>/);
  assert.match(html, /Format drift per Claude Code release/);
  const segs = segments(html);
  assert.deepEqual(segs.map((s) => s.tip.split(' · ')[0]), ['cc2.1.251', 'cc2.1.253']);
  assert.ok(html.indexOf('Verdict per Claude Code release') < html.indexOf('<h2>Setup health</h2>'), 'placed after the verdict timeline');
  assert.match(html, /Findings in the newest check <span>cc2\.1\.253/, 'tiles and findings follow the newest checked run, even if later runs have none');
});

test('setup health: each state wears its reserved tone with a glyph, and the tooltip says what loaded', async () => {
  const { html, verdicts } = await healthFixture([
    ['2.1.250', { skills: skillsDoc(), suite: suiteDoc({ version: '2.1.250' }) }],
    ['2.1.251', { skills: skillsDoc({ warnings: 1, findings: [{ level: 'WARN', rule: 'body-empty', file: 'skills/x/SKILL.md', line: 4, message: 'the body is empty', fix: 'write it' }] }), suite: suiteDoc({ version: '2.1.251' }) }],
    ['2.1.252', { skills: skillsDoc(), suite: suiteDoc({ status: 'skipped', reason: 'no --runner given and no claude on PATH' }) }],
    ['2.1.253', { skills: skillsDoc(), suite: suiteDoc({ version: '2.1.253', failed: 1 }) }],
    ['2.1.254', { skills: skillsDoc(), suite: suiteDoc({ version: '2.1.254', failed: 1, findings: [sdFinding('ERROR', 1, { fixable: true, confirmedByRunner: true })] }) }],
  ]);
  const segs = segments(html);
  assert.deepEqual(segs.map((s) => s.tone), ['pass', 'warn', 'warn', 'fail', 'fail'], 'clean, warnings, not confirmed, load failure, suite error');
  assert.equal(segs[0].tip, 'cc2.1.250 · loaded 4 of 4 · 0 errors');
  assert.equal(segs[1].tip, 'cc2.1.251 · loaded 4 of 4 · 0 errors · the body is empty');
  assert.equal(segs[2].tip, 'cc2.1.252 · not confirmed, 4 cases · 0 errors');
  assert.equal(segs[3].tip, 'cc2.1.253 · loaded 3 of 4 · 0 errors');
  assert.equal(segs[4].tip, 'cc2.1.254 · loaded 3 of 4 · 1 error · error message 1');
  for (const g of ['✓', '⚠', '✖']) assert.match(html, new RegExp(`class="fdg"[^>]*>${g}<`), `glyph ${g} drawn inside its segment`);
  assert.match(html, /<div class="tl">Eval suite format<\/div><div class="tb fail">✖ 3 of 4 load<\/div><div class="ts">on Claude Code 2\.1\.254 · confirmed by the runner · 1 error, 1 fixable with --fix<\/div>/);
  assert.match(html, /<div class="tl">Skills<\/div><div class="tb pass">✓ healthy<\/div><div class="ts">3 checked · 0 errors · 0 warnings<\/div>/);
  assert.match(html, /<i>--fix can apply<\/i> <i>runner agrees<\/i>/);
  assert.deepEqual(verdicts.health.versions.map((v) => [v.claudeCode, v.format]), [['2.1.254', 'errors'], ['2.1.253', 'errors'], ['2.1.252', 'unconfirmed'], ['2.1.251', 'warnings'], ['2.1.250', 'healthy']]);
});

test('setup health: a clean newest check says so in one line; an unconfirmed one says why', async () => {
  const clean = await healthFixture([['2.1.250', { skills: skillsDoc(), suite: suiteDoc({ version: '2.1.250' }) }]]);
  assert.match(clean.html, /<p class="hfok pass">✓ Every skill is well formed and all 4 eval cases load on Claude Code 2\.1\.250\. Nothing to fix\.<\/p>/);
  const skipped = await healthFixture([['2.1.250', { suite: suiteDoc({ status: 'skipped', reason: 'no --runner given and no claude on PATH' }) }]]);
  assert.match(skipped.html, /<div class="tb warn">⚠ not confirmed<\/div><div class="ts">4 cases · static checks only, not confirmed by the runner \(no --runner given and no claude on PATH\)<\/div>/);
  assert.match(skipped.html, /<p class="hfok warn">⚠ The static checks found nothing to fix, but loading was not confirmed against the runner: no --runner given and no claude on PATH\.<\/p>/);
  assert.match(skipped.html, /<div class="tl">Skills<\/div><div class="tb ">n\/a<\/div>/, 'a missing part is shown as not checked, not as healthy');
});

test('setup health: findings list errors first, at most 8, then "and N more"', async () => {
  const findings = [];
  for (let i = 1; i <= 12; i++) findings.push(sdFinding(i % 3 === 0 ? 'ERROR' : 'WARN', i));
  const { html } = await healthFixture([['2.1.250', { suite: suiteDoc({ version: '2.1.250', findings }) }]]);
  const items = [...html.matchAll(/<span class="hfm">([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.equal(items.length, 8);
  assert.deepEqual(items.slice(0, 4), ['error message 3', 'error message 6', 'error message 9', 'error message 12'], 'errors first, in order');
  assert.deepEqual(items.slice(4), ['warn message 1', 'warn message 2', 'warn message 4', 'warn message 5']);
  assert.match(html, /<p class="hfmore">and 4 more<\/p>/);
  assert.match(html, /<span class="hfl fail">✖ error<\/span><span class="hfw mono">suite · case-3 · case\.yaml · k:<\/span>/);
});

test('setup health: verdicts.json gains health per version and keeps every existing field', async () => {
  const { verdicts } = await healthFixture([
    ['2.1.250'],
    ['2.1.251', { skills: skillsDoc({ errors: 1, findings: [{ level: 'ERROR', rule: 'name-missing', file: 'skills/x/SKILL.md', line: null, message: 'no name', fix: 'add name' }] }), suite: suiteDoc({ version: '2.1.251' }) }],
  ]);
  assert.deepEqual(Object.keys(verdicts), ['suite', 'generatedAt', 'pageUrl', 'streak', 'verdicts', 'health']);
  assert.equal(verdicts.verdicts.length, 2);
  for (const v of verdicts.verdicts) for (const k of ['claudeCode', 'at', 'track', 'runner', 'verdict', 'wobble', 'overall', 'casesMoved', 'report']) assert.ok(k in v, k);
  assert.equal(verdicts.health.latest, '2.1.251');
  assert.deepEqual(verdicts.health.versions, [{ claudeCode: '2.1.251', at: '2026-09-02T10:00:00Z', format: 'errors', cases: 4, loaded: 4, failedToLoad: 0, confirmed: true,
    errors: 1, warnings: 0, fixable: 0, skills: { checked: 3, errors: 1, warnings: 0 } }]);
});

test('setup health: finding text, fixes and versions are HTML-escaped', async () => {
  const evil = '<script>alert("x")</script> & co';
  const { html } = await healthFixture([['2.1.250', { suite: suiteDoc({ version: '2.1.250<b>', findings: [sdFinding('ERROR', 1, { message: evil, fix: evil, case: evil })] }) }]]);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; co/);
  assert.match(html, /on Claude Code 2\.1\.250&lt;b&gt;/);
});

// ---- untested releases: seen (free-floor record or release-watch state) but never behaviour-tested ----
const floorDoc = (cc, reason, at, { loaded = 6, cases = 6, alwaysOn = 123 } = {}) => ({
  schemaVersion: 1, tool: 'floor', generatedAt: at, claudeCode: cc, track: 'canary',
  skip: { reason, spentMonth: 25, capMonth: 25, nextAllowed: null },
  preflight: { skills: skillsDoc(), suite: suiteDoc({ version: cc, cases, failed: cases - loaded }) },
  contextCost: { alwaysOn, onInvoke: 440, source: 'official', claudeVersion: cc },
  checks: { suite: { cases, loaded, confirmed: true, errors: 0, warnings: 0 }, skills: { checked: 3, errors: 0, warnings: 0 } },
});
// a canary on 2.1.296 and one on 2.1.298, both green unless red; floors and releaseWatch are optional extras
async function untestedFixture({ floors = null, releaseWatch = null, red = false, pinnedOnly = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'untested-'));
  const hist = path.join(dir, 'history');
  await fs.mkdir(hist);
  for (const [i, cc] of [[1, '2.1.296'], [2, '2.1.298']]) {
    const track = pinnedOnly ? 'pinned' : 'canary';
    const r = result({ a: red && cc === '2.1.298' ? [0.2, 0.2, 0.2] : [1, 1, 1] }, { at: `2026-10-0${i}T10:00:00Z`, cc, track });
    await fs.writeFile(path.join(hist, `2026100${i}T100000Z-cc${cc}-official-${track}.json`), JSON.stringify(r));
  }
  const base = path.join(dir, 'baseline.json');
  await fs.writeFile(base, JSON.stringify(result({ a: [1, 1, 1] }, { at: '2026-09-30T10:00:00Z', cc: '2.1.290' })));
  const args = [hist, '--baseline', base, '--out', path.join(dir, 'index.html'), '--title', 'gaps', '--page-url', 'https://x.example/drift'];
  if (floors) {
    const fd = path.join(hist, 'floor'); await fs.mkdir(fd);
    for (const f of floors) await fs.writeFile(path.join(fd, `${f.generatedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-cc${f.claudeCode}.json`), JSON.stringify(f));
  }
  if (releaseWatch) { await fs.writeFile(path.join(dir, 'rw.json'), JSON.stringify(releaseWatch)); args.push('--release-watch', path.join(dir, 'rw.json')); }
  const r = spawnSync('node', [TOOL, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const read = (f) => fs.readFile(path.join(dir, f), 'utf8');
  return { html: await read('index.html'), verdicts: JSON.parse(await read('verdicts.json')), feed: await read('feed.xml'), badge: await read('status.svg') };
}
const stable = (o) => ({ ...o, verdicts: { ...o.verdicts, generatedAt: null }, feed: o.feed.replace(/(<\/title>\n  <updated>)[^<]*/, '$1') });

test('untested: no floor records and no untested release render byte-identically to before', async () => {
  const plain = stable(await untestedFixture());
  // an empty floor dir and a release-watch state naming a release that was tested change nothing
  const same = stable(await untestedFixture({ floors: [], releaseWatch: { harness: '2.1.298', models: ['m1'] } }));
  assert.equal(same.html, plain.html);
  assert.equal(same.badge, plain.badge);
  assert.equal(same.feed, plain.feed);
  assert.deepEqual(same.verdicts, plain.verdicts);
  assert.doesNotMatch(plain.html, /untested|class="ut"/);
  assert.ok(!('untested' in plain.verdicts));
  assert.match(plain.badge, /✓ cc2\.1\.298/);
});

test('untested: a budget-skipped release is its own state in verdicts.json, the timeline, the badge, the feed and the hero', async () => {
  const { html, verdicts, feed, badge } = await untestedFixture({ floors: [floorDoc('2.1.310', 'budget', '2026-10-20T06:17:00.000Z'), floorDoc('2.1.299', 'interval', '2026-10-16T06:17:00.000Z')] });
  assert.deepEqual(verdicts.verdicts.map((v) => [v.claudeCode, v.verdict]), [['2.1.310', 'untested'], ['2.1.299', 'untested'], ['2.1.298', 'held'], ['2.1.296', 'held']], 'version order, newest first');
  const [v] = verdicts.verdicts;
  assert.equal(v.reason, 'budget');
  assert.deepEqual(v.freeChecks, { suiteCases: 6, suiteLoaded: 6, contextCostTokens: 123, summary: 'Free checks ran: suite loads 6 of 6, context cost 123 tokens.' });
  assert.equal(verdicts.verdicts[1].reason, 'interval');
  assert.deepEqual(verdicts.untested, { newest: '2.1.310', versions: ['2.1.310', '2.1.299'] });
  // timeline: a dashed neutral segment, never a status colour, and the key names the state
  const ut = [...html.matchAll(/<rect class="ut" [^>]*fill="var\(--code\)" stroke="var\(--muted\)"[^>]*><title>([^<]*)<\/title>/g)].map((m) => m[1]);
  assert.deepEqual(ut, ['cc2.1.299 · untested (too soon after the last scheduled canary) · Free checks ran: suite loads 6 of 6, context cost 123 tokens.', 'cc2.1.310 · untested (monthly budget reached) · Free checks ran: suite loads 6 of 6, context cost 123 tokens.']);
  assert.match(html, /<i class="muted">○<\/i> untested, behaviour not run/);
  // badge: amber, names the version and the reason
  assert.match(badge, /aria-label="agent setup: cc2\.1\.310 · untested \(budget\)"/);
  assert.match(badge, /fill="#d29922"/);
  assert.doesNotMatch(badge, /#3fb950/);
  // feed: an entry for the untested release too
  assert.match(feed, /<title>Claude Code 2\.1\.310: behaviour not tested, monthly budget reached \(gaps\)<\/title>\n    <updated>2026-10-20T06:17:00\.000Z<\/updated>/);
  assert.match(feed, /<summary>Free checks ran: suite loads 6 of 6, context cost 123 tokens\. No behaviour verdict until a run covers this release\.<\/summary>/);
  assert.match(feed, /Claude Code 2\.1\.298: behaviour held/);
  // hero and tile: not green
  assert.match(html, /<h1 class="warn"><span class="mark">◆<\/span><span>Not tested on Claude Code 2\.1\.310<\/span><\/h1>/);
  assert.match(html, /Behaviour has not been tested on 2\.1\.310 \(monthly budget reached\), nor on 1 other release\. The newest tested release, 2\.1\.298, held\. Free checks ran on 2\.1\.310: suite loads 6 of 6, context cost 123 tokens\./);
  assert.match(html, /latest verdict<\/div><div class="tb warn">untested<\/div><div class="ts">cc2\.1\.310/);
  // the floor's preflight fills the Setup health strip for the skipped release
  assert.match(html, /<rect class="fd" [^>]*fill="var\(--pass\)"><title>cc2\.1\.310 · loaded 6 of 6/);
});

test('untested: the release-watch state counts for a suite that follows releases, not for a pinned-only one', async () => {
  const rw = { harness: '2.1.310', models: ['m1'] };
  const { verdicts, badge } = await untestedFixture({ releaseWatch: rw });
  assert.equal(verdicts.verdicts[0].claudeCode, '2.1.310');
  assert.equal(verdicts.verdicts[0].verdict, 'untested');
  assert.equal(verdicts.verdicts[0].reason, null);
  assert.equal(verdicts.verdicts[0].freeChecks, null);
  assert.match(badge, /cc2\.1\.310 · untested</);
  const pinned = await untestedFixture({ releaseWatch: rw, pinnedOnly: true });
  assert.ok(!('untested' in pinned.verdicts));
  assert.match(pinned.badge, /✓ cc2\.1\.298/);
});

test('untested: a red run still wins the badge and the hero', async () => {
  const { html, badge, verdicts } = await untestedFixture({ red: true, floors: [floorDoc('2.1.310', 'budget', '2026-10-20T06:17:00.000Z')] });
  assert.match(badge, /drift on cc2\.1\.298/);
  assert.match(badge, /#f85149/);
  assert.match(html, /<h1 class="fail">/);
  assert.equal(verdicts.verdicts[0].verdict, 'untested', 'the gap is still on the wire');
});
