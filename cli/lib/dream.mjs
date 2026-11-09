import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_TTL_DAYS,
  addDays,
  commit,
  ensureRepo,
  git,
  isExpired,
  loadConfig,
  numFlag,
  withLock,
} from './core.mjs';
import { backfillIds, entryId } from './ids.mjs';
import { cmdTriage } from './triage.mjs';
import { loadUsage } from './rank.mjs';
import {
  CONSOLIDATE_AT,
  allLiveEntries,
  consolidationProposals,
  liveEntryLines,
  mergeProposals,
} from './consolidate.mjs';
import { queueConsolidations } from './pending.mjs';

const out = (s = '') => process.stdout.write(s + '\n');
const err = (s) => process.stderr.write(s + '\n');

// Interactive-only moon-phase spinner (stderr, so stdout stays clean).
const FRAMES = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
let spinTimer = null;
let spinI = 0;
let spinT0 = 0;
const spinStart = (enabled) => {
  if (!enabled || spinTimer) return;
  spinT0 = Date.now();
  spinTimer = setInterval(() => {
    process.stderr.write(`\r${FRAMES[spinI++ % FRAMES.length]} dreaming…`);
  }, 120);
};
const spinStop = () => {
  if (!spinTimer) return;
  clearInterval(spinTimer);
  spinTimer = null;
  process.stderr.write('\r\x1b[K');
};
// Let the moon finish at least minMs of its cycle — interactive runs
// get to watch the dream; the timer keeps the process alive until it
// clears. Non-TTY runs never start the timer so this is a no-op there.
const spinDone = (minMs = 1500) => {
  if (!spinTimer) return;
  const wait = Math.max(0, minMs - (Date.now() - spinT0));
  setTimeout(spinStop, wait);
};

