#!/usr/bin/env node
/**
 * merge-drawing-reads.mjs — merge N independent transcriptions of the same
 * engineering drawing (fluidcad-drawing-read/v1, see
 * ../references/transcription-contract.md) into one consensus dimension
 * inventory (fluidcad-drawing-inventory/v1).
 *
 * Entries are aligned across readers by view + sheet position + callout
 * similarity, then compared. Each merged entry gets a status:
 *
 *   agreed    every reader saw it and read the same value
 *   majority  every reader saw it; most agree, the dissent is recorded
 *   partial   at least one reader missed it (those who saw it agree)
 *   conflict  no majority on the value — carries variants only, no value
 *
 * Usage:
 *   node merge-drawing-reads.mjs read-a.json read-b.json [read-c.json ...] \
 *        -o part.drawing.json [--source bracket.pdf]
 *
 * The human-readable report goes to stdout. Without -o, the merged JSON
 * takes stdout and the report moves to stderr. Exit 1 on invalid input —
 * conflicts are data, not errors.
 *
 * No dependencies. Node >= 18.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const KINDS = [
  'linear',
  'diameter',
  'radius',
  'spherical-radius',
  'angle',
  'counterbore',
  'countersink',
  'depth',
  'chamfer',
  'thread',
  'count',
  'note',
];

const CONFIDENCES = ['high', 'medium', 'low'];
const CONF_RANK = { high: 2, medium: 1, low: 0 };
const TITLE_FIELDS = [
  'units',
  'projection',
  'scale',
  'material',
  'general_tolerance',
  'revision',
  'title',
];
const MATCH_THRESHOLD = 3.0;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
const round = (v, dp) => Math.round(v * 10 ** dp) / 10 ** dp;
const approxEq = (a, b) => isNum(a) && isNum(b) && Math.abs(a - b) < 1e-9;

function modal(values) {
  const counts = new Map();
  for (const v of values) {
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best;
  let bestCount = -1;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

function levenshtein(a, b) {
  if (a === b) {
    return 0;
  }
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) {
    return m + n;
  }
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

function textSimilarity(a, b) {
  const x = norm(a);
  const y = norm(b);
  const maxLen = Math.max(x.length, y.length);
  if (maxLen === 0) {
    return 1;
  }
  return 1 - levenshtein(x, y) / maxLen;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Returns a list of error strings; empty means the transcription is valid. */
