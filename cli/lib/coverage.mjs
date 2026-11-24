import fs from 'node:fs';
import path from 'node:path';
import { commit, ensureRepo, numFlag, withLock } from './core.mjs';
import { collectSessions, extractMessages } from './harvest.mjs';
import { resolveJudge, runJudge } from './judge.mjs';

const out = (s = '') => process.stdout.write(s + '\n');

// What "should have been saved" looks like in a user message: durable
// preferences, decisions, confirmations, and root-cause findings.
// STRONG markers alone qualify; WEAK markers only in short messages
// (long dumps happen to contain them by accident).
const STRONG =
  /\b(prefer|always|never|remember|note that|decided|instead of|rather than|default to|don['’]?t use|do not use|we use|sticking with|confirmed|turns out|workaround|the fix was|root cause|deprecated)\b/i;
const WEAK = /\b(shipped|released|pinned|going with)\b/i;

// Non-user prose that rides the user role in transcripts: tool errors,
// context summaries, file/code dumps, listings, test output, diffs,
// annotations, agent-monologue steps (antigravity mixes them into the
// user slot).
const DUMP =
  /^(error:|context summary|#|```|\{|\[|\/|\d+\s|\d+[:|]|[-\w./]+ total \d+|total \d+ |diff |--- |@@ |index |[MDAR] \S+\.\w+|response annotations|base directory|permission for this action|stop hook feedback|hook feedback|\[?system)/i;
const heavyMarkup = (t) =>
  (t.match(/[{}"|#*<>_=[\]\\`]/g) || []).length / t.length > 0.12;
const FILE_REFS =
  /\b[\w.-]+\.(?:go|tsx?|mjs|jsx?|cs|json|ya?ml|py|rs|cpp|c|h|png|jpe?g|dll|exe|log|toml|sql|ps1|sh)\b/g;
// Source-code density: several of () ; {} // => == ++ --- is a paste
// of code, not a user statement.
const isCodey = (t) =>
  (t.match(/[{}();]|\/\/|=>|={2,}|[+-]{3,}/g) || []).length >= 4;
const isDump = (t) =>
  DUMP.test(t) ||
  heavyMarkup(t) ||
  isCodey(t) ||
  /[drwx-]{10}/.test(t) ||
  /(\d+ (files?|tests?) (passed|failed))|passed \(\d+\)|RUN v\d|✓/.test(t) ||
  /^(the user (is|asked|wants)|we (need|should|can|must|will)\b)/i.test(t) ||
  (t.match(FILE_REFS) || []).length >= 3;
const flagged = (t) => STRONG.test(t) || (t.length < 200 && WEAK.test(t));
const isDurable = (t) => !isDump(t) && flagged(t);
// Unflagged-but-plausible: what the heuristic silently drops. A bounded
// sample of this goes to the judge so the heuristic's false-negative
// rate is measured instead of assumed.
const isChatter = (t) => !isDump(t) && !flagged(t);

const STOP = new Set(
  'the a an and or but with this that from into your you for are was were have has been not all can will would could should about when what which there their they them then than also just like over under more some any each other such only very make made does done here need want keep lets'.split(
    ' '
  )
);

// Most distinctive terms first: code tokens and long words carry the
// signal that a memory entry would share.
const terms = (text) =>
  [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_.\/-]+/gu, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !STOP.has(w))
    ),
  ]
    .sort((a, b) => b.length - a.length)
    .slice(0, 12);

const normWords = (t) =>
  t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_.\/-]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

const walkMd = (home) => {
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md') && e.name !== 'pending-saves.md')
        files.push(p);
    }
  })(home);
  return files;
};

const corpusText = (home) =>
  ` ${walkMd(home)
    .map((p) => normWords(fs.readFileSync(p, 'utf8')).join(' '))
    .join(' ')} `;

// Individual memory entries for the judge prompt — bounded so the
// prompt stays small even on large repos.
const corpusLines = (home) =>
  walkMd(home)
    .flatMap((p) => fs.readFileSync(p, 'utf8').split(/\r?\n/))
    .filter((l) => l.trim().startsWith('- '))
    .slice(0, 200);

// A durable signal counts as covered when a 4-word run of its content
// appears verbatim in the corpus (near-verbatim save), or when ≥35% of
// its distinctive terms appear (paraphrased save). Term hits are
// prefix-aware at 6 chars so prefer matches prefers/preference.
const covered = (text, corpus) => {
  const content = normWords(text).filter(
    (w) => w.length >= 4 && !STOP.has(w)
  );
  for (let i = 0; i + 4 <= content.length; i++)
    if (corpus.includes(` ${content.slice(i, i + 4).join(' ')} `))
      return true;
  const t = terms(text);
  if (!t.length) return false;
  const hit = (w) =>
    corpus.includes(` ${w} `) ||
    corpus.includes(` ${w.slice(0, Math.min(6, w.length))}`);
  const hits = t.filter(hit).length;
  return hits / t.length >= 0.35;
};

