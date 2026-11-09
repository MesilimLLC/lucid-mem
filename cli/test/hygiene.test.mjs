import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initRepo, read, run, tmpdir } from './helpers.mjs';
import { scoreEntry } from '../lib/rank.mjs';
import { renderEntry, ttlDays } from '../lib/core.mjs';

const seeded = () => {
  const home = tmpdir();
  assert.equal(run(['ensure'], { amrHome: home }).status, 0);
  return home;
};
// Whole days between the UTC date stamps amr writes (not wall-clock time).
const daysFromNow = (iso) =>
  Math.round((Date.parse(iso) - Date.parse(new Date().toISOString().slice(0, 10))) / 864e5);
const expiresOf = (text) => text.match(/expires: (\d{4}-\d{2}-\d{2})/)?.[1];

const CP_ONE =
  "When editing source files from Python on Windows, open with encoding='utf-8' or use binary mode; the default cp1252 corrupts em dashes and ellipses. Also avoid backslash escapes inside bash heredoc python; build them with chr(92) or use sed.";
const CP_TWO =
  'When editing Python source files on Windows, use UTF-8 explicitly or the Edit tool, because Python defaults to cp1252 which corrupts em dashes, ellipses, and backslash escapes.';

// ---- staleness ------------------------------------------------------------

test('hosting and deploy facts expire sooner; method entries keep the normal TTL', () => {
  const home = seeded();
  const add = (text, ...extra) => {
    const r = run(['add', text, ...extra], { amrHome: home });
    assert.equal(r.status, 0, r.stderr);
    return read(path.join(home, 'MEMORY.md'));
  };
  const host = add('The ops dashboard is deployed on Cloudflare Workers behind the ops subdomain', '--kind', 'fact');
  const hostLine = host.split('\n').find((l) => l.includes('ops dashboard'));
  assert.equal(daysFromNow(expiresOf(hostLine)), 14);
  const pit = add('When a build fails on stale caches, wipe the output folder, because incremental state lies', '--kind', 'pitfall');
  const pitLine = pit.split('\n').find((l) => l.includes('stale caches'));
  assert.equal(daysFromNow(expiresOf(pitLine)), 30);
  // explicit --ttl still wins
  const t = add('The marketing site is hosted on Netlify with a custom apex domain record', '--kind', 'fact', '--ttl', '90');
  const tLine = t.split('\n').find((l) => l.includes('marketing site'));
  assert.equal(daysFromNow(expiresOf(tLine)), 90);
  assert.equal(ttlDays('served live from Lovable', {}, 'pitfall'), 30);
  assert.equal(ttlDays('served live from Lovable', { hostingTtlDays: 7 }, 'fact'), 7);
});

test('--verify is stored escaped, shown with the entry in context, and never run', () => {
  const home = seeded();
  const marker = path.join(tmpdir(), 'ran.txt');
  const cmd = `curl -sI https://ops.example.com; echo [ok] > ${marker.replace(/\\/g, '/')}`;
  const a = run(['add', 'The ops site is served live from the Lovable platform', '--kind', 'fact', '--verify', cmd], {
    amrHome: home,
  });
  assert.equal(a.status, 0, a.stderr);
  const raw = read(path.join(home, 'MEMORY.md'));
  assert.match(raw, /verify: curl -sI https:\/\/ops\.example\.com%3B echo %5Bok%5D/);
  const ctx = run(['context'], { amrHome: home }).stdout;
  assert.ok(ctx.includes('(verify: `' + cmd + '`)'), ctx);
  assert.ok(!fs.existsSync(marker), 'verify command must never be executed');
  // a replacement keeps the check command
  const id = a.stdout.match(/\[id ([0-9a-f]{4})\]/)[1];
  assert.equal(run(['supersede', id, 'The ops site is now served from Cloudflare Pages instead'], { amrHome: home }).status, 0);
  assert.match(read(path.join(home, 'MEMORY.md')), /Cloudflare Pages[^\n]*verify: curl/);
});

test('amr add finds a similar entry in another file and offers supersede instead of piling up', () => {
  const home = seeded();
  assert.equal(run(['add', CP_ONE, '--kind', 'pitfall'], { amrHome: home }).status, 0);
  const r = run(['add', CP_TWO, '--kind', 'pitfall', '--file', 'pitfalls'], { amrHome: home });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /similar to \[id [0-9a-f]{4}\]/);
  assert.match(r.stdout, /amr supersede [0-9a-f]{4}/);
  assert.ok(!fs.existsSync(path.join(home, 'pitfalls.md')), 'near-copy must not be saved');
  const forced = run(['add', CP_TWO, '--kind', 'pitfall', '--file', 'pitfalls', '--new'], { amrHome: home });
  assert.match(forced.stdout, /saved to pitfalls\.md/);
  // short, generic entries are exempt (tiny token sets match by luck)
  assert.match(run(['add', 'entry number one fact'], { amrHome: home }).stdout, /saved/);
  assert.match(run(['add', 'entry number two fact'], { amrHome: home }).stdout, /saved/);
});

