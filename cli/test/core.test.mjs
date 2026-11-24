import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run, tmpdir, initRepo, read, entries } from './helpers.mjs';

test('ensure creates repo, MEMORY.md with index, idempotent', () => {
  const home = tmpdir();
  const r1 = run(['ensure'], { amrHome: home });
  assert.equal(r1.status, 0, r1.stderr);
  const mem = read(path.join(home, 'MEMORY.md'));
  assert.match(mem, /# Memory/);
  assert.match(mem, /## Index/);
  assert.ok(fs.existsSync(path.join(home, '.git')));
  const r2 = run(['ensure'], { amrHome: home });
  assert.equal(r2.status, 0);
});

test('ensure refuses a non-empty non-repo dir', () => {
  const home = tmpdir();
  fs.writeFileSync(path.join(home, 'junk.txt'), 'x');
  const r = run(['ensure'], { amrHome: home });
  assert.notEqual(r.status, 0);
});

test('add appends a dated bullet to MEMORY.md', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  const r = run(['add', 'prefers bullet points'], { amrHome: home });
  assert.equal(r.status, 0, r.stderr);
  const lines = entries(path.join(home, 'MEMORY.md'));
  assert.ok(lines.some((l) => l.includes('prefers bullet points')));
  assert.match(lines[lines.length - 1], /\[added: \d{4}-\d{2}-\d{2}/);
});

test('add refuses secret-shaped text; --allow-secret overrides', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  const r = run(['add', 'api key is ghp_abcdefghijklmnop1234567890'], { amrHome: home });
  assert.notEqual(r.status, 0);
  assert.ok(!(read(path.join(home, 'MEMORY.md')) || '').includes('ghp_'));
  const r2 = run(['add', 'api key is ghp_abcdefghijklmnop1234567890', '--allow-secret'], {
    amrHome: home,
  });
  assert.equal(r2.status, 0);
});

test('add skips near-duplicates', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  run(['add', 'uses dark mode'], { amrHome: home });
  const r = run(['add', 'uses dark mode'], { amrHome: home });
  assert.equal(r.status, 0);
  assert.equal(
    entries(path.join(home, 'MEMORY.md')).filter((l) => l.includes('dark mode')).length,
    1
  );
});

test('add warns on a near-duplicate and points at `lucid update <id>` instead of saving a copy', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  const a = run(['add', 'When editing source files from Python on Windows, open with encoding utf-8, because the default cp1252 corrupts em dashes'], { amrHome: home });
  const id = a.stdout.match(/\[id ([0-9a-f]{4})\]/)?.[1];
  assert.ok(id, a.stdout);
  const r = run(['add', 'When editing source files from Python on Windows, open files with encoding utf-8 because default cp1252 corrupts em dashes and ellipses'], { amrHome: home });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout + r.stderr, new RegExp(`near-duplicate of .*${id}`));
  assert.match(r.stdout + r.stderr, new RegExp(`lucid update ${id}`));
  assert.equal(
    entries(path.join(home, 'MEMORY.md')).filter((l) => l.includes('cp1252')).length,
    1
  );
});

test('add --file writes a topic file and indexes it', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  const r = run(['add', 'prefers pnpm', '--file', 'tooling'], { amrHome: home });
  assert.equal(r.status, 0);
  assert.ok(read(path.join(home, 'tooling.md')).includes('prefers pnpm'));
  assert.match(read(path.join(home, 'MEMORY.md')), /\[\[tooling\]\]/);
});

test('update replaces an entry and keeps metadata', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  run(['add', 'port is 3000'], { amrHome: home });
  const r = run(['update', 'port is', 'port is 8080'], { amrHome: home });
  assert.equal(r.status, 0, r.stderr);
  const mem = read(path.join(home, 'MEMORY.md'));
  assert.match(mem, /port is 8080/);
  assert.match(mem, /updated: \d{4}-\d{2}-\d{2}/);
  assert.ok(!mem.includes('port is 3000'));
});

test('update errors on zero and multiple matches', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  run(['add', 'alpha entry'], { amrHome: home });
  run(['add', 'alpha two'], { amrHome: home });
  const none = run(['update', 'no-such-text', 'x'], { amrHome: home });
  assert.notEqual(none.status, 0);
  const many = run(['update', 'alpha', 'x'], { amrHome: home });
  assert.notEqual(many.status, 0);
});

test('search finds entries; index rebuilds', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  run(['add', 'kokoro for tts'], { amrHome: home });
  const r = run(['search', 'kokoro'], { amrHome: home });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /kokoro/);
  const ri = run(['index'], { amrHome: home });
  assert.equal(ri.status, 0);
});

