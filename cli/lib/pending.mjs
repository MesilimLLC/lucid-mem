// Reflection review queue. The background judge never writes memory
// directly: its proposals land in dreams/pending-reflections.md, which
// `amr context` lists under "Pending memory candidates" for the next
// session to accept (`amr add` / `amr update <id>`) or ignore. Proposals
// drain when a matching entry is saved and age out after a fortnight.
// Kept apart from pending-saves.md, which `amr coverage` rewrites whole.

import fs from 'node:fs';
import path from 'node:path';
import { today, withLock } from './core.mjs';

export const PENDING_REFLECTIONS = path.join('dreams', 'pending-reflections.md');
// Overflow and age-out evictions land here instead of being deleted, so
// a proposal the queue drops before any session reviewed it can still be
// rescued with `amr add`. Trim reviewed lines by hand when done.
export const REFLECTION_ARCHIVE = path.join('dreams', 'reflection-archive.md');
const MAX_ITEMS = 15;
const MAX_AGE_DAYS = 14;
const MAX_ARCHIVED = 200;
const SIMILAR = 0.8;
const HEADER = [
  '# Pending reflections',
  '',
  'Background-judge proposals, unsaved. Review: `amr add` / `amr update <id>` the real ones; ignore the rest.',
  '',
];
const ARCHIVE_HEADER = [
  '# Archived reflections',
  '',
  'Proposals the pending queue evicted (overflow past 15 items, or older than a fortnight) before any session reviewed them. Rescue the real ones with `amr add` / `amr update <id>`, then delete the line.',
  '',
];

const words = (s) =>
  new Set(
    String(s)
      .toLowerCase()
      .replace(/\[[^\]]*\]\s*$/, '') // entry meta
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3)
  );

// Token Jaccard: a cheap paraphrase-blind near-duplicate check, enough to
// stop the same lesson being proposed or saved twice in near-identical
// words. Real paraphrase dedupe is left to the judge, which sees memory.
export function similarity(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / (x.size + y.size - inter);
}

// Overlap coefficient: shared tokens over the smaller token set. Catches a
// short entry restating a long one (Jaccard dilutes it with the long one's
// extra words), e.g. the same pitfall saved twice at different lengths.
export function overlap(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / Math.min(x.size, y.size);
}

export const isNearDuplicate =(text, others) =>
  others.some((o) => similarity(text, o) >= SIMILAR);

// Best near-duplicate among existing entry lines, or null. Used by
// `amr add` to point at `amr update <id>` instead of saving a copy.
// Short entries are exempt: their token sets are tiny ("entry number 0"
// vs "entry number 1" score 1.0 once digits drop out), so a match there
// is noise, and exact copies are already caught by entryExists.
export function nearDuplicate(text, lines) {
  if (words(text).size < 6) return null;
  let best = null;
  for (const line of lines) {
    const score = similarity(text, line);
    if (score >= SIMILAR && (!best || score > best.score))
      best = { line, score };
  }
  return best;
}

// "- [reflect] 2026-10-24 add pitfall project: text"
// "- [reflect] 2026-10-24 update a3f9: text"
// "- [consolidate] 2026-10-26 tidy scope=slug: merge a3f9 into b2c1 ..."
const ITEM = /^- \[(?:reflect|consolidate)\] (\d{4}-\d{2}-\d{2}) (.+?): (.*)$/;

function readItems(abs) {
  if (!fs.existsSync(abs)) return [];
  return fs
    .readFileSync(abs, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.match(ITEM))
    .filter(Boolean)
    .map(([line, date, head, text]) => ({ line, date, head, text }));
}

// Project scope rides on the head as scope=<slug>. Unscoped items are
// global and show everywhere; scoped items show only in that project.
const visibleIn = (head, scope) => {
  const s = (head.match(/scope=([a-z0-9-]+)/) || [])[1];
  return !s || s === scope;
};