test('unused entries rank below used ones after a grace period; fresh ones are exempt', () => {
  const now = Date.parse('2026-11-09');
  const line = (added, id) => `- some fact about things [added: ${added}; kind: fact; id: ${id}]`;
  const fresh = scoreEntry(line('2026-11-08', 'a001'), {}, undefined, now);
  const justUnder = scoreEntry(line('2026-10-27', 'a002'), {}, undefined, now); // 13 days
  const old = scoreEntry(line('2026-10-20', 'a003'), {}, undefined, now); // 20 days
  const oldUsed = scoreEntry(line('2026-10-20', 'a004'), { a004: { n: 1, last: now - 864e5 } }, undefined, now);
  // inside the grace period only age decay applies
  assert.ok(justUnder / fresh > 0.8, `fresh vs 13d: ${justUnder / fresh}`);
  // past it, the unused penalty stacks on the decay
  assert.ok(old / fresh < 0.7, `fresh vs 20d unused: ${old / fresh}`);
  assert.ok(oldUsed > old);
});

// ---- consolidation --------------------------------------------------------

test('dream proposes merging near-duplicates in a small topic file, far under any budget', () => {
  const home = seeded();
  fs.writeFileSync(
    path.join(home, 'pitfalls.md'),
    [
      '# pitfalls',
      '',
      `- ${CP_ONE} [added: 2026-10-24; kind: pitfall; id: 088f]`,
      `- ${CP_TWO} [added: 2026-10-24; kind: pitfall; id: 7266]`,
      '- Unrelated: pin the Node version in CI because matrix drift hides failures [added: 2026-10-24; kind: pitfall; id: 9a9a]',
      '',
    ].join('\n')
  );
  const d = run(['dream', '--fix'], { amrHome: home });
  assert.equal(d.status, 0, d.stderr);
  const queue = read(path.join(home, 'dreams', 'pending-reflections.md')) || '';
  assert.match(queue, /merge (088f|7266) into (088f|7266) \(near-duplicate\)/);
  assert.doesNotMatch(queue, /9a9a/);
});

// ---- session-start display ------------------------------------------------

test('digest shows when an entry was added or last confirmed, including legacy bare-date meta', () => {
  assert.equal(
    renderEntry('- legacy pitfall text [ 2026-10-24; kind: pitfall; id: 088f]'),
    '- legacy pitfall text [added: 2026-10-24; kind: pitfall; id: 088f]'
  );
  assert.equal(
    renderEntry('- confirmed fact [added: 2026-10-01; kind: fact; id: aaaa]', Date.parse('2026-11-01')),
    '- confirmed fact [added: 2026-10-01; kind: fact; id: aaaa; confirmed: 2026-11-01]'
  );
  // used before the last write: nothing to add
  assert.equal(
    renderEntry('- edited fact [added: 2026-10-01; updated: 2026-11-02; id: bbbb]', Date.parse('2026-11-01')),
    '- edited fact [added: 2026-10-01; updated: 2026-11-02; id: bbbb]'
  );
});

test('"N omitted" pointer appears only for the current repo, not linked projects or the index', () => {
  const home = seeded();
  const repo = initRepo(path.join(tmpdir(), 'redisapp'), 'https://github.com/acme/redisapp.git');
  const other = initRepo(path.join(tmpdir(), 'sibling'), 'https://github.com/acme/sibling.git');
  assert.equal(run(['add', 'seed note about redis', '--project'], { amrHome: home, cwd: repo }).status, 0);
  assert.equal(run(['add', 'seed note about sibling', '--project'], { amrHome: home, cwd: other }).status, 0);
  assert.equal(run(['link', 'sibling'], { amrHome: home, cwd: repo }).status, 0);
  const L = (t, id) => `- ${t} ${'pad '.repeat(8)}[added: 2026-01-01; kind: fact; id: ${id}]`;
  const fill = (cwdRepo, title, prefix) => {
    const f = path.join(home, 'projects', fs.readdirSync(path.join(home, 'projects')).find((n) => n.startsWith(prefix)));
    fs.writeFileSync(f, [`# Project: ${title}`, '', ...[1, 2, 3, 4, 5, 6].map((i) => L(`${title} note ${i} zq${i}`, `${prefix[0]}00${i}`)), ''].join('\n'));
  };
  fill(repo, 'redisapp', 'redisapp');
  fill(other, 'sibling', 'sibling');
  const budget = String(L('x', '0000').length * 3 + 10);
  const out = run(['context', '--budget', budget], { amrHome: home, cwd: repo }).stdout;
  const [mine, linked] = out.split('## Project: sibling (linked)');
  assert.match(mine, /lower-ranked entries omitted/);
  assert.doesNotMatch(linked || '', /entries omitted/);
});