// Write via temp+rename so a kill mid-write can never leave a
// truncated memory file (Windows rename replaces the target).
function atomicWrite(abs, data) {
  const tmp = `${abs}.amr-tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, abs);
}

const bulletText = (line) =>
  line
    .trim()
    .replace(/^-\s*/, '')
    .replace(/(\s*\[[^\]]*\])+\s*$/, '')
    .trim()
    .toLowerCase();

const metaDate = (line) => {
  const dates = [...line.matchAll(/(?:added|updated):\s*(\d{4}-\d{2}-\d{2})/g)]
    .map((m) => m[1])
    .sort();
  return dates.length ? dates[dates.length - 1] : null;
};

function mdFiles(home) {
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md'))
        files.push(path.relative(home, p).replace(/\\/g, '/'));
    }
  })(home);
  return files.sort();
}

// Files whose entries `amr context` injects: MEMORY.md plus projects/*.md.
function injectableFiles(home) {
  const pdir = path.join(home, 'projects');
  return [
    'MEMORY.md',
    ...(fs.existsSync(pdir)
      ? fs
          .readdirSync(pdir, { withFileTypes: true })
          .filter((e) => e.isFile() && e.name.endsWith('.md'))
          .map((e) => `projects/${e.name}`)
      : []),
  ];
}

function collect(home) {
  const entries = [];
  const indexLinks = new Set();
  for (const rel of mdFiles(home)) {
    const lines = fs
      .readFileSync(path.join(home, rel), 'utf8')
      .split(/\r?\n/);
    let inIndex = false;
    lines.forEach((l, i) => {
      if (/^##\s+Index/.test(l)) inIndex = true;
      else if (/^#{1,2}\s/.test(l) && !/^##\s+Index/.test(l)) inIndex = false;
      const link = l.match(/^-\s*\[\[([^\]]+)\]\]/);
      if (link) {
        if (rel === 'MEMORY.md' && inIndex) indexLinks.add(link[1]);
        return;
      }
      if (!l.trim().startsWith('- ')) return;
      entries.push({
        file: rel,
        line: i,
        raw: l,
        norm: bulletText(l),
        date: metaDate(l),
        archived: rel.startsWith('archive/'),
      });
    });
  }
  return { entries, indexLinks };
}

export function analyze(home, { staleDays = 90, budget = 0 } = {}) {
  const { entries, indexLinks } = collect(home);
  const files = mdFiles(home).filter((f) => f !== 'MEMORY.md');
  const cutoff = new Date(Date.now() - staleDays * 864e5)
    .toISOString()
    .slice(0, 10);

  const byNorm = new Map();
  for (const e of entries)
    byNorm.set(e.norm, [...(byNorm.get(e.norm) || []), e]);
  const exactDups = [...byNorm.values()].filter((g) => g.length > 1);

  const possibleDups = [];
  const uniq = [...byNorm.keys()];
  for (let i = 0; i < uniq.length; i++)
    for (let j = i + 1; j < uniq.length; j++) {
      const [a, b] = [uniq[i], uniq[j]];
      if (a.length > 15 && b.length > 15 && (a.includes(b) || b.includes(a)))
        possibleDups.push([byNorm.get(a)[0], byNorm.get(b)[0]]);
    }

  const stale = entries.filter(
    (e) => !e.archived && e.date && e.date < cutoff
  );
  const expired = entries.filter((e) => !e.archived && isExpired(e.raw));
  const noDate = entries.filter((e) => !e.archived && !e.date).length;

  const filesNoExt = files.map((f) => f.replace(/\.md$/, ''));
  const liveNoExt = filesNoExt.filter((f) => !f.startsWith('archive/'));
  const deadLinks = [...indexLinks].filter(
    (l) => !filesNoExt.includes(l)
  );
  const unindexed = liveNoExt.filter((f) => ![...indexLinks].includes(f));

  const mem = path.join(home, 'MEMORY.md');
  const memLines = fs.existsSync(mem)
    ? fs.readFileSync(mem, 'utf8').split(/\r?\n/)
    : [];
  const memBytes = fs.existsSync(mem) ? fs.statSync(mem).size : 0;

  // Digest pressure per injectable file (globals + projects): share of
  // the context char budget its live entries would consume.
  const fills = [];
  if (budget > 0) {
    for (const rel of injectableFiles(home)) {
      const chars = liveEntryLines(home, rel).reduce((n, l) => n + l.length, 0);
      if (chars) fills.push({ file: rel, chars, pct: chars / budget });
    }
  }

  const dirty = git(home, ['status', '--porcelain']).stdout;

  return {
    repo: home,
    stats: {
      files: mdFiles(home).length,
      entries: entries.length,
      memoryMdBytes: memBytes,
      memoryMdLines: memLines.length,
      dirtyFiles: dirty ? dirty.split('\n').length : 0,
    },
    exactDups: exactDups.map((g) =>
      g.map((e) => `${e.file}:${e.line + 1}`)
    ),
    possibleDups: possibleDups.map(([a, b]) => [
      `${a.file}:${a.line + 1}`,
      `${b.file}:${b.line + 1}`,
    ]),
    stale: stale.map(
      (e) => `${e.file}:${e.line + 1} (last: ${e.date})`
    ),
    expired: expired.map((e) => `${e.file}:${e.line + 1}`),
    entriesWithoutDate: noDate,
    deadIndexLinks: deadLinks,
    unindexedFiles: unindexed,
    fills,
    budget,
  };
}

function lastDreamAt(home) {
  const stamp = path.join(home, '.git', 'amr.lastdream');
  if (fs.existsSync(stamp)) return fs.statSync(stamp).mtimeMs;
  const log = git(home, ['log', '-1', '--format=%ct', '--grep=^Dream:']);
  return log.code === 0 && log.stdout ? parseInt(log.stdout, 10) * 1000 : 0;
}

function touchDream(home) {
  fs.writeFileSync(
    path.join(home, '.git', 'amr.lastdream'),
    new Date().toISOString()
  );
}

function spinDemo() {
  if (!process.stderr.isTTY)
    return out('run `amr dream --spin` in a real terminal to see the moons');
  spinStart(true);
  setTimeout(() => {
    spinStop();
    out('💤 dreamt.');
  }, 2600);
}

// --if-stale N: true when the last dream is recent enough to skip this run.
function recentlyDreamt(home, flags) {
  if (flags['if-stale'] === undefined) return false;
  const minAge = numFlag(flags['if-stale'] || '7', 7);
  const ageDays = (Date.now() - lastDreamAt(home)) / 864e5;
  return ageDays < minAge;
}

function printReport(report, home, staleDays) {
  const s = report.stats;
  out(`dream report — ${home}`);
  out(`  ${s.entries} entries in ${s.files} file(s); MEMORY.md ${s.memoryMdBytes}B/${s.memoryMdLines} lines`);
  if (s.memoryMdBytes > 3072)
    out(`  ! MEMORY.md is large — move detail into topic files`);
  for (const f of report.fills.filter((x) => x.pct >= CONSOLIDATE_AT))
    out(
      `  ! ${f.file} at ${Math.round(f.pct * 100)}% of the ${report.budget}-char digest budget — new entries will rank out of context`
    );
  if (s.dirtyFiles) out(`  ! ${s.dirtyFiles} uncommitted change(s) present`);
  out(`  exact duplicates   : ${report.exactDups.length}`);
  report.exactDups.forEach((g) => out(`    - ${g.join('  AND  ')}`));
  out(`  possible duplicates: ${report.possibleDups.length}`);
  report.possibleDups.forEach(([a, b]) => out(`    - ${a}  ~  ${b}`));
  out(`  stale (>${staleDays}d)      : ${report.stale.length}`);
  report.stale.forEach((e) => out(`    - ${e}`));
  out(`  expired state      : ${report.expired.length}`);
  out(`  dead index links   : ${report.deadIndexLinks.length}`);
  report.deadIndexLinks.forEach((l) => out(`    - [[${l}]]`));
  out(`  unindexed files    : ${report.unindexedFiles.length}`);
  report.unindexedFiles.forEach((f) => out(`    - ${f}`));
  if (report.entriesWithoutDate)
    out(`  entries missing 'added:' date: ${report.entriesWithoutDate}`);
}

// An expired entry that earned a recent `amr used` proved it is still
// load-bearing: return the line with a renewed TTL, or null to drop it.
function renewedLine(line, usage, nowMs, cfg) {
  const u = usage[entryId(line)];
  if (!u || nowMs - u.last >= 90 * 864e5) return null;
  return line.replace(
    /expires:\s*\d{4}-\d{2}-\d{2}/,
    `expires: ${addDays(numFlag(cfg.defaultTtlDays, DEFAULT_TTL_DAYS))}`
  );
}

// drop exact-duplicate bullets (keeping the first occurrence) and expired
// state, renewing expired entries that were recently marked used
function dedupeAndExpire(home, cfg, changed, touched) {
  const usage = loadUsage(home);
  const nowMs = Date.now();
  const seen = new Set();
  for (const rel of mdFiles(home)) {
    const abs = path.join(home, rel);
    const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
    const keep = [];
    let removed = 0;
    let expiredRemoved = 0;
    let renewed = 0;
    for (const l of lines) {
      if (l.trim().startsWith('- ') && !l.includes('[[')) {
        if (isExpired(l)) {
          const fresh = renewedLine(l, usage, nowMs, cfg);
          if (fresh) {
            renewed++;
            keep.push(fresh);
          } else {
            expiredRemoved++;
          }
          continue;
        }
        const n = bulletText(l);
        if (seen.has(n)) {
          removed++;
          continue;
        }
        seen.add(n);
      }
      keep.push(l);
    }
    if (!(removed || expiredRemoved || renewed)) continue;
    atomicWrite(abs, keep.join('\n').replace(/\n{3,}/g, '\n\n'));
    touched.add(rel);
    if (removed) changed.push(`${rel}: removed ${removed} duplicate(s)`);
    if (expiredRemoved)
      changed.push(`${rel}: dropped ${expiredRemoved} expired entr${expiredRemoved === 1 ? 'y' : 'ies'}`);
    if (renewed)
      changed.push(`${rel}: renewed ${renewed} expired entr${renewed === 1 ? 'y' : 'ies'} (marked used recently)`);
  }
}

// Budget pressure: collect merge/delete proposals for files past the
// consolidation threshold so the next session can act on them.
// Files under the threshold still get the duplicate scan: waiting for
// the budget wall is how three copies of one pitfall coexisted.
// Returns [scope, texts] pairs, queued after the lock releases.
function collectProposals(home, cfg, report, changed) {
  const tidies = [];
  const consolidateAt = cfg.consolidateAt ?? CONSOLIDATE_AT;
  for (const f of report.fills) {
    const props =
      f.pct >= consolidateAt
        ? consolidationProposals(home, f.file, report.budget)
        : mergeProposals(home, f.file).proposals;
    if (!props.length) continue;
    const scope =
      f.file === 'MEMORY.md' ? null : f.file.replace(/^projects\/|\.md$/g, '');
    tidies.push([scope, props]);
    changed.push(`${f.file}: queued ${props.length} consolidation proposal(s)`);
  }
  // Topic files (pitfalls.md, fact-bank.md, ...) are not in the digest, so
  // they have no budget fill and were never scanned at all: that is where
  // the duplicate pitfalls piled up. Same duplicate pass for them.
  const scanned = new Set(report.fills.map((f) => f.file));
  for (const rel of new Set(allLiveEntries(home).map((e) => e.rel))) {
    if (scanned.has(rel)) continue;
    const props = mergeProposals(home, rel).proposals;
    if (!props.length) continue;
    // Project files scope their proposals to that project, like the
    // budget loop above; MEMORY.md and topic files are global.
    const scope = rel.startsWith('projects/') ? rel.replace(/^projects\/|\.md$/g, '') : null;
    tidies.push([scope, props]);
    changed.push(`${rel}: queued ${props.length} consolidation proposal(s)`);
  }
  return tidies;
}

function assignIds(home, changed, touched) {
  const ids = backfillIds(home);
  if (!ids.n) return;
  ids.touched.forEach((f) => touched.add(f));
  changed.push(`assigned ids to ${ids.n} entr${ids.n === 1 ? 'y' : 'ies'}`);
}

// prune dead index links + index unindexed files
function syncIndex(home, report, changed, touched) {
  const memPath = path.join(home, 'MEMORY.md');
  let memLines = fs.readFileSync(memPath, 'utf8').split(/\r?\n/);
  const pruned = memLines.filter((l) => {
    const m = l.match(/^-\s*\[\[([^\]]+)\]\]/);
    return !m || !report.deadIndexLinks.includes(m[1]);
  });
  if (pruned.length !== memLines.length) {
    changed.push(`pruned ${memLines.length - pruned.length} dead link(s)`);
    memLines = pruned;
    touched.add('MEMORY.md');
  }
  if (report.unindexedFiles.length) {
    let idx = memLines.findIndex((l) => /^##\s+Index/.test(l));
    if (idx < 0) {
      memLines.push('', '## Index');
      idx = memLines.length - 1;
    }
    let ins = idx + 1;
    while (ins < memLines.length && /^-\s*\[\[/.test(memLines[ins].trim()))
      ins++;
    memLines.splice(
      ins,
      0,
      ...report.unindexedFiles.map((f) => `- [[${f}]]`)
    );
    touched.add('MEMORY.md');
    changed.push(`indexed ${report.unindexedFiles.length} file(s)`);
  }
  if (touched.has('MEMORY.md'))
    atomicWrite(memPath, memLines.join('\n').replace(/\n{3,}/g, '\n\n'));
}

// Archive the oldest bullets of one injectable file beyond the `keep` cap.
function compactFile(home, rel, keep, changed, touched) {
  const abs = path.join(home, rel);
  if (!fs.existsSync(abs)) return;
  const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  const idxAt =
    rel === 'MEMORY.md' ? lines.findIndex((l) => /^##\s+Index/.test(l)) : -1;
  const headEnd = idxAt >= 0 ? idxAt : lines.length;
  const bulletIdx = [];
  for (let i = 0; i < headEnd; i++)
    if (lines[i].trim().startsWith('- ') && !lines[i].includes('[['))
      bulletIdx.push(i);
  if (bulletIdx.length <= keep) return;
  const move = new Set(bulletIdx.slice(0, bulletIdx.length - keep));
  const archived = [...move].sort((a, b) => a - b).map((i) => lines[i]);
  const arel = rel === 'MEMORY.md' ? 'archive/MEMORY.md' : `archive/${rel}`;
  const aabs = path.join(home, arel);
  if (!fs.existsSync(aabs)) {
    fs.mkdirSync(path.dirname(aabs), { recursive: true });
    fs.writeFileSync(aabs, `# Archive: ${rel}\n\n`);
  }
  fs.appendFileSync(aabs, archived.join('\n') + '\n');
  atomicWrite(
    abs,
    lines
      .filter((_, i) => !move.has(i))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
  );
  touched.add(rel);
  touched.add(arel);
  changed.push(`${rel}: archived ${archived.length} oldest entrie(s)`);
}

