import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run, tmpdir, initRepo, read } from './helpers.mjs';

// A stub judge: records the prompt it was sent and replies with the
// contents of reply.json.
function stubJudge(dir, reply) {
  const replyFile = path.join(dir, 'reply.json');
  const promptFile = path.join(dir, 'prompt.txt');
  fs.writeFileSync(replyFile, JSON.stringify(reply));
  const script = path.join(dir, 'judge.mjs');
  fs.writeFileSync(
    script,
    `import fs from 'node:fs';
const input = fs.readFileSync(0, 'utf8');
fs.writeFileSync(${JSON.stringify(promptFile)}, input);
process.stdout.write(fs.readFileSync(${JSON.stringify(replyFile)}, 'utf8'));
`
  );
  return {
    env: { AMR_JUDGE_CMD: `"${process.execPath}" "${script}"` },
    prompt: () => read(promptFile),
  };
}

function writeQueue(home, lines) {
  fs.mkdirSync(path.join(home, 'dreams'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'dreams', 'pending-reflections.md'),
    `# Pending reflections\n\nheader\n\n${lines.join('\n')}\n`
  );
}

const queueFile = (home) => path.join(home, 'dreams', 'pending-reflections.md');
const queueText = (home) => (fs.existsSync(queueFile(home)) ? read(queueFile(home)) : '');
const review = (home, judge, args = []) =>
  run(['review', '--auto', '--judge', 'env', ...args], { amrHome: home, cwd: tmpdir(), env: judge.env });

function idOf(home, rel, needle) {
  const line = read(path.join(home, rel))
    .split('\n')
    .find((l) => l.includes(needle));
  return (line.match(/id: ([0-9a-f]+)/) || [])[1];
}

test('review --auto without --apply prints the plan and writes nothing', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  writeQueue(home, ['- [reflect] 2026-11-23 add pitfall global: When builds hang on Windows, kill stray node processes, because they hold file locks.']);
  const before = queueText(home);
  const judge = stubJudge(tmpdir(), [{ n: 1, decision: 'accept', reason: 'durable' }]);
  const r = review(home, judge);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Plan for 1 queued/);
  assert.match(r.stdout, /accept .*kill stray node processes/);
  assert.match(r.stdout, /nothing written/);
  assert.equal(queueText(home), before);
  assert.ok(!read(path.join(home, 'MEMORY.md')).includes('stray node'));
});

test('review --auto --apply accepts, merges and drops, then empties the queue and logs', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  run(['add', 'Deploys run from the release branch only.'], { amrHome: home });
  const target = idOf(home, 'MEMORY.md', 'release branch');
  writeQueue(home, [
    '- [reflect] 2026-11-23 add pitfall global: When builds hang on Windows, kill stray node processes, because they hold file locks.',
    '- [reflect] 2026-11-23 add decision global: Deploys go out from the release branch, never from main.',
    '- [reflect] 2026-11-23 add fact global: The coffee machine is on floor three.',
  ]);
  const judge = stubJudge(tmpdir(), [
    { n: 1, decision: 'accept', text: 'When builds hang on Windows, kill stray node processes first, because they hold file locks.', reason: 'durable pitfall' },
    { n: 2, decision: 'merge', id: target, text: 'Deploys run from the release branch only, never from main.', reason: 'same fact' },
    { n: 3, decision: 'drop', reason: 'irrelevant' },
  ]);
  const r = review(home, judge, ['--apply']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\+1 ~1 -0 x1/);

  const mem = read(path.join(home, 'MEMORY.md'));
  assert.match(mem, /kill stray node processes first/);
  // Accepted entries get the default TTL, not durable.
  assert.match(mem.split('\n').find((l) => l.includes('stray node')), /expires: \d{4}-\d{2}-\d{2}/);
  assert.match(mem, new RegExp(`never from main\\.[^\\n]*id: ${target}`));
  assert.ok(!mem.includes('coffee machine'));

  assert.equal(queueText(home), '');
  const log = read(path.join(home, 'dreams', 'review-log.md'));
  assert.match(log, /accept: When builds hang/);
  assert.match(log, /merge: Deploys run from the release branch/);
  assert.match(log, /drop: The coffee machine is on floor three\. — irrelevant/);

  // The run is committed.
  const logOut = run(['search', 'coffee'], { amrHome: home }).stdout;
  assert.match(logOut, /review-log\.md/);
});

