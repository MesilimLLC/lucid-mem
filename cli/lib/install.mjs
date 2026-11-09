import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addJsoncEntry, removeJsoncEntry, ShapeError } from './jsonc.mjs';
import { ensureRepo, git, hasRemote, isMemoryRepo, loadConfig, resolveHome, resolveProjectSlug, sh } from './core.mjs';

const out = (s = '') => process.stdout.write(s + '\n');
const err = (s) => process.stderr.write(s + '\n');

const CLI_ENTRY = path.resolve(
  fileURLToPath(new URL('../amr.mjs', import.meta.url))
);
const hookCmd = (sub) => `node "${CLI_ENTRY}" ${sub}`;

export const MARK_BEGIN = '<!-- lucid-mem -->';
export const MARK_END = '<!-- /lucid-mem -->';

// Pre-rename markers. Installs made before the rename carry these; install
// migrates them in place and uninstall/doctor still recognise them.
export const LEGACY_MARK_BEGIN = '<!-- agent-memory-repo -->';
export const LEGACY_MARK_END = '<!-- /agent-memory-repo -->';

const blockRe = (begin, end) => new RegExp(`${begin}[\\s\\S]*?${end}`, 'm');

const RULE_TEMPLATE = fs.readFileSync(
  new URL('./rule-block.md', import.meta.url),
  'utf8'
);

export const RULE_BLOCK = RULE_TEMPLATE.slice(
  RULE_TEMPLATE.indexOf(MARK_BEGIN),
  RULE_TEMPLATE.indexOf(MARK_END) + MARK_END.length
).replaceAll('{{CLI_ENTRY}}', () => CLI_ENTRY);

const RULE_FILE_WRAPPER = `---
description: lucid-mem persistent agent memory
alwaysApply: true
---

${RULE_BLOCK}
`;

const home = os.homedir();
const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');

const firstExisting = (paths) => paths.find((p) => fs.existsSync(p));

const localappdata =
  process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
const documents = path.join(home, 'Documents');
const zedConfig =
  process.platform === 'win32'
    ? path.join(appdata, 'Zed')
    : path.join(xdgConfigHome, 'zed');
// Nous Hermes Agent home: $HERMES_HOME when set, else the platform
// default (Windows desktop installs live under LOCALAPPDATA).
const hermesHome = () =>
  process.env.HERMES_HOME
    ? path.resolve(process.env.HERMES_HOME)
    : process.platform === 'win32'
      ? path.join(localappdata, 'hermes')
      : path.join(home, '.hermes');
// Meta Muse Code config root: XDG with a home fallback on every OS
// (Windows uses %USERPROFILE%\.config\muse, never AppData).
const museConfigDir = () => path.join(xdgConfigHome, 'muse');
// Devin CLI user config: %APPDATA%\devin\config.json on Windows,
// ~/.config/devin/config.json elsewhere. Holds hooks and MCP servers.
const devinConfigFile = () =>
  process.platform === 'win32'
    ? path.join(appdata, 'devin', 'config.json')
    : path.join(xdgConfigHome, 'devin', 'config.json');

