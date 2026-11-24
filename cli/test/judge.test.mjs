import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run, tmpdir, read } from './helpers.mjs';
import { quoteWinArg } from '../lib/judge.mjs';

// A fake headless CLI: answers a prompt read from --prompt-file (or
// stdin), records argv and cwd, and can echo a model name back.
function fakeCli(dir) {
  const script = path.join(dir, 'fakejudge.mjs');
  const log = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(
    script,
    `import fs from 'node:fs';
const argv = process.argv.slice(2);
const i = argv.indexOf('--prompt-file');
const prompt = i >= 0 ? fs.readFileSync(argv[i + 1], 'utf8') : fs.readFileSync(0, 'utf8');
const m = argv.indexOf('--model');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, cwd: process.cwd(), entries: fs.readdirSync(process.cwd()), prompt }) + '\\n');
const model = m >= 0 ? argv[m + 1] : '';
if (model === 'broken') { process.stderr.write('model broken does not exist'); process.exit(1); }
if (argv.includes('--jsonl')) {
  process.stdout.write(JSON.stringify({ type: 'start' }) + '\\n' + JSON.stringify({ type: 'final', message: { text: '[{"ok":true}]' } }) + '\\n');
} else process.stdout.write('[{"ok":true}]');
`
  );
  return { cmd: `"${process.execPath}" "${script}"`, calls: () => read(log).trim().split('\n').map((l) => JSON.parse(l)) };
}

const amr = (home, args) => run(args, { amrHome: home });

test('judge add/use/list writes amr.json and picks per-command judges', () => {
  const home = tmpdir();
  amr(home, ['ensure']);
  const fake = fakeCli(tmpdir());
  let r = amr(home, ['judge', 'add', 'mine', '--cmd', `${fake.cmd} --prompt-file {promptFile} --model {model}`, '--model', 'tiny-1']);
  assert.equal(r.status, 0, r.stderr);
  r = amr(home, ['judge', 'use', 'mine']);
  assert.equal(r.status, 0, r.stderr);
  r = amr(home, ['judge', 'use', 'claude', '--for', 'coverage']);
  assert.equal(r.status, 0, r.stderr);

  const cfg = JSON.parse(read(path.join(home, 'amr.json')));
  assert.equal(cfg.judge.use, 'mine');
  assert.equal(cfg.judge.coverage, 'claude');
  assert.equal(cfg.judge.providers.mine.model, 'tiny-1');
  assert.deepEqual(cfg.judge.providers.mine.args.slice(-4), ['--prompt-file', '{promptFile}', '--model', '{model}']);

  const list = amr(home, ['judge']).stdout;
  assert.match(list, /mine\s+available/);
  assert.match(list, /review\s+mine/);
  assert.match(list, /triage\s+mine/);
});

test('judge test runs a configured provider with placeholders filled, in an empty temp dir', () => {
  const home = tmpdir();
  amr(home, ['ensure']);
  const fake = fakeCli(tmpdir());
  amr(home, ['judge', 'add', 'mine', '--cmd', `${fake.cmd} --prompt-file {promptFile} --model {model}`, '--model', 'tiny-1']);
  const r = amr(home, ['judge', 'test', 'mine']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /mine: ok/);
  const [call] = fake.calls();
  assert.ok(call.argv.includes('tiny-1'));
  assert.match(call.prompt, /Reply with ONLY this JSON array/);
  assert.match(path.basename(path.dirname(call.cwd)), /^amr-judge-/);
  assert.deepEqual(call.entries, []);
});