test('review --auto --apply refuses unsafe decisions and still clears the items', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  run(['add', 'Tabs over spaces.'], { amrHome: home });
  const shown = idOf(home, 'MEMORY.md', 'Tabs over spaces');
  writeQueue(home, [
    '- [reflect] 2026-11-23 add fact global: The staging host is staging.example.test.',
    '- [reflect] 2026-11-23 add fact global: Use the shared deploy key.',
    '- [reflect] 2026-11-23 add preference global: Prefer short commit subjects.',
  ]);
  const judge = stubJudge(tmpdir(), [
    { n: 1, decision: 'merge', id: 'ffff', text: 'merged text', reason: 'bogus id' },
    { n: 2, decision: 'accept', text: 'Deploy key: AKIAABCDEFGHIJKLMNOP', reason: 'secret' },
    { n: 3, decision: 'retire', id: shown, reason: 'not a tidy' },
  ]);
  const r = review(home, judge, ['--apply']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /refused  merge ffff: .*not in the shown memory/);
  assert.match(r.stdout, /refused  accept: .*secret-shaped/);
  assert.match(r.stdout, /refused  retire [0-9a-f]+: .*only allowed for tidy/);
  const mem = read(path.join(home, 'MEMORY.md'));
  assert.match(mem, /Tabs over spaces/);
  assert.ok(!mem.includes('AKIA'));
  assert.equal(queueText(home), '');
  assert.match(read(path.join(home, 'dreams', 'review-log.md')), /drop: Use the shared deploy key\. — judged decision refused by vetting/);
});

test('review --auto --apply applies a tidy merge: fold into the keeper, retire the duplicate', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  run(['add', 'Run the linter before pushing.'], { amrHome: home });
  run(['add', 'Always lint before a push, CI rejects lint errors.', '--new'], { amrHome: home });
  const keep = idOf(home, 'MEMORY.md', 'Run the linter');
  const dup = idOf(home, 'MEMORY.md', 'Always lint');
  writeQueue(home, [
    `- [consolidate] 2026-11-23 tidy: merge ${dup} into ${keep} (near-duplicate): fold any unique detail into ${keep}, then \`lucid delete ${dup}\``,
  ]);
  const judge = stubJudge(tmpdir(), [
    { n: 1, decision: 'retire', id: dup, reason: 'duplicate' },
    { n: 1, decision: 'merge', id: keep, text: 'Run the linter before pushing, because CI rejects lint errors.', reason: 'fold detail' },
  ]);
  const r = review(home, judge, ['--apply']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\+0 ~1 -1 x0/);
  const mem = read(path.join(home, 'MEMORY.md'));
  assert.match(mem, /because CI rejects lint errors/);
  assert.ok(!mem.includes('Always lint'), mem);
});

test('scoped items are judged against that project memory and saved to it', () => {
  const home = tmpdir();
  const repo = initRepo(path.join(tmpdir(), 'app'), 'https://github.com/acme/app.git');
  run(['ensure'], { amrHome: home });
  run(['add', 'app uses redis for sessions', '--project'], { amrHome: home, cwd: repo });
  const slug = fs.readdirSync(path.join(home, 'projects'))[0].replace(/\.md$/, '');
  writeQueue(home, [
    `- [reflect] 2026-11-23 add pitfall project scope=${slug}: When redis restarts, app sessions drop, so warn users before maintenance, because sessions are not persisted.`,
  ]);
  const judge = stubJudge(tmpdir(), [{ n: 1, decision: 'accept', reason: 'durable' }]);
  const r = review(home, judge, ['--apply']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(judge.prompt(), /app uses redis for sessions/);
  assert.match(read(path.join(home, 'projects', `${slug}.md`)), /When redis restarts/);
});

test('an item memory already covers counts as a drop, not a failure', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  run(['add', 'When builds hang on Windows, kill stray node processes, because they hold file locks.'], { amrHome: home });
  writeQueue(home, ['- [reflect] 2026-11-23 add pitfall global: When builds hang on Windows, kill stray node processes, because they hold file locks.']);
  const judge = stubJudge(tmpdir(), [{ n: 1, decision: 'accept', reason: 'judge missed it' }]);
  const r = review(home, judge, ['--apply']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /already in memory/);
  assert.equal(queueText(home), '');
});