const HOSTS = {
  cursor: {
    detect: () => fs.existsSync(path.join(home, '.cursor')),
    hooksJson: () => path.join(home, '.cursor', 'hooks.json'),
    mcpJson: () => path.join(home, '.cursor', 'mcp.json'),
    rules: () => [
      {
        path: path.join(home, '.cursor', 'rules', 'lucid-mem.mdc'),
        legacyPaths: [path.join(home, '.cursor', 'rules', 'agent-memory-repo.mdc')],
        content: RULE_FILE_WRAPPER,
        append: false,
      },
    ],
  },
  claude: {
    detect: () => fs.existsSync(path.join(home, '.claude')),
    settingsJson: () => path.join(home, '.claude', 'settings.json'),
    mcpJson: () => path.join(home, '.claude.json'),
    rules: () => [
      {
        path: path.join(home, '.claude', 'CLAUDE.md'),
        content: RULE_BLOCK,
        append: true,
      },
    ],
  },
  'claude-desktop': {
    // Desktop app: no hooks/rules file — MCP tools are the only channel.
    detect: () => fs.existsSync(path.join(appdata, 'Claude')),
    mcpJson: () =>
      path.join(appdata, 'Claude', 'claude_desktop_config.json'),
  },
  windsurf: {
    detect: () => fs.existsSync(path.join(home, '.codeium', 'windsurf')),
    hooksJson: () =>
      path.join(home, '.codeium', 'windsurf', 'hooks.json'),
    mcpJson: () =>
      path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
    rules: () => [
      {
        path: path.join(
          home,
          '.codeium',
          'windsurf',
          'memories',
          'global_rules.md'
        ),
        content: RULE_BLOCK,
        append: true,
      },
    ],
  },
  devin: {
    // Devin CLI user config holds Claude-Code-compatible hooks plus
    // mcpServers. Hooks fire with Claude-shaped stdin; SessionStart
    // stdout injects context.
    detect: () =>
      !!firstExisting([
        path.join(appdata, 'devin'),
        path.join(home, '.config', 'devin'),
      ]),
    devinConfig: () => devinConfigFile(),
    rules: () => [
      {
        path:
          firstExisting([
            path.join(appdata, 'devin', 'AGENTS.md'),
            path.join(home, '.config', 'devin', 'AGENTS.md'),
          ]) || path.join(appdata, 'devin', 'AGENTS.md'),
        content: RULE_BLOCK,
        append: true,
      },
    ],
  },
  copilot: {
    detect: () => fs.existsSync(path.join(home, '.copilot')),
    rules: () => [
      {
        path: path.join(home, '.copilot', 'AGENTS.md'),
        content: RULE_BLOCK,
        append: true,
      },
    ],
  },
  codex: {
    // No session-start hook: config.toml `notify` is fire-and-forget,
    // single-slot, and can't inject context. AGENTS.md block only.
    detect: () => fs.existsSync(path.join(home, '.codex')),
    mcpToml: () => path.join(home, '.codex', 'config.toml'),
    rules: () => [
      {
        path: path.join(home, '.codex', 'AGENTS.md'),
        content: RULE_BLOCK,
        append: true,
      },
    ],
  },
  cline: {
    // Cline global rules live in Documents/Cline/Rules; ~/.cline is the
    // CLI data dir. Cline hooks are named executables in .clinerules/hooks
    // — unverified for global scope, so rules-only for now.
    detect: () => fs.existsSync(path.join(home, '.cline')),
    mcpJson: () => path.join(home, '.cline', 'mcp.json'),
    rules: () => [
      {
        path: path.join(documents, 'Cline', 'Rules', 'lucid-mem.md'),
        legacyPaths: [path.join(documents, 'Cline', 'Rules', 'agent-memory-repo.md')],
        content: RULE_BLOCK,
        append: false,
      },
      {
        path: path.join(home, '.cline', 'AGENTS.md'),
        content: RULE_BLOCK,
        append: true,
      },
    ],
  },
  muse: {
    // Meta Muse Code CLI (`muse`). User settings at
    // ~/.config/muse/settings.json hold hooks (Claude-shaped payloads,
    // SessionStart stdout/additionalContext injection) and MCP servers;
    // schema_version: 1 is mandatory there. User rules at
    // ~/.config/muse/AGENTS.md load for every project. Hooks run with
    // a cleared environment, so commands use absolute paths.
    detect: () => fs.existsSync(museConfigDir()),
    museSettings: () => path.join(museConfigDir(), 'settings.json'),
    rules: () => [
      {
        path: path.join(museConfigDir(), 'AGENTS.md'),
        content: RULE_BLOCK,
        append: true,
      },
    ],
  },
  hermes: {
    // Nous Hermes Agent. SOUL.md is its global instructions file;
    // config.yaml carries MCP servers (mcp_servers) and shell hooks:
    // pre_llm_call injects `amr context --hermes`, post_compaction
    // re-arms the injection. Only the default profile is wired.
    detect: () => fs.existsSync(hermesHome()),
    configYaml: () => path.join(hermesHome(), 'config.yaml'),
    rules: () => [
      {
        path: path.join(hermesHome(), 'SOUL.md'),
        content: RULE_BLOCK,
        append: true,
      },
    ],
  },
  antigravity: {
    // Google's agentic IDE (Windsurf-derived). Shares ~/.gemini with the
    // CLIs: global rules at GEMINI.md, MCP at config/mcp_config.json in
    // the standard mcpServers shape. Rules+MCP tier; no injectable hooks.
    detect: () =>
      !!firstExisting([
        path.join(appdata, 'Antigravity IDE'),
        path.join(appdata, 'Antigravity'),
        path.join(home, '.gemini', 'antigravity-ide'),
        path.join(home, '.gemini', 'antigravity-cli'),
      ]),
    mcpJson: () => path.join(home, '.gemini', 'config', 'mcp_config.json'),
    rules: () => [
      {
        path: path.join(home, '.gemini', 'GEMINI.md'),
        content: RULE_BLOCK,
        append: true,
      },
    ],
  },
  'gemini-cli': {
    // Gemini CLI shares GEMINI.md with Antigravity but stores MCP servers
    // in settings.json using the standard mcpServers shape.
    // The CLI creates ~/.gemini on install; settings.json may not exist yet.
    detect: () => fs.existsSync(path.join(home, '.gemini')),
    mcpJson: () => path.join(home, '.gemini', 'settings.json'),
    rules: () => [
      {
        path: path.join(home, '.gemini', 'GEMINI.md'),
        content: RULE_BLOCK,
        append: true,
      },
    ],
  },
  zed: {
    detect: () => fs.existsSync(zedConfig),
    mcpZed: () => path.join(zedConfig, 'settings.json'),
    rules: () => [
      {
        path: path.join(zedConfig, 'AGENTS.md'),
        content: RULE_BLOCK,
        append: true,
      },
    ],
  },
  opencode: {
    // SST's opencode CLI. Global rules at ~/.config/opencode/AGENTS.md;
    // MCP lives in opencode.json's "mcp" object with a local/remote
    // schema different from mcpServers — needs its own merge.
    detect: () =>
      !!firstExisting([
        path.join(home, '.config', 'opencode'),
        path.join(home, '.opencode'),
      ]),
    mcpOpencode: () =>
      firstExisting([
        path.join(home, '.config', 'opencode', 'opencode.json'),
        path.join(home, '.config', 'opencode', 'opencode.jsonc'),
      ]) || path.join(home, '.config', 'opencode', 'opencode.json'),
    rules: () => [
      {
        path: path.join(home, '.config', 'opencode', 'AGENTS.md'),
        content: RULE_BLOCK,
        append: true,
      },
    ],
  },
  commandcode: {
    // Claude-Code-shaped CLI (projects/<slug>/<uuid>.jsonl sessions,
    // mcp.json with mcpServers). Entries there use explicit
    // "transport" fields, so tag the entry accordingly.
    detect: () => fs.existsSync(path.join(home, '.commandcode')),
    mcpJson: () => path.join(home, '.commandcode', 'mcp.json'),
    mcpEntry: { transport: 'stdio', command: 'node', args: [CLI_ENTRY, 'serve'], enabled: true },
    rules: () => [
      {
        path: path.join(home, '.commandcode', 'AGENTS.md'),
        content: RULE_BLOCK,
        append: true,
      },
    ],
  },
  freebuff: {
    // Free codebuff CLI. Its ~/.freebuff/mcp.json is a manifest-managed
    // server registry (hash-keyed, approvedManifest) — not safe to
    // hand-edit, so rules-only. Sessions live in the shared codebuff
    // dir (~/.config/manicode/projects/*/chats/*/log.jsonl), which
    // harvest already reaches.
    detect: () =>
      !!firstExisting([
        path.join(home, '.freebuff'),
        path.join(home, '.config', 'manicode', 'freebuff.exe'),
      ]),
    rules: () => [
      {
        path: path.join(home, '.freebuff', 'AGENTS.md'),
        content: RULE_BLOCK,
        append: true,
      },
      {
        path: path.join(home, '.config', 'manicode', 'AGENTS.md'),
        content: RULE_BLOCK,
        append: true,
      },
    ],
  },
};