test('a provider without a prompt placeholder gets the prompt on stdin', () => {
  const home = tmpdir();
  amr(home, ['ensure']);
  const fake = fakeCli(tmpdir());
  amr(home, ['judge', 'add', 'piped', '--cmd', fake.cmd]);
  const r = amr(home, ['judge', 'test', 'piped']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(fake.calls()[0].prompt, /Reply with ONLY this JSON array/);
});

test('json:<path> output extracts the reply from JSONL events', () => {
  const home = tmpdir();
  amr(home, ['ensure']);
  const fake = fakeCli(tmpdir());
  amr(home, ['judge', 'add', 'events', '--cmd', `${fake.cmd} --jsonl`, '--output', 'json:message.text']);
  const r = amr(home, ['judge', 'test', 'events']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /events: ok/);
});

test('judge test reports the CLI error when a provider fails', () => {
  const home = tmpdir();
  amr(home, ['ensure']);
  const fake = fakeCli(tmpdir());
  amr(home, ['judge', 'add', 'bad', '--cmd', `${fake.cmd} --model {model}`, '--model', 'broken']);
  const r = amr(home, ['judge', 'test', 'bad']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /model broken does not exist/);
});

test('an unavailable configured judge falls back to the next choice', () => {
  const home = tmpdir();
  amr(home, ['ensure']);
  amr(home, ['judge', 'add', 'ghost', '--cmd', 'definitely-not-a-real-binary-xyz']);
  amr(home, ['judge', 'use', 'ghost']);
  const fake = fakeCli(tmpdir());
  // env is always available here, so something other than ghost is chosen.
  const r = run(['judge'], { amrHome: home, env: { AMR_JUDGE_CMD: fake.cmd } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ghost\s+command not found/);
  assert.match(r.stdout, /review\s+(?!ghost)\S+\s+\(configured ghost unavailable\)/);
});

test('review --auto uses the configured review judge', () => {
  const home = tmpdir();
  amr(home, ['ensure']);
  const dir = tmpdir();
  const script = path.join(dir, 'drop.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs'; fs.readFileSync(0, 'utf8'); process.stdout.write('[{"n":1,"decision":"drop","reason":"stub"}]');`);
  amr(home, ['judge', 'add', 'dropper', '--cmd', `"${process.execPath}" "${script}"`]);
  amr(home, ['judge', 'use', 'dropper', '--for', 'review']);
  fs.mkdirSync(path.join(home, 'dreams'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'dreams', 'pending-reflections.md'),
    '# Pending reflections\n\nh\n\n- [reflect] 2026-11-23 add fact global: Some lesson about widgets.\n'
  );
  const r = run(['review', '--auto'], { amrHome: home, cwd: tmpdir() });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /with dropper/);
  assert.match(r.stdout, /drop .*widgets/);
});

test('judge use/remove validate names and clean up references', () => {
  const home = tmpdir();
  amr(home, ['ensure']);
  assert.equal(amr(home, ['judge', 'use', 'nope']).status, 1);
  assert.equal(amr(home, ['judge', 'add', 'claude', '--preset', 'muse']).status, 1);
  amr(home, ['judge', 'add', 'spark', '--preset', 'muse']);
  amr(home, ['judge', 'use', 'spark']);
  amr(home, ['judge', 'use', 'spark', '--for', 'review']);
  assert.equal(amr(home, ['judge', 'remove', 'spark']).status, 0);
  const cfg = JSON.parse(read(path.join(home, 'amr.json')));
  assert.equal(cfg.judge, undefined);
});

test('the muse preset passes the prompt by file and the model by flag', () => {
  const home = tmpdir();
  amr(home, ['ensure']);
  amr(home, ['judge', 'add', 'spark', '--preset', 'muse', '--model', 'muse-spark-1.3']);
  const p = JSON.parse(read(path.join(home, 'amr.json'))).judge.providers.spark;
  assert.equal(p.command, 'muse');
  assert.equal(p.model, 'muse-spark-1.3');
  assert.deepEqual(p.args.slice(0, 5), ['exec', '--prompt-file', '{promptFile}', '--model', '{model}']);
});

test('AMR_JUDGE_CMD is split into argv, never run through a shell', () => {
  const home = tmpdir();
  amr(home, ['ensure']);
  const fake = fakeCli(tmpdir());
  const marker = path.join(tmpdir(), 'marker.txt');
  // A shell would run the redirect; argv passes it through as plain text.
  const r = run(['judge', 'test', 'env'], {
    amrHome: home,
    env: { AMR_JUDGE_CMD: `${fake.cmd} & echo pwned > "${marker}"` },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /env: ok/);
  assert.equal(fs.existsSync(marker), false);
});

test('quoteWinArg quotes only what cmd.exe needs quoted', () => {
  assert.equal(quoteWinArg('exec'), 'exec');
  assert.equal(quoteWinArg('C:\\Temp\\a b\\p.txt'), '"C:\\Temp\\a b\\p.txt"');
  assert.equal(quoteWinArg('{"a":1}'), '"{\\"a\\":1}"');
  assert.equal(quoteWinArg('dir\\'), 'dir\\');
  assert.equal(quoteWinArg('a b\\'), '"a b\\\\"');
  assert.equal(quoteWinArg(''), '""');
});
