import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run, tmpdir, initRepo, read, entries } from './helpers.mjs';

const PITFALL =
  'When writing files through a bash heredoc on Windows, build backslash escapes with chr(92), because heredoc escapes corrupt string literals';

const seeded = () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  return home;
};

const idOf = (r) => r.stdout.match(/\[id ([0-9a-f]{4})\]/)?.[1];

test('delete removes an entry entirely; search --history still finds it', () => {
  const home = seeded();
  const a = run(['add', 'disposable scratch note about zephyr'], { amrHome: home });
  assert.equal(a.status, 0, a.stderr);
  const id = idOf(a);
  const mem = path.join(home, 'MEMORY.md');
  assert.match(read(mem), /zephyr/);

  const d = run(['delete', id], { amrHome: home });
  assert.equal(d.status, 0, d.stderr);
  assert.doesNotMatch(read(mem), /zephyr/);
  // No stub, no archive copy — zero trace in the tree.
  assert.doesNotMatch(read(mem), /supersed/i);
  const arch = read(path.join(home, 'archive', 'superseded.md'));
  assert.ok(!arch || !arch.includes('zephyr'));
  assert.equal(run(['search', 'zephyr'], { amrHome: home }).stdout.trim(), 'no matches');
  // Git history is the recovery path.
  assert.match(run(['search', 'zephyr', '--history'], { amrHome: home }).stdout, /zephyr/);

  // Unknown id is an error; rm is an alias.
  assert.notEqual(run(['delete', 'ffff'], { amrHome: home }).status, 0);
  const b = run(['add', 'another scratch note about mistral'], { amrHome: home });
  assert.equal(run(['rm', idOf(b)], { amrHome: home }).status, 0);
  assert.doesNotMatch(read(mem), /mistral/);
});

test('entries expire by default; --durable and --ttl control it', () => {
  const home = seeded();
  run(['add', 'short-lived fact alpha'], { amrHome: home });
  const mem = path.join(home, 'MEMORY.md');
  assert.match(read(mem), /short-lived fact alpha \[added: [0-9-]+; expires: [0-9-]+/);

  run(['add', 'durable fact beta', '--durable'], { amrHome: home });
  const dur = entries(mem).find((l) => l.includes('beta'));
  assert.ok(dur && !/expires:/.test(dur), dur);

  run(['add', 'week fact gamma', '--ttl', '7'], { amrHome: home });
  const w = entries(mem).find((l) => l.includes('gamma'));
  const exp = w.match(/expires: (\d{4}-\d{2}-\d{2})/)[1];
  const delta = (Date.parse(exp) - Date.now()) / 864e5;
  assert.ok(delta > 5 && delta < 8, `expected ~7d, got ${delta}`);

  run(['add', 'zero ttl delta', '--ttl', '0'], { amrHome: home });
  const z = entries(mem).find((l) => l.includes('delta'));
  assert.ok(z && !/expires:/.test(z), z);

  // Expired entries leave context but stay searchable until cleanup.
  fs.writeFileSync(
    mem,
    read(mem).replace(/(short-lived fact alpha.*?)expires: [0-9-]+/, '$1expires: 2020-01-01')
  );
  assert.doesNotMatch(run(['context'], { amrHome: home }).stdout, /short-lived fact alpha/);
  assert.match(run(['search', 'alpha'], { amrHome: home }).stdout, /short-lived fact alpha/);
});

test('update rolls expiry forward; --durable drops it', () => {
  const home = seeded();
  const a = run(['add', 'rotating detail epsilon'], { amrHome: home });
  const id = idOf(a);
  const mem = path.join(home, 'MEMORY.md');
  fs.writeFileSync(mem, read(mem).replace(/expires: [0-9-]+/, 'expires: 2020-01-01'));

  const u = run(['update', id, 'rotating detail epsilon v2'], { amrHome: home });
  assert.equal(u.status, 0, u.stderr);
  const line = entries(mem).find((l) => l.includes('epsilon'));
  assert.ok(Date.parse(line.match(/expires: (\d{4}-\d{2}-\d{2})/)[1]) > Date.now(), line);
  assert.match(line, /updated: \d{4}-\d{2}-\d{2}/);

  const u2 = run(['update', id, 'rotating detail epsilon v3', '--durable'], { amrHome: home });
  assert.equal(u2.status, 0, u2.stderr);
  const line2 = entries(mem).find((l) => l.includes('epsilon'));
  assert.ok(!/expires:/.test(line2), line2);

  // A durable entry stays durable across plain updates.
  const u3 = run(['update', id, 'rotating detail epsilon v4'], { amrHome: home });
  assert.equal(u3.status, 0, u3.stderr);
  assert.ok(!/expires:/.test(entries(mem).find((l) => l.includes('epsilon'))));
});

test('dream --fix renews expired entries that were marked used', () => {
  const home = seeded();
  const a = run(['add', 'load-bearing note theta'], { amrHome: home });
  const id = idOf(a);
  run(['add', 'stale junk iota'], { amrHome: home });
  const mem = path.join(home, 'MEMORY.md');
  fs.writeFileSync(mem, read(mem).replace(/expires: [0-9-]+/g, 'expires: 2020-01-01'));

  assert.equal(run(['used', id], { amrHome: home }).status, 0);
  const d = run(['dream', '--fix'], { amrHome: home });
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /renewed 1 expired entry/);
  assert.match(d.stdout, /dropped 1 expired entry/);
  const after = read(mem);
  assert.match(after, /theta/);
  assert.doesNotMatch(after, /theta.*expires: 2020/);
  assert.doesNotMatch(after, /iota/);
});

