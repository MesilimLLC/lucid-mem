import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const resolveHome = () =>
  path.resolve(process.env.AMR_HOME || path.join(os.homedir(), 'agent-memory'));

export function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts.timeout ?? 15000,
    cwd: opts.cwd,
    shell: false,
  });
  return {
    code: r.status ?? -1,
    stdout: (r.stdout || '').trimEnd(),
    stderr: (r.stderr || '').trimEnd(),
    error: r.error,
  };
}

export const git = (repo, args, opts) => sh('git', ['-C', repo, ...args], opts);

// Canonicalize before comparing: git reports the long form of paths
// while env vars may carry 8.3 aliases (RUNNER~1) or symlinks.
const canon = (p) => {
  const r = path.resolve(p);
  // .native expands 8.3 aliases and symlinks; plain realpathSync keeps
  // 8.3 names as-is on Windows (verified).
  try {
    return fs.realpathSync.native(r);
  } catch {
    return r;
  }
};
const samePath = (a, b) => canon(a).toLowerCase() === canon(b).toLowerCase();

export function isMemoryRepo(dir) {
  if (!fs.existsSync(path.join(dir, 'MEMORY.md'))) return false;
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  return top.code === 0 && samePath(top.stdout, dir);
}

export function ensureIdentity(repo) {
  const name = git(repo, ['config', 'user.name']);
  if (name.code !== 0 || !name.stdout.trim())
    git(repo, ['config', 'user.name', 'Agent Memory']);
  const email = git(repo, ['config', 'user.email']);
  if (email.code !== 0 || !email.stdout.trim())
    git(repo, ['config', 'user.email', 'agent-memory@localhost']);
}

export function ensureRepo() {
  const home = resolveHome();
  const empty =
    !fs.existsSync(home) || fs.readdirSync(home).length === 0;
  if (empty) {
    fs.mkdirSync(home, { recursive: true });
    sh('git', ['init'], { cwd: home });
    fs.writeFileSync(path.join(home, 'MEMORY.md'), '# Memory\n\n## Index\n');
    ensureIdentity(home);
    git(home, ['add', 'MEMORY.md']);
    git(home, ['commit', '-m', 'Create memory repo']);
    return home;
  }
  if (!isMemoryRepo(home))
    throw new Error(
      `${home} exists but is not an agent memory repo (needs its own git repo with MEMORY.md at top)`
    );
  return home;
}

export function projectFor(dir) {
  const top = sh('git', ['rev-parse', '--show-toplevel'], { cwd: dir });
  if (top.code !== 0) return null;
  const toplevel = top.stdout.trim();
  const remote = sh('git', ['remote', 'get-url', 'origin'], { cwd: toplevel });
  const basis =
    remote.code === 0 && remote.stdout.trim() ? remote.stdout.trim() : toplevel;
  // The name comes from the remote when there is one, so every clone and
  // worktree of a repo shares one slug; the checkout dir name (which
  // varies per worktree) only names remote-less repos.
  const rawName =
    (remote.code === 0 &&
      remote.stdout
        .trim()
        .replace(/[\\/]+$/, '')
        .replace(/\.git$/i, '')
        .split(/[\\/]/)
        .pop()
        .split(':')
        .pop()) ||
    path.basename(toplevel);
  const name =
    rawName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'repo';
  const hash = crypto
    .createHash('sha1')
    .update(basis.toLowerCase())
    .digest('hex')
    .slice(0, 6);
  return { slug: `${name}-${hash}`, name: rawName, toplevel };
}

export function sanitizeFile(input) {
  let p = String(input).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!p.toLowerCase().endsWith('.md')) p += '.md';
  const norm = path.posix.normalize(p);
  if (norm.startsWith('..') || path.posix.isAbsolute(norm))
    throw new Error(`bad memory file path: ${input}`);
  return norm;
}

export const today = () => new Date().toISOString().slice(0, 10);

// Numeric flag with fallback — bad input gets the default, never NaN.
export const numFlag = (v, dflt) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
};

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /AIza[0-9A-Za-z_-]{35}/,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/,
];
export const looksSecret = (text) =>
  SECRET_PATTERNS.some((re) => re.test(text));

const bulletText = (line) =>
  line
    .trim()
    .replace(/^-\s*/, '')
    .replace(/(\s*\[[^\]]*\])+\s*$/, '')
    .trim()
    .toLowerCase();

export function entryExists(filePath, text) {
  if (!fs.existsSync(filePath)) return false;
  const target = bulletText(text);
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith('- '))
    .some((l) => bulletText(l) === target);
}

