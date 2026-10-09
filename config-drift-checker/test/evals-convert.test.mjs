import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { slugify, isAboutFiles, readSkillCreator, planImport, applyImport, exportSuite, triggerMatch } from '../tools/evals-convert.mjs';
import { loadSuite, diagnose } from '../tools/suite-doctor.mjs';

const TOOL = new URL('../tools/evals-convert.mjs', import.meta.url).pathname;
const DOCTOR = new URL('../tools/suite-doctor.mjs', import.meta.url).pathname;
const EXAMPLE = new URL('../../examples/komo-stack', import.meta.url).pathname;

// The skill-creator layout: <plugin>/skills/<skill>/evals/evals.json, files relative to the skill root.
const EVALS = {
  skill_name: 'csv-tidy',
  evals: [
    { id: 1, prompt: 'My boss sent sales.csv with messy headers: clean them up and save it as tidy.csv',
      expected_output: 'A tidy.csv with snake_case headers',
      files: ['evals/files/sales.csv', 'evals/files/notes/readme.txt'],
      expectations: ['The output file tidy.csv exists', 'The reply explains which headers changed', 'Headers use "snake_case": no spaces, no quotes like \'this\''] },
    { id: 2, prompt: "What's a CSV dialect?", expectations: ['The answer mentions delimiters and quoting'] },
  ],
};
async function plugin(evals = EVALS, { inputs = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evals-convert-'));
  await fs.mkdir(path.join(root, '.claude-plugin'), { recursive: true });
  await fs.writeFile(path.join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'tidy', skills: ['./skills/csv-tidy'] }));
  const skill = path.join(root, 'skills/csv-tidy');
  await fs.mkdir(path.join(skill, 'evals/files/notes'), { recursive: true });
  await fs.writeFile(path.join(skill, 'SKILL.md'), '---\nname: csv-tidy\ndescription: Tidy CSV files\n---\nTidy.\n');
  if (inputs) {
    await fs.writeFile(path.join(skill, 'evals/files/sales.csv'), 'First Name,Last Name\n');
    await fs.writeFile(path.join(skill, 'evals/files/notes/readme.txt'), 'notes\n');
  }
  const json = path.join(skill, 'evals/evals.json');
  await fs.writeFile(json, JSON.stringify(evals, null, 2));
  return { root, skill, json };
}
const emptyPath = async () => fs.mkdtemp(path.join(os.tmpdir(), 'no-claude-'));
const run = (tool, args, opts = {}) => spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8', ...opts });
async function snapshot(dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  const walk = async (d) => { for (const e of await fs.readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) await walk(p); else out[path.relative(dir, p)] = await fs.readFile(p, 'utf8'); } };
  await walk(dir);
  return out;
}
const read = (p) => fs.readFile(p, 'utf8');

test('slugs are deterministic and file-ish statements are recognised', () => {
  assert.equal(slugify('  Héllo, World: the "CSV" thing!  '), 'hello-world-the-csv-thing');
  assert.equal(slugify('a'.repeat(30) + ' ' + 'b'.repeat(30)), 'a'.repeat(30));
  assert.ok(isAboutFiles('The output file tidy.csv exists'));
  assert.ok(isAboutFiles('Creates report.docx'));
  assert.ok(!isAboutFiles('The reply explains which headers changed'));
  assert.ok(new RegExp(triggerMatch('csv-tidy')).test(JSON.stringify({ skill: 'tidy:csv-tidy' })));
  assert.ok(!new RegExp(triggerMatch('csv-tidy')).test(JSON.stringify({ skill: 'other' })));
});

test('readSkillCreator accepts evals.json (with the assertions alias) and trigger sets, and rejects other shapes', () => {
  const r = readSkillCreator({ skill_name: 's', evals: [{ prompt: 'p', assertions: ['x', { text: 'y' }] }] });
  assert.deepEqual(r.items[0].expectations, ['x', 'y']);
  assert.equal(r.items[0].id, 1);
  assert.equal(readSkillCreator([{ query: 'q', should_trigger: false }]).kind, 'triggers');
  assert.throws(() => readSkillCreator({ evals: [{ id: 1 }] }), /no prompt/);
  assert.throws(() => readSkillCreator({ foo: 1 }), /not a skill-creator evals.json/);
  assert.throws(() => readSkillCreator([{ query: 'q' }]), /should_trigger/);
  assert.throws(() => planImport({ skill_name: "it's", evals: [{ prompt: 'p' }] }, { pluginDir: os.tmpdir(), skillDir: os.tmpdir() }), /not a skill directory name/);
});