test('add past 80% of budget queues consolidation proposals; delete drains them', () => {
  const home = seeded();
  const mem = path.join(home, 'MEMORY.md');
  fs.writeFileSync(
    mem,
    '# Memory\n\n- rotten leftover note [added: 2026-01-01; expires: 2020-01-01; id: cc01]\n\n## Index\n'
  );
  const a = run(['add', 'ordinary new note', '--budget', '100'], { amrHome: home });
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stderr, /of the 100-char digest budget/);
  assert.match(a.stderr, /consolidate: expired entry cc01/);

  const pend = () => read(path.join(home, 'dreams', 'pending-reflections.md')) || '';
  assert.match(pend(), /\[consolidate\].*amr delete cc01/);
  // Proposals surface as pending candidates in context.
  assert.match(run(['context'], { amrHome: home }).stdout, /Pending memory candidates/);
  assert.match(run(['context'], { amrHome: home }).stdout, /cc01/);

  // Hard-deleting the entry drops proposals that pointed at it.
  assert.equal(run(['delete', 'cc01'], { amrHome: home }).status, 0);
  assert.doesNotMatch(pend(), /cc01/);
});

test('queue overflow archives evicted proposals instead of dropping them', () => {
  const home = seeded();
  const queue = path.join(home, 'dreams', 'pending-reflections.md');
  // Dates are relative: the queue ages items out after 14 days, so fixed
  // dates silently turn this test into a different one.
  const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const old = `- [reflect] ${daysAgo(8)} add pitfall global: oldest queued lesson about zephyr sondes`;
  const fresh = Array.from(
    { length: 14 },
    (_, i) => `- [reflect] ${daysAgo(2)} add fact global: filler proposal number ${i} about mistral`
  );
  fs.mkdirSync(path.dirname(queue), { recursive: true });
  fs.writeFileSync(queue, ['# Pending reflections', '', ...[old, ...fresh]].join('\n') + '\n');
  // One more queued proposal overflows the 15-item cap and evicts `old`.
  const mem = path.join(home, 'MEMORY.md');
  fs.writeFileSync(
    mem,
    '# Memory\n\n- rotten leftover note [added: 2026-01-01; expires: 2020-01-01; id: cc01]\n\n## Index\n'
  );
  const a = run(['add', 'ordinary new note', '--budget', '100'], { amrHome: home });
  assert.equal(a.status, 0, a.stderr);
  assert.doesNotMatch(read(queue), /zephyr sondes/);
  const arch = path.join(home, 'dreams', 'reflection-archive.md');
  assert.match(read(arch), /zephyr sondes/);
  // Context points at the archive so the next session can rescue it.
  assert.match(run(['context'], { amrHome: home }).stdout, /reflection-archive\.md/);
});