test('items the judge does not answer stay queued', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  writeQueue(home, [
    '- [reflect] 2026-11-23 add fact global: First proposal about release trains.',
    '- [reflect] 2026-11-23 add fact global: Second proposal about cache warmers.',
  ]);
  const judge = stubJudge(tmpdir(), [{ n: 1, decision: 'drop', reason: 'no' }]);
  const r = review(home, judge, ['--apply']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /unanswered 1/);
  const q = queueText(home);
  assert.ok(!q.includes('release trains'));
  assert.match(q, /cache warmers/);
});

test('a retire is skipped when its merge is refused, so the detail is not lost', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  run(['add', 'Run the linter before pushing.'], { amrHome: home });
  run(['add', 'Always lint before a push, CI rejects lint errors.', '--new'], { amrHome: home });
  const keep = idOf(home, 'MEMORY.md', 'Run the linter');
  const dup = idOf(home, 'MEMORY.md', 'Always lint');
  writeQueue(home, [
    `- [consolidate] 2026-11-23 tidy: merge ${dup} into ${keep} (near-duplicate): fold any unique detail into ${keep}, then \`lucid delete ${dup}\``,
  ]);
  // The merge has no text, so vetting refuses it; the retire must not run.
  const judge = stubJudge(tmpdir(), [
    { n: 1, decision: 'merge', id: keep, reason: 'fold detail' },
    { n: 1, decision: 'retire', id: dup, reason: 'duplicate' },
  ]);
  const r = review(home, judge, ['--apply']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /refused  retire [0-9a-f]+: its merge was not applied/);
  assert.match(read(path.join(home, 'MEMORY.md')), /Always lint/);
});

test('a tidy can retire a topic-file entry it names', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  run(['add', 'Pin the lockfile version in CI.', '--file', 'pitfalls'], { amrHome: home });
  run(['add', 'Pin lockfile versions in CI so builds repeat.', '--file', 'pitfalls', '--new'], { amrHome: home });
  const keep = idOf(home, 'pitfalls.md', 'Pin the lockfile');
  const dup = idOf(home, 'pitfalls.md', 'Pin lockfile versions');
  writeQueue(home, [
    `- [consolidate] 2026-11-23 tidy: merge ${dup} into ${keep} (near-duplicate): fold any unique detail into ${keep}, then \`lucid delete ${dup}\``,
  ]);
  const judge = stubJudge(tmpdir(), [
    { n: 1, decision: 'merge', id: keep, text: 'Pin the lockfile version in CI so builds repeat.', reason: 'fold' },
    { n: 1, decision: 'retire', id: dup, reason: 'duplicate' },
  ]);
  const r = review(home, judge, ['--apply']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /-1 /);
  assert.ok(!read(path.join(home, 'pitfalls.md')).includes('Pin lockfile versions'));
});

test('a review the judge did not finish does not stamp the day as reviewed', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  writeQueue(home, ['- [reflect] 2026-11-23 add fact global: Proposal the judge cannot answer.']);
  const stamp = path.join(home, '.git', 'amr.lastreview');
  // An empty reply: nothing parses, so the item stays queued.
  const failing = stubJudge(tmpdir(), []);
  const r1 = review(home, failing, ['--apply']);
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(r1.stdout, /unanswered 1/);
  assert.equal(fs.existsSync(stamp), false);
  const working = stubJudge(tmpdir(), [{ n: 1, decision: 'drop', reason: 'no' }]);
  const r2 = review(home, working, ['--apply']);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(fs.existsSync(stamp), true);
});