const MCP_ENTRY = { command: 'node', args: [CLI_ENTRY, 'serve'] };

// JSONC-aware merge: comments in a host config are kept, and a file that
// cannot be parsed at all is left untouched — rewriting it as {} plus our
// entry would drop every other MCP server the app relies on. cmdInstall
// counts an 'unparseable' skip as a host failure.
function mergeJsoncEntry(file, section, name, entry) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  let next;
  try {
    next = addJsoncEntry(text, section, name, entry);
  } catch (e) {
    return e instanceof ShapeError ? `skipped (${e.message})` : 'skipped (unparseable)';
  }
  if (next === null) return false;
  backup(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  return true;
}
function unmergeJsoncEntry(file, section, name) {
  if (!fs.existsSync(file)) return false;
  let next;
  try {
    next = removeJsoncEntry(fs.readFileSync(file, 'utf8'), section, name);
  } catch {
    return false;
  }
  if (next === null) return false;
  backup(file);
  fs.writeFileSync(file, next);
  return true;
}

function mergeMcpJson(file, entry = MCP_ENTRY) {
  return mergeJsoncEntry(file, 'mcpServers', 'agent-memory', entry);
}

function mergeMcpToml(file) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (text.includes('mcp_servers.agent-memory')) return false;
  backup(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${text}\n[mcp_servers.agent-memory]\ncommand = "node"\nargs = ["${CLI_ENTRY.replace(/\\/g, '\\\\')}", "serve"]\n`
  );
  return true;
}

// opencode.json uses `"mcp": {name: {type:'local', command:[...]}}` —
// a different schema from mcpServers. .jsonc files may contain comments
// that break JSON.parse; never clobber an unparseable config.
function mergeMcpOpencode(file) {
  return mergeJsoncEntry(file, 'mcp', 'agent-memory', {
    type: 'local',
    command: ['node', CLI_ENTRY, 'serve'],
    disabled: false,
  });
}

// Zed stores context servers in `context_servers` and permits JSONC
// comments in settings.json. Keep an unparseable file untouched.
function mergeMcpZed(file) {
  return mergeJsoncEntry(file, 'context_servers', 'agent-memory', {
    command: 'node',
    args: [CLI_ENTRY, 'serve'],
    env: {},
  });
}

// Hermes config.yaml is YAML and lucid-mem has no YAML parser, so the
// merge is textual and conservative (same contract as mergeMcpToml):
// back up first, only insert under a plain block `mcp_servers:` /
// `hooks:` key, and skip (fail closed) when the section is a flow
// mapping or the hook events we need already exist. JSON string
// quoting is valid YAML double-quoted style.
const yamlArg = (s) => JSON.stringify(String(s).replace(/\\/g, '/'));
const hermesHookCommand = `node "${CLI_ENTRY.replace(/\\/g, '/')}" context --hermes`;

function insertUnderKey(lines, key, block) {
  const idx = lines.findIndex((l) => new RegExp(`^${key}:\\s*(#.*)?$`).test(l));
  if (idx >= 0) {
    lines.splice(idx + 1, 0, ...block);
    return true;
  }
  if (new RegExp(`^${key}:`, 'm').test(lines.join('\n'))) return false; // non-block form
  lines.push('', `${key}:`, ...block);
  return true;
}

function mergeMcpYaml(file) {
  const block = [
    '  agent-memory:',
    '    command: "node"',
    `    args: [${yamlArg(CLI_ENTRY)}, "serve"]`,
  ];
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `mcp_servers:\n${block.join('\n')}\n`);
    return true;
  }
  const text = fs.readFileSync(file, 'utf8');
  if (/(^|\n) {2}agent-memory:/.test(text)) return false;
  const lines = text.split('\n');
  backup(file);
  if (!insertUnderKey(lines, 'mcp_servers', block))
    return 'skipped (mcp_servers is not a block mapping; add agent-memory manually)';
  fs.writeFileSync(file, lines.join('\n'));
  return true;
}