test('dream --fix proposes merges for near-duplicate pairs past the threshold', () => {
  const home = seeded();
  const mem = path.join(home, 'MEMORY.md');
  fs.writeFileSync(
    mem,
    [
      '# Memory',
      '',
      '- When the widget build flakes on windows runners re-run the job once because the runners are flaky [added: 2026-01-01; kind: pitfall; id: aa01]',
      '- When the widget build flakes on windows runners re-run the job twice because flakes are common [added: 2026-01-02; kind: pitfall; id: bb02]',
      '',
      '## Index',
      '',
    ].join('\n')
  );
  const d = run(['dream', '--fix', '--budget', '250'], { amrHome: home });
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /queued \d+ consolidation proposal/);
  const pend = read(path.join(home, 'dreams', 'pending-reflections.md')) || '';
  assert.match(pend, /\[consolidate\]/);
  assert.match(pend, /merge (aa01|bb02) into (aa01|bb02) \(near-duplicate\)/);
});

test('recall dedupes within a session and re-fires in a new one', () => {
  const home = seeded();
  assert.equal(run(['add', PITFALL, '--kind', 'pitfall'], { amrHome: home }).status, 0);
  const payload = (sid) =>
    JSON.stringify({
      session_id: sid,
      tool_name: 'Bash',
      tool_response: { stderr: 'error CS1010: Newline in constant', exit_code: 1 },
    });
  const first = run(['recall', '--hook'], { amrHome: home, input: payload('dedupe-1') });
  assert.match(first.stdout, /additionalContext/);
  const second = run(['recall', '--hook'], { amrHome: home, input: payload('dedupe-1') });
  assert.equal(second.stdout.trim(), '');
  const third = run(['recall', '--hook'], { amrHome: home, input: payload('dedupe-2') });
  assert.match(third.stdout, /additionalContext/);
});

test('recall ignores weak token overlap without a trigger hit', () => {
  const home = seeded();
  run(['add', 'uses pnpm for packages in this repo'], { amrHome: home });
  const r = run(['recall', 'error ECONNREFUSED connecting to pnpm registry mirror'], { amrHome: home });
  assert.equal(r.stdout.trim(), '');
});

test('context relevance signal pulls the work-relevant entry into a tight budget', () => {
  const home = tmpdir();
  const repo = initRepo(path.join(tmpdir(), 'redisapp'), 'https://github.com/acme/redisapp.git');
  run(['ensure'], { amrHome: home });
  assert.equal(run(['add', 'seed note', '--project'], { amrHome: home, cwd: repo }).status, 0);
  const pf = path.join(home, 'projects', fs.readdirSync(path.join(home, 'projects'))[0]);
  const L = (t, id) => `- ${t} ${'pad '.repeat(8)}[added: 2026-01-01; kind: fact; id: ${id}]`;
  fs.writeFileSync(
    pf,
    [
      '# Project: redisapp',
      '',
      L('redisapp cache nodes need sentinel failover', 'a001'),
      L('beta note about retry backoff in workers', 'b002'),
      L('gamma note about graceful shutdown drains', 'c003'),
      L('delta note about cold start warmers everywhere', 'd004'),
      '',
    ].join('\n')
  );
  // Room for exactly three of the four entries.
  const budget = L('x', '0000').length * 3 + 10;
  const inside = run(['context', '--budget', String(budget)], { amrHome: home, cwd: repo }).stdout;
  // The oldest-position entry mentions the current project by name, so the
  // work signal lifts it into the budget; one of the others drops out.
  assert.match(inside, /redisapp cache nodes need sentinel failover/);
  assert.match(inside, /lower-ranked entries omitted/);
  // From an unrelated cwd there is no such signal: the oldest-position
  // entry loses the tie and falls out of the pooled digest.
  const outside = run(['context', '--budget', String(budget)], { amrHome: home, cwd: tmpdir() }).stdout;
  assert.doesNotMatch(outside, /sentinel failover/);
});

test('rank: the work-signal boost is real scoring, not a token hack', async () => {
  const { scoreEntry } = await import('../lib/rank.mjs');
  const line = '- redisapp sharding needs care [added: 2026-01-01; kind: fact; id: bb02]';
  const now = Date.now();
  const base = scoreEntry(line, {}, () => false, now);
  const boosted = scoreEntry(line, {}, () => false, now, new Set(['redisapp']));
  assert.ok(boosted > base, `${boosted} !> ${base}`);
  // Ambient 3-char tokens and unrelated signals change nothing.
  assert.equal(scoreEntry(line, {}, () => false, now, new Set(['zzz'])), base);
  assert.equal(scoreEntry(line, {}, () => false, now, new Set(['mem'])), base);
});