// One bounded judge call: prune recall cues and chatter from the
// deterministic candidate set, decide coverage semantically (paraphrase
// saves the term-overlap check misses), and distill a proposed entry
// per miss so pending review is approve/reject instead of rewrite.
function judgePass(name, candidates, unflagged, corpus) {
  const row = (c, i) =>
    `${i}\t[${c.host}] ${c.mtime.slice(0, 10)}\t${c.text
      .slice(0, 300)
      .replace(/\s+/g, ' ')}`;
  const prompt = [
    'You are auditing save coverage for an agent memory system.',
    '',
    'SECTION A — flagged candidates (index<TAB>[host] date<TAB>text):',
    candidates.slice(0, 40).map(row).join('\n') || '(none)',
    '',
    'SECTION B — unflagged sample (the deterministic filter said these were NOT durable; catch its false negatives):',
    unflagged.map(row).join('\n') || '(none)',
    '',
    'MEMORY — entries already saved:',
    corpus.join('\n') || '(empty)',
    '',
    'For every index in BOTH sections decide:',
    '- durable: it states a durable preference, decision, correction, rule, fact, or root cause worth persisting across sessions. Recall cues ("remember that?"), task chatter, status updates, and transient context are NOT durable.',
    '- covered: the durable content is already represented in MEMORY (paraphrase counts).',
    '- proposal: if durable and not covered, one concise memory entry suitable for `amr add`.',
    '',
    'Reply with ONLY JSON: {"flagged":[{"i":0,"durable":true,"covered":false,"proposal":"..."}],"unflagged":[{"i":0,"durable":false}]} — one entry per index in each section.',
  ].join('\n');
  const text = runJudge(name, prompt);
  if (!text) return null;
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try {
    const r = JSON.parse(text.slice(s, e + 1));
    return {
      flagged: Array.isArray(r?.flagged) ? r.flagged : [],
      unflagged: Array.isArray(r?.unflagged) ? r.unflagged : [],
    };
  } catch {
    return null;
  }
}

function applyVerdicts(durable, verdicts) {
  const byIdx = new Map(verdicts.map((v) => [v.i, v]));
  for (let i = durable.length - 1; i >= 0; i--) {
    const v = byIdx.get(i);
    if (!v) continue;
    if (v.durable === false) {
      durable.splice(i, 1);
      continue;
    }
    if (typeof v.covered === 'boolean') durable[i].covered = v.covered;
    if (typeof v.proposal === 'string' && v.proposal.trim())
      durable[i].proposal = v.proposal.trim().slice(0, 200);
  }
}