function mergeHermesHooks(file) {
  const entry = (event) => [
    `  ${event}:`,
    `    - command: ${yamlArg(hermesHookCommand)}`,
    '      timeout: 30',
  ];
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (text.includes('context --hermes')) return false;
  // A pre-existing pre_llm_call/post_compaction key would collide with
  // ours (duplicate YAML key); leave the file untouched.
  if (/^\s+(pre_llm_call|post_compaction):/m.test(text))
    return 'skipped (existing pre_llm_call/post_compaction hook; add the agent-memory hooks manually)';
  const lines = text.split('\n');
  backup(file);
  if (!insertUnderKey(lines, 'hooks', [...entry('pre_llm_call'), ...entry('post_compaction')]))
    return 'skipped (hooks is not a block mapping; add the agent-memory hooks manually)';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n'));
  return true;
}

function unmergeMcpYaml(file) {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  const next = text.replace(/\n? {2}agent-memory:\n {4}command: [^\n]*\n {4}args: [^\n]*/, '');
  if (next === text) return false;
  backup(file);
  fs.writeFileSync(file, next);
  return true;
}

function unmergeHermesHooks(file) {
  if (!fs.existsSync(file)) return false;
  let text = fs.readFileSync(file, 'utf8');
  if (!text.includes('context --hermes')) return false;
  for (const event of ['pre_llm_call', 'post_compaction'])
    text = text.replace(
      new RegExp(`\\n? {2}${event}:\\n {4}- command: [^\\n]*context --hermes[^\\n]*\\n {6}timeout: \\d+`),
      ''
    );
  // Drop a now-empty hooks: header we may have created.
  text = text.replace(/\nhooks:\s*\n(?=\S|$)/, '\n');
  backup(file);
  fs.writeFileSync(file, text);
  return true;
}

function backup(file) {
  if (!fs.existsSync(file)) return;
  const to = `${file}.amr-backup`;
  if (!fs.existsSync(to)) fs.copyFileSync(file, to);
}

const HOOK_ENTRIES = [
  ['sessionStart', 'context'],
  ['sessionEnd', 'sync'],
  ['sessionEnd', 'dream --if-stale 1 --fix --compact --inline'],
  ['sessionEnd', 'coverage --days 2'],
];

// Match installed hooks by subcommand token ("dream"), but rewrite the
// command when it drifts from HOOK_ENTRIES so upgrades land in place.
function mergeHooksJson(file, entries) {
  let cfg = { hooks: {}, version: 1 };
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim()) {
    try {
      cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new Error(`cannot parse ${file}; leaving it untouched`);
    }
  }
  cfg.hooks ||= {};
  const added = [];
  for (const [event, sub] of entries) {
    const key = sub.split(' ')[0];
    const want = hookCmd(sub);
    const list = (cfg.hooks[event] ||= []);
    let found = false;
    for (const e of list) {
      if (
        typeof e?.command === 'string' &&
        e.command.includes(`amr.mjs" ${key}`)
      ) {
        found = true;
        if (e.command !== want) {
          e.command = want;
          added.push(`~${event}:${key}`);
        }
      }
    }
    if (!found) {
      list.push({ command: want });
      added.push(`${event}:${sub}`);
    }
  }
  if (added.length) {
    backup(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  }
  return added;
}

function mergeHooksIntoCfg(cfg, entries) {
  cfg.hooks ||= {};
  const added = [];
  for (const [event, sub, matcher] of entries) {
    const key = sub.split(' ')[0];
    const want = hookCmd(sub);
    const list = (cfg.hooks[event] ||= []);
    let found = false;
    for (const e of list) {
      for (const h of e?.hooks || []) {
        if (
          typeof h?.command === 'string' &&
          h.command.includes(`amr.mjs" ${key}`)
        ) {
          found = true;
          if (h.command !== want) {
            h.command = want;
            added.push(`~${event}:${key}`);
          }
        }
      }
    }
    if (!found) {
      list.push({
        ...(matcher ? { matcher } : {}),
        hooks: [{ type: 'command', command: want }],
      });
      added.push(`${event}:${sub}`);
    }
  }
  return added;
}

// Remove amr's `key` command from an event's hooks (an upgrade that moves a
// hook to another event, e.g. recall PostToolUse -> PostToolUseFailure).
// Foreign hooks in the same entry are kept. Returns labels of what went.
function retireHooks(cfg, retire) {
  const gone = [];
  for (const [event, key] of retire) {
    const list = cfg.hooks?.[event];
    if (!Array.isArray(list)) continue;
    const kept = [];
    for (const e of list) {
      const hooks = e?.hooks;
      if (!Array.isArray(hooks)) {
        kept.push(e);
        continue;
      }
      const rest = hooks.filter(
        (h) => !(typeof h?.command === 'string' && h.command.includes(`amr.mjs" ${key}`))
      );
      if (rest.length !== hooks.length) gone.push(`-${event}:${key}`);
      if (rest.length) kept.push({ ...e, hooks: rest });
    }
    if (kept.length) cfg.hooks[event] = kept;
    else delete cfg.hooks[event];
  }
  return gone;
}

function mergeClaudeSettings(file, entries, retire = []) {
  let cfg = {};
  if (fs.existsSync(file)) {
    try {
      cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new Error(`cannot parse ${file}; leaving it untouched`);
    }
  }
  const added = [...retireHooks(cfg, retire), ...mergeHooksIntoCfg(cfg, entries)];
  if (added.length) {
    backup(file);
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  }
  return added;
}

