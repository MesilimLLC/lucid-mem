// `amr judge setup`: pick a judge interactively, sign in to its CLI if
// needed, test it, and only then save it. Sign-in always runs the CLI's
// own login command on the user's terminal; amr never handles
// credentials.
//
// The flow is driven through a small `ui` object (select / ask / confirm
// / log) so tests can script it; the terminal version below is
// dependency-free (readline keypress events in raw mode).

import readline from 'node:readline';
import { ensureRepo } from './core.mjs';
import {
  PRESETS,
  PURPOSES,
  authSpec,
  available,
  checkAuth,
  findBin,
  judgeConfig,
  listJudges,
  probeJudge,
  providerAvailable,
  runLogin,
  writeJudgeConfig,
} from './judge.mjs';

const BUILTIN_DETAIL = {
  claude: 'Claude Code CLI, model haiku',
  codex: 'Codex CLI, its default model',
};

const clone = (o) => JSON.parse(JSON.stringify(o));

// Every judge the picker offers, in display order.
export function setupEntries(home) {
  const { j, providers } = judgeConfig(home);
  const entries = [];
  for (const name of ['claude', 'codex'])
    entries.push({ name, kind: 'builtin', installed: available(name, providers), detail: BUILTIN_DETAIL[name] });
  for (const [name, pre] of Object.entries(PRESETS)) {
    if (Object.hasOwn(BUILTIN_DETAIL, name) || Object.hasOwn(providers, name)) continue;
    entries.push({
      name,
      kind: 'preset',
      installed: !!findBin(pre.command),
      detail: `${pre.command} CLI${pre.model ? `, model ${pre.model}` : ''} (new)`,
    });
  }
  for (const [name, p] of Object.entries(providers))
    entries.push({
      name,
      kind: 'provider',
      installed: providerAvailable(p),
      detail: `${p.command}${p.model ? `, model ${p.model}` : ''}`,
    });
  entries.push({ name: 'auto', kind: 'auto', installed: true, detail: 'first installed built-in (claude, codex)' });
  for (const e of entries) e.current = j.use ? j.use === e.name : e.kind === 'auto';
  return entries;
}