export function insertEntry(filePath, entry, { beforeIndex = false } = {}) {
  let lines = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf8').split(/\r?\n/)
    : [];
  if (!lines.length || !lines[0].startsWith('#'))
    lines.unshift(`# ${path.basename(filePath, '.md')}`, '');
  const idx = lines.findIndex((l) => /^##\s+Index/.test(l));
  if (beforeIndex && idx >= 0) {
    const head = lines.slice(0, idx);
    while (head.length && head[head.length - 1].trim() === '') head.pop();
    head.push(entry, '');
    lines = [...head, ...lines.slice(idx)];
  } else {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push(entry, '');
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join('\n').replace(/\n{3,}/g, '\n\n'));
}

export function addIndexLink(repo, relNoExt) {
  const mem = path.join(repo, 'MEMORY.md');
  if (!fs.existsSync(mem)) return false;
  const link = `- [[${relNoExt}]]`;
  const lines = fs.readFileSync(mem, 'utf8').split(/\r?\n/);
  if (lines.some((l) => l.trim() === link)) return false;
  let idx = lines.findIndex((l) => /^##\s+Index/.test(l));
  if (idx < 0) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push('', '## Index');
    idx = lines.length - 1;
  }
  let ins = idx + 1;
  while (ins < lines.length && lines[ins].trim() !== '') ins++;
  lines.splice(ins, 0, link);
  fs.writeFileSync(mem, lines.join('\n').replace(/\n{3,}/g, '\n\n'));
  return true;
}

export function withLock(repo, fn, { retries = 15, retryMs = 200 } = {}) {
  const lock = path.join(repo, '.git', 'amr.lock');
  const wait = (ms) => {
    const buf = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(buf), 0, 0, ms);
  };
  let acquired = false;
  for (let i = 0; i < retries && !acquired; i++) {
    try {
      if (fs.existsSync(lock)) {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > 60000) fs.unlinkSync(lock);
      }
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      acquired = true;
    } catch {
      wait(retryMs);
    }
  }
  // Fail closed: running fn without the lock would let two writers
  // interleave writes and commits. Callers surface this as an error.
  if (!acquired)
    throw new Error(
      `could not acquire lock ${lock} after ${Math.round((retries * retryMs) / 1000)}s; another amr process may be writing — retry shortly`
    );
  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {}
  }
}

// A failed `git add` (typically index.lock held by another git process)
// used to be ignored, so the commit silently left that file out. Retry
// briefly, and report failure if any file still did not stage.
export function commit(repo, files, msg) {
  ensureIdentity(repo);
  const unstaged = [];
  for (const f of files) {
    let r = git(repo, ['add', '--', f]);
    for (let i = 0; i < 5 && r.code !== 0; i++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      r = git(repo, ['add', '--', f]);
    }
    if (r.code !== 0) {
      const why = (r.stderr || r.error?.message || '').trim().split('\n')[0];
      unstaged.push(why ? `${f} (${why})` : f);
    }
  }
  const r = git(repo, ['commit', '-m', msg]);
  if (unstaged.length)
    process.stderr.write(`amr: could not stage ${unstaged.join(', ')}; left uncommitted\n`);
  return r.code === 0 && !unstaged.length;
}

export function hasRemote(repo) {
  const r = git(repo, ['remote']);
  return r.code === 0 && r.stdout.trim().length > 0;
}

export function pullFfOnly(repo, timeout = 2000) {
  return git(repo, ['pull', '--ff-only'], { timeout });
}

const CONFIG_REL = 'amr.json';

export function loadConfig(repo) {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(repo, CONFIG_REL), 'utf8')
    );
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch {
    return {};
  }
}

export function saveConfig(repo, cfg) {
  fs.writeFileSync(
    path.join(repo, CONFIG_REL),
    JSON.stringify(cfg, null, 2) + '\n'
  );
}