// Muse Code's settings.json also carries MCP servers. Muse reads
// `mcpServers` ("type": "stdio") or the legacy `mcp_servers`
// ("transport": "stdio"), and ignores every server when both maps are
// present, so that state fails closed. `mode: "optional"` matters:
// Muse's default "required" aborts the whole run when a server
// cannot start. schema_version: 1 is added only when missing; Muse
// refuses to start without it.
const MUSE_HOOK_ENTRIES = [
  ...HOOK_ENTRIES.map(([e, s]) => [
    e[0].toUpperCase() + e.slice(1),
    e === 'sessionStart' ? 'context --hook' : s,
  ]),
  // Muse fires PostToolUseFailure instead of PostToolUse when a tool
  // fails, so recall rides that event alone. No matcher: Muse's tool
  // names are lowercase (bash, read_file...).
  ['PostToolUseFailure', 'recall --hook'],
  ['Stop', 'reflect'],
];

function mergeMuseSettings(file) {
  let cfg = {};
  if (fs.existsSync(file)) {
    try {
      cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new Error(`cannot parse ${file}; leaving it untouched`);
    }
  }
  if (cfg.mcpServers && cfg.mcp_servers)
    return {
      hooks: [],
      mcp: 'skipped (settings.json has both mcpServers and mcp_servers; Muse ignores every MCP server in that state - delete one map and re-run)',
    };
  let changed = false;
  if (cfg.schema_version === undefined) {
    cfg.schema_version = 1;
    changed = true;
  }
  const added = [
    ...retireHooks(cfg, [['PostToolUse', 'recall']]),
    ...mergeHooksIntoCfg(cfg, MUSE_HOOK_ENTRIES),
  ];
  if (added.length) changed = true;
  const legacy = !!cfg.mcp_servers;
  const key = legacy ? 'mcp_servers' : 'mcpServers';
  cfg[key] ||= {};
  let mcp = false;
  if (!cfg[key]['agent-memory']) {
    cfg[key]['agent-memory'] = legacy
      ? { transport: 'stdio', command: 'node', args: [CLI_ENTRY, 'serve'], mode: 'optional' }
      : { type: 'stdio', command: 'node', args: [CLI_ENTRY, 'serve'], mode: 'optional' };
    mcp = true;
    changed = true;
  }
  if (changed) {
    backup(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  }
  return { hooks: added, mcp };
}

function unmergeHooksFromCfg(cfg) {
  if (!cfg.hooks) return false;
  let changed = false;
  for (const [ev, list] of Object.entries(cfg.hooks)) {
    const kept = list
      .map((e) => ({
        ...e,
        hooks: (e?.hooks || []).filter((h) => !isAmrCmd(h?.command)),
      }))
      .filter((e) => (e.hooks || []).length || !Array.isArray(e?.hooks));
    if (JSON.stringify(kept) !== JSON.stringify(list)) changed = true;
    if (kept.length) cfg.hooks[ev] = kept;
    else delete cfg.hooks[ev];
  }
  if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
  return changed;
}

function unmergeMuseSettings(file) {
  if (!fs.existsSync(file)) return false;
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  let changed = unmergeHooksFromCfg(cfg);
  for (const key of ['mcpServers', 'mcp_servers']) {
    if (cfg[key]?.['agent-memory']) {
      delete cfg[key]['agent-memory'];
      if (!Object.keys(cfg[key]).length) delete cfg[key];
      changed = true;
    }
  }
  if (changed) {
    backup(file);
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  }
  return changed;
}

// Devin CLI user config carries hooks and MCP servers together.
// Hook shape matches Claude Code (SessionStart stdout injects context;
// PostToolUse recall acts only when the payload shows a failure and is
// silent otherwise, so no matcher — Devin's shell tool is `exec`). No
// PostToolUseFailure: Devin's documented events end at PostToolUse.
const DEVIN_HOOK_ENTRIES = [
  ...HOOK_ENTRIES.map(([e, s]) => [
    e[0].toUpperCase() + e.slice(1),
    e === 'sessionStart' ? 'context --hook' : s,
  ]),
  ['PostToolUse', 'recall --hook'],
  ['Stop', 'reflect'],
];

function mergeDevinSettings(file) {
  let cfg = {};
  if (fs.existsSync(file)) {
    try {
      cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new Error(`cannot parse ${file}; leaving it untouched`);
    }
  }
  const added = mergeHooksIntoCfg(cfg, DEVIN_HOOK_ENTRIES);
  let changed = added.length > 0;
  cfg.mcpServers ||= {};
  let mcp = false;
  if (!cfg.mcpServers['agent-memory']) {
    cfg.mcpServers['agent-memory'] = {
      command: 'node',
      args: [CLI_ENTRY, 'serve'],
    };
    mcp = true;
    changed = true;
  }
  if (changed) {
    backup(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  }
  return { hooks: added, mcp };
}

function unmergeDevinSettings(file) {
  if (!fs.existsSync(file)) return false;
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  let changed = unmergeHooksFromCfg(cfg);
  if (cfg.mcpServers?.['agent-memory']) {
    delete cfg.mcpServers['agent-memory'];
    if (!Object.keys(cfg.mcpServers).length) delete cfg.mcpServers;
    changed = true;
  }
  if (changed) {
    backup(file);
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  }
  return changed;
}

function stampBlock(file, content, { append }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, content + '\n');
    return 'created';
  }
  const text = fs.readFileSync(file, 'utf8');
  const re = blockRe(MARK_BEGIN, MARK_END);
  const legacyRe = blockRe(LEGACY_MARK_BEGIN, LEGACY_MARK_END);
  if (!text.includes(MARK_BEGIN) && legacyRe.test(text)) {
    const markedPart = (content.match(re) || [content])[0];
    backup(file);
    fs.writeFileSync(file, text.replace(legacyRe, () => markedPart));
    return 'migrated';
  }
  if (text.includes(MARK_BEGIN)) {
    const markedPart = (content.match(re) || [content])[0];
    const next = text.replace(re, markedPart);
    if (next !== text) {
      backup(file);
      fs.writeFileSync(file, next);
      return 'updated';
    }
    return 'unchanged';
  }
  if (!append) {
    if (text.trim() === content.trim()) return 'unchanged';
    backup(file);
    fs.writeFileSync(file, content + '\n');
    return 'replaced';
  }
  backup(file);
  const joiner = text.endsWith('\n') ? '\n' : '\n\n';
  fs.writeFileSync(file, text + joiner + content + '\n');
  return 'appended';
}