export function validateTranscription(t, label = 'transcription') {
  const errors = [];
  const err = (path, msg) => errors.push(`${label}: ${path} — ${msg}`);

  if (t === null || typeof t !== 'object' || Array.isArray(t)) {
    err('$', 'expected a JSON object');
    return errors;
  }
  if (t.schema !== undefined && !String(t.schema).startsWith('fluidcad-drawing-read/')) {
    err('schema', `unrecognized schema "${t.schema}"`);
  }
  if (!Array.isArray(t.dimensions)) {
    err('dimensions', 'expected an array');
    return errors;
  }
  t.dimensions.forEach((e, i) => {
    const at = (f) => `dimensions[${i}].${f}`;
    if (e === null || typeof e !== 'object') {
      err(`dimensions[${i}]`, 'expected an object');
      return;
    }
    if (!KINDS.includes(e.kind)) {
      err(at('kind'), `expected one of ${KINDS.join(', ')}; got "${e.kind}"`);
    }
    if (e.kind !== 'note' && !isNum(e.value)) {
      err(at('value'), `expected a number for kind "${e.kind}"; got ${JSON.stringify(e.value)}`);
    }
    if (typeof e.text !== 'string' || e.text.trim() === '') {
      err(at('text'), 'expected the verbatim callout text');
    }
    if (typeof e.view !== 'string' || e.view.trim() === '') {
      err(at('view'), 'expected the name of the view the callout sits in');
    }
    if (
      !Array.isArray(e.loc) ||
      e.loc.length !== 2 ||
      !e.loc.every((v) => isNum(v) && v >= 0 && v <= 1)
    ) {
      err(at('loc'), 'expected [x, y] with each value in 0..1');
    }
    if (e.count !== undefined && (!Number.isInteger(e.count) || e.count < 1)) {
      err(at('count'), `expected a positive integer; got ${JSON.stringify(e.count)}`);
    }
    if (e.confidence !== undefined && !CONFIDENCES.includes(e.confidence)) {
      err(at('confidence'), `expected one of ${CONFIDENCES.join(', ')}; got "${e.confidence}"`);
    }
  });
  if (t.questions !== undefined && !Array.isArray(t.questions)) {
    err('questions', 'expected an array of strings');
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Clustering — align entries across readers
// ---------------------------------------------------------------------------

function clusterLoc(cluster) {
  const xs = cluster.members.map((m) => m.entry.loc[0]);
  const ys = cluster.members.map((m) => m.entry.loc[1]);
  return [xs.reduce((a, b) => a + b, 0) / xs.length, ys.reduce((a, b) => a + b, 0) / ys.length];
}

function scoreAgainstCluster(cluster, entry) {
  const members = cluster.members.map((m) => m.entry);
  const viewScore = members.some((m) => norm(m.view) === norm(entry.view)) ? 2 : -1.5;
  const [cx, cy] = clusterLoc(cluster);
  const d = Math.hypot(entry.loc[0] - cx, entry.loc[1] - cy);
  const locScore = d <= 0.04 ? 2 : d <= 0.1 ? 1.2 : d <= 0.2 ? 0 : -3;
  const kindScore = entry.kind === modal(members.map((m) => m.kind)) ? 1 : 0;
  const valueScore = members.some(
    (m) => (m.kind === 'note' && entry.kind === 'note') || approxEq(m.value, entry.value),
  )
    ? 1.5
    : 0;
  const sim = Math.max(...members.map((m) => textSimilarity(m.text, entry.text)));
  const textScore = sim >= 0.75 ? 1 : sim >= 0.5 ? 0.5 : 0;
  return viewScore + locScore + kindScore + valueScore + textScore;
}

function clusterEntries(reads) {
  const clusters = reads[0].dimensions.map((entry) => ({
    members: [{ reader: reads[0].label, entry }],
  }));
  for (let i = 1; i < reads.length; i++) {
    const { label, dimensions } = reads[i];
    const pairs = [];
    clusters.forEach((cluster, ci) => {
      dimensions.forEach((entry, ei) => {
        const score = scoreAgainstCluster(cluster, entry);
        if (score >= MATCH_THRESHOLD) {
          pairs.push({ ci, ei, score });
        }
      });
    });
    pairs.sort((a, b) => b.score - a.score);
    const usedClusters = new Set();
    const usedEntries = new Set();
    for (const { ci, ei } of pairs) {
      if (usedClusters.has(ci) || usedEntries.has(ei)) {
        continue;
      }
      usedClusters.add(ci);
      usedEntries.add(ei);
      clusters[ci].members.push({ reader: label, entry: dimensions[ei] });
    }
    dimensions.forEach((entry, ei) => {
      if (!usedEntries.has(ei)) {
        clusters.push({ members: [{ reader: label, entry }] });
      }
    });
  }
  return clusters;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

function agreementKey(e) {
  const value = e.kind === 'note' ? '' : String(round(e.value, 6));
  return `${e.kind}|${value}|${e.count ?? 1}|${norm(e.unit ?? '')}`;
}

function confidenceOf(e) {
  return e.confidence ?? 'medium';
}

function mergeCluster(cluster, labels) {
  const R = labels.length;
  const members = cluster.members;
  const groups = new Map();
  for (const m of members) {
    const key = agreementKey(m.entry);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(m);
  }
  const grouped = [...groups.values()].sort(
    (a, b) =>
      b.length - a.length ||
      b.reduce((s, m) => s + CONF_RANK[confidenceOf(m.entry)], 0) -
        a.reduce((s, m) => s + CONF_RANK[confidenceOf(m.entry)], 0),
  );
  const winner = grouped[0];
  const unanimous = grouped.length === 1;
  const seen = members.length;

  let status;
  if (seen === R) {
    status = unanimous ? 'agreed' : winner.length > R / 2 ? 'majority' : 'conflict';
  } else {
    status = unanimous ? 'partial' : 'conflict';
  }

  const rep = [...winner].sort(
    (a, b) => CONF_RANK[confidenceOf(b.entry)] - CONF_RANK[confidenceOf(a.entry)],
  )[0].entry;
  const targets = members.map((m) => m.entry.target).filter((t) => typeof t === 'string' && t);
  const seenBy = members.map((m) => m.reader);

  const out = {
    status,
    kind: rep.kind,
    text: rep.text,
    view: modal(members.map((m) => norm(m.entry.view))),
    count: rep.count ?? 1,
    loc: clusterLoc(cluster).map((v) => round(v, 3)),
    confidence: winner.reduce(
      (worst, m) => (CONF_RANK[confidenceOf(m.entry)] < CONF_RANK[worst] ? confidenceOf(m.entry) : worst),
      'high',
    ),
    readers_seen: seenBy,
  };
  // A conflict has no trustworthy canonical value — force consumers to the variants.
  if (status !== 'conflict' && rep.kind !== 'note') {
    out.value = rep.value;
  }
  if (rep.unit !== undefined) {
    out.unit = rep.unit;
  }
  if (targets.length > 0) {
    out.target = targets.sort((a, b) => b.length - a.length)[0];
  }
  const missing = labels.filter((l) => !seenBy.includes(l));
  if (missing.length > 0) {
    out.missing_from = missing;
  }
  if (status !== 'agreed') {
    out.variants = members.map((m) => ({
      reader: m.reader,
      ...(m.entry.kind === 'note' ? {} : { value: m.entry.value }),
      kind: m.entry.kind,
      count: m.entry.count ?? 1,
      ...(m.entry.unit !== undefined ? { unit: m.entry.unit } : {}),
      text: m.entry.text,
      confidence: confidenceOf(m.entry),
    }));
  }
  return out;
}

function mergeTitleBlock(reads) {
  const out = {};
  for (const field of TITLE_FIELDS) {
    const stated = reads
      .map((r) => ({ reader: r.label, value: r.title_block?.[field] }))
      .filter((s) => s.value !== undefined && s.value !== null && String(s.value).trim() !== '');
    if (stated.length === 0) {
      out[field] = { value: null, status: 'unstated' };
      continue;
    }
    const distinct = new Set(stated.map((s) => norm(s.value)));
    if (distinct.size === 1) {
      out[field] = { value: stated[0].value, status: 'agreed', stated_by: stated.length };
    } else {
      out[field] = {
        value: null,
        status: 'conflict',
        variants: Object.fromEntries(stated.map((s) => [s.reader, s.value])),
      };
    }
  }
  return out;
}

function mergeViews(reads) {
  const byName = new Map();
  for (const r of reads) {
    for (const v of r.views ?? []) {
      if (typeof v?.name !== 'string' || v.name.trim() === '') {
        continue;
      }
      const key = norm(v.name);
      if (!byName.has(key)) {
        byName.set(key, { name: v.name, types: [], seen_by: [] });
      }
      const rec = byName.get(key);
      if (typeof v.type === 'string') {
        rec.types.push(v.type);
      }
      rec.seen_by.push(r.label);
    }
  }
  return [...byName.values()].map((rec) => ({
    name: rec.name,
    type: rec.types.length > 0 ? modal(rec.types) : 'other',
    seen_by: rec.seen_by,
  }));
}

/**
 * reads: [{ label, dimensions, title_block?, views?, questions? }, ...]
 * Returns the merged inventory object (fluidcad-drawing-inventory/v1).
 */
export function mergeTranscriptions(reads, { source } = {}) {
  if (!Array.isArray(reads) || reads.length < 2) {
    throw new Error('mergeTranscriptions needs at least 2 transcriptions — a single read has nothing to agree with');
  }
  const labels = reads.map((r) => r.label);
  const clusters = clusterEntries(reads);
  const dimensions = clusters
    .map((c) => mergeCluster(c, labels))
    .sort(
      (a, b) =>
        a.view.localeCompare(b.view) || a.loc[1] - b.loc[1] || a.loc[0] - b.loc[0],
    )
    .map((entry, i) => ({ id: `d${i + 1}`, ...entry }));

  const questionSeen = new Set();
  const questions = [];
  for (const r of reads) {
    for (const q of r.questions ?? []) {
      if (typeof q !== 'string' || q.trim() === '') {
        continue;
      }
      const key = norm(q);
      if (!questionSeen.has(key)) {
        questionSeen.add(key);
        questions.push(q);
      }
    }
  }

  const title_block = mergeTitleBlock(reads);
  const count = (status) => dimensions.filter((d) => d.status === status).length;
  const summary = {
    readers: labels,
    agreed: count('agreed'),
    majority: count('majority'),
    partial: count('partial'),
    conflict: count('conflict'),
    low_confidence: dimensions
      .filter((d) => (d.status === 'agreed' || d.status === 'majority') && d.confidence === 'low')
      .map((d) => d.id),
    title_block_conflicts: TITLE_FIELDS.filter((f) => title_block[f].status === 'conflict'),
  };

  return {
    schema: 'fluidcad-drawing-inventory/v1',
    ...(source ? { source } : {}),
    title_block,
    views: mergeViews(reads),
    dimensions,
    questions,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function describeVariants(entry) {
  return entry.variants
    .map((v) => `${v.reader}=${v.kind === 'note' ? `"${v.text}"` : v.value}${v.count > 1 ? ` (${v.count}X)` : ''} [${v.confidence}]`)
    .join('  ');
}

export function formatReport(inv) {
  const s = inv.summary;
  const lines = [];
  lines.push(
    `Merged ${s.readers.length} transcriptions (${s.readers.join(', ')}): ` +
      `${s.agreed} agreed, ${s.majority} majority, ${s.partial} partial, ${s.conflict} conflict.`,
  );
  const section = (title, entries, describe) => {
    if (entries.length === 0) {
      return;
    }
    lines.push('', title);
    for (const e of entries) {
      lines.push(`  ${describe(e)}`);
    }
  };
  const place = (d) => `[${d.view} @ ${d.loc[0]}, ${d.loc[1]}]`;
  section(
    'CONFLICT — no majority; resolve with the user or a fresh whole-sheet look before modeling:',
    inv.dimensions.filter((d) => d.status === 'conflict'),
    (d) => `${d.id} ${place(d)} ${d.kind} "${d.text}": ${describeVariants(d)}`,
  );
  section(
    'MAJORITY — usable, but the dissent is recorded; mention when it drives a functional dimension:',
    inv.dimensions.filter((d) => d.status === 'majority'),
    (d) => `${d.id} ${place(d)} ${d.kind} = ${d.value}: ${describeVariants(d)}`,
  );
  section(
    'PARTIAL — missed by at least one reader (or invented by one); verify before modeling:',
    inv.dimensions.filter((d) => d.status === 'partial'),
    (d) =>
      `${d.id} ${place(d)} ${d.kind} "${d.text}" — seen by ${d.readers_seen.join(', ')}` +
      (d.missing_from ? `, missing from ${d.missing_from.join(', ')}` : ''),
  );
  const lowConf = inv.dimensions.filter((d) => s.low_confidence.includes(d.id));
  section('LOW CONFIDENCE among agreed/majority entries:', lowConf, (d) => `${d.id} ${place(d)} "${d.text}"`);
  section(
    'TITLE BLOCK CONFLICTS:',
    s.title_block_conflicts,
    (f) =>
      `${f}: ${Object.entries(inv.title_block[f].variants)
        .map(([r, v]) => `${r}="${v}"`)
        .join('  ')}`,
  );
  section('READER QUESTIONS for the user:', inv.questions, (q) => `- ${q}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(argv) {
  const inputs = [];
  let out;
  let source;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-o' || arg === '--out') {
      out = argv[++i];
    } else if (arg === '--source') {
      source = argv[++i];
    } else if (arg === '-h' || arg === '--help') {
      console.log(
        'Usage: node merge-drawing-reads.mjs <read.json> <read.json> [more...] -o <part>.drawing.json [--source <drawing file>]',
      );
      return 0;
    } else {
      inputs.push(arg);
    }
  }
  if (inputs.length < 2) {
    console.error('error: need at least 2 transcription files (independent reads of the same sheet)');
    return 1;
  }

  const labels = inputs.map((_, i) => String.fromCharCode(65 + i)); // A, B, C, ...
  const reads = [];
  const errors = [];
  inputs.forEach((file, i) => {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      errors.push(`${file}: ${e.message}`);
      return;
    }
    errors.push(...validateTranscription(parsed, file));
    reads.push({ label: labels[i], ...parsed });
  });
  if (errors.length > 0) {
    console.error('invalid input:\n' + errors.map((e) => `  ${e}`).join('\n'));
    return 1;
  }

  const inventory = mergeTranscriptions(reads, { source });
  const report =
    formatReport(inventory) +
    `\nReaders: ${inputs.map((f, i) => `${labels[i]}=${f}`).join('  ')}`;
  if (out) {
    writeFileSync(out, JSON.stringify(inventory, null, 2) + '\n');
    console.log(report);
    console.log(`\nWrote ${out}`);
  } else {
    console.error(report);
    console.log(JSON.stringify(inventory, null, 2));
  }
  return 0;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun) {
  process.exit(main(process.argv.slice(2)));
}