test('add --project routes to projects/<slug>.md', () => {
  const home = tmpdir();
  const repo = initRepo(path.join(tmpdir(), 'myproj'), 'https://github.com/acme/myproj.git');
  run(['ensure'], { amrHome: home });
  const r = run(['add', 'uses pnpm workspaces', '--project'], {
    amrHome: home,
    cwd: repo,
  });
  assert.equal(r.status, 0, r.stderr);
  const projDir = path.join(home, 'projects');
  const files = fs.readdirSync(projDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^myproj-[0-9a-f]{6}\.md$/);
  assert.ok(read(path.join(projDir, files[0])).includes('pnpm workspaces'));
});

test('--kind state gets an expiry; expired entries drop from context and dream --fix', () => {
  const amrHome = tmpdir();
  run(['ensure'], { amrHome });
  const r = run(['add', 'PR 12 is open', '--kind', 'state'], { amrHome });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /session state/);
  const mem = path.join(amrHome, 'MEMORY.md');
  assert.match(read(mem), /kind: state; expires: \d{4}-\d{2}-\d{2}/);
  assert.match(run(['context'], { amrHome }).stdout, /PR 12 is open/);
  // backdate the expiry
  fs.writeFileSync(
    mem,
    read(mem).replace(/expires: \d{4}-\d{2}-\d{2}/, 'expires: 2020-01-01')
  );
  assert.doesNotMatch(run(['context'], { amrHome }).stdout, /PR 12 is open/);
  assert.match(run(['search', 'PR 12'], { amrHome }).stdout, /PR 12 is open/);
  const d = run(['dream', '--fix'], { amrHome });
  assert.match(d.stdout, /dropped 1 expired entry/);
  assert.doesNotMatch(read(mem), /PR 12 is open/);
});

test('unknown --kind is rejected', () => {
  const amrHome = tmpdir();
  run(['ensure'], { amrHome });
  const r = run(['add', 'x thing', '--kind', 'bogus'], { amrHome });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown kind/);
});

test('entries get ids; update and supersede address them by id', () => {
  const amrHome = tmpdir();
  run(['ensure'], { amrHome });
  const a = run(['add', 'uses tabs for indentation'], { amrHome });
  const id = a.stdout.match(/\[id ([0-9a-f]{4})\]/)?.[1];
  assert.ok(id, a.stdout);
  const u = run(['update', id, 'uses two-space indentation'], { amrHome });
  assert.equal(u.status, 0, u.stderr);
  assert.match(u.stdout, new RegExp(`\\[id ${id}\\]`));
  const mem = path.join(amrHome, 'MEMORY.md');
  assert.match(read(mem), new RegExp(`two-space indentation.*id: ${id}`));
  assert.doesNotMatch(read(mem), /tabs for indentation/);
  const s = run(['supersede', id, 'uses four-space indentation'], { amrHome });
  assert.equal(s.status, 0, s.stderr);
  assert.match(read(mem), /four-space indentation.*supersedes: /);
  assert.doesNotMatch(read(mem), /two-space/);
  assert.match(
    read(path.join(amrHome, 'archive', 'superseded.md')),
    /two-space indentation/
  );
  assert.notEqual(run(['update', 'zzzz1', 'x y'], { amrHome }).status, 0);
});

test('ids backfills legacy entries and keeps ids unique', () => {
  const amrHome = tmpdir();
  run(['ensure'], { amrHome });
  const mem = path.join(amrHome, 'MEMORY.md');
  fs.writeFileSync(
    mem,
    '# Memory\n\n- legacy one [added: 2026-01-01]\n- legacy two\n\n## Index\n'
  );
  const r = run(['ids'], { amrHome });
  assert.match(r.stdout, /assigned ids to 2 entries/);
  const found = [...read(mem).matchAll(/id: ([0-9a-f]{4})/g)].map((m) => m[1]);
  assert.equal(found.length, 2);
  assert.notEqual(found[0], found[1]);
  assert.match(run(['ids'], { amrHome }).stdout, /already have ids/);
});

test('add "text" --project <name>: a known project name is the scope, not entry text', () => {
  const home = tmpdir();
  const repoA = initRepo(tmpdir());
  const repoB = initRepo(tmpdir());
  assert.equal(run(['add', 'seed note', '--project'], { amrHome: home, cwd: repoB }).status, 0);
  const slug = fs.readdirSync(path.join(home, 'projects'))[0].replace(/\.md$/, '');
  const name = slug.replace(/-[0-9a-f]{6}$/, '');
  const r = run(['add', 'scoped from elsewhere', '--project', name], { amrHome: home, cwd: repoA });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readdirSync(path.join(home, 'projects')).length, 1);
  const body = read(path.join(home, 'projects', `${slug}.md`));
  assert.match(body, /scoped from elsewhere \[/);
  assert.doesNotMatch(body, new RegExp(`scoped from elsewhere ${name}`));
});

test('add "text" --project <unknown>: warns instead of mis-saving silently', () => {
  const home = tmpdir();
  const repo = initRepo(tmpdir());
  const r = run(['add', 'some entry', '--project', 'nosuchproj'], { amrHome: home, cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /does not name a known project/);
  assert.match(r.stderr, /--project=nosuchproj/);
});