export function cmdInstall(flags) {
  const requested = flags.host
    ? String(flags.host).split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  // Validate every requested name before touching any host, so a typo in
  // `--host codex,bogus` fails the run instead of being silently dropped.
  if (requested) {
    const bad = requested.filter((r) => r !== 'all' && !Object.keys(HOSTS).includes(r));
    if (bad.length) {
      process.stderr.write(
        `unknown host(s): ${bad.join(', ')} (known: ${Object.keys(HOSTS).join(', ')})\n`
      );
      process.exitCode = 1;
      return;
    }
  }
  const names = Object.keys(HOSTS).filter(
    (n) =>
      requested
        ? requested.includes('all') || requested.includes(n)
        : HOSTS[n].detect()
  );
  if (!names.length) {
    out('no known agent hosts detected; use --host <name> to force');
    return;
  }
  const failed = [];
  for (const name of names) {
    const h = HOSTS[name];
    const did = [];
    try {
      if (h.hooksJson) {
        const file = h.hooksJson();
        const added = mergeHooksJson(file, HOOK_ENTRIES);
        did.push(
          added.length
            ? `hooks +${added.join(',')} in ${file}`
            : `hooks already wired in ${file}`
        );
      }
      if (h.settingsJson) {
        const file = h.settingsJson();
        const added = mergeClaudeSettings(file, [
          ...HOOK_ENTRIES.map(([e, s]) => [
            e[0].toUpperCase() + e.slice(1),
            // SessionStart reads its payload (--hook) so a compaction
            // re-injection can be suppressed or delta-only.
            e === 'sessionStart' ? 'context --hook' : s,
          ]),
          // Failure-triggered recall: surface possibly relevant memory
          // when a shell tool fails. PostToolUseFailure, not PostToolUse:
          // Claude Code fires it only on real failures, so successful
          // output (grep hits, source files, CI logs) never reaches recall.
          ['PostToolUseFailure', 'recall --hook', 'Bash'],
          // Stop supports block-and-continue: `amr reflect` asks the
          // session to save durable learnings the user never stated.
          ['Stop', 'reflect'],
        ], [['PostToolUse', 'recall']]);
        did.push(
          added.length
            ? `hooks +${added.join(',')} in ${file}`
            : `hooks already wired in ${file}`
        );
      }
      if (h.rules) {
        for (const r of h.rules()) {
          const res = stampBlock(r.path, r.content, { append: r.append });
          did.push(`rules ${res}: ${r.path}`);
          for (const old of r.legacyPaths || []) {
            const gone = unstampRules(old);
            if (gone !== 'absent') did.push(`legacy rules ${gone}: ${old}`);
          }
        }
      }
      if (h.mcpJson) {
        const file = h.mcpJson();
        const res = mergeMcpJson(file, h.mcpEntry);
        did.push(
          res === true
            ? `mcp +agent-memory in ${file}`
            : res === false
            ? `mcp already wired in ${file}`
            : `mcp ${res}: ${file}`
        );
      }
      if (h.mcpToml) {
        const file = h.mcpToml();
        did.push(
          mergeMcpToml(file)
            ? `mcp +agent-memory in ${file}`
            : `mcp already wired in ${file}`
        );
      }
      if (h.mcpOpencode) {
        const file = h.mcpOpencode();
        const res = mergeMcpOpencode(file);
        did.push(
          res === true
            ? `mcp +agent-memory in ${file}`
            : res === false
            ? `mcp already wired in ${file}`
            : `mcp ${res}: ${file}`
        );
      }
      if (h.mcpZed) {
        const file = h.mcpZed();
        const res = mergeMcpZed(file);
        did.push(
          res === true
            ? `mcp +agent-memory in ${file}`
            : res === false
            ? `mcp already wired in ${file}`
            : `mcp ${res}: ${file}`
        );
      }
      if (h.museSettings) {
        const file = h.museSettings();
        const res = mergeMuseSettings(file);
        did.push(
          res.hooks.length
            ? `hooks +${res.hooks.join(',')} in ${file}`
            : `hooks already wired in ${file}`
        );
        did.push(
          res.mcp === true
            ? `mcp +agent-memory in ${file}`
            : res.mcp === false
            ? `mcp already wired in ${file}`
            : `mcp ${res.mcp}: ${file}`
        );
      }
      if (h.devinConfig) {
        const file = h.devinConfig();
        const res = mergeDevinSettings(file);
        did.push(
          res.hooks.length
            ? `hooks +${res.hooks.join(',')} in ${file}`
            : `hooks already wired in ${file}`
        );
        did.push(
          res.mcp === true
            ? `mcp +agent-memory in ${file}`
            : res.mcp === false
            ? `mcp already wired in ${file}`
            : `mcp ${res.mcp}: ${file}`
        );
      }
      if (h.configYaml) {
        const file = h.configYaml();
        const m = mergeMcpYaml(file);
        did.push(
          m === true
            ? `mcp +agent-memory in ${file}`
            : m === false
            ? `mcp already wired in ${file}`
            : `mcp ${m}: ${file}`
        );
        const hk = mergeHermesHooks(file);
        did.push(
          hk === true
            ? `hooks +pre_llm_call,post_compaction in ${file}`
            : hk === false
            ? `hooks already wired in ${file}`
            : `hooks ${hk}: ${file}`
        );
      }
    } catch (e) {
      err(`${name}: ${e.message}`);
      failed.push(name);
      continue;
    }
    for (const d of did) out(`${name}: ${d}`);
    // A config left untouched because it could not be merged means the
    // host is not (fully) wired; automation must see that as a failure.
    if (did.some((d) => d.includes('skipped ('))) failed.push(name);
  }
  out('');
  if (failed.length) {
    err(`install incomplete for: ${failed.join(', ')}`);
    process.exitCode = 1;
  }
  out('verify with: amr doctor');
}