// Returns true when a judge was saved.
export async function runSetup({ home, ui }) {
  const { j, providers } = judgeConfig(home);
  const entries = setupEntries(home);
  const pick = await ui.select(
    'Which model should judge memory candidates?',
    entries.map((e) => ({
      label: e.name,
      hint: `${e.detail}${e.installed ? '' : ' (not installed)'}${e.current ? ' (current)' : ''}`,
      disabled: !e.installed,
    })),
    Math.max(0, entries.findIndex((e) => e.current && e.installed))
  );
  if (pick == null) {
    ui.log('cancelled; nothing changed');
    return false;
  }
  const entry = entries[pick];

  const scopes = [
    { key: 'use', label: 'all commands', hint: j.use ? `now ${j.use}` : 'now auto' },
    ...PURPOSES.map((p) => ({ key: p, label: p, hint: j[p] ? `now ${j[p]}` : 'follows "all commands"' })),
  ];
  const s = await ui.select(`Use ${entry.name} for:`, scopes, 0);
  if (s == null) {
    ui.log('cancelled; nothing changed');
    return false;
  }
  const key = scopes[s].key;

  if (entry.kind === 'auto') {
    writeJudgeConfig(home, (c) => delete c[key], `Use judge auto${key === 'use' ? '' : ` for ${key}`}`);
    ui.log(`cleared judge.${key}; the first installed built-in is used`);
    return true;
  }

  // The definition being set up: a new preset copy, an edited copy of a
  // configured provider, or null for a built-in.
  let provider = null;
  if (entry.kind === 'preset') provider = clone(PRESETS[entry.name]);
  if (entry.kind === 'provider') provider = clone(providers[entry.name]);
  if (provider && 'model' in provider) {
    const m = await ui.ask('Model (Enter keeps it)', provider.model || '');
    if (m == null) {
      ui.log('cancelled; nothing changed');
      return false;
    }
    provider.model = m;
  }

  const auth = authSpec(entry.name, provider);
  const loginLine = auth.login ? `${auth.command} ${auth.login.join(' ')}` : '';
  let loggedIn = false;
  const offerLogin = async (why) => {
    if (!auth.login) return false;
    if (!(await ui.confirm(`${why} Run \`${loginLine}\` now?`, true))) return false;
    ui.log(`running \`${loginLine}\`; finish signing in, then come back here`);
    const status = ui.login(auth);
    loggedIn = true;
    if (status !== 0) ui.log(`\`${loginLine}\` exited with ${status}`);
    return true;
  };

  if (checkAuth(auth) === false) {
    const ran = await offerLogin(`You are not signed in to ${auth.command}.`);
    if (!ran || checkAuth(auth) === false) {
      ui.log(`still not signed in to ${auth.command}${loginLine ? `; run \`${loginLine}\` yourself` : ''}. Nothing saved.`);
      return false;
    }
  }

  ui.log(`testing ${entry.name}...`);
  let probe = probeJudge(entry.name, { home, provider });
  if (!probe.ok && !loggedIn) {
    ui.log(`${entry.name} did not answer: ${probe.error || 'no reply'}`);
    if (await offerLogin('It may need you to sign in.')) {
      ui.log(`testing ${entry.name} again...`);
      probe = probeJudge(entry.name, { home, provider });
    }
  }
  if (!probe.ok) {
    ui.log(`${entry.name}: no usable reply after ${probe.secs}s${probe.error ? `: ${probe.error}` : ''}. Nothing saved.`);
    return false;
  }

  writeJudgeConfig(
    home,
    (c) => {
      if (provider) c.providers[entry.name] = provider;
      c[key] = entry.name;
    },
    `Set up judge ${entry.name}${key === 'use' ? '' : ` for ${key}`}`
  );
  ui.log(`${entry.name}: ok (${probe.secs}s). judge.${key} = ${entry.name}`);
  return true;
}

// ---- terminal ui ----------------------------------------------------------

const color = process.env.NO_COLOR ? null : true;
const dim = (s) => (color ? `\x1b[2m${s}\x1b[22m` : s);
const accent = (s) => (color ? `\x1b[36m${s}\x1b[39m` : s);

function terminalUi() {
  const { stdin, stdout } = process;
  const fit = (s) => {
    const w = (stdout.columns || 80) - 1;
    return s.length > w ? `${s.slice(0, w - 1)}…` : s;
  };
  return {
    log: (s) => stdout.write(`${s}\n`),
    select(title, items, initial = 0) {
      return new Promise((resolve) => {
        const enabled = (k) => items[k] && !items[k].disabled;
        let i = enabled(initial) ? initial : items.findIndex((_, k) => enabled(k));
        if (i < 0) {
          stdout.write(`${title}\n  nothing available\n`);
          return resolve(null);
        }
        let drawn = 0;
        const draw = () => {
          if (drawn) stdout.write(`\x1b[${drawn}A`);
          const lines = [
            title,
            ...items.map((it, k) => {
              const text = fit(`${k === i ? '>' : ' '} ${k + 1}. ${it.label}${it.hint ? `  ${it.hint}` : ''}`);
              return it.disabled ? dim(text) : k === i ? accent(text) : text;
            }),
            dim(fit('up/down to move, enter to choose, esc to cancel')),
          ];
          stdout.write(lines.map((l) => `\x1b[2K${l}`).join('\n') + '\n');
          drawn = lines.length;
        };
        const move = (d) => {
          for (let k = i + d; k >= 0 && k < items.length; k += d)
            if (enabled(k)) return void (i = k);
        };
        const wasRaw = stdin.isRaw;
        const done = (v) => {
          stdin.off('keypress', onKey);
          stdin.setRawMode(wasRaw);
          stdin.pause();
          resolve(v);
        };
        const onKey = (str, key = {}) => {
          if ((key.ctrl && key.name === 'c') || key.name === 'escape' || key.name === 'q') return done(null);
          if (key.name === 'return' || key.name === 'enter') return done(i);
          if (key.name === 'up' || key.name === 'k') move(-1);
          else if (key.name === 'down' || key.name === 'j') move(1);
          else if (/^[1-9]$/.test(str || '') && enabled(Number(str) - 1)) {
            i = Number(str) - 1;
            draw();
            return done(i);
          } else return;
          draw();
        };
        readline.emitKeypressEvents(stdin);
        stdin.setRawMode(true);
        stdin.resume();
        stdin.on('keypress', onKey);
        draw();
      });
    },
    ask(question, def = '') {
      return new Promise((resolve) => {
        const rl = readline.createInterface({ input: stdin, output: stdout });
        let answered = false;
        rl.question(`${question}${def ? ` [${def}]` : ''}: `, (a) => {
          answered = true;
          rl.close();
          resolve(a.trim() || def);
        });
        rl.on('close', () => answered || resolve(null));
      });
    },
    async confirm(question, def = true) {
      const a = await this.ask(`${question} ${def ? '[Y/n]' : '[y/N]'}`, '');
      if (a == null) return false;
      return a ? /^y/i.test(a) : def;
    },
    login: (auth) => runLogin(auth),
  };
}

export async function cmdJudgeSetup() {
  try {
    const home = ensureRepo();
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stderr.write(
        'lucid judge setup needs an interactive terminal. Run it in your own terminal, or use `lucid judge add`, `lucid judge use` and `lucid judge test`.\n\n'
      );
      listJudges(home);
      process.exitCode = 1;
      return;
    }
    if (!(await runSetup({ home, ui: terminalUi() }))) process.exitCode = 1;
  } catch (e) {
    process.stderr.write(`lucid: ${e.message}\n`);
    process.exitCode = 1;
  }
}