// --compact: archive oldest entries beyond the digest cap so live
// files never exceed what `amr context` injects. Archive files stay
// searchable via `amr search`; they are not session-injected.
function compactAll(home, flags, changed, touched) {
  const keep = numFlag(flags.keep || '25', 25);
  for (const rel of injectableFiles(home))
    compactFile(home, rel, keep, changed, touched);
}

// Commit what moved and report it. Returns the queued proposals.
function commitFixes(home, changed, touched, tidies) {
  if (!changed.length) {
    touchDream(home);
    out('nothing mechanical to fix');
    return tidies;
  }
  // Proposals alone touch no live files; commit only when files moved.
  const ok = touched.size ? commit(home, [...touched], 'Dream: mechanical cleanup') : true;
  // Stamp only after a successful commit — a failed/interrupted run
  // must not count as dreamt for --if-stale.
  if (ok) touchDream(home);
  changed.forEach((c) => out(`  ${c}`));
  if (!ok) err('commit failed; fixes left uncommitted in working tree');
  return tidies;
}

// The fix+compact pass; runs under the repo lock (see cmdDream) so a
// concurrent `amr add` can't interleave or lose an update mid-dream.
function applyFixes(home, cfg, report, flags) {
  const changed = [];
  const touched = new Set();
  dedupeAndExpire(home, cfg, changed, touched);
  const tidies = collectProposals(home, cfg, report, changed);
  assignIds(home, changed, touched);
  syncIndex(home, report, changed, touched);
  if (flags.compact) compactAll(home, flags, changed, touched);
  return commitFixes(home, changed, touched, tidies);
}

