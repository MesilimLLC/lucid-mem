// Relevance ranking for `amr context`: instead of "newest 25", pick the
// entries most likely to help a fresh session, within a size budget.
// Score = kind weight x recency decay x usage boost, with a penalty for
// session-state-shaped noise. Usage (entries the agent marked via
// `amr used` because they helped) lives in .git/amr-usage.json — local,
// never committed, so ranking is per-machine.

import fs from 'node:fs';
import path from 'node:path';
import { entryKind, entryTokens, trailingMeta } from './core.mjs';
import { entryId } from './ids.mjs';

export const DEFAULT_BUDGET = 6000; // chars of entries, roughly 1.5k tokens
export const MIN_PER_SECTION = 3;

const KIND_WEIGHT = {
  pitfall: 3,
  decision: 2.5,
  preference: 2.5,
  howto: 2,
  fact: 1.5,
  state: 1,
};
const HALF_LIFE_DAYS = 60;
const USAGE_WINDOW_DAYS = 90;

const usagePath = (home) => path.join(home, '.git', 'amr-usage.json');

export function loadUsage(home) {
  try {
    const u = JSON.parse(fs.readFileSync(usagePath(home), 'utf8'));
    // Anything but a plain object would crash scoreEntry or lose writes.
    return u && typeof u === 'object' && !Array.isArray(u) ? u : {};
  } catch {
    return {};
  }
}

export function bumpUsage(home, ids, now = Date.now()) {
  if (!ids.length) return;
  const u = loadUsage(home);
  for (const id of ids) {
    const e = u[id] || { n: 0 };
    u[id] = { n: e.n + 1, last: now };
  }
  // Temp file then rename: an interrupted write cannot leave a torn file
  // that loadUsage would then discard along with all usage.
  const abs = usagePath(home);
  const tmp = `${abs}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(u));
    fs.renameSync(tmp, abs);
  } catch {}
}

const latestDate = (line) => {
  const ds = [...line.matchAll(/(?:added|updated):\s*(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]);
  // Legacy meta carries a bare leading date: "[ 2026-10-24; kind: ...]".
  const bare = trailingMeta(line).match(/^\s*(\d{4}-\d{2}-\d{2})/);
  if (bare) ds.push(bare[1]);
  ds.sort();
  return ds.length ? ds[ds.length - 1] : null;
};

// An entry nobody ever marked `amr used` has never been shown to help.
// After a grace period that ranks it below entries with a track record, so
// session-start budget goes to memory that earned it. Fresh entries are
// exempt: they have had no chance to be used yet.
const UNUSED_GRACE_DAYS = 14;
const UNUSED_FACTOR = 0.75;

// Relevance to the current work: shared tokens between the entry and the
// session's work signal (project/cwd/branch/recent-commit/transcript
// tokens built by cmdContext). Long, specific tokens count double;
// three-char tokens like "mem" or "dev" are too ambient to count.
const relevanceWeight = (line, signal) => {
  if (!signal || !signal.size) return 0;
  let w = 0;
  for (const t of entryTokens(line))
    if (signal.has(t)) w += t.length >= 6 ? 2 : t.length >= 4 ? 1 : 0;
  return Math.min(w, 5);
};

export function scoreEntry(line, usage = {}, isNoise = () => false, now = Date.now(), signal = null) {
  const kind = entryKind(line);
  let s = KIND_WEIGHT[kind] ?? 1.5;
  const d = latestDate(line);
  const ageDays = d ? Math.max(0, (now - Date.parse(d)) / 864e5) : HALF_LIFE_DAYS;
  s *= Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
  const u = usage[entryId(line)];
  if (u && now - u.last < USAGE_WINDOW_DAYS * 864e5) s *= 1 + 0.5 * Math.log2(1 + u.n);
  else if (!u && kind !== 'state' && (!d || ageDays >= UNUSED_GRACE_DAYS)) s *= UNUSED_FACTOR;
  if (kind !== 'state' && isNoise(line)) s *= 0.3;
  s *= 1 + 0.6 * relevanceWeight(line, signal);
  return s;
}

// A floor entry that would overrun the budget is clipped to this many
// chars, so the floor bounds the overrun (MIN_PER_SECTION x this per
// section) instead of letting a few huge entries blow the limit.
export const FLOOR_ENTRY_CAP = 240;

// Shorten an entry's text, keeping its trailing [meta] so the id stays
// addressable (`amr search`, `amr update <id>`) after clipping.
export function clipEntry(line, cap = FLOOR_ENTRY_CAP) {
  if (line.length <= cap) return line;
  const meta = (line.match(/\s*\[[^\]]*\]\s*$/) || [''])[0];
  const body = line.slice(0, line.length - meta.length);
  const keep = Math.max(24, cap - meta.length - 1);
  return `${body.slice(0, keep).trimEnd()}…${meta}`;
}

// Highest-scored entries first until `maxCount` or the char budget is
// hit, returned in original order. The top MIN_PER_SECTION entries are
// always kept, clipped when they would not fit, so a section never
// renders empty but also never exceeds the budget by more than the
// floor cap allows.
export function pickWithinBudget(arr, maxCount, budget, usage, isNoise, signal = null) {
  // One clock reading for the whole pass: per-entry Date.now() calls put
  // equal-score entries a millisecond apart, so ties broke by timing.
  const now = Date.now();
  const ranked = arr
    .map((line, i) => ({ line, i, s: scoreEntry(line, usage, isNoise, now, signal) }))
    .sort((a, b) => b.s - a.s || b.i - a.i);
  const chosen = [];
  let chars = 0;
  let clipped = false;
  for (const r of ranked) {
    if (chosen.length >= maxCount) break;
    if (chars + r.line.length > budget) {
      if (chosen.length >= MIN_PER_SECTION) continue;
      const line = clipEntry(r.line);
      clipped ||= line !== r.line;
      r.line = line;
    }
    chosen.push(r);
    chars += r.line.length;
  }
  chosen.sort((a, b) => a.i - b.i);
  return { items: chosen.map((r) => r.line), chars, clipped };
}
