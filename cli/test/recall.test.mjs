import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initRepo, run, tmpdir } from './helpers.mjs';

const PITFALL =
  'When writing files through a bash heredoc on Windows, build backslash escapes with chr(92), because heredoc escapes corrupt string literals';

function seed(home) {
  run(['ensure'], { amrHome: home });
  const a = run(['add', PITFALL, '--kind', 'pitfall'], { amrHome: home });
  assert.equal(a.status, 0, a.stderr);
  return a.stdout.match(/\[id ([0-9a-f]{4})\]/)?.[1];
}

test('recall surfaces the heredoc pitfall on CS1010', () => {
  const home = tmpdir();
  const id = seed(home);
  const r = run(['recall', 'error CS1010: Newline in constant'], { amrHome: home });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /chr\(92\)/);
  assert.match(r.stdout, new RegExp(id));
});

test('recall surfaces the heredoc pitfall on shell heredoc EOF errors', () => {
  const home = tmpdir();
  seed(home);
  const r = run(['recall', "bash: unexpected EOF while looking for matching `''"], { amrHome: home });
  assert.match(r.stdout, /chr\(92\)/);
});

test('recall stays silent for unrelated errors and for non-error output', () => {
  const home = tmpdir();
  seed(home);
  const miss = run(['recall', 'error TS2304: Cannot find name frobnicate'], { amrHome: home });
  assert.equal(miss.stdout.trim(), '');
  const ok = run(['recall', 'build succeeded, 0 errors'], { amrHome: home });
  assert.equal(ok.stdout.trim(), '');
});

test('recall --hook reads a PostToolUse payload and emits additionalContext JSON only on a match', () => {
  const home = tmpdir();
  seed(home);
  const payload = JSON.stringify({
    session_id: 's1',
    tool_name: 'Bash',
    tool_response: { stderr: 'error CS1010: Newline in constant', exit_code: 1 },
  });
  const r = run(['recall', '--hook'], { amrHome: home, input: payload });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.match(parsed.hookSpecificOutput.additionalContext, /chr\(92\)/);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');

  const quiet = run(['recall', '--hook'], {
    amrHome: home,
    input: JSON.stringify({ session_id: 's1', tool_name: 'Bash', tool_response: { stdout: 'all good' } }),
  });
  assert.equal(quiet.stdout.trim(), '');
});

// ---- failure-only, project-scoped, rare-word recall ----------------------

const hook = (home, payload) =>
  run(['recall', '--hook'], { amrHome: home, input: JSON.stringify(payload) });
const fires = (r) => /additionalContext/.test(r.stdout);
const CS = 'error CS1010: Newline in constant';

test('successful output that merely contains error words does not recall', () => {
  const home = tmpdir();
  seed(home);
  const r = hook(home, {
    session_id: 'ok1',
    tool_name: 'Bash',
    tool_response: {
      stdout: 'tests/foo.py: SyntaxError cp1252 UnicodeDecodeError error CS1010 newline in constant',
      stderr: '',
      exit_code: 0,
    },
  });
  assert.equal(r.stdout.trim(), '');
});

test('read-only tools never recall, even when their output is full of error words', () => {
  const home = tmpdir();
  seed(home);
  for (const tool_name of ['Read', 'Grep', 'Glob']) {
    const r = hook(home, {
      session_id: `ro-${tool_name}`,
      tool_name,
      tool_response: { content: `${CS}\nSyntaxError heredoc cp1252`, is_error: true },
    });
    assert.equal(r.stdout.trim(), '', tool_name);
  }
});

test('tool_input echo is not scored: a failure unrelated to the command text stays silent', () => {
  const home = tmpdir();
  seed(home);
  const r = hook(home, {
    session_id: 'echo1',
    tool_name: 'Bash',
    tool_input: { command: 'grep -rn "CS1010 heredoc chr(92) cp1252" src' },
    tool_response: { stderr: 'error: pathspec src does not match', exit_code: 2 },
  });
  assert.equal(r.stdout.trim(), '');
});

test('PostToolUseFailure fires, echoes its event name, and the header is honest', () => {
  const home = tmpdir();
  seed(home);
  const r = hook(home, {
    session_id: 'f1',
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    error: `Exit code 1\n${CS}`,
  });
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PostToolUseFailure');
  assert.match(out.additionalContext, /^Possibly relevant/);
  assert.doesNotMatch(out.additionalContext, /Relevant memory for this error/);
  assert.match(out.additionalContext, /amr unhelpful/);
});