test('a file full of duplicate pairs still gets its expired entries flagged', async () => {
  const { consolidationProposals } = await import('../lib/consolidate.mjs');
  const home = seeded();
  const words = [
    ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'],
    ['india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa'],
    ['quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray'],
    ['yankee', 'zulu', 'amber', 'basalt', 'cobalt', 'dune', 'ember', 'fjord'],
    ['garnet', 'harbor', 'indigo', 'jasper', 'kestrel', 'lagoon', 'meadow', 'nectar'],
  ];
  const rows = [];
  words.forEach((w, i) => {
    rows.push(`- ${w.join(' ')} shared topic ${i} one extra [added: 2026-11-01; kind: fact; id: a${i}0a]`);
    rows.push(`- ${w.join(' ')} shared topic ${i} two extra [added: 2026-11-01; kind: fact; id: a${i}0b]`);
  });
  rows.push('- stale thing nobody needs [added: 2026-01-01; expires: 2026-01-02; kind: fact; id: dead]');
  fs.writeFileSync(path.join(home, 'MEMORY.md'), `# Memory\n\n${rows.join('\n')}\n\n## Index\n`);
  const props = consolidationProposals(home, 'MEMORY.md', 6000);
  assert.ok(props.some((p) => /expired entry dead/.test(p)), props.join('\n'));
});

test('--new also overrides the same-file near-duplicate check', () => {
  const home = seeded();
  const base = 'When regenerating the lockfile on Windows, use the CI npm version, because the local npm drops nested entries';
  assert.match(run(['add', base], { amrHome: home }).stdout, /saved/);
  const variant = base.replace('Windows', 'Linux');
  assert.match(run(['add', variant], { amrHome: home }).stdout, /near-duplicate|similar/);
  assert.match(run(['add', variant, '--new'], { amrHome: home }).stdout, /saved/);
});

test('a similar entry in another project does not block a copy scoped to this one', () => {
  const home = seeded();
  const a = initRepo(path.join(tmpdir(), 'alpha'), 'https://github.com/acme/alpha.git');
  const b = initRepo(path.join(tmpdir(), 'beta'), 'https://github.com/acme/beta.git');
  const text = 'When writing files through a bash heredoc on Windows, build backslash escapes with chr(92), because heredoc escapes corrupt string literals';
  assert.match(run(['add', text, '--project'], { amrHome: home, cwd: a }).stdout, /saved/);
  // beta cannot see alpha's entry, so saving its own copy is right
  assert.match(run(['add', text + ' today', '--project'], { amrHome: home, cwd: b }).stdout, /saved/);
  // a global copy is not covered by alpha's project-scoped entry either
  assert.match(run(['add', text + ' globally'], { amrHome: home }).stdout, /saved/);
  // but inside alpha it is a near-copy of what alpha already has
  assert.match(run(['add', text + ' again', '--project'], { amrHome: home, cwd: a }).stdout, /similar|near-duplicate/);
});

test('dream scopes duplicate proposals from a project file to that project', () => {
  const home = seeded();
  const repo = initRepo(path.join(tmpdir(), 'gamma'), 'https://github.com/acme/gamma.git');
  assert.equal(run(['add', 'seed note for gamma project', '--project'], { amrHome: home, cwd: repo }).status, 0);
  const pf = path.join(home, 'projects', fs.readdirSync(path.join(home, 'projects'))[0]);
  fs.writeFileSync(
    pf,
    [
      '# Project: gamma',
      '',
      `- ${CP_ONE} [added: 2026-10-24; kind: pitfall; id: 088f]`,
      `- ${CP_TWO} [added: 2026-10-24; kind: pitfall; id: 7266]`,
      '',
    ].join('\n')
  );
  assert.equal(run(['dream', '--fix'], { amrHome: home }).status, 0);
  const queue = read(path.join(home, 'dreams', 'pending-reflections.md')) || '';
  assert.match(queue, /tidy scope=gamma-[0-9a-f]{6}: merge/);
});
