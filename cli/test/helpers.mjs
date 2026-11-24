import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'amr.mjs'
);

export function tmpdir(prefix = 'amrtest-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Run the real CLI as a subprocess. Every test gets an isolated
// AMR_HOME; fakeHome additionally redirects HOME/USERPROFILE for
// adapters and harvest sources that resolve paths off the home dir.
export function run(args, { cwd, amrHome, fakeHome, env, input } = {}) {
  const e = {
    ...process.env,
    AMR_HOME: amrHome,
    // `amr dream --if-stale` detaches a judge-backed queue review; never
    // let a test start a real judge. Tests that exercise it override this.
    AMR_REVIEW: 'off',
    // Redirect every home-ish env var so harvest/adapters can't touch
    // the real user profile during tests (APPDATA leaks otherwise).
    ...(fakeHome
      ? {
          HOME: fakeHome,
          USERPROFILE: fakeHome,
          APPDATA: path.join(fakeHome, 'AppData', 'Roaming'),
          LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local'),
          HOMEDRIVE: path.parse(fakeHome).root.replace(/[\\/]+$/, ''),
          HOMEPATH: fakeHome.slice(path.parse(fakeHome).root.length),
          XDG_CONFIG_HOME: path.join(fakeHome, '.config'),
        }
      : {}),
    ...env,
  };
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd,
    env: e,
    input,
    timeout: 30_000,
  });
  return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

export function git(dir, args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0)
    throw new Error(`git ${args[0]} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

export function initRepo(dir, remoteUrl) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-b', 'main']);
  if (remoteUrl) git(dir, ['remote', 'add', 'origin', remoteUrl]);
  git(dir, [
    '-c', 'user.email=test@lucid-mem.dev',
    '-c', 'user.name=amr-test',
    'commit', '--allow-empty', '-m', 'init',
  ]);
  return dir;
}

export function read(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

export function entries(file) {
  const t = read(file) || '';
  return t.split('\n').filter((l) => l.startsWith('- '));
}
