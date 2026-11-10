import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run, tmpdir, initRepo, read } from './helpers.mjs';

function seed(home, repo, text) {
  const r = run(['add', text, '--project'], { amrHome: home, cwd: repo });
  assert.equal(r.status, 0, r.stderr);
}

test('context in a non-git dir shows global memory only', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  run(['add', 'prefers tabs'], { amrHome: home });
  const r = run(['context'], { amrHome: home, cwd: tmpdir() });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /prefers tabs/);
});

test('context in a repo shows its project memory', () => {
  const home = tmpdir();
  const repo = initRepo(path.join(tmpdir(), 'app'), 'https://github.com/acme/app.git');
  run(['ensure'], { amrHome: home });
  seed(home, repo, 'app uses redis cache');
  const r = run(['context'], { amrHome: home, cwd: repo });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /app uses redis cache/);
});

test('link attaches siblings and private transitively (links are owner curation)', () => {
  const home = tmpdir();
  const base = tmpdir();
  const repoA = initRepo(path.join(base, 'a'), 'https://github.com/acme/a.git');
  const repoB = initRepo(path.join(base, 'b'), 'https://github.com/acme/b.git');
  const repoC = initRepo(path.join(base, 'c'), 'https://github.com/acme/c.git');
  run(['ensure'], { amrHome: home });
  seed(home, repoA, 'a uses sqlite');
  seed(home, repoB, 'b uses kafka');
  seed(home, repoC, 'c is a leaf');

  // b links to a
  const link = run(['link', 'a'], { amrHome: home, cwd: repoB });
  assert.equal(link.status, 0);
  const inB = run(['context'], { amrHome: home, cwd: repoB });
  assert.match(inB.stdout, /a uses sqlite/);

  // c links to b; a is private -> still attaches transitively, since
  // the link chain is the owner's own curation
  run(['link', 'b'], { amrHome: home, cwd: repoC });
  run(['policy', 'a', 'private', 'true'], { amrHome: home, cwd: repoA });
  const inC = run(['context'], { amrHome: home, cwd: repoC });
  assert.match(inC.stdout, /b uses kafka/);
  assert.match(inC.stdout, /a uses sqlite/);

  // explicit --also still attaches the private project
  const explicit = run(['context', '--also', 'a'], { amrHome: home, cwd: repoC });
  assert.match(explicit.stdout, /a uses sqlite/);
});

test('unresolved link names surface a marker', () => {
  const home = tmpdir();
  const repo = initRepo(path.join(tmpdir(), 'solo'), 'https://github.com/acme/solo.git');
  run(['ensure'], { amrHome: home });
  seed(home, repo, 'solo entry');
  run(['link', 'ghost-project'], { amrHome: home, cwd: repo });
  const r = run(['context'], { amrHome: home, cwd: repo });
  assert.match(r.stdout, /unresolved \(no memory file\): ghost-project/);
});

test('unlink removes the auto-attach', () => {
  const home = tmpdir();
  const base = tmpdir();
  const repoA = initRepo(path.join(base, 'x1'), 'https://github.com/acme/x1.git');
  const repoB = initRepo(path.join(base, 'y1'), 'https://github.com/acme/y1.git');
  run(['ensure'], { amrHome: home });
  seed(home, repoA, 'x1 fact');
  seed(home, repoB, 'y1 fact');
  run(['link', 'x1'], { amrHome: home, cwd: repoB });
  assert.match(run(['context'], { amrHome: home, cwd: repoB }).stdout, /x1 fact/);
  run(['unlink', 'x1'], { amrHome: home, cwd: repoB });
  assert.ok(!run(['context'], { amrHome: home, cwd: repoB }).stdout.includes('x1 fact'));
});

test('context in a known project is project-scoped (no global section)', () => {
  const home = tmpdir();
  const repo = initRepo(path.join(tmpdir(), 'iso'), 'https://github.com/acme/iso.git');
  run(['ensure'], { amrHome: home });
  run(['add', 'global pref'], { amrHome: home });
  seed(home, repo, 'iso fact');
  const r = run(['context'], { amrHome: home, cwd: repo });
  assert.match(r.stdout, /iso fact/);
  assert.ok(!r.stdout.includes('global pref'));
  assert.ok(!r.stdout.includes('## Global'));
  assert.ok(!r.stdout.includes('## Recent project memory'));
});