export function cmdCoverage(flags) {
  const home = ensureRepo();
  const days = numFlag(flags.days ?? '7', 7);
  const since = flags.since
    ? new Date(flags.since).getTime()
    : Date.now() - days * 864e5;
  const max = numFlag(flags.max || '400', 400);

  const found = collectSessions(since);
  const msgs = extractMessages(found, { max, since });
  const corpus = corpusText(home);

  const seen = new Set();
  const durable = [];
  const chatter = [];
  for (const m of msgs) {
    const key = m.text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    if (isDurable(m.text))
      durable.push({ ...m, covered: covered(m.text, corpus) });
    else if (isChatter(m.text)) chatter.push(m);
  }
  // Stratified sample of the unflagged pool — the judge checks it for
  // false negatives so the metric measures heuristic recall, not just
  // flagged-message coverage.
  const step = Math.max(1, Math.floor(chatter.length / 30));
  const sample = chatter.filter((_, i) => i % step === 0).slice(0, 30);
  const unflaggedDurable = [];

  // Optional judge pass. AMR_NO_JUDGE is set on judge child processes so
  // a spawned host session's own hooks can't recurse into judging.
  let judge = null;
  if (flags.judge !== undefined && !process.env.AMR_NO_JUDGE) {
    const name = resolveJudge(flags.judge, { purpose: 'coverage' });
    if (!name)
      out(
        `note: --judge ${flags.judge === true ? '' : flags.judge + ' '}unavailable — deterministic results`
      );
    else {
      const verdicts = judgePass(name, durable, sample, corpusLines(home));
      if (verdicts === null)
        out(`note: judge ${name} failed — deterministic results`);
      else {
        judge = name;
        applyVerdicts(durable, verdicts.flagged);
        const byIdx = new Map(verdicts.unflagged.map((v) => [v.i, v]));
        for (let i = 0; i < sample.length; i++) {
          const v = byIdx.get(i);
          if (v?.durable !== true) continue;
          unflaggedDurable.push({
            ...sample[i],
            unflagged: true,
            covered: v.covered === true,
            proposal:
              typeof v.proposal === 'string' && v.proposal.trim()
                ? v.proposal.trim().slice(0, 200)
                : undefined,
          });
        }
      }
    }
  }

  const hits = durable.filter((d) => d.covered).length;
  const missed = [
    ...durable.filter((d) => !d.covered),
    ...unflaggedDurable.filter((d) => !d.covered),
  ];
  const rate = durable.length ? Math.round((hits / durable.length) * 100) : null;
  // Extrapolate the sample to the whole chatter pool for an adjusted
  // estimate of the true save rate.
  const ufCovered = unflaggedDurable.filter((d) => d.covered).length;
  const estDurable =
    sample.length && judge
      ? durable.length +
        Math.round((chatter.length * unflaggedDurable.length) / sample.length)
      : null;
  const estRate =
    estDurable !== null && estDurable > 0
      ? Math.round(
          (100 *
            (hits +
              Math.round((chatter.length * ufCovered) / sample.length))) /
            estDurable
        )
      : null;

  // The queue the next session reviews: misses become candidates in
  // `amr context`, drain when saved, and age out with the window.
  // Rewritten every run; excluded from the corpus so it can't
  // self-cover.
  const pending = path.join(home, 'dreams', 'pending-saves.md');
  withLock(home, () => {
    fs.mkdirSync(path.dirname(pending), { recursive: true });
    if (missed.length) {
      const body = [
        '# Pending memory candidates',
        '',
        'Durable-sounding user statements not found in memory.',
        'Review: `amr add` the real ones; ignore the rest.',
        '',
        ...missed
          .slice(0, 15)
          .map(
            (m) =>
              `- [${m.host}] ${m.mtime.slice(0, 10)} ${m.proposal || m.text.slice(0, 200)}`
          ),
      ].join('\n');
      fs.writeFileSync(pending, body + '\n');
    } else fs.rmSync(pending, { force: true });
  });

  if (flags.json)
    return out(
      JSON.stringify(
        {
          days,
          judge,
          transcripts: found.length,
          messages: msgs.length,
          durable: durable.length,
          covered: hits,
          rate,
          unflagged: judge
            ? {
                pool: chatter.length,
                sampled: sample.length,
                durable: unflaggedDurable.length,
                covered: ufCovered,
              }
            : null,
          estRate,
          missed: missed.map((m) => ({
            host: m.host,
            date: m.mtime.slice(0, 10),
            unflagged: !!m.unflagged,
            text: m.text.slice(0, 300),
            proposal: m.proposal || null,
          })),
        },
        null,
        2
      )
    );

  if (!durable.length && !missed.length)
    return out(`no durable signals found in ${found.length} transcript(s), ${days}d`);
  out(
    `coverage (${days}d${judge ? `, judge:${judge}` : ''}): ${hits}/${durable.length} durable signals covered — save rate ${rate === null ? 'n/a' : rate + '%'}`
  );
  if (judge && sample.length)
    out(
      `unflagged sample: ${unflaggedDurable.length}/${sample.length} durable (pool ${chatter.length}) → adjusted save rate ≈ ${estRate}%`
    );
  if (missed.length) {
    out('missed:');
    for (const m of missed.slice(0, 20))
      out(
        `  [${m.host}] ${m.mtime.slice(0, 10)}${m.unflagged ? ' (unflagged)' : ''} ${m.text.slice(0, 140)}`
      );
    if (missed.length > 20) out(`  … +${missed.length - 20} more`);
  }
  out(
    'note: user-stated signals only; facts the agent learned silently are not observable from transcripts'
  );

  // Trend line: append this run so the metric has history.
  if (!flags['no-log']) {
    const log = path.join(home, 'dreams', 'coverage.jsonl');
    const entry = {
      ts: new Date().toISOString(),
      days,
      judge,
      durable: durable.length,
      covered: hits,
      rate,
      unflagged: judge
        ? { pool: chatter.length, sampled: sample.length, durable: unflaggedDurable.length }
        : null,
      estRate,
    };
    withLock(home, () => {
      fs.mkdirSync(path.dirname(log), { recursive: true });
      fs.appendFileSync(log, JSON.stringify(entry) + '\n');
      const files = ['dreams/coverage.jsonl'];
      if (fs.existsSync(pending)) files.push('dreams/pending-saves.md');
      commit(home, files, `Coverage ${rate}% (${hits}/${durable.length})`);
    });
  }
}