test('a dropped tidy is not re-queued by the next dream', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  run(['add', 'Run the linter before pushing any branch to the shared remote.'], { amrHome: home });
  run(['add', 'Run the linter before pushing any branch to the shared remote repo.', '--new'], { amrHome: home });
  // The daily dream queues a tidy for the near-duplicate pair.
  run(['dream', '--fix'], { amrHome: home });
  const tidy = queueText(home).split('\n').find((l) => l.startsWith('- [consolidate]'));
  assert.ok(tidy, queueText(home));
  writeQueue(home, [tidy]);
  const judge = stubJudge(tmpdir(), [{ n: 1, decision: 'drop', reason: 'distinct enough' }]);
  assert.equal(review(home, judge, ['--apply']).status, 0);
  assert.equal(queueText(home), '');
  run(['dream', '--fix'], { amrHome: home });
  assert.ok(!queueText(home).includes('[consolidate]'), queueText(home));
});

test('review --auto --archive works the archive newest first, bounded by --limit', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  fs.mkdirSync(path.join(home, 'dreams'), { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(
    path.join(home, 'dreams', 'reflection-archive.md'),
    `# Archived reflections\n\nheader\n\n- [reflect] ${day} add fact global: Older archived lesson about queues.\n- [reflect] ${day} add fact global: Newer archived lesson about caches.\n`
  );
  const judge = stubJudge(tmpdir(), [{ n: 1, decision: 'drop', reason: 'stale' }]);
  const r = review(home, judge, ['--archive', '--limit', '1', '--apply']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(judge.prompt(), /Newer archived lesson/);
  assert.ok(!judge.prompt().includes('Older archived lesson'));
  const arch = read(path.join(home, 'dreams', 'reflection-archive.md'));
  assert.match(arch, /Older archived lesson/);
  assert.ok(!arch.includes('Newer archived lesson'));
});

test('a background review backs off while another holds the run lock', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  writeQueue(home, ['- [reflect] 2026-11-23 add fact global: Some proposal about logs.']);
  fs.writeFileSync(path.join(home, '.git', 'amr-review.lock'), '1');
  const judge = stubJudge(tmpdir(), [{ n: 1, decision: 'drop', reason: 'no' }]);
  const r = review(home, judge, ['--apply', '--background']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(queueText(home), /proposal about logs/);
  assert.ok(fs.existsSync(path.join(home, '.git', 'amr-review.lock')));
});

test('dream --if-stale starts a detached review that drains the queue', async () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  writeQueue(home, ['- [reflect] 2026-11-23 add fact global: Background proposal about tracing.']);
  const judge = stubJudge(tmpdir(), [{ n: 1, decision: 'drop', reason: 'no' }]);
  const r = run(['dream', '--if-stale', '1', '--fix'], {
    amrHome: home,
    env: { ...judge.env, AMR_REVIEW: '', AMR_REVIEW_JUDGE: 'env' },
  });
  assert.equal(r.status, 0, r.stderr);
  // The review is detached; give it time to finish. A 20s budget was too
  // tight on the slower Windows CI runner (node startup + git commit).
  // The child drops queue lines before it writes the log, so wait for the
  // log row too, not only for the queue to empty.
  const logPath = path.join(home, 'dreams', 'review-log.md');
  const logged = () => fs.existsSync(logPath) && /Background proposal about tracing/.test(read(logPath));
  for (let i = 0; i < 300 && (queueText(home).includes('tracing') || !logged()); i++)
    await new Promise((res) => setTimeout(res, 200));
  assert.ok(!queueText(home).includes('tracing'), queueText(home));
  assert.ok(logged(), 'review log never recorded the decision');
});