test('outside context pools latest project entries; private and noglobal excluded', () => {
  const home = tmpdir();
  const base = tmpdir();
  const repoA = initRepo(path.join(base, 'pa'), 'https://github.com/acme/pa.git');
  const repoB = initRepo(path.join(base, 'pb'), 'https://github.com/acme/pb.git');
  const repoC = initRepo(path.join(base, 'pc'), 'https://github.com/acme/pc.git');
  const repoD = initRepo(path.join(base, 'pd'), 'https://github.com/acme/pd.git');
  run(['ensure'], { amrHome: home });
  seed(home, repoA, 'pa pooled fact');
  seed(home, repoB, 'pb pooled fact');
  seed(home, repoC, 'pc secret fact');
  seed(home, repoD, 'pd quiet fact');
  run(['policy', 'pc', 'private', 'true'], { amrHome: home, cwd: repoC });
  run(['policy', 'pd', 'noglobal', 'true'], { amrHome: home, cwd: repoD });
  const r = run(['context'], { amrHome: home, cwd: tmpdir() });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /## Recent project memory/);
  assert.match(r.stdout, /pa pooled fact/);
  assert.match(r.stdout, /pb pooled fact/);
  assert.ok(!r.stdout.includes('pc secret fact'));
  assert.ok(!r.stdout.includes('pd quiet fact'));
});

test('context ranks by kind/recency within a budget; `amr used` boosts entries, search does not', () => {
  const home = tmpdir();
  const run0 = (args) => run(args, { amrHome: home });
  run0(['ensure']);
  const mem = path.join(home, 'MEMORY.md');
  const rows = [];
  for (let i = 0; i < 10; i++)
    rows.push(`- old filler fact number ${i} about nothing much at all [added: 2025-01-01; kind: fact; id: a00${i}]`);
  rows.push('- When CI flakes, re-run once, because runners are flaky [added: 2026-10-20; kind: pitfall; id: b001]');
  fs.writeFileSync(mem, `# Memory\n\n${rows.join('\n')}\n\n## Index\n`);
  const tight = run0(['context', '--budget', '10']).stdout;
  assert.match(tight, /When CI flakes/);
  // Global entries are not about the current repo, so no "N omitted" pointer.
  assert.doesNotMatch(tight, /entries omitted/);
  assert.equal((tight.match(/old filler fact/g) || []).length, 2);
  // Surfacing an entry in a search is not a use: it must not rank higher.
  run0(['search', 'number 7']);
  assert.doesNotMatch(run0(['context', '--budget', '10']).stdout, /number 7/);
  // Marking it used (it helped) lifts it above its peers.
  assert.match(run0(['used', 'a007']).stdout, /marked used: a007/);
  const after = run0(['context', '--budget', '10']).stdout;
  assert.match(after, /number 7/);
  assert.match(run0(['context', '--full']).stdout, /number 0/);
});

test('project identity is worktree-stable: slug derives from the origin remote, not the checkout dir name', () => {
  const home = tmpdir();
  const base = tmpdir();
  const main = initRepo(path.join(base, 'app'), 'https://github.com/acme/app.git');
  const worktree = initRepo(path.join(base, 'app-feature-x'), 'https://github.com/acme/app.git');
  run(['ensure'], { amrHome: home });
  seed(home, main, 'app uses redis cache');
  run(['add', 'global pref'], { amrHome: home });
  const r = run(['context'], { amrHome: home, cwd: worktree });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /app uses redis cache/);
  // Same project, so the digest is project-scoped, not the pooled dump.
  assert.ok(!r.stdout.includes('global pref'));
  assert.ok(!r.stdout.includes('## Recent project memory'));
});

