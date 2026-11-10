// Failure-triggered recall: given a real tool failure, surface the one or
// two memory entries most likely to help, at the moment it matters, instead
// of hoping the agent spots them in the session-start dump. Deterministic
// only: error-code/keyword triggers plus rarity-weighted token overlap
// against live entries (archive/ and dreams/ never fire).
//
// Silence is the default, because a recall hook that cries wolf gets
// ignored. It acts only when the payload shows a failure (a
// PostToolUseFailure event, is_error, a non-zero exit code, interrupted),
// never for read-only tools, only scores the lines that report the
// failure (never the tool's input echo or a successful 10 KB dump), only
// offers entries from the current project (or global ones), and needs a
// shared word that is rare across memory, so ambient words like
// "install" or "session" cannot fire it.

import fs from 'node:fs';
import path from 'node:path';
import {
  ensureRepo,
  entryKind,
  loadConfig,
  normName,
  projectEntry,
  projectFor,
  renderEntry,
  resolveProjectSlug,
} from './core.mjs';
import { entryId } from './ids.mjs';
import { allLiveEntries, entryScope } from './consolidate.mjs';
import { loadUsage } from './rank.mjs';
import { overlap, similarity } from './pending.mjs';

const out = (s = '') => process.stdout.write(s + '\n');

// Per-session dedupe: the failure hook fires on every tool error, and
// without memory of what it already showed, the same "relevant" entries
// re-inject all session. .git/amr-recall-state.json maps a session key to
// {entryKey: timestamp}; anything surfaced in the last window stays quiet.
const RECALL_STATE = 'amr-recall-state.json';
const RESHOW_MS = 4 * 3600e3;
const KEEP_MS = 7 * 864e5;

function loadRecallState(home) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(home, '.git', RECALL_STATE), 'utf8'));
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  } catch {
    return {};
  }
}

// hit keys are entry ids; id-less lines dedupe by their first chars.
const hitKey = (line) => entryId(line) || `txt:${line.trim().slice(0, 80)}`;

function filterFresh(home, sessionKey, hits, now = Date.now()) {
  if (!hits.length) return hits;
  const state = loadRecallState(home);
  // Drop stale sessions and stale hits inside surviving sessions.
  for (const k of Object.keys(state)) {
    const bucket = state[k];
    if (!bucket || typeof bucket !== 'object') {
      delete state[k];
      continue;
    }
    for (const id of Object.keys(bucket))
      if (now - bucket[id] > KEEP_MS) delete bucket[id];
    if (!Object.keys(bucket).length) delete state[k];
  }
  const seen = state[sessionKey] || {};
  const fresh = hits.filter((l) => {
    const ts = seen[hitKey(l)];
    return !ts || now - ts > RESHOW_MS;
  });
  if (!fresh.length) return fresh;
  state[sessionKey] = { ...seen };
  for (const l of fresh) state[sessionKey][hitKey(l)] = now;
  writeJsonAtomic(path.join(home, '.git', RECALL_STATE), state);
  return fresh;
}