function writeItems(abs, items) {
  if (!items.length) return fs.rmSync(abs, { force: true });
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // Temp file then rename, so `amr context` never reads a torn queue.
  const tmp = `${abs}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, [...HEADER, ...items.map((i) => i.line)].join('\n') + '\n');
  fs.renameSync(tmp, abs);
}

const fresh = (date, now) => (Date.parse(now) - Date.parse(date)) / 864e5 <= MAX_AGE_DAYS;

// Evicted queue items are appended here (exact-line deduped, newest 200
// kept) instead of being deleted. Runs inside the caller's lock.
function archiveItems(home, items) {
  if (!items.length) return;
  const abs = path.join(home, REFLECTION_ARCHIVE);
  const have = new Set(
    fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8').split(/\r?\n/) : []
  );
  const lines = items.map((i) => i.line).filter((l) => !have.has(l));
  if (!lines.length) return;
  const prev = fs.existsSync(abs)
    ? fs.readFileSync(abs, 'utf8').split(/\r?\n/).filter((l) => ITEM.test(l))
    : [];
  const kept = [...prev, ...lines].slice(-MAX_ARCHIVED);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, [...ARCHIVE_HEADER, ...kept].join('\n') + '\n');
}

// Fresh (unexpired) archived lines, for the `amr context` pointer.
export function archivedReflectionCount(home, now = today()) {
  const abs = path.join(home, REFLECTION_ARCHIVE);
  if (!fs.existsSync(abs)) return 0;
  return fs
    .readFileSync(abs, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.match(ITEM))
    .filter((m) => m && fresh(m[1], now)).length;
}

// proposals: [{op:'add'|'update', id?, kind?, project?, text}]
// Returns how many were queued (new, not near-duplicates of queued ones).
// Items the cap or the age-out drops are archived, never deleted.
export function queueReflections(home, proposals, now = today(), scope = null) {
  const abs = path.join(home, PENDING_REFLECTIONS);
  return withLock(home, () => {
    const all = readItems(abs);
    archiveItems(home, all.filter((i) => !fresh(i.date, now)));
    const items = all.filter((i) => fresh(i.date, now));
    let queued = 0;
    for (const p of proposals) {
      const text = String(p.text).replace(/\s+/g, ' ').trim();
      if (!text || isNearDuplicate(text, items.map((i) => i.text))) continue;
      const base =
        p.op === 'update'
          ? `update ${p.id}`
          : ['add', p.kind, p.project ? 'project' : 'global'].filter(Boolean).join(' ');
      // Updates name ids from this project's memory, so they are scoped too.
      const head = scope && (p.op === 'update' || p.project) ? `${base} scope=${scope}` : base;
      items.push({ line: `- [reflect] ${now} ${head}: ${text}`, date: now, text });
      queued++;
    }
    const kept = items.slice(-MAX_ITEMS);
    archiveItems(home, items.slice(0, items.length - kept.length));
    writeItems(abs, kept);
    return queued;
  });
}

// Budget-pressure proposals queued by `amr add`/`amr dream` when a file
// crosses the consolidation threshold. `texts` are ready-made suggestion
// strings; duplicates of queued items are skipped.
export function queueConsolidations(home, scope, texts, now = today()) {
  const abs = path.join(home, PENDING_REFLECTIONS);
  return withLock(home, () => {
    const all = readItems(abs);
    archiveItems(home, all.filter((i) => !fresh(i.date, now)));
    const items = all.filter((i) => fresh(i.date, now));
    let queued = 0;
    for (const t of texts) {
      const text = String(t).replace(/\s+/g, ' ').trim();
      if (!text || items.some((i) => i.text === text)) continue;
      const head = `tidy${scope ? ` scope=${scope}` : ''}`;
      items.push({
        line: `- [consolidate] ${now} ${head}: ${text}`,
        date: now,
        text,
      });
      queued++;
    }
    const kept = items.slice(-MAX_ITEMS);
    archiveItems(home, items.slice(0, items.length - kept.length));
    writeItems(abs, kept);
    return queued;
  });
}

// Drop queued proposals that a just-saved entry now covers, or that point
// at ids a delete/supersede just removed. Called from add/update/delete/
// supersede while their lock is already released.
export function drainReflections(home, savedText, deadIds = []) {
  const abs = path.join(home, PENDING_REFLECTIONS);
  if (!fs.existsSync(abs)) return;
  const dead = deadIds.filter(Boolean).map((id) => new RegExp(`\\b${id}\\b`));
  withLock(home, () => {
    const items = readItems(abs);
    const kept = items.filter(
      (i) =>
        similarity(i.text, savedText) < SIMILAR &&
        !dead.some((re) => re.test(i.line))
    );
    if (kept.length !== items.length) writeItems(abs, kept);
  });
}

// Bullet lines for `amr context`, newest first, expired ones skipped.
export function pendingReflectionLines(home, now = today(), scope = null) {
  return readItems(path.join(home, PENDING_REFLECTIONS))
    .filter((i) => fresh(i.date, now) && visibleIn(i.head, scope))
    .reverse()
    .map((i) => i.line);
}