test('outside context spends budget on pooled project entries before global ones', () => {
  const home = tmpdir();
  const repo = initRepo(path.join(tmpdir(), 'pooled'), 'https://github.com/acme/pooled.git');
  run(['ensure'], { amrHome: home });
  const tail = 'padding '.repeat(40) + 'TAILMARKER';
  seed(home, repo, `pooled project fact ${tail}`);
  const mem = path.join(home, 'MEMORY.md');
  fs.writeFileSync(
    mem,
    fs.readFileSync(mem, 'utf8').replace(
      '## Index',
      `- global fact ${tail} [added: 2026-10-20; kind: fact; id: d001]\n\n## Index`
    )
  );
  const out = run(['context', '--budget', '600'], { amrHome: home, cwd: tmpdir() }).stdout;
  // Pooled entry was allocated first and survives whole; the global
  // entry only got the leftover budget and was floor-clipped.
  const pooled = out.split('\n').find((l) => l.includes('pooled project fact'));
  const global = out.split('\n').find((l) => l.includes('global fact'));
  assert.ok(pooled.includes('TAILMARKER'), pooled);
  assert.ok(!global.includes('TAILMARKER'), global);
});

test('context --hook: a compaction re-injection with nothing new is suppressed; later ones are deltas', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  run(['add', 'first durable fact'], { amrHome: home });
  const payload = (source) =>
    JSON.stringify({ session_id: 'sess-1', source, cwd: tmpdir() });
  const start = run(['context', '--hook'], { amrHome: home, cwd: tmpdir(), input: payload('startup') });
  assert.match(start.stdout, /first durable fact/);
  const compact1 = run(['context', '--hook'], { amrHome: home, cwd: tmpdir(), input: payload('compact') });
  assert.equal(compact1.stdout.trim(), '');
  run(['add', 'second durable fact'], { amrHome: home });
  const compact2 = run(['context', '--hook'], { amrHome: home, cwd: tmpdir(), input: payload('compact') });
  assert.match(compact2.stdout, /second durable fact/);
  assert.ok(!compact2.stdout.includes('first durable fact'));
});

test('context --hermes: pre_llm_call injects once per session, post_compaction re-arms it', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  run(['add', 'hermes durable fact'], { amrHome: home });
  const payload = (hook_event_name) =>
    JSON.stringify({ hook_event_name, session_id: 'hsess-1', cwd: tmpdir() });
  const first = run(['context', '--hermes'], { amrHome: home, cwd: tmpdir(), input: payload('pre_llm_call') });
  assert.equal(first.status, 0, first.stderr);
  assert.match(JSON.parse(first.stdout).context, /hermes durable fact/);
  const again = run(['context', '--hermes'], { amrHome: home, cwd: tmpdir(), input: payload('pre_llm_call') });
  assert.equal(again.stdout.trim(), '');
  const compact = run(['context', '--hermes'], { amrHome: home, cwd: tmpdir(), input: payload('post_compaction') });
  assert.equal(compact.stdout.trim(), '');
  const after = run(['context', '--hermes'], { amrHome: home, cwd: tmpdir(), input: payload('pre_llm_call') });
  assert.match(JSON.parse(after.stdout).context, /hermes durable fact/);
});

test('context clips oversized floor entries so the budget overrun stays bounded', () => {
  const home = tmpdir();
  const run0 = (args) => run(args, { amrHome: home });
  run0(['ensure']);
  const huge = (n) => `- huge entry ${n} ${'detail '.repeat(700)}[added: 2026-10-20; kind: pitfall; id: c00${n}]`;
  fs.writeFileSync(
    path.join(home, 'MEMORY.md'),
    `# Memory\n\n${[1, 2, 3].map(huge).join('\n')}\n\n## Index\n`
  );
  const out = run0(['context', '--budget', '10']).stdout;
  const lines = out.split('\n').filter((l) => l.startsWith('- huge entry'));
  // The floor still shows the top three entries...
  assert.equal(lines.length, 3);
  for (const [i, l] of lines.entries()) {
    // ...each clipped to the floor cap, with its id meta intact.
    assert.ok(l.length <= 240, `entry ${i + 1} is ${l.length} chars`);
    assert.match(l, /…\s*\[added: 2026-10-20; kind: pitfall; id: c00\d\]$/);
  }
  // --full is the escape hatch: nothing clipped.
  assert.ok(run0(['context', '--full']).stdout.includes('detail '.repeat(700).trim()));
});
