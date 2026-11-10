// Stable short entry IDs. Every entry carries `id: xxxx` in its meta
// bracket; `amr update <id>` and `amr supersede <id>` address entries by
// it, across all memory files, so a typo in the text can't miss.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  addDays,
  commit,
  ensureRepo,
  git,
  hasRemote,
  loadConfig,
  today,
  trailingMeta,
  ttlDays,
  withLock,
} from './core.mjs';
import { drainReflections } from './pending.mjs';

const out = (s = '') => process.stdout.write(s + '\n');
const err = (s) => process.stderr.write(s + '\n');

export const ID_RE = /^[0-9a-f]{4,8}$/;
const META_ID = /\bid:\s*([0-9a-f]{4,8})\b/;

export const entryId = (line) => (trailingMeta(line).match(META_ID) || [])[1] || null;

function memFiles(home) {
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md'))
        files.push(path.relative(home, p).split(path.sep).join('/'));
    }
  })(home);
  return files;
}

const isEntry = (l) => l.trim().startsWith('- ') && !l.includes('[[');

export function scanIds(home) {
  const ids = new Set();
  for (const rel of memFiles(home))
    for (const l of fs.readFileSync(path.join(home, rel), 'utf8').split(/\r?\n/)) {
      const id = isEntry(l) && entryId(l);
      if (id) ids.add(id);
    }
  return ids;
}

// 4 hex chars; grows only if the space gets crowded.
export function newId(taken) {
  for (let len = 4; len <= 8; len++)
    for (let i = 0; i < 50; i++) {
      const id = crypto.randomBytes(4).toString('hex').slice(0, len);
      if (!taken.has(id)) {
        taken.add(id);
        return id;
      }
    }
  throw new Error('could not allocate an entry id');
}

export function findById(home, id) {
  const hits = [];
  for (const rel of memFiles(home)) {
    const lines = fs.readFileSync(path.join(home, rel), 'utf8').split(/\r?\n/);
    lines.forEach((l, i) => {
      if (isEntry(l) && entryId(l) === id) hits.push({ rel, line: i });
    });
  }
  return hits.length === 1 ? hits[0] : null;
}

const stripId = (meta) => meta.replace(/;?\s*id:\s*[0-9a-f]{4,8}/, '');

// Add an id to every live entry that lacks one. Returns the count.
export function backfillIds(home) {
  const taken = scanIds(home);
  const touched = [];
  let n = 0;
  for (const rel of memFiles(home)) {
    const abs = path.join(home, rel);
    const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
    let changed = false;
    lines.forEach((l, i) => {
      if (!isEntry(l) || entryId(l)) return;
      const id = newId(taken);
      const m = l.match(/(\[[^\]]*\])\s*$/);
      lines[i] = m
        ? l.replace(/\]\s*$/, `; id: ${id}]`)
        : `${l.trimEnd()} [id: ${id}]`;
      changed = true;
      n++;
    });
    if (changed) {
      fs.writeFileSync(abs, lines.join('\n'));
      touched.push(rel);
    }
  }
  return { n, touched };
}

export function cmdIds() {
  const home = ensureRepo();
  const { n, touched } = withLock(home, () => {
    const r = backfillIds(home);
    if (r.n) commit(home, r.touched, `Assign ids to ${r.n} entries`);
    return r;
  });
  if (n && hasRemote(home)) git(home, ['push'], { timeout: 10000 });
  out(n ? `assigned ids to ${n} entr${n === 1 ? 'y' : 'ies'} in ${touched.length} file(s)` : 'all entries already have ids');
}

// amr delete <id> — a real delete: the entry leaves the tree entirely.
// No archive copy (that is what supersede is for); the committed git
// history is the recovery path (`amr search --history <term>`).
export function cmdDelete(id) {
  const home = ensureRepo();
  if (!ID_RE.test(id)) throw new Error('usage: amr delete <id>');
  const rel = withLock(home, () => {
    const hit = findById(home, id);
    if (!hit) return null;
    const abs = path.join(home, hit.rel);
    const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
    lines.splice(hit.line, 1);
    fs.writeFileSync(abs, lines.join('\n').replace(/\n{3,}/g, '\n\n'));
    commit(home, [hit.rel], `Delete memory ${id}`);
    return hit.rel;
  });
  if (!rel) {
    err(`no entry with id ${id}`);
    process.exitCode = 1;
    return;
  }
  drainReflections(home, '', [id]);
  if (hasRemote(home)) git(home, ['push'], { timeout: 10000 });
  out(`deleted ${id} from ${rel} (history keeps it: amr search --history "term")`);
}

// amr supersede <id> ["replacement"] — retire an entry. The old line moves
// to archive/superseded.md (searchable, never injected); an optional
// replacement is saved in the same file with `supersedes: <id>`.
export function cmdSupersede(id, text) {
  const home = ensureRepo();
  if (!ID_RE.test(id)) throw new Error('usage: amr supersede <id> ["replacement text"]');
  const result = withLock(home, () => {
    const hit = findById(home, id);
    if (!hit) return null;
    const abs = path.join(home, hit.rel);
    const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
    const old = lines[hit.line];
    const newid = text ? newId(scanIds(home)) : null;
    if (text) {
      const kind = (old.match(/kind:\s*([a-z-]+)/) || [])[1];
      const proj = (old.match(/project:\s*([^;\]]+)/) || [])[1];
      const meta = [`added: ${today()}`];
      if (kind) meta.push(`kind: ${kind}`);
      // A replacement of a TTL'd entry gets a fresh TTL, same as an
      // update; replacing a durable entry stays durable.
      if (/expires:\s*\d{4}-\d{2}-\d{2}/.test(old))
        meta.push(`expires: ${addDays(ttlDays(text, loadConfig(home), kind))}`);
      // The check command describes the thing, not the wording: it carries over.
      const verify = (trailingMeta(old).match(/verify:\s*([^;]*)/) || [])[1];
      if (verify) meta.push(`verify: ${verify.trim()}`);
      if (proj) meta.push(`project: ${proj.trim()}`);
      meta.push(`supersedes: ${id}`, `id: ${newid}`);
      lines[hit.line] = `- ${text.replace(/\s+/g, ' ').trim()} [${meta.join('; ')}]`;
    } else lines.splice(hit.line, 1);
    fs.writeFileSync(abs, lines.join('\n').replace(/\n{3,}/g, '\n\n'));
    const arch = path.join(home, 'archive', 'superseded.md');
    fs.mkdirSync(path.dirname(arch), { recursive: true });
    if (!fs.existsSync(arch)) fs.writeFileSync(arch, '# superseded\n\n');
    fs.appendFileSync(
      arch,
      `${stripId(old).replace(/\]\s*$/, `; id: ${id}; superseded: ${today()}]`)}\n`
    );
    commit(home, [hit.rel, 'archive/superseded.md'], `Supersede ${id}`);
    return { rel: hit.rel, newid };
  });
  if (!result) {
    err(`no entry with id ${id}`);
    process.exitCode = 1;
    return;
  }
  drainReflections(home, '', [id]);
  if (hasRemote(home)) git(home, ['push'], { timeout: 10000 });
  out(
    result.newid
      ? `superseded ${id} → ${result.newid} in ${result.rel}`
      : `retired ${id} (moved to archive/superseded.md)`
  );
}