// Project files are projects/<name>-<hash>.md. A config key may be the
// full slug or just the repo name (case-insensitive).
export function listProjects(repo) {
  const dir = path.join(repo, 'projects');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const slug = f.slice(0, -3);
      const dash = slug.lastIndexOf('-');
      return { slug, name: dash > 0 ? slug.slice(0, dash) : slug };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

// Config keys may be full slugs, slug-names, or raw repo basenames like
// "api.trackdub" — normalize the same way projectFor names slugs so all
// forms resolve.
export const normName = (s) =>
  String(s)
    .toLowerCase()
    .replace(/\.md$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export function resolveProjectSlug(repo, key) {
  const k = String(key).toLowerCase().replace(/\.md$/, '');
  const kn = normName(k);
  const all = listProjects(repo);
  const exact = all.find((p) => p.slug === k || p.slug === kn);
  if (exact) return exact.slug;
  const named = all.filter((p) => p.name === kn || p.name === k);
  return named[0]?.slug ?? null;
}

// Config entries may be keyed by slug or name (lowercase). Look up a
// project's policy/link entry by either form.
export function projectEntry(cfg, { slug, name }) {
  const projects = cfg.projects || {};
  for (const k of [slug, name && name.toLowerCase(), name && normName(name)]) {
    if (k && projects[k]) return projects[k];
  }
  return null;
}

// Entry kinds. `state` is session-scoped (what is open, what was just
// committed) and expires in STATE_TTL_DAYS; other kinds expire in
// DEFAULT_TTL_DAYS unless saved with --durable.
export const KINDS = ['pitfall', 'decision', 'preference', 'fact', 'howto', 'state'];
export const STATE_TTL_DAYS = 2;

export const addDays = (days, from = new Date()) =>
  new Date(from.getTime() + days * 864e5).toISOString().slice(0, 10);

// The trailing [meta] group is the only place kind, expires and id are read
// from: prose in an entry's text can say "expires:" without meaning it.
export const trailingMeta = (line) =>
  (String(line).match(/\[([^[\]]*)\]\s*$/) || [])[1] || '';

export const entryKind = (line) =>
  (trailingMeta(line).match(/kind:\s*([a-z-]+)/) || [])[1] || null;

// Session state goes stale within hours and crowds out durable knowledge.
const EPISODIC = [
  [/\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/i, 'commit SHA'],
  [/\b(?:PR|pull request)\s*#?\d+|#\d{2,}\b/i, 'PR/issue number'],
  [/\b(?:run|job)\s*(?:id\s*)?\d{8,}\b|\b\d{10,}\b/i, 'run ID'],
  [/\b(?:not pushed|just committed|currently open)\b/i, 'session state'],
];

export function episodicHits(text) {
  return EPISODIC.filter(([re]) => re.test(text)).map(([, label]) => label);
}

// An entry is expired when its expires: date is before `now` (YYYY-MM-DD).
export const isExpired = (line, now = today()) => {
  const d = (trailingMeta(line).match(/expires:\s*(\d{4}-\d{2}-\d{2})/) || [])[1];
  return !!d && d < now;
};

// Entries get a TTL by default: 30 days for durable-looking kinds,
// STATE_TTL_DAYS for session state. An entry without `expires:` is
// durable forever (legacy entries, `--durable`, `--ttl 0`).
export const DEFAULT_TTL_DAYS = 30;

// Hosting and deploy facts (what serves a site, which platform deploys it)
// go stale fastest: the platform gets swapped and nothing flags the old
// entry. They get a shorter default TTL (cfg.hostingTtlDays overrides).
// Pitfalls, how-tos and preferences are about method, not infrastructure,
// so they keep the normal TTL.
export const HOSTING_TTL_DAYS = 14;
const HOSTING_RE =
  /\b(?:deploy(?:s|ed|ment|ments|ing)?|hosted|hosting|served\s+(?:live\s+)?(?:from|on|by)|workers\.dev|pages\.dev|cloudflare|vercel|netlify|lovable|fly\.io|heroku|dns|nameservers?|cname|production\s+(?:url|site|host))\b/i;
export const looksHosting = (text) => HOSTING_RE.test(String(text));

// Default TTL in days for an entry's text and kind.
export function ttlDays(text, cfg = {}, kind = null) {
  if (kind === 'state') return STATE_TTL_DAYS;
  const base = numFlag(cfg.defaultTtlDays, DEFAULT_TTL_DAYS);
  if (kind === 'pitfall' || kind === 'howto' || kind === 'preference') return base;
  return looksHosting(text) ? Math.min(base, numFlag(cfg.hostingTtlDays, HOSTING_TTL_DAYS)) : base;
}

// `--verify "<cmd>"`: a command that re-checks the fact. It lives in the
// entry's meta, where ; and brackets are structural, so those are
// percent-escaped. It is only ever shown, never run: memory is data.
export const encodeVerify = (cmd) =>
  String(cmd).replace(/[%;[\]]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
export const decodeVerify = (s) =>
  String(s).replace(/%(25|3B|5B|5D)/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
export const entryVerify = (line) => {
  const m = trailingMeta(line).match(/verify:\s*([^;]*)/);
  return m ? decodeVerify(m[1].trim()) : null;
};

// How an entry is shown in a digest or recall: legacy bare-date meta gets
// its `added:` label, a `confirmed:` date appears when `amr used` is newer
// than the last write (so staleness is judgeable at a glance), and a
// verify command moves out of the meta into the body where it is read.
export function renderEntry(line, usedAtMs = null) {
  const m = String(line).match(/\[([^[\]]*)\]\s*$/);
  if (!m) return line;
  const body = line.slice(0, m.index).trimEnd();
  let fields = m[1].split(';').map((f) => f.trim()).filter(Boolean);
  fields = fields.map((f) => (/^\d{4}-\d{2}-\d{2}$/.test(f) ? `added: ${f}` : f));
  const verify = entryVerify(line);
  fields = fields.filter((f) => !/^verify:/.test(f));
  const dates = fields
    .map((f) => (f.match(/^(?:added|updated):\s*(\d{4}-\d{2}-\d{2})/) || [])[1])
    .filter(Boolean)
    .sort();
  if (usedAtMs) {
    const used = new Date(usedAtMs).toISOString().slice(0, 10);
    if (!dates.length || used > dates[dates.length - 1]) fields.push(`confirmed: ${used}`);
  }
  const tail = verify ? ` (verify: \`${verify}\`)` : '';
  return `${body}${tail} [${fields.join('; ')}]`;
}

// Tokenize entry/prose text for overlap scoring: lowercase words of
// 3+ chars, entry meta bracket stripped so `id:`/`kind:` never match.
export const entryTokens = (s) =>
  new Set(
    String(s)
      .toLowerCase()
      .replace(/\[[^\]]*\]\s*$/, '')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3)
  );