// ---------- uninstall ----------

const isAmrCmd = (c) => typeof c === 'string' && c.includes('amr.mjs');

function unmergeHooksJson(file) {
  if (!fs.existsSync(file)) return false;
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  if (!cfg.hooks) return false;
  let changed = false;
  for (const [ev, list] of Object.entries(cfg.hooks)) {
    const kept = list.filter((e) => !isAmrCmd(e?.command));
    if (kept.length !== list.length) changed = true;
    if (kept.length) cfg.hooks[ev] = kept;
    else delete cfg.hooks[ev];
  }
  if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
  if (changed) {
    backup(file);
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  }
  return changed;
}

function unmergeClaudeSettings(file) {
  if (!fs.existsSync(file)) return false;
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  const changed = unmergeHooksFromCfg(cfg);
  if (changed) {
    backup(file);
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  }
  return changed;
}

function unmergeMcpJson(file) {
  return unmergeJsoncEntry(file, 'mcpServers', 'agent-memory');
}

function unmergeMcpToml(file) {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  const next = text.replace(
    /\n*\[mcp_servers\.agent-memory\]\n(?:[^[]*)?/,
    '\n'
  );
  if (next === text) return false;
  backup(file);
  fs.writeFileSync(file, next);
  return true;
}

function unmergeMcpOpencode(file) {
  return unmergeJsoncEntry(file, 'mcp', 'agent-memory');
}

function unmergeMcpZed(file) {
  return unmergeJsoncEntry(file, 'context_servers', 'agent-memory');
}

function unstampRules(file) {
  if (!fs.existsSync(file)) return 'absent';
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(MARK_BEGIN) && !text.includes(LEGACY_MARK_BEGIN)) return 'absent';
  let next = text;
  for (const [b, e] of [
    [MARK_BEGIN, MARK_END],
    [LEGACY_MARK_BEGIN, LEGACY_MARK_END],
  ])
    next = next.replace(new RegExp(`\\n*${b}[\\s\\S]*?${e}\\n?`, 'm'), '\n');
  next = next.replace(/\n{3,}/g, '\n\n');
  // If only whitespace or a lone yaml frontmatter husk remains (e.g.
  // a wrapper file we created), the file was entirely ours — delete it.
  if (!next.replace(/^---\s*\n[\s\S]*?\n---/, '').trim()) {
    fs.rmSync(file);
    return 'removed (file deleted)';
  }
  backup(file);
  fs.writeFileSync(file, next);
  return 'removed';
}

