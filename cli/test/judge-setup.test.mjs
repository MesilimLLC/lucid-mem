import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run, tmpdir, read } from './helpers.mjs';

// The setup flow runs in-process against a scripted ui; the repo it
// writes is this test file's own AMR_HOME.
const home = tmpdir();
process.env.AMR_HOME = home;
run(['ensure'], { amrHome: home });
const { runSetup, setupEntries } = await import('../lib/judge-setup.mjs');

// A fake CLI with `status` / `login` subcommands. It answers the judge
// prompt only after `login` has created its token file.
function fakeCli() {
  const dir = tmpdir();
  const script = path.join(dir, 'fake.mjs');
  const token = path.join(dir, 'token');
  const log = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(
    script,
    `import fs from 'node:fs';
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + '\\n');
if (argv[0] === 'status') process.exit(fs.existsSync(${JSON.stringify(token)}) ? 0 : 1);
if (argv[0] === 'login') { fs.writeFileSync(${JSON.stringify(token)}, 'x'); process.exit(0); }
fs.readFileSync(0, 'utf8');
if (!fs.existsSync(${JSON.stringify(token)})) { process.stderr.write('not logged in'); process.exit(1); }
process.stdout.write('[{"ok":true}]');
`
  );
  const q = (s) => `"${s}"`;
  return {
    script,
    token,
    calls: () => read(log).trim().split('\n').map((l) => JSON.parse(l)),
    add: (name, extra = []) =>
      run(['judge', 'add', name, '--cmd', `${q(process.execPath)} ${q(script)}`, ...extra], { amrHome: home }),
  };
}

// Scripted answers: select by label, ask/confirm from queues.
function scriptedUi({ picks = [], answers = [], confirms = [] }) {
  const logs = [];
  const logins = [];
  return {
    logs,
    logins,
    async select(title, items) {
      const want = picks.shift();
      if (want === null) return null;
      const k = items.findIndex((it) => it.label === want);
      assert.ok(k >= 0, `no "${want}" in ${title}: ${items.map((i) => i.label)}`);
      assert.ok(!items[k].disabled, `"${want}" is disabled`);
      return k;
    },
    async ask(_q, def) {
      return answers.length ? answers.shift() : def;
    },
    async confirm() {
      return confirms.length ? confirms.shift() : true;
    },
    log: (s) => logs.push(s),
    login() {
      throw new Error('unexpected login');
    },
  };
}

// Real login: run the provider command itself (the fake writes its token).
function withRealLogin(ui) {
  ui.login = (auth) => {
    ui.logins.push(auth);
    const { spawnSync } = process.getBuiltinModule('node:child_process');
    return spawnSync(auth.command, auth.login, { stdio: 'ignore' }).status;
  };
  return ui;
}

const localFile = () => path.join(home, '.git', 'amr-judge.json');
const localProviders = () => {
  try {
    return JSON.parse(read(localFile())).providers || {};
  } catch {
    return {};
  }
};
const judgeCfg = () => {
  const amrJson = path.join(home, 'amr.json');
  // Spreading undefined is a no-op, so a missing amr.json needs no fallback.
  const shared = fs.existsSync(amrJson) ? JSON.parse(read(amrJson)).judge : undefined;
  return { ...shared, providers: localProviders() };
};

test('setup signs in through the CLI login when status says signed out, tests, then saves', async () => {
  const fake = fakeCli();
  fake.add('fk1', ['--login', `"${fake.script}" login`, '--status', `"${fake.script}" status`]);
  const ui = withRealLogin(scriptedUi({ picks: ['fk1', 'all commands'] }));
  assert.equal(await runSetup({ home, ui }), true, ui.logs.join('\n'));
  assert.equal(ui.logins.length, 1);
  assert.ok(fs.existsSync(fake.token));
  assert.equal(judgeCfg().use, 'fk1');
  assert.match(ui.logs.at(-1), /fk1: ok .*judge\.use = fk1/);
});

test('declining the login saves nothing', async () => {
  const before = judgeCfg().use;
  const fake = fakeCli();
  fake.add('fk2', ['--login', `"${fake.script}" login`, '--status', `"${fake.script}" status`]);
  const ui = withRealLogin(scriptedUi({ picks: ['fk2', 'review'], confirms: [false] }));
  assert.equal(await runSetup({ home, ui }), false);
  assert.equal(ui.logins.length, 0);
  assert.equal(judgeCfg().review, undefined);
  assert.equal(judgeCfg().use, before);
  assert.match(ui.logs.at(-1), /Nothing saved/);
});

test('without a status command, a failed test offers the login and retests', async () => {
  const fake = fakeCli();
  fake.add('fk3', ['--login', `"${fake.script}" login`]);
  const ui = withRealLogin(scriptedUi({ picks: ['fk3', 'coverage'] }));
  assert.equal(await runSetup({ home, ui }), true, ui.logs.join('\n'));
  assert.equal(ui.logins.length, 1);
  assert.ok(ui.logs.some((l) => /did not answer: not logged in/.test(l)));
  assert.equal(judgeCfg().coverage, 'fk3');
});

test('a changed model is tested before it is saved', async () => {
  const fake = fakeCli();
  fs.writeFileSync(fake.token, 'x');
  fake.add('fk4', ['--model', 'small-1']);
  // fake.add put no {model} in args; add one so the model reaches argv.
  const cfg = JSON.parse(read(localFile()));
  cfg.providers.fk4.args.push('--model', '{model}');
  fs.writeFileSync(localFile(), JSON.stringify(cfg, null, 2));
  const ui = withRealLogin(scriptedUi({ picks: ['fk4', 'triage'], answers: ['small-2'] }));
  assert.equal(await runSetup({ home, ui }), true, ui.logs.join('\n'));
  assert.ok(fake.calls().some((argv) => argv.includes('small-2')));
  assert.equal(judgeCfg().providers.fk4.model, 'small-2');
  assert.equal(judgeCfg().triage, 'fk4');
});

test('picking auto clears the chosen scope', async () => {
  const ui = scriptedUi({ picks: ['auto', 'all commands'] });
  assert.equal(await runSetup({ home, ui }), true);
  assert.equal(judgeCfg().use, undefined);
});

test('cancelling the picker changes nothing', async () => {
  const before = read(path.join(home, 'amr.json'));
  const ui = scriptedUi({ picks: [null] });
  assert.equal(await runSetup({ home, ui }), false);
  assert.equal(read(path.join(home, 'amr.json')), before);
});

test('the picker lists built-ins, unadded presets, configured providers and auto', () => {
  const names = setupEntries(home).map((e) => `${e.kind}:${e.name}`);
  assert.deepEqual(names.slice(0, 2), ['builtin:claude', 'builtin:codex']);
  assert.ok(names.includes('preset:muse'));
  assert.ok(names.includes('provider:fk1'));
  assert.equal(names.at(-1), 'auto:auto');
});

test('judge setup without a terminal explains itself and lists judges', () => {
  const r = run(['judge', 'setup'], { amrHome: tmpdir() });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /needs an interactive terminal/);
  assert.match(r.stdout, /In use:/);
});
