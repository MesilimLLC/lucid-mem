import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveHome,
  ensureRepo,
  projectFor,
  loadConfig,
  resolveProjectSlug,
  numFlag,
  git,
} from './core.mjs';
import { collectSessions, extractMessages } from './harvest.mjs';

const out = (s = '') => process.stdout.write(s + '\n');

// Dirs that never carry their own memory identity.
const NOISE = new Set([
  'worktrees', 'worktree', '_worktrees', 'archive', 'archived', 'models',
  'node_modules', 'null', 'flutter', 'docs', 'doc', 'logs', 'log', 'temp',
  'tmp', 'build', 'dist', 'out', 'bin', 'obj', 'src', 'test', 'tests',
  'scripts', 'client', 'server', 'functions', 'cache', '.cache', 'assets',
]);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// basename mention bounded so `more-or-less` doesn't count `more-or-less-admin`
const nameRe = (name) =>
  new RegExp(`(?<![\\w.-])${esc(name)}(?![\\w.-])`, 'i');

const DEFAULT_ROOTS = () => {
  const home = os.homedir();
  return [
    'D:\\Dev',
    'D:\\Dev\\Trackdub_Workspace',
    'B:\\Dev',
    'C:\\Dev',
    path.join(home, 'Dev'),
    path.join(home, 'dev'),
    path.join(home, 'repos'),
    path.join(home, 'projects'),
    path.join(home, 'code'),
    path.join(home, 'src'),
  ].filter((d) => fs.existsSync(d));
};

const isGitRepo = (dir) => fs.existsSync(path.join(dir, '.git'));

// Immediate child dirs of each root; one extra level for container dirs
// (e.g. *_Workspace / *worktrees) so sibling repos are found too.
function* repoDirs(roots, cap = 400) {
  const seen = new Set();
  let n = 0;
  for (const root of roots) {
    let kids;
    try {
      kids = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const k of kids) {
      if (n >= cap) return;
      if (!k.isDirectory() || k.name.startsWith('.')) continue;
      const dir = path.join(root, k.name);
      if (isGitRepo(dir)) {
        if (!seen.has(dir)) {
          seen.add(dir);
          n++;
          yield dir;
        }
      } else {
        let grands;
        try {
          grands = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const g of grands) {
          if (n >= cap) return;
          if (!g.isDirectory() || g.name.startsWith('.')) continue;
          const gdir = path.join(dir, g.name);
          if (isGitRepo(gdir) && !seen.has(gdir)) {
            seen.add(gdir);
            n++;
            yield gdir;
          }
        }
      }
    }
  }
}

const orgOf = (remote) => {
  const m =
    String(remote || '').match(/[:/]([^/:]+)\/[^/]+?(\.git)?\s*$/) || [];
  return (m[1] || '').toLowerCase() || null;
};