export function cmdDream(flags) {
  if (flags.spin) return spinDemo();
  // Judge-backed backlog triage is opt-in and separate from --fix, which
  // the session-end hook runs unattended.
  if (flags.triage) return cmdTriage(flags);
  const home = ensureRepo();
  const staleDays = numFlag(flags.days ?? '90', 90);
  const cfg = loadConfig(home);
  const budget = numFlag(flags.budget, cfg.contextBudget ?? 0);

  // recently dreamt; stay quiet (hook-safe)
  if (recentlyDreamt(home, flags)) return;

  // --inline: printed moon frames instead of a live spinner — survives
  // hook/tool-output capture and shows up inline in agent transcripts.
  const ttySpin = process.stderr.isTTY && !flags.json && !flags.inline;
  spinStart(ttySpin);
  const moon = (suffix) => {
    if (flags.inline && !flags.json)
      err(`${FRAMES[spinI++ % FRAMES.length]} ${suffix}`);
  };
  try {
    const report = analyze(home, { staleDays, budget });
    moon('dreaming…');

    if (flags.json) {
      out(JSON.stringify(report, null, 2));
      return;
    }

    printReport(report, home, staleDays);

    if (!flags.fix && !flags.compact) {
      touchDream(home);
      out('');
      out('run `amr dream --fix` for mechanical cleanup (index, dead links, exact dups); add --compact to archive entries beyond the digest cap. Semantic merging needs an agent — see dreams/DREAMER.md');
      return;
    }

    moon('still dreaming…');
    const tidies = withLock(home, () => applyFixes(home, cfg, report, flags)) || [];
    for (const [scope, texts] of tidies) queueConsolidations(home, scope, texts);
    if (flags.inline && !flags.json) err('💤 dreamt.');
  } finally {
    spinDone();
  }
}