export function cmdUninstall(flags) {
  const requested = flags.host
    ? String(flags.host).split(',').map((s) => s.trim())
    : null;
  const names = Object.keys(HOSTS).filter((n) =>
    requested ? requested.includes('all') || requested.includes(n) : HOSTS[n].detect()
  );
  if (!names.length) {
    out('no known agent hosts detected; nothing to remove');
    return;
  }
  for (const name of names) {
    const h = HOSTS[name];
    const did = [];
    try {
      if (h.hooksJson && unmergeHooksJson(h.hooksJson()))
        did.push(`hooks removed from ${h.hooksJson()}`);
      if (h.settingsJson && unmergeClaudeSettings(h.settingsJson()))
        did.push(`hooks removed from ${h.settingsJson()}`);
      if (h.rules) {
        for (const r of h.rules()) {
          const sharedWith = Object.entries(HOSTS).find(
            ([otherName, other]) =>
              !names.includes(otherName) &&
              other.detect() &&
              other.rules?.().some(
                (otherRule) => path.resolve(otherRule.path) === path.resolve(r.path)
              )
          )?.[0];
          if (sharedWith) {
            did.push(`rules retained (also used by ${sharedWith}): ${r.path}`);
            continue;
          }
          for (const p of [r.path, ...(r.legacyPaths || [])]) {
            const res = unstampRules(p);
            if (res !== 'absent') did.push(`rules ${res}: ${p}`);
          }
        }
      }
      if (h.mcpJson && unmergeMcpJson(h.mcpJson()))
        did.push(`mcp entry removed from ${h.mcpJson()}`);
      if (h.mcpToml && unmergeMcpToml(h.mcpToml()))
        did.push(`mcp entry removed from ${h.mcpToml()}`);
      if (h.mcpOpencode && unmergeMcpOpencode(h.mcpOpencode()))
        did.push(`mcp entry removed from ${h.mcpOpencode()}`);
      if (h.mcpZed && unmergeMcpZed(h.mcpZed()))
        did.push(`mcp entry removed from ${h.mcpZed()}`);
      if (h.museSettings && unmergeMuseSettings(h.museSettings()))
        did.push(`hooks+mcp removed from ${h.museSettings()}`);
      if (h.devinConfig && unmergeDevinSettings(h.devinConfig()))
        did.push(`hooks+mcp removed from ${h.devinConfig()}`);
      if (h.configYaml) {
        if (unmergeMcpYaml(h.configYaml()))
          did.push(`mcp entry removed from ${h.configYaml()}`);
        if (unmergeHermesHooks(h.configYaml()))
          did.push(`hooks removed from ${h.configYaml()}`);
      }
    } catch (e) {
      err(`${name}: ${e.message}`);
      continue;
    }
    out(`${name}: ${did.length ? did.join('; ') : 'nothing wired'}`);
  }
}

function hostWired(name) {
  const h = HOSTS[name];
  if (!h.detect()) return 'not installed';
  const has = (file, needle) =>
    fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(needle);
  try {
    if (h.hooksJson && has(h.hooksJson(), 'amr')) return 'wired';
    if (h.settingsJson && has(h.settingsJson(), 'amr')) return 'wired';
    if (h.museSettings && has(h.museSettings(), 'amr')) return 'wired';
    if (h.devinConfig && has(h.devinConfig(), 'amr')) return 'wired';
    const mcp =
      (h.mcpJson && has(h.mcpJson(), 'agent-memory')) ||
      (h.mcpToml && has(h.mcpToml(), 'agent-memory')) ||
      (h.mcpOpencode && has(h.mcpOpencode(), 'agent-memory')) ||
      (h.configYaml && has(h.configYaml(), 'agent-memory')) ||
      (h.museSettings && has(h.museSettings(), 'agent-memory')) ||
      (h.devinConfig && has(h.devinConfig(), 'agent-memory')) ||
      (h.mcpZed && has(h.mcpZed(), 'agent-memory'));
    if (h.rules && h.rules().some((r) => has(r.path, MARK_BEGIN) || has(r.path, LEGACY_MARK_BEGIN)))
      return mcp ? 'wired (rules+mcp)' : 'wired (rules only)';
    if (mcp) return 'wired (mcp only)';
  } catch {}
  return 'not wired';
}

export function cmdDoctor() {
  const homeDir = resolveHome();
  const okRepo = fs.existsSync(homeDir) && isMemoryRepo(homeDir);
  out(`memory repo : ${okRepo ? homeDir : 'MISSING (run: amr ensure)'}`);
  if (okRepo) {
    const dirty = git(homeDir, ['status', '--porcelain']);
    out(`worktree    : ${dirty.stdout ? 'DIRTY — uncommitted changes present' : 'clean'}`);
    out(`remote      : ${hasRemote(homeDir) ? git(homeDir, ['remote', 'get-url', 'origin']).stdout : 'none (local only)'}`);
    // amr.json keys that resolve to no project file are dead config —
    // usually a mistyped repo name from link/policy.
    const cfg = loadConfig(homeDir);
    const dead = [];
    for (const [k, e] of Object.entries(cfg.projects || {})) {
      if (!resolveProjectSlug(homeDir, k)) dead.push(k);
      for (const l of e.links || [])
        if (!resolveProjectSlug(homeDir, l)) dead.push(`${k} -> ${l}`);
    }
    if (dead.length)
      out(`config      : ${dead.length} unresolvable project key(s): ${dead.join(', ')}`);
    try {
      const cov = fs
        .readFileSync(path.join(homeDir, 'dreams', 'coverage.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const last = cov[cov.length - 1];
      if (last?.rate != null)
        out(
          `save rate   : ${last.rate}% (${last.covered}/${last.durable} durable signals, ${last.days}d, ${last.ts.slice(0, 10)})`
        );
    } catch {}
    const missingPeers = (cfg.extraRepos || []).filter(
      (p) =>
        !fs.existsSync(
          path.join(path.dirname(homeDir), `${path.basename(homeDir)}-peers`, p.name)
        )
    );
    if (missingPeers.length)
      out(`peers       : ${missingPeers.map((p) => p.name).join(', ')} configured but not cloned`);
  }
  const onPath =
    sh('where', ['amr']).code === 0 || sh('which', ['amr']).code === 0;
  out(`amr on PATH : ${onPath ? 'yes' : `no — hooks still work via: node "${CLI_ENTRY}"`}`);
  for (const name of Object.keys(HOSTS)) out(`${name.padEnd(11)}: ${hostWired(name)}`);
}
