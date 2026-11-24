import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initRepo, read, run, tmpdir } from './helpers.mjs';

function setup() {
  const amrHome = tmpdir();
  const fakeHome = tmpdir();
  assert.equal(run(['ensure'], { amrHome, fakeHome }).status, 0);
  return { amrHome, fakeHome };
}

function claudeJsonl(fakeHome, lines) {
  const dir = path.join(fakeHome, '.claude', 'projects', 'projx');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'sess.jsonl');
  fs.writeFileSync(
    file,
    lines
      .map((text) =>
        JSON.stringify({ type: 'user', message: { content: text } })
      )
      .join('\n')
  );
}

test('coverage reports save rate and lists missed durable signals', () => {
  const { amrHome, fakeHome } = setup();
  run(['add', 'prefers tabs over spaces'], { amrHome, fakeHome });
  claudeJsonl(fakeHome, [
    // saved: near-verbatim in corpus
    'I prefer tabs over spaces everywhere, remember that',
    // durable but never saved
    'we decided the cache TTL should always be 300 seconds',
    // a code dump that merely contains a marker word — excluded
    'const x = () => { if (a) { return b; } }; // never skip this check',
    // ordinary chatter — not durable
    'looks good, ship it',
  ]);
  const r = run(['coverage', '--days', '7', '--no-log'], {
    amrHome,
    fakeHome,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1\/2 durable signals covered — save rate 50%/);
  assert.match(r.stdout, /cache TTL should always be 300/);
  assert.ok(!r.stdout.includes('never skip this check'));

  // Misses land in the pending queue the next session reviews.
  const pending = path.join(amrHome, 'dreams', 'pending-saves.md');
  assert.match(read(pending), /cache TTL should always be 300/);

  // The queue must not self-cover: the same miss stays a miss.
  const r2 = run(['coverage', '--days', '7', '--no-log'], {
    amrHome,
    fakeHome,
  });
  assert.match(r2.stdout, /save rate 50%/);

  // And it surfaces in context for both modes (outside-mode here).
  const ctx = run(['context'], { amrHome, fakeHome, cwd: fakeHome });
  assert.match(ctx.stdout, /Pending memory candidates/);
  assert.match(ctx.stdout, /cache TTL/);
});

test('--judge env refines verdicts: prunes recall cues, catches paraphrase saves, proposes entries', () => {
  const { amrHome, fakeHome } = setup();
  run(['add', 'package manager is pnpm'], { amrHome, fakeHome });
  claudeJsonl(fakeHome, [
    // deterministic: durable (always), covered? terms don't overlap → miss
    'we always use pnpm for this repo, never npm',
    // deterministic: durable marker, but it is a recall cue not a save
    'going back to the sidebar rework, remember that?',
  ]);
  // Judge says: 0 is covered (paraphrase of the saved entry), 1 is not
  // durable (recall cue). Deterministic-only run would say 0/2.
  const judge = path.join(fakeHome, 'fake-judge.mjs');
  fs.writeFileSync(
    judge,
    `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify({flagged:[
      {i:0,durable:true,covered:true},
      {i:1,durable:false,kind:'recall'}
    ],unflagged:[]})))`
  );
  const r = run(['coverage', '--days', '7', '--no-log', '--judge', 'env'], {
    amrHome,
    fakeHome,
    env: { AMR_JUDGE_CMD: `node "${judge}"` },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /judge:env/);
  assert.match(r.stdout, /1\/1 durable signals covered — save rate 100%/);
  // Nothing missed → the queue is empty.
  assert.ok(!fs.existsSync(path.join(amrHome, 'dreams', 'pending-saves.md')));
});

test('judge samples the unflagged pool and extrapolates the miss rate', () => {
  const { amrHome, fakeHome } = setup();
  claudeJsonl(fakeHome, [
    'we decided the cache TTL should always be 300 seconds', // flagged, unsaved
    'ok cool, that approach works for me', // chatter — judge calls index 1 durable
    'thanks, moving on to the next piece',
    'sounds right to me, go ahead with it',
  ]);
  const judge = path.join(fakeHome, 'fake-judge.mjs');
  fs.writeFileSync(
    judge,
    `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      const i=JSON.parse(JSON.stringify(s));
      console.log(JSON.stringify({flagged:[{i:0,durable:true,covered:false,proposal:'cache TTL is 300s'}],
        unflagged:[{i:1,durable:true,covered:false,proposal:'deploys happen fridays'}]}))})`
  );
  const r = run(['coverage', '--days', '7', '--judge', 'env'], {
    amrHome,
    fakeHome,
    env: { AMR_JUDGE_CMD: `node "${judge}"` },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /unflagged sample: 1\/3 durable/);
  assert.match(r.stdout, /adjusted save rate ≈ 0%/);
  assert.match(r.stdout, /\(unflagged\)/);
  const pending = read(path.join(amrHome, 'dreams', 'pending-saves.md'));
  assert.match(pending, /deploys happen fridays/);
});

function workTranscript(dir, n) {
  const file = path.join(dir, 'work.jsonl');
  const row = {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] },
  };
  fs.writeFileSync(file, Array(n).fill(JSON.stringify(row)).join('\n'));
  return file;
}

test('reflect stays quiet without real work, blocks once after it, then rate-limits', () => {
  const { amrHome, fakeHome } = setup();
  const hook = (payload) =>
    run(['reflect'], {
      amrHome,
      fakeHome,
      env: { AMR_REFLECT: 'block' },
      input: JSON.stringify(payload),
    });
  const sid = `s-${path.basename(fakeHome)}`;
  const quiet = hook({ session_id: sid, transcript_path: workTranscript(fakeHome, 2) });
  assert.equal(quiet.stdout, '');
  const t = workTranscript(fakeHome, 7);
  const j = JSON.parse(hook({ session_id: sid, transcript_path: t }).stdout);
  assert.equal(j.decision, 'block');
  assert.match(j.reason, /lucid add/);
  assert.equal(hook({ session_id: sid, transcript_path: t }).stdout, '');
  assert.equal(
    hook({ session_id: sid, stop_hook_active: true, transcript_path: t }).stdout,
    ''
  );
});

test('add --project "text" keeps the text; episodic entries get a warning', () => {
  const { amrHome, fakeHome } = setup();
  const repo = initRepo(tmpdir());
  const r = run(['add', '--project', 'PR #788 open, commit 1f06cc1b not pushed'], {
    amrHome, fakeHome, cwd: repo,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /saved to projects\//);
  assert.match(r.stderr, /session state/);
  assert.match(r.stderr, /commit SHA/);
});

test('a failing judge falls back to deterministic results', () => {
  const { amrHome, fakeHome } = setup();
  claudeJsonl(fakeHome, ['we decided the db migration runs weekly']);
  const judge = path.join(fakeHome, 'bad-judge.mjs');
  fs.writeFileSync(judge, 'process.exit(3)');
  const r = run(['coverage', '--days', '7', '--no-log', '--judge', 'env'], {
    amrHome,
    fakeHome,
    env: { AMR_JUDGE_CMD: `node "${judge}"` },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /judge env failed — deterministic results/);
  assert.match(r.stdout, /save rate 0%/);
});

test('pending queue drains once a missed signal is saved', () => {
  const { amrHome, fakeHome } = setup();
  claudeJsonl(fakeHome, ['we decided the db migration runs weekly']);
  run(['coverage', '--no-log'], { amrHome, fakeHome });
  const pending = path.join(amrHome, 'dreams', 'pending-saves.md');
  assert.ok(fs.existsSync(pending));

  run(['add', 'db migration runs weekly'], { amrHome, fakeHome });
  const r = run(['coverage', '--no-log'], { amrHome, fakeHome });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1\/1 .*100%/);
  assert.ok(!fs.existsSync(pending));
});

test('coverage logs a trend line by default; --no-log skips it', () => {
  const { amrHome, fakeHome } = setup();
  claudeJsonl(fakeHome, ['we decided the db migration runs weekly']);
  const log = path.join(amrHome, 'dreams', 'coverage.jsonl');
  run(['coverage', '--no-log'], { amrHome, fakeHome });
  assert.ok(!fs.existsSync(log));
  const r = run(['coverage'], { amrHome, fakeHome });
  assert.equal(r.status, 0, r.stderr);
  const entry = JSON.parse(readLines(log).at(-1));
  assert.equal(entry.durable, 1);
  assert.equal(entry.covered, 0);
  assert.equal(entry.rate, 0);
});

function readLines(file) {
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean);
}

// A judge stub that records the prompt it was given and replies with
// a fixed JSON array.
function stubJudge(fakeHome, reply) {
  const judge = path.join(fakeHome, 'stub-judge.mjs');
  const seen = path.join(fakeHome, 'judge-prompt.txt');
  fs.writeFileSync(
    judge,
    'import fs from "node:fs";' +
      'fs.writeFileSync(' + JSON.stringify(seen) + ', fs.readFileSync(0, "utf8"));' +
      'console.log(' + JSON.stringify(JSON.stringify(reply)) + ');'
  );
  return { judge, seen };
}

function reflectRun({ amrHome, fakeHome, repo, reply, env = {} }) {
  const transcript = path.join(fakeHome, 'convo.jsonl');
  fs.writeFileSync(
    transcript,
    JSON.stringify({ type: 'user', message: { content: 'ci flaked again' } })
  );
  const { judge, seen } = stubJudge(fakeHome, reply);
  const payload = path.join(fakeHome, 'payload.json');
  fs.writeFileSync(payload, JSON.stringify({ transcript_path: transcript, cwd: repo }));
  const r = run(['reflect-run', payload], {
    amrHome,
    fakeHome,
    env: { AMR_JUDGE_CMD: '"' + process.execPath + '" "' + judge + '"', AMR_REFLECT_JUDGE: 'env', ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  return { prompt: fs.readFileSync(seen, 'utf8') };
}

const pendingFile = (amrHome) => path.join(amrHome, 'dreams', 'pending-reflections.md');

test('reflect-run queues judge proposals for review instead of saving them', () => {
  const { amrHome, fakeHome } = setup();
  const repo = initRepo(tmpdir());
  run(['add', '--project', 'When the drift gate flakes, warm the Go cache, because cold rebuilds time out'], {
    amrHome, fakeHome, cwd: repo,
  });
  const body0 = read(path.join(amrHome, 'projects', fs.readdirSync(path.join(amrHome, 'projects'))[0]));
  const id = body0.match(/id: ([0-9a-f]{4,8})/)[1];

  const { prompt } = reflectRun({
    amrHome, fakeHome, repo,
    reply: [
      { op: 'add', text: 'When CI flakes, re-run once before debugging, because runners are flaky', project: true, kind: 'pitfall' },
      { op: 'add', text: 'PR #788 open, commit 1f06cc1b not pushed', project: true },
      // restates saved memory: dropped
      { op: 'add', text: 'When the drift gate flakes, warm the Go cache because cold rebuilds time out', project: true },
      { op: 'update', id, text: 'When the drift gate flakes, run go test ./... first to warm the cache, because cold rebuilds time out' },
      { op: 'update', id: 'ffff', text: 'update to an id the judge was never shown' },
    ],
  });

  // The judge saw existing memory, addressed by id.
  const memoryBlock = prompt.slice(prompt.indexOf('<memory>'), prompt.indexOf('</memory>'));
  assert.ok(memoryBlock.includes(`${id}: When the drift gate flakes`), memoryBlock);
  // Nothing new was written to memory.
  assert.equal(read(path.join(amrHome, 'projects', fs.readdirSync(path.join(amrHome, 'projects'))[0])), body0);
  const queue = read(pendingFile(amrHome));
  assert.match(queue, /add pitfall project scope=[a-z0-9-]+: When CI flakes, re-run once/);
  assert.match(queue, new RegExp('update ' + id + ' scope=[a-z0-9-]+: When the drift gate flakes, run go test'));
  assert.doesNotMatch(queue, /PR #788/);
  assert.doesNotMatch(queue, /warm the Go cache because/);
  assert.doesNotMatch(queue, /ffff/);

  // The next session sees the proposals; saving one drains it.
  const ctx = run(['context'], { amrHome, fakeHome, cwd: repo }).stdout;
  assert.match(ctx, /Pending memory candidates[\s\S]*When CI flakes, re-run once/);
  run(['add', '--project', 'When CI flakes, re-run once before debugging, because runners are flaky'], {
    amrHome, fakeHome, cwd: repo,
  });
  const after = read(pendingFile(amrHome));
  assert.doesNotMatch(after, /When CI flakes/);
  assert.match(after, new RegExp('update ' + id));

  // A repeat reflection does not queue the same proposal twice.
  reflectRun({
    amrHome, fakeHome, repo,
    reply: [{ op: 'update', id, text: 'When the drift gate flakes, run go test ./... first to warm the cache, because cold rebuilds time out' }],
  });
  assert.equal((read(pendingFile(amrHome)).match(/^- \[reflect\] .* update /gm) || []).length, 1);
});

test('AMR_REFLECT_AUTOSAVE saves new entries directly; updates still wait for review', () => {
  const { amrHome, fakeHome } = setup();
  const repo = initRepo(tmpdir());
  run(['add', '--project', 'When the drift gate flakes, warm the Go cache, because cold rebuilds time out'], {
    amrHome, fakeHome, cwd: repo,
  });
  const file = path.join(amrHome, 'projects', fs.readdirSync(path.join(amrHome, 'projects'))[0]);
  const id = read(file).match(/id: ([0-9a-f]{4,8})/)[1];
  reflectRun({
    amrHome, fakeHome, repo,
    env: { AMR_REFLECT_AUTOSAVE: '1' },
    reply: [
      { op: 'add', text: 'When CI flakes, re-run once before debugging, because runners are flaky', project: true, kind: 'pitfall' },
      { op: 'update', id, text: 'When the drift gate flakes, run go test ./... first, because cold rebuilds time out' },
    ],
  });
  const body = read(file);
  assert.match(body, /re-run once before debugging.*kind: pitfall/);
  assert.match(body, /warm the Go cache/); // not rewritten
  assert.match(read(pendingFile(amrHome)), new RegExp('update ' + id));
});

function toolTranscript(dir, name, calls) {
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(
    file,
    calls
      .map(([tool, command]) =>
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: tool, input: { command } }] },
        })
      )
      .join('\n')
  );
  return file;
}

test('reflect counts shell writes as work and long investigations as due', () => {
  const { amrHome, fakeHome } = setup();
  const hook = (sid, transcript_path) =>
    run(['reflect'], {
      amrHome,
      fakeHome,
      env: { AMR_REFLECT: 'block' },
      input: JSON.stringify({ session_id: `${sid}-${path.basename(fakeHome)}`, transcript_path }),
    }).stdout;
  // Six changing shell commands, no Edit/Write tool at all.
  const shellWork = toolTranscript(fakeHome, 'shell', [
    ['Bash', 'sed -i s/a/b/ f.txt'],
    ['Bash', 'echo x > out.txt'],
    ['PowerShell', 'Set-Content f.txt x'],
    ['Bash', 'git commit -m fix'],
    ['Bash', 'git push origin HEAD'],
    ['Bash', 'gh pr create --base main'],
  ]);
  assert.match(hook('shell', shellWork), /"decision":"block"/);
  // Read-only shell commands are not work, including inline scripts
  // and filters whose arrows or comparisons look like redirects...
  const reads = [
    ...Array(8).fill(['Bash', 'git log --oneline 2>&1']),
    ['Bash', 'node -e "[1].map(a=>a)"'],
    ['Bash', "jq '.n > 1' f.json"],
  ];
  assert.equal(hook('reads', toolTranscript(fakeHome, 'reads', reads)), '');
  // ...but a long investigation is due even without edits.
  const investigation = Array(20).fill(['Bash', 'grep -rn foo src']);
  assert.match(hook('probe', toolTranscript(fakeHome, 'probe', investigation)), /"decision":"block"/);
});

test('the judge transcript keeps failing tool output, drops secrets, keeps head and tail', async () => {
  const { transcriptText } = await import('../lib/reflect.mjs');
  const dir = tmpdir();
  const file = path.join(dir, 't.jsonl');
  const rows = [
    { type: 'user', message: { content: 'EARLY: why does CI fail?' } },
    {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', is_error: false, content: 'Error: Timed out waiting for ROUND_START' },
          { type: 'tool_result', content: [{ type: 'text', text: 'all 50 tests passed' }] },
          { type: 'tool_result', content: 'Error: authentication failed; password=hunter2' },
          { type: 'tool_result', content: 'Error: 401 Authorization: Bearer abcdefghijklmnop' },
          { type: 'tool_result', content: 'error: token ghp_abcdefghijklmnopqrstuvwxyz0123456789 rejected' },
        ],
      },
    },
    ...Array(200).fill({ type: 'assistant', message: { content: 'filler '.repeat(20) } }),
    { type: 'assistant', message: { content: 'LATE: fixed by relaxing the round pace' } },
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n'));
  const t = transcriptText(file);
  assert.match(t, /EARLY: why does CI fail/);
  assert.match(t, /LATE: fixed by relaxing/);
  assert.match(t, /middle of session omitted/);
  assert.match(t, /TOOL RESULT: Error: Timed out waiting for ROUND_START/);
  assert.doesNotMatch(t, /all 50 tests passed/);
  // Credential values are redacted, not sent to the judge verbatim.
  assert.doesNotMatch(t, /hunter2|abcdefghijklmnop/);
  assert.match(t, /authentication failed; password=\[redacted\]/);
  assert.doesNotMatch(t, /ghp_/);
  assert.ok(t.length <= 14100, `transcript is ${t.length} chars`);
});