test('import writes official cases that pass every suite-doctor static rule, and the CLI doctor agrees with the live layer off', async () => {
  const { root, json } = await plugin();
  const r = run(TOOL, ['import', json]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const dirs = (await fs.readdir(path.join(root, 'evals'))).sort();
  assert.deepEqual(dirs, ['csv-tidy-1-my-boss-sent-sales-csv-with', 'csv-tidy-2-what-s-a-csv-dialect']);
  assert.deepEqual(diagnose(loadSuite(root)), []);
  const doc = run(DOCTOR, [root], { env: { ...process.env, PATH: await emptyPath() } });
  assert.equal(doc.status, 0, doc.stdout + doc.stderr);
  assert.match(doc.stdout, /summary: 0 error\(s\), 0 warning\(s\)/);

  const c1 = path.join(root, 'evals', dirs[0]);
  const prompt = await read(path.join(c1, 'prompt.md'));
  assert.match(prompt, /^---\ndescription: "Imported from skill-creator evals.json \(csv-tidy\), eval 1."\n/);
  assert.match(prompt, /\nexpected_outcome: "A tidy.csv with snake_case headers"\n/);
  assert.match(prompt, /\nallowed_tools: \[Read, Glob, Grep, Skill, Bash, Write, Edit\]\n/);
  assert.doesNotMatch(prompt, /^name:|covers/m);
  assert.match(prompt, /---\nMy boss sent sales.csv[^\n]*\n\nInput files \(copied into the working directory\): `evals\/files\/sales.csv`, `evals\/files\/notes\/readme.txt`\n$/);

  const graders = (await fs.readdir(path.join(c1, 'graders'))).sort();
  assert.deepEqual(graders, ['expect-01-the-output-file-tidy-csv-exists.md', 'expect-02-the-reply-explains-which-headers-changed.md',
    'expect-03-headers-use-snake-case-no-spaces-no.md', 'expected-output.md', 'skill-fired.md']);
  assert.match(await read(path.join(c1, 'graders', graders[0])), /^---\ntype: llm\nfocus: files\n# focus files [^\n]*\n---\nThe output file tidy.csv exists\n$/);
  assert.equal(await read(path.join(c1, 'graders', graders[1])), '---\ntype: llm\nfocus: last_message\n---\nThe reply explains which headers changed\n');
  const fired = await read(path.join(c1, 'graders/skill-fired.md'));
  assert.match(fired, /\ntool: Skill\ninput_match: '"skill"\\s\*:\\s\*"\(\?:\[\\w-\]\+:\)\?csv-tidy"'\nmin: 1\narm: with-only\n/);

  assert.equal(await read(path.join(c1, 'case.yaml')), `schema_version: "1.1"\n# name matches the directory so --case globs work the same under both runners\nname: ${dirs[0]}\ncontext:\n  scaffold_script: scaffold.sh\n`);
  const scaffold = await read(path.join(c1, 'scaffold.sh'));
  assert.ok(scaffold.includes('ROOT="${EVAL_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"'), scaffold);
  assert.equal(statSync(path.join(c1, 'scaffold.sh')).mode & 0o777, 0o755);
  assert.ok(!existsSync(path.join(c1, 'covers.yaml')));
  assert.ok(!existsSync(path.join(root, 'evals', dirs[1], 'case.yaml')), 'no inputs, no case.yaml');
});

test('the generated scaffold copies the input files into an empty workspace with no EVAL_* variables', async () => {
  const { root, json } = await plugin();
  assert.equal(run(TOOL, ['import', json]).status, 0);
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'evals-convert-ws-'));
  const script = path.join(root, 'evals/csv-tidy-1-my-boss-sent-sales-csv-with/scaffold.sh');
  const r = spawnSync('bash', [script], { cwd: ws, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: ws } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(await snapshot(ws), { 'evals/files/sales.csv': 'First Name,Last Name\n', 'evals/files/notes/readme.txt': 'notes\n' });
});

test('an input file outside the plugin is copied into the case dir and staged from there; a path escaping the workspace lands at its basename', async () => {
  const { root, skill } = await plugin();
  const outside = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'evals-convert-out-')), 'big.pdf');
  await fs.writeFile(outside, 'PDF');
  const rel = path.relative(skill, outside);
  const plan = planImport({ skill_name: 'csv-tidy', evals: [{ id: 7, prompt: 'Summarise it', files: [rel] }] }, { pluginDir: root, skillDir: skill });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(applyImport(plan).refused, []);
  const c = plan.cases[0];
  assert.equal(await read(path.join(c.dir, 'files/big.pdf')), 'PDF');
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'evals-convert-ws-'));
  assert.equal(spawnSync('bash', [path.join(c.dir, 'scaffold.sh')], { cwd: ws, env: { PATH: process.env.PATH } }).status, 0);
  assert.deepEqual(await snapshot(ws), { 'big.pdf': 'PDF' });
  assert.deepEqual(diagnose(loadSuite(root)), []);
});

