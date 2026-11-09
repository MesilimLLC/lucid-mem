// Budget-pressure consolidation. The context digest has a fixed char
// budget; once a live file's entries approach it, the next writes get
// ranked out of sessions entirely. Rather than fail at the wall, `amr
// add` and `amr dream` propose concrete merges when a file crosses the
// threshold: near-duplicate pairs get a delete suggestion, expired and
// session-state-looking entries get delete/re-scope suggestions. The
// proposals surface under "Pending memory candidates" via pending.mjs.

import fs from 'node:fs';
import path from 'node:path';
import {
  episodicHits,
  entryKind,
  isExpired,
  loadConfig,
  numFlag,
} from './core.mjs';
import { entryId } from './ids.mjs';
import { DEFAULT_BUDGET, loadUsage, scoreEntry } from './rank.mjs';
import { overlap, similarity } from './pending.mjs';

export const CONSOLIDATE_AT = 0.8;
const MAX_PROPOSALS = 5;

// Near-duplicate test shared by dream's merge pass and `amr add`'s
// supersede offer. Jaccard alone missed the real duplicates (the same
// pitfall saved at two lengths scored 0.38), so a short entry restating a
// long one also counts when most of its words are in the long one. Short
// entries are exempt from the overlap path: tiny token sets match by luck.
export const MERGE_SIMILARITY = 0.4;
export const MERGE_OVERLAP = 0.6;
export const MERGE_MIN_WORDS = 8;
const JACCARD_MIN_WORDS = 6; // matches nearDuplicate's short-entry exemption
const wordCount = (s) =>
  new Set(
    String(s)
      .toLowerCase()
      .replace(/\[[^\]]*\]\s*$/, '')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3)
  ).size;
export function nearlySame(a, b) {
  const small = Math.min(wordCount(a), wordCount(b));
  if (small < JACCARD_MIN_WORDS) return false;
  if (similarity(a, b) >= MERGE_SIMILARITY) return true;
  return small >= MERGE_MIN_WORDS && overlap(a, b) >= MERGE_OVERLAP;
}

// Live entry lines of a memory file; MEMORY.md's Index section is links,
// not entries, so it stops counting there.
export function liveEntryLines(home, rel) {
  const abs = path.join(home, rel);
  if (!fs.existsSync(abs)) return [];
  const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  const end =
    rel === 'MEMORY.md'
      ? (() => {
          const i = lines.findIndex((l) => /^##\s+Index/.test(l));
          return i < 0 ? lines.length : i;
        })()
      : lines.length;
  const out = [];
  for (let i = 0; i < end; i++)
    if (lines[i].trim().startsWith('- ') && !lines[i].includes('[['))
      out.push(lines[i]);
  return out;
}

// Every live entry across the repo (archive/ and dreams/ excluded), with
// the file it lives in.
export function allLiveEntries(home) {
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(dir, e.name);
      const rel = path.relative(home, p).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (rel !== 'archive' && rel !== 'dreams') walk(p);
      } else if (e.name.endsWith('.md')) files.push(rel);
    }
  })(home);
  const out = [];
  for (const rel of files)
    for (const line of liveEntryLines(home, rel))
      if (!isExpired(line)) out.push({ line, rel });
  return out;
}

// The live entry `text` most nearly restates, or null.
export function similarEntry(text, entries) {
  let best = null;
  for (const e of entries) {
    if (!nearlySame(text, e.line)) continue;
    const score = similarity(text, e.line);
    if (!best || score > best.score) best = { ...e, score };
  }
  return best;
}

export function digestBudget(home, override) {
  const cfg = loadConfig(home);
  return numFlag(override, cfg.contextBudget ?? DEFAULT_BUDGET);
}

export function budgetFill(home, rel, budget) {
  const chars = liveEntryLines(home, rel).reduce((n, l) => n + l.length, 0);
  return { chars, budget, pct: budget > 0 ? chars / budget : 0 };
}

const text = (line) =>
  line.trim().slice(2).replace(/\s*\[[^\]]*\]\s*$/, '').trim();

// Near-duplicate pairs in one file: keep the stronger entry, delete the
// weaker. Independent of how full the file is: duplicates are noise at any
// size, and waiting for the budget wall is how three copies of one
// pitfall survived.
export function mergeProposals(home, rel, now = Date.now(), max = MAX_PROPOSALS) {
  const lines = liveEntryLines(home, rel);
  const usage = loadUsage(home);
  const proposals = [];
  const paired = new Set();
  const scored = lines.map((l, i) => ({
    l,
    i,
    id: entryId(l),
    s: scoreEntry(l, usage, undefined, now),
  }));
  for (let i = 0; i < scored.length && proposals.length < max; i++) {
    for (let j = i + 1; j < scored.length; j++) {
      const [a, b] = [scored[i], scored[j]];
      if (paired.has(a.i) || paired.has(b.i) || !a.id || !b.id) continue;
      if (!nearlySame(text(a.l), text(b.l))) continue;
      const [keep, drop] = a.s >= b.s ? [a, b] : [b, a];
      proposals.push(
        `merge ${drop.id} into ${keep.id} (near-duplicate): fold any unique detail into ${keep.id}, then \`amr delete ${drop.id}\``
      );
      paired.add(a.i);
      paired.add(b.i);
      break;
    }
  }
  return { proposals, paired, scored };
}

// Concrete proposals for one file that is at/over the threshold.
export function consolidationProposals(home, rel, budget, now = Date.now()) {
  const { proposals, paired, scored } = mergeProposals(home, rel, now);

  // Entries that should not occupy budget at all.
  for (const { l, i, id } of scored) {
    if (proposals.length >= MAX_PROPOSALS || paired.has(i) || !id) continue;
    if (isExpired(l))
      proposals.push(`expired entry ${id}: \`amr delete ${id}\``);
    else if (entryKind(l) !== 'state' && episodicHits(l).length)
      proposals.push(
        `session-state-looking entry ${id}: \`amr delete ${id}\` or re-save as --kind state`
      );
  }
  return proposals;
}

// True when the file is at/over the consolidation threshold.
export function overThreshold(home, rel, budget) {
  const cfg = loadConfig(home);
  return budgetFill(home, rel, budget).pct >= (cfg.consolidateAt ?? CONSOLIDATE_AT);
}