test('a project entry fires only inside its own project', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  const a = initRepo(path.join(tmpdir(), 'alpha'), 'https://github.com/acme/alpha.git');
  const b = initRepo(path.join(tmpdir(), 'beta'), 'https://github.com/acme/beta.git');
  assert.equal(run(['add', PITFALL, '--kind', 'pitfall', '--project'], { amrHome: home, cwd: a }).status, 0);
  const payload = (sid, cwd) => ({
    session_id: sid,
    cwd,
    tool_name: 'Bash',
    tool_response: { stderr: CS, exit_code: 1 },
  });
  assert.equal(hook(home, payload('p-b', b)).stdout.trim(), '');
  assert.equal(hook(home, payload('p-none', tmpdir())).stdout.trim(), '');
  assert.ok(fires(hook(home, payload('p-a', a))));
  // a worktree/clone of alpha shares the remote-derived slug
  const a2 = initRepo(path.join(tmpdir(), 'alpha-wt'), 'https://github.com/acme/alpha.git');
  assert.ok(fires(hook(home, payload('p-a2', a2))));
});

test('a shared common word is not enough: a rare shared word is required', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  const common = [
    'When the package install step stalls on a locked registry, retry with a clean cache folder',
    'When the package install hook rewrites lockfiles, review the diff before committing anything',
    'When the package install output is noisy, silence it with the quiet flag in CI scripts',
  ];
  for (const t of common) assert.equal(run(['add', t], { amrHome: home }).status, 0);
  // shares only "package"/"install" (in all three entries, so not rare)
  const ambient = run(['recall', 'error: package install exited unexpectedly'], { amrHome: home });
  assert.equal(ambient.stdout.trim(), '');
  // shares a word only the first entry has, plus a second one
  const specific = run(['recall', 'error: registry locked, install stalled on cache folder'], { amrHome: home });
  assert.match(specific.stdout, /locked registry/);
});

test('near-duplicate hits collapse to one', () => {
  const home = tmpdir();
  run(['ensure'], { amrHome: home });
  const one =
    "When editing source files from Python on Windows, open with encoding='utf-8' or use binary mode; the default cp1252 corrupts em dashes and ellipses. Also avoid backslash escapes inside bash heredoc python; build them with chr(92) or use sed.";
  const two =
    'When editing Python source files on Windows, use UTF-8 explicitly or the Edit tool, because Python defaults to cp1252 which corrupts em dashes, ellipses, and backslash escapes.';
  const three = 'When Windows tools emit cp1252 text, decode it with iconv before grepping for non-ASCII characters.';
  for (const t of [one, two, three]) assert.equal(run(['add', t, '--kind', 'pitfall'], { amrHome: home }).status, 0);
  const r = run(['recall', "UnicodeDecodeError: 'charmap' codec can't decode byte 0x9d (cp1252)"], { amrHome: home });
  const shown = r.stdout.trim().split('\n').filter(Boolean);
  assert.ok(shown.length <= 2, `expected at most 2 hits, got ${shown.length}`);
  assert.ok(!(/em dashes and ellipses/.test(r.stdout) && /ellipses, and backslash/.test(r.stdout)));
});

test('amr unhelpful mutes an entry for that kind of error only', () => {
  const home = tmpdir();
  const id = seed(home);
  const first = hook(home, {
    session_id: 'u1',
    tool_name: 'Bash',
    tool_response: { stderr: CS, exit_code: 1 },
  });
  assert.ok(fires(first));
  const m = run(['unhelpful', id], { amrHome: home });
  assert.equal(m.status, 0, m.stderr);
  assert.match(m.stdout, new RegExp(`muted.*${id}`));
  const again = hook(home, {
    session_id: 'u2',
    tool_name: 'Bash',
    tool_response: { stderr: CS, exit_code: 1 },
  });
  assert.equal(again.stdout.trim(), '');
  // a different kind of error (shell heredoc EOF) still surfaces it
  const other = hook(home, {
    session_id: 'u3',
    tool_name: 'Bash',
    tool_response: { stderr: "bash: unexpected EOF while looking for matching `''", exit_code: 2 },
  });
  assert.ok(fires(other));
  const unknown = run(['unhelpful', 'ffff'], { amrHome: home });
  assert.match(unknown.stdout, /no matching ids/);
});

test('reading recall.mjs (source full of trigger words) does not recall', () => {
  const home = tmpdir();
  seed(home);
  const src = fs.readFileSync(new URL('../lib/recall.mjs', import.meta.url), 'utf8');
  assert.match(src, /syntaxerror/i);
  const r = hook(home, {
    session_id: 'src1',
    tool_name: 'Read',
    tool_response: { file: { content: src } },
  });
  assert.equal(r.stdout.trim(), '');
  const viaBash = hook(home, {
    session_id: 'src2',
    tool_name: 'Bash',
    tool_response: { stdout: src, stderr: '', exit_code: 0 },
  });
  assert.equal(viaBash.stdout.trim(), '');
});

test('--hook with an unparseable payload stays silent instead of treating it as error text', () => {
  const home = tmpdir();
  seed(home);
  const r = run(['recall', '--hook'], { amrHome: home, input: 'not json: error CS1010 Newline in constant' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '');
  // the manual form still takes piped text
  const manual = run(['recall'], { amrHome: home, input: 'error CS1010: Newline in constant' });
  assert.match(manual.stdout, /chr\(92\)/);
});