test('import never overwrites: a clash refuses the whole import, --dry-run writes nothing, --force replaces case dirs whole', async () => {
  const { root, json } = await plugin();
  const dry = run(TOOL, ['import', json, '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /create {3}csv-tidy-1-my-boss-sent-sales-csv-with\//);
  assert.match(dry.stdout, /dry run: nothing written\./);
  assert.match(dry.stdout, /run it: claude plugin eval \S+ --scaffold --allow-tools Bash,Write,Edit/);
  assert.ok(!existsSync(path.join(root, 'evals')));

  assert.equal(run(TOOL, ['import', json]).status, 0);
  const c2 = path.join(root, 'evals/csv-tidy-2-what-s-a-csv-dialect');
  await fs.writeFile(path.join(c2, 'graders/mine.md'), 'hand-written');
  await fs.rm(path.join(root, 'evals/csv-tidy-1-my-boss-sent-sales-csv-with'), { recursive: true });
  const before = await snapshot(path.join(root, 'evals'));
  const again = run(TOOL, ['import', json]);
  assert.equal(again.status, 1);
  assert.match(again.stdout, /exists {3}csv-tidy-2-what-s-a-csv-dialect\//);
  assert.match(again.stdout, /refused: nothing written\./);
  assert.deepEqual(await snapshot(path.join(root, 'evals')), before, 'not even the non-clashing case is written');
  assert.equal(run(TOOL, ['import', json, '--dry-run']).status, 1);

  const forced = run(TOOL, ['import', json, '--force']);
  assert.equal(forced.status, 0, forced.stdout);
  assert.match(forced.stdout, /replace {2}csv-tidy-2-what-s-a-csv-dialect\//);
  assert.ok(!existsSync(path.join(c2, 'graders/mine.md')), 'replaced whole, so stale graders do not linger');
  assert.ok(existsSync(path.join(root, 'evals/csv-tidy-1-my-boss-sent-sales-csv-with/prompt.md')));
});

test('a missing input file refuses the import and names it', async () => {
  const { root, json } = await plugin(EVALS, { inputs: false });
  const r = run(TOOL, ['import', json]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /ERROR {2}csv-tidy-1-[^:]+: input file evals\/files\/sales.csv not found/);
  assert.ok(!existsSync(path.join(root, 'evals')));
});

test('covers.yaml only with --covers; no skill name means no trigger grader; usage errors exit 2', async () => {
  const { root, json } = await plugin({ evals: [{ id: 'a b', prompt: 'Hello there', expectations: ['Says hi'] }] });
  const r = run(TOOL, ['import', json, '--covers', 'skill/csv-tidy/x, claude-md/y']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no skill name \(no trigger grader\)/);
  const c = path.join(root, 'evals/eval-a-b-hello-there');
  assert.equal(await read(path.join(c, 'covers.yaml')), '# rule ids this case exercises (config-coverage.mjs --list prints valid ids)\n- skill/csv-tidy/x\n- claude-md/y\n');
  assert.deepEqual(await fs.readdir(path.join(c, 'graders')), ['expect-01-says-hi.md']);
  assert.deepEqual(diagnose(loadSuite(root)), []);

  assert.equal(run(TOOL, []).status, 2);
  assert.equal(run(TOOL, ['import']).status, 2);
  assert.equal(run(TOOL, ['import', json, '--bogus']).status, 2);
  const lone = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'evals-convert-lone-')), 'evals.json');
  await fs.writeFile(lone, JSON.stringify(EVALS));
  assert.match(run(TOOL, ['import', lone]).stderr, /no plugin found above .*: pass --plugin/);
});

test('a trigger eval set becomes trigger and negative-trigger cases, and needs a skill name', async () => {
  const set = [{ query: 'clean up my messy sales csv', should_trigger: true }, { query: 'write a haiku', should_trigger: false }];
  const { root, skill } = await plugin();
  const file = path.join(skill, 'evals/trigger-set.json');
  await fs.writeFile(file, JSON.stringify(set));
  assert.match(run(TOOL, ['import', file]).stderr, /names no skill: pass --skill/);
  const r = run(TOOL, ['import', file, '--skill', 'csv-tidy']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const pos = path.join(root, 'evals/csv-tidy-trigger-1-clean-up-my-messy-sales');
  const neg = path.join(root, 'evals/csv-tidy-no-trigger-2-write-a-haiku');
  assert.match(await read(path.join(pos, 'graders/skill-fired.md')), /\nmin: 1\narm: with-only\n/);
  assert.match(await read(path.join(neg, 'graders/skill-not-fired.md')), /\nmin: 0\nmax: 0\narm: both\n/);
  assert.match(await read(path.join(neg, 'prompt.md')), /tags: \[skill-creator, csv-tidy, negative-trigger\]/);
  assert.deepEqual(diagnose(loadSuite(root)), []);
});

test('round trip: import then export gives back the skill-creator evals', async () => {
  const { root, json, skill } = await plugin();
  assert.equal(run(TOOL, ['import', json]).status, 0);
  const out = path.join(skill, 'evals/exported.json');
  const r = run(TOOL, ['export', root, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const back = JSON.parse(await read(out));
  assert.equal(back.skill_name, 'csv-tidy');
  assert.deepEqual(back.evals.map(({ id: _id, ...e }) => e), EVALS.evals.map(({ id: _id, ...e }) => ({ expected_output: '', files: [], ...e })));
  assert.match(r.stderr, /carried over: 2 prompt\(s\), 4 expectation\(s\), 1 expected_output, 2 input file\(s\)/);
  assert.match(r.stderr, /graders\/skill-fired.md {2}tool_used Skill \(csv-tidy\): a trigger check/);
  const again = run(TOOL, ['export', root, '--out', out]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /refused: .* exists \(use --force/);
  assert.equal(run(TOOL, ['export', root, '--out', out, '--force']).status, 0);
});

test('export lists every grader and setting it cannot carry over instead of dropping it', async () => {
  const r = run(TOOL, ['export', EXAMPLE]);
  assert.equal(r.status, 0, r.stderr);
  const json = JSON.parse(r.stdout);
  assert.equal(json.skill_name, 'spring-boot-conventions');
  assert.equal(json.evals.length, (await fs.readdir(path.join(EXAMPLE, 'evals'))).filter((d) => d !== 'results').length);
  const guard = json.evals.find((e) => /git reset --hard HEAD/.test(e.prompt));
  assert.deepEqual(guard.files, []);
  assert.match(r.stderr, /guard-blocks-destructive-git {2}scaffold.sh {2}scaffold script/);
  assert.match(r.stderr, /guard-blocks-destructive-git {2}graders\/blocked-by-hook.md {2}regex contains \/BLOCKED: [^/]+\/ on trace/);
  assert.match(r.stderr, /graders\/attempted.md {2}tool_used Bash matching git reset --hard HEAD \(min 1\)/);
  assert.match(r.stderr, /vue-request-does-not-trigger-skill {2}graders\/skill-not-fired.md {2}tool_used Skill matching spring-boot-conventions \(min 0, max 0\)/);
  assert.match(r.stderr, /covers.yaml {2}rule coverage ids/);
  assert.match(r.stderr, /prompt.md {2}runs: 3/);
  // llm criteria in frontmatter (this suite's idiom) are carried over too
  assert.ok(json.evals.some((e) => e.expectations.some((x) => /^The Java controller is thin/.test(x))));
  const res = exportSuite(EXAMPLE);
  const regexGraders = loadSuite(EXAMPLE).cases.flatMap((c) => c.graders.filter((g) => g.meta.type === 'regex').map((g) => `${c.name} ${g.file}`));
  for (const g of regexGraders) assert.ok(res.lost.some((l) => `${l.case} ${l.file}` === g), `${g} reported`);
});