// Temp file then rename: an interrupted write cannot leave a torn file.
function writeJsonAtomic(abs, value) {
  const tmp = `${abs}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, abs);
  } catch {}
}

// Known error shapes and the vocabulary of the entries that fix them.
// First entries: shell heredocs mangling escapes (CS1010 from C#
// string literals, shell EOF, Python SyntaxError) and cp1252 decoding.
const TRIGGERS = [
  { re: /cs1010|newline in constant/i, terms: ['heredoc', 'chr(92)', 'backslash', 'escape'] },
  { re: /unexpected eof while looking for matching|unexpected end of file/i, terms: ['heredoc', 'chr(92)', 'backslash', 'escape'] },
  { re: /syntaxerror/i, terms: ['heredoc', 'chr(92)', 'backslash', 'escape'] },
  { re: /unicodedecodeerror|cp1252|codec can't decode|charmap/i, terms: ['cp1252', 'encoding', 'utf-8', 'utf8'] },
];

const STOP = new Set([
  'error', 'the', 'and', 'for', 'with', 'from', 'that', 'this', 'file',
  'line', 'failed', 'failure', 'exception', 'traceback', 'most', 'recent',
  'last', 'call', 'exit', 'code', 'status',
]);

const tokens = (s) =>
  new Set(
    String(s)
      .toLowerCase()
      .replace(/\[[^\]]*\]\s*$/, '')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w))
  );

// ---- failure detection --------------------------------------------------

// Tools that return file contents or search hits, not errors: their output
// can contain any error-looking word (source code, logs) without anything
// having failed.
const READ_ONLY_TOOLS = new Set([
  'read', 'grep', 'glob', 'ls', 'notebookread', 'read_file', 'read_many_files',
  'list_dir', 'list_directory', 'grep_search', 'file_search', 'search_file_content',
  'view', 'webfetch', 'websearch',
]);

const EXIT_KEYS = ['exit_code', 'exitcode', 'returncode', 'return_code', 'exit_status'];
const SKIP_TEXT_KEYS = new Set(['command', 'cmd', 'input', 'tool_input', 'args', 'arguments']);

// Does a tool response itself report a failure? Looks (a few levels deep)
// for is_error, interrupted, success:false or a non-zero exit code.
const FLAG_KEYS = new Set(['is_error', 'iserror', 'interrupted']);

// Does this one key/value pair say "failed"?
function fieldReportsFailure(key, val) {
  if (FLAG_KEYS.has(key)) return val === true;
  if (key === 'success') return val === false;
  if (!EXIT_KEYS.includes(key)) return false;
  const n = typeof val === 'string' ? Number(val) : val;
  return typeof n === 'number' && Number.isFinite(n) && n !== 0;
}

function responseFailed(v, depth = 0) {
  if (!v || typeof v !== 'object' || depth > 3) return false;
  if (Array.isArray(v)) return v.some((x) => responseFailed(x, depth + 1));
  return Object.entries(v).some(
    ([k, val]) => fieldReportsFailure(k.toLowerCase(), val) || responseFailed(val, depth + 1)
  );
}

// Strings of a tool response, minus keys that echo the invocation.
function responseText(v, depth = 0, parts = []) {
  if (typeof v === 'string') parts.push(v);
  else if (depth <= 6 && Array.isArray(v)) v.forEach((x) => responseText(x, depth + 1, parts));
  else if (depth <= 6 && v && typeof v === 'object')
    for (const [k, val] of Object.entries(v))
      if (!SKIP_TEXT_KEYS.has(k.toLowerCase())) responseText(val, depth + 1, parts);
  return parts;
}

// Returns the failure text of a hook payload, or null when nothing failed
// (or the tool is read-only). Only tool output counts: tool_input, which
// can echo the very words being searched for, is never scored.
export function failureFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const tool = String(payload.tool_name || payload.toolName || '').toLowerCase();
  if (READ_ONLY_TOOLS.has(tool)) return null;
  const resp = payload.tool_response ?? payload.tool_result ?? payload.tool_output;
  const event = String(payload.hook_event_name || payload.hookEventName || '');
  const failed =
    /failure/i.test(event) ||
    payload.is_error === true ||
    payload.interrupted === true ||
    responseFailed(resp);
  if (!failed) return null;
  const parts = [];
  if (typeof payload.error === 'string') parts.push(payload.error);
  responseText(resp, 0, parts);
  // A failure with no extractable text has nothing to match on: null, so
  // callers keep one "nothing to score" check.
  return parts.join('\n') || null;
}

// Lines that read like a failure report.
const ERROR_WORDS =
  /\b(error|failed|failure|fatal|exception|traceback|panic|denied|refused|cannot|could not|unable to|not found|no such|unexpected|invalid|missing|timed out|syntaxerror|unicodedecodeerror)\b|\b[a-z]{2,3}\d{4}\b|\bexit code [1-9]/i;
// errno names (ENOENT, EACCES, EUSAGE) are upper-case by convention; with the
// i flag this would match every word of 5+ letters starting with "e".
const ERRNO = /\bE[A-Z]{4,}\b/;
const ERROR_LINE = { test: (s) => ERROR_WORDS.test(s) || ERRNO.test(s) };

export const EXCERPT_CAP = 2048;
const LINE_CAP = 400;
const CONTEXT_LINES = 2;

// The part of an output that reports the failure: lines matching the error
// pattern plus a little context, capped. With `fallbackTail`, a payload
// already known to have failed but with no recognizable error line (a bare
// non-zero exit) falls back to the end of the output.
export function failureExcerpt(text, { fallbackTail = false, cap = EXCERPT_CAP } = {}) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.slice(0, LINE_CAP));
  const keep = new Set();
  lines.forEach((l, i) => {
    if (!ERROR_LINE.test(l)) return;
    for (let j = Math.max(0, i - CONTEXT_LINES); j <= Math.min(lines.length - 1, i + CONTEXT_LINES); j++)
      keep.add(j);
  });
  let picked = [...keep].sort((a, b) => a - b).map((i) => lines[i]);
  if (!picked.length) {
    if (!fallbackTail) return '';
    picked = lines.slice(-20);
  }
  return picked.join('\n').slice(0, cap);
}

// ---- project gating -----------------------------------------------------

// Names the current working directory answers to: its full slug (stable
// across worktrees and clones, distinct for same-named repos with different
// remotes), its repo name (for entries scoped only by `project:` meta), a
// pre-slug file named after the checkout dir, and its linked projects.
function projectKeys(home, cwd) {
  const keys = new Set();
  if (!cwd || !fs.existsSync(cwd)) return keys;
  const proj = projectFor(cwd);
  if (!proj) return keys;
  keys.add(proj.slug);
  keys.add(normName(proj.name));
  // Project files predating worktree-stable slugs were named after the
  // checkout dir but hashed the same basis, so they share this repo's hash
  // suffix. Requiring it keeps a same-named repo with another remote out.
  if (!fs.existsSync(path.join(home, 'projects', `${proj.slug}.md`))) {
    const legacy = resolveProjectSlug(home, path.basename(proj.toplevel));
    if (legacy && legacy.slice(-6) === proj.slug.slice(-6)) keys.add(legacy);
  }
  const links = projectEntry(loadConfig(home), proj)?.links || [];
  for (const l of links) keys.add(resolveProjectSlug(home, l) || normName(l));
  return keys;
}

// ---- unhelpful feedback -------------------------------------------------

// `amr unhelpful <id>` mutes an entry for the kind of error it was just
// shown for. Local to this machine (.git, never committed), like usage.
//   amr-recall-last.json   {id: sig}  what each entry last matched on
//   amr-unhelpful.json     {id: [sig|null]}  null = muted for every error
// sig = { tokens: [words shared by the error and the entry], trig: [TRIGGERS idx] }
const LAST_FILE = 'amr-recall-last.json';
const MUTED_FILE = 'amr-unhelpful.json';

function loadJson(home, name) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(home, '.git', name), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function sameKind(sig, errTokens, trigIdx) {
  if (!sig) return true;
  if ((sig.trig || []).some((i) => trigIdx.includes(i))) return true;
  const t = sig.tokens || [];
  return t.length > 0 && t.filter((w) => errTokens.has(w)).length / t.length >= 0.6;
}

const isMuted = (muted, id, errTokens, trigIdx) =>
  !!id && (muted[id] || []).some((sig) => sameKind(sig, errTokens, trigIdx));

export function cmdUnhelpful(ids, errorText = '') {
  const home = ensureRepo();
  const last = loadJson(home, LAST_FILE);
  const muted = loadJson(home, MUTED_FILE);
  const done = [];
  const already = [];
  // Expired entries still count: an entry can expire between the recall
  // that showed it and the user muting it.
  const entries = allLiveEntries(home, { includeExpired: true });
  for (const id of ids) {
    const entry = entries.find((e) => entryId(e.line) === id);
    if (!entry) continue;
    // A null sig mutes the entry for every error, so a later selective
    // mute adds nothing; say so instead of silently stacking.
    if ((muted[id] || []).includes(null)) {
      already.push(id);
      continue;
    }
    let sig = last[id] || null;
    if (errorText.trim()) {
      const err = tokens(failureExcerpt(errorText) || errorText);
      const shared = [...tokens(entry.line)].filter((w) => err.has(w));
      const trig = triggerIndexes(errorText, entry.line);
      sig = { tokens: shared, trig };
    }
    // A wildcard replaces any narrower mutes it now covers.
    if (sig === null) muted[id] = [null];
    else (muted[id] ||= []).push(sig);
    done.push(id);
  }
  if (done.length) writeJsonAtomic(path.join(home, '.git', MUTED_FILE), muted);
  const lines = [];
  if (done.length)
    lines.push(
      `muted for similar errors: ${done.join(', ')}${done.some((i) => muted[i]?.includes(null)) ? ' (no recent recall to learn from: muted for all errors)' : ''}`
    );
  if (already.length)
    lines.push(`already muted for all errors: ${already.join(', ')} (delete its entry in .git/amr-unhelpful.json to unmute)`);
  out(lines.length ? lines.join('\n') : 'no matching ids');
}

// ---- matching -----------------------------------------------------------

function triggerIndexes(errorText, line) {
  const text = line.toLowerCase();
  const idx = [];
  TRIGGERS.forEach((t, i) => {
    if (t.re.test(errorText) && t.terms.some((term) => text.includes(term))) idx.push(i);
  });
  return idx;
}

const RARE_DF = 2; // a shared word must appear in at most this many live entries
const RARE_MIN_LEN = 5;
const MIN_SHARED = 2; // without a trigger: at least two shared words, one rare
const DEDUPE_OVERLAP = 0.6;

// Score one entry against an error. Returns a candidate, or null when the
// entry fails the gate or is muted. `ctx` carries the per-call state:
// errorText, errTokens, triggerTerms, df (word -> entry count), N, muted.
function scoreCandidate(e, ctx) {
  const { errorText, errTokens, triggerTerms, df, N, muted } = ctx;
  let score = 0;
  let rare = 0;
  const sharedWords = [];
  for (const w of e.toks) {
    if (!errTokens.has(w)) continue;
    sharedWords.push(w);
    const d = df.get(w) || 1;
    score += Math.log2(1 + N / d);
    if (d <= RARE_DF && w.length >= RARE_MIN_LEN) rare++;
  }
  const text = e.line.toLowerCase();
  const triggerHit = triggerTerms.some((term) => text.includes(term));
  if (triggerHit) score += 4;
  if (entryKind(e.line) === 'pitfall') score += 0.5;
  // Gate, not just score: a curated trigger, or two shared words one of
  // which is rare, so overlap on ambient words never fires the hook.
  if (!(triggerHit || (rare >= 1 && sharedWords.length >= MIN_SHARED))) return null;
  const id = entryId(e.line);
  const trigIdx = triggerIndexes(errorText, e.line);
  if (isMuted(muted, id, errTokens, trigIdx)) return null;
  return { line: e.line, toks: e.toks, score, id, sig: { tokens: sharedWords, trig: trigIdx } };
}

// Collapse near-duplicates: several entries saying the same thing add
// noise, not signal, so the best one stands for them.
function isDuplicateOf(c, p) {
  return (
    similarity(c.line, p.line) >= 0.5 ||
    (Math.min(c.toks.size, p.toks.size) >= 8 && overlap(c.line, p.line) >= DEDUPE_OVERLAP)
  );
}

function collapseDuplicates(scored, limit) {
  const picked = [];
  for (const c of scored) {
    if (picked.length >= limit) break;
    if (!picked.some((p) => isDuplicateOf(c, p))) picked.push(c);
  }
  return picked;
}

export function findRecall(home, errorText, opts = {}) {
  const { limit = 2, cwd = null } = opts;
  if (!errorText || !ERROR_LINE.test(errorText)) return [];
  const scope = projectKeys(home, cwd);
  const entries = allLiveEntries(home).map((e) => ({ ...e, toks: tokens(e.line) }));
  // How many live entries contain each word: rare words identify a topic,
  // common ones ("install", "session") are ambient.
  const df = new Map();
  for (const e of entries) for (const w of e.toks) df.set(w, (df.get(w) || 0) + 1);
  const ctx = {
    errorText,
    errTokens: tokens(errorText),
    triggerTerms: TRIGGERS.filter((t) => t.re.test(errorText)).flatMap((t) => t.terms),
    df,
    N: entries.length,
    muted: loadJson(home, MUTED_FILE),
  };
  const scored = entries
    .filter((e) => {
      const keys = entryScope(e.line, e.rel);
      return !keys.size || [...keys].some((k) => scope.has(k));
    })
    .map((e) => scoreCandidate(e, ctx))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  return collapseDuplicates(scored, limit);
}

// ---- command ------------------------------------------------------------

// Where the failure text comes from: {payload, raw}, or null to stay
// silent. A hook host always sends JSON, so an unreadable payload is not an
// error report. Only the manual form (`... | amr recall` with no --hook)
// takes stdin as pasted error text.
function readInput(text, flags) {
  const input = { payload: null, raw: text || '' };
  if (!flags.hook && input.raw) return input;
  let stdin = '';
  try {
    stdin = fs.readFileSync(0, 'utf8');
  } catch {}
  if (!stdin.trim()) return input;
  try {
    input.payload = JSON.parse(stdin);
  } catch {
    if (flags.hook) return null;
    input.raw = stdin;
  }
  return input;
}

// The excerpt to score, or '' when nothing failed.
function errorTextFor({ payload, raw }) {
  if (payload && typeof payload === 'object') {
    // A hook payload: act only on a real failure.
    const failure = failureFromPayload(payload);
    return failure === null ? '' : failureExcerpt(failure, { fallbackTail: true });
  }
  // Text handed to the command is an explicit "here is an error".
  return failureExcerpt(raw);
}

// Hits not already shown this session. With no session id there is no way
// to tell sessions apart, so every call is fresh rather than sharing one
// dedupe bucket across unrelated sessions.
function freshHits(home, payload, found) {
  const sid = payload?.session_id || payload?.sessionId || payload?.conversation_id;
  if (!sid) return found;
  const fresh = new Set(filterFresh(home, `s:${sid}`, found.map((h) => h.line)));
  return found.filter((h) => fresh.has(h.line));
}

// Remember what each shown entry matched on, so `amr unhelpful <id>` can
// mute it for that kind of error only.
function rememberHits(home, hits) {
  const last = loadJson(home, LAST_FILE);
  for (const h of hits) if (h.id) last[h.id] = h.sig;
  writeJsonAtomic(path.join(home, '.git', LAST_FILE), last);
}

const HOOK_HEADER =
  'Possibly relevant memory (matched on this tool failure by keyword, so it may not apply; run `amr unhelpful <id>` if it is noise):';

export function cmdRecall(text, flags) {
  const home = ensureRepo();
  const input = readInput(text, flags);
  if (!input) return;
  const errorText = errorTextFor(input);
  if (!errorText) return;
  const { payload } = input;
  const found = findRecall(home, errorText, { cwd: payload?.cwd || process.cwd() });
  const hits = freshHits(home, payload, found);
  if (!hits.length) return;
  const usage = loadUsage(home);
  const show = (h) => renderEntry(h.line, usage[h.id]?.last ?? null);
  rememberHits(home, hits);
  if (!flags.hook) {
    for (const h of hits) out(h.id ? `${show(h)} [recall id: ${h.id}]` : show(h));
    return;
  }
  const ev = String(payload?.hook_event_name || '');
  out(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: /^PostToolUse(Failure)?$/.test(ev) ? ev : 'PostToolUse',
        additionalContext: `${HOOK_HEADER}\n${hits.map(show).join('\n')}`,
      },
    })
  );
}