export function cmdDiscover(flags) {
  const home = ensureRepo(resolveHome());
  const cfg = loadConfig(home);
  const days = numFlag(flags.days ?? '90', 90);
  const maxMsgs = numFlag(flags.max || '400', 400);
  const minHits = numFlag(flags.min || '1', 1);
  const roots = cfg.scanRoots?.length ? cfg.scanRoots : DEFAULT_ROOTS();

  const since = Date.now() - days * 864e5;
  const sessions = collectSessions(since);
  const msgs = extractMessages(sessions, { max: maxMsgs });

  // Candidate repos: dedup by remote identity (worktrees/clones/dir-name
  // variants of the same remote collapse into one memory identity).
  const bySlug = new Map();
  const seenRemote = new Set();
  for (const dir of repoDirs(roots)) {
    const proj = projectFor(dir);
    if (!proj) continue;
    const remote = git(proj.toplevel, ['remote', 'get-url', 'origin']);
    const rurl = remote.code === 0 ? remote.stdout.trim() : '';
    const ident = (rurl || proj.toplevel).toLowerCase();
    if (seenRemote.has(ident) || bySlug.has(proj.slug)) continue;
    const base = path.basename(proj.toplevel);
    if (base.length < 3 || NOISE.has(base.toLowerCase())) continue;
    seenRemote.add(ident);
    bySlug.set(proj.slug, {
      slug: proj.slug,
      dir: proj.toplevel,
      base,
      remote: rurl,
      hits: 0,
    });
  }

  const corpus = msgs.map((m) => m.text);
  const projDir = path.join(home, 'projects');
  const seeded = new Set(
    fs.existsSync(projDir)
      ? fs
          .readdirSync(projDir, { withFileTypes: true })
          .filter((e) => e.isFile() && e.name.endsWith('.md'))
          .map((e) => e.name.slice(0, -3))
      : []
  );

  // Mention counts per candidate.
  for (const r of bySlug.values()) {
    const re = nameRe(r.base);
    for (const t of corpus) if (re.test(t)) r.hits++;
  }
  const hot = [...bySlug.values()]
    .filter((r) => r.hits >= minHits)
    .sort((a, b) => b.hits - a.hits || a.slug.localeCompare(b.slug));

  // Co-occurrence: repos named in the same transcript file.
  const byFile = new Map();
  for (const m of msgs) {
    if (!byFile.has(m.file)) byFile.set(m.file, m.text);
    else byFile.set(m.file, byFile.get(m.file) + ' ' + m.text);
  }
  // Co-occurrence: repos named in the same transcript file. Files that
  // mention >5 repos are listing dumps (pasted `ls` output etc.), not
  // real workflow co-occurrence — they would pair everything with
  // everything, so skip them.
  const pairs = new Map();
  const cand = [...bySlug.values()].filter((r) => r.hits > 0);
  for (const text of byFile.values()) {
    const present = cand.filter((r) => nameRe(r.base).test(text));
    if (present.length > 5) continue;
    for (let i = 0; i < present.length; i++)
      for (let j = i + 1; j < present.length; j++) {
        const [a, b] = [present[i], present[j]].sort((x, y) =>
          x.slug.localeCompare(y.slug)
        );
        const k = `${a.slug}|${b.slug}`;
        pairs.set(k, (pairs.get(k) || 0) + 1);
      }
  }

  // Org lookup for annotating pairs (org alone is too weak to suggest).
  const orgBySlug = new Map();
  for (const r of cand) orgBySlug.set(r.slug, orgOf(r.remote));

  // Existing links so we don't re-suggest them.
  const projCfg = cfg.projects || {};
  const linkedPairs = new Set();
  for (const [key, e] of Object.entries(projCfg)) {
    const a = resolveProjectSlug(home, key) || key;
    for (const l of e.links || []) {
      const b = resolveProjectSlug(home, l) || l;
      linkedPairs.add([a, b].sort().join('|'));
    }
  }

  // Suggestions come only from real co-mention evidence; same-org is an
  // annotation strengthening a pair, never a standalone suggestion.
  const suggestions = [];
  for (const [k, n] of pairs) {
    if (linkedPairs.has(k) || n < 2) continue;
    const [a, b] = k.split('|');
    const oa = orgBySlug.get(a);
    const ob = orgBySlug.get(b);
    const why =
      oa && oa === ob ? `co-mentioned ${n}x; same org ${oa}` : `co-mentioned ${n}x`;
    suggestions.push({ k, n, why });
  }
  suggestions.sort((x, y) => y.n - x.n);

  const report = {
    windowDays: days,
    transcripts: sessions.length,
    messages: msgs.length,
    scanRoots: roots,
    hot: hot.map((r) => ({
      ...r,
      memory: seeded.has(r.slug) ? 'seeded' : 'missing',
    })),
    linkSuggestions: suggestions.map((s) => {
      const [a, b] = s.k.split('|');
      return { a, b, coMentions: s.n, why: s.why };
    }),
  };

  if (flags.json) return out(JSON.stringify(report, null, 2));

  out(
    `== transcript-hot repos (${days}d window, ${msgs.length} messages from ${sessions.length} transcripts) ==`
  );
  if (!hot.length) out('  (no repo mentions found)');
  for (const r of report.hot) {
    const tag = r.memory === 'seeded' ? 'seeded ' : 'MISSING';
    const hint =
      r.memory === 'seeded'
        ? ''
        : '   <- cd here; lucid add "<identity>" --project';
    out(
      `  ${String(r.hits).padStart(4)}  ${r.base.padEnd(24)} ${tag}  ${r.remote}${hint}`
    );
  }
  out('');
  out('== suggested links ==');
  if (!report.linkSuggestions.length) out('  (none — all pairs already linked or unrelated)');
  for (const s of report.linkSuggestions)
    out(`  ${s.a} <-> ${s.b}   (${s.why})`);
  out('');
  out(
    'seed:   cd <repo> && lucid add "<one-line identity>" --project   (run inside the repo so the slug matches)'
  );
  out('link:   cd <repo> && lucid link <sibling> [more...]');
}
