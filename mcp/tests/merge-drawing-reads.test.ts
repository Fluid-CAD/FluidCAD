import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import {
  mergeTranscriptions,
  validateTranscription,
  formatReport,
  // @ts-ignore — plain-JS skill script, no type declarations
} from '../skills/FluidCAD-from-drawing/scripts/merge-drawing-reads.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(
  __dirname,
  '../skills/FluidCAD-from-drawing/scripts/merge-drawing-reads.mjs',
);

type Dim = Record<string, unknown>;

const dim = (overrides: Dim): Dim => ({
  kind: 'linear',
  view: 'front',
  confidence: 'high',
  ...overrides,
});

// Three readers over the same synthetic sheet. Locations get per-reader
// jitter to exercise the position-based alignment.
function makeReads() {
  const jitter = (l: [number, number], dx: number, dy: number): [number, number] => [
    Math.min(1, Math.max(0, l[0] + dx)),
    Math.min(1, Math.max(0, l[1] + dy)),
  ];
  const base = {
    overall: dim({ value: 120, text: '120', loc: [0.5, 0.92], target: 'overall width' }),
    bore: dim({ value: 24, kind: 'diameter', text: '⌀24 THRU', loc: [0.42, 0.33], target: 'center bore' }),
    bolt: dim({ value: 8, kind: 'diameter', text: '4X ⌀8', count: 4, loc: [0.61, 0.34], target: 'bolt hole' }),
    cbore: dim({ value: 14, kind: 'counterbore', text: '⌴14', loc: [0.66, 0.4] }),
    note: dim({ kind: 'note', text: 'ALL UNMARKED FILLETS R2', loc: [0.9, 0.95] }),
    depth: dim({ value: 10, kind: 'depth', text: '↧10', view: 'top', loc: [0.3, 0.18] }),
    thick: dim({ value: 15, text: '15', view: 'right', loc: [0.8, 0.3], target: 'plate thickness' }),
  };
  const clone = (d: Dim, dx = 0, dy = 0, extra: Dim = {}): Dim => ({
    ...d,
    loc: jitter(d.loc as [number, number], dx, dy),
    ...extra,
  });

  const readerA = {
    schema: 'fluidcad-drawing-read/v1',
    title_block: { units: 'mm', material: '6061-T6', general_tolerance: '±0.1' },
    views: [{ name: 'front', type: 'orthographic' }, { name: 'top', type: 'orthographic' }],
    dimensions: [
      clone(base.overall),
      clone(base.bore),
      clone(base.bolt),
      clone(base.cbore),
      clone(base.note),
      clone(base.depth), // A reads the top-view depth as 10
      clone(base.thick),
    ],
    questions: ['Is the bolt hole diameter 8 or 3? The scan is blurry there.'],
  };
  const readerB = {
    schema: 'fluidcad-drawing-read/v1',
    title_block: { units: 'mm', material: '6061-T6', general_tolerance: '±0.2' },
    views: [{ name: 'front', type: 'orthographic' }],
    dimensions: [
      clone(base.overall, 0.01, -0.01),
      clone(base.bore, -0.01, 0.01),
      clone(base.bolt, 0.02, 0, { value: 3, text: '4X ⌀3', confidence: 'medium' }), // digit misread
      clone(base.cbore, 0.01, 0.01),
      clone(base.note, 0, 0.01),
      clone(base.depth, 0.01, 0, { value: 12, text: '↧12' }), // conflicting depth read
      clone(base.thick, 0.02, 0.01),
    ],
    questions: ['Is the bolt hole diameter 8 or 3? The scan is blurry there.'], // duplicate
  };
  const readerC = {
    schema: 'fluidcad-drawing-read/v1',
    title_block: { units: 'mm' },
    views: [{ name: 'front', type: 'orthographic' }, { name: 'right', type: 'orthographic' }],
    dimensions: [
      clone(base.overall, -0.01, 0.01),
      clone(base.bore, 0.01, 0, { confidence: 'low' }),
      clone(base.bolt, 0.01, 0.01, { confidence: 'low' }),
      // C misses the counterbore and the top-view depth entirely
      clone(base.note, 0.01, 0),
      clone(base.thick, 0.05, 0.03), // larger jitter, still within the match band
      dim({ value: 5, kind: 'radius', text: 'R5', view: 'right', loc: [0.85, 0.55] }), // only C sees this
    ],
    questions: ['Which revision governs, A or B?'],
  };
  return [
    { label: 'A', ...readerA },
    { label: 'B', ...readerB },
    { label: 'C', ...readerC },
  ];
}

const byText = (inv: any, text: string) =>
  inv.dimensions.find((d: any) => d.text === text || d.variants?.some((v: any) => v.text === text));

describe('merge-drawing-reads', () => {
  const inv = mergeTranscriptions(makeReads(), { source: 'bracket.png' });

  it('validates a well-formed transcription', () => {
    for (const read of makeReads()) {
      expect(validateTranscription(read, read.label)).toEqual([]);
    }
  });

  it('reports schema violations with paths', () => {
    const errors = validateTranscription(
      {
        dimensions: [
          { kind: 'bogus', text: 'x', view: 'front', loc: [0.5, 0.5], value: 1 },
          { kind: 'linear', text: '12', view: 'front', loc: [2, 0.5], value: '12' },
          { kind: 'linear', text: '9', view: 'front' }, // missing loc + value
        ],
      },
      'bad.json',
    );
    expect(errors.join('\n')).toContain('dimensions[0].kind');
    expect(errors.join('\n')).toContain('dimensions[1].value');
    expect(errors.join('\n')).toContain('dimensions[1].loc');
    expect(errors.join('\n')).toContain('dimensions[2].loc');
    expect(errors.join('\n')).toContain('dimensions[2].value');
  });

  it('refuses to merge fewer than 2 reads', () => {
    expect(() => mergeTranscriptions([makeReads()[0]])).toThrow(/at least 2/);
  });

  it('marks unanimous entries agreed and carries the worst confidence', () => {
    const overall = byText(inv, '120');
    expect(overall.status).toBe('agreed');
    expect(overall.value).toBe(120);
    expect(overall.readers_seen).toEqual(['A', 'B', 'C']);
    expect(overall.variants).toBeUndefined();

    const bore = byText(inv, '⌀24 THRU');
    expect(bore.status).toBe('agreed');
    expect(bore.confidence).toBe('low'); // C read it at low confidence
    expect(inv.summary.low_confidence).toContain(bore.id);
  });

  it('detects a digit misread as majority with the dissent recorded', () => {
    const bolt = byText(inv, '4X ⌀8');
    expect(bolt.status).toBe('majority');
    expect(bolt.value).toBe(8);
    expect(bolt.count).toBe(4);
    expect(bolt.variants).toHaveLength(3);
    expect(bolt.variants.find((v: any) => v.reader === 'B').value).toBe(3);
  });

  it('marks a 1-vs-1 disagreement as conflict with no canonical value', () => {
    const depth = byText(inv, '↧10');
    expect(depth.status).toBe('conflict');
    expect(depth.value).toBeUndefined();
    expect(depth.missing_from).toEqual(['C']);
    expect(depth.variants.map((v: any) => v.value).sort()).toEqual([10, 12]);
  });

  it('marks entries missed by a reader as partial', () => {
    const cbore = byText(inv, '⌴14');
    expect(cbore.status).toBe('partial');
    expect(cbore.value).toBe(14);
    expect(cbore.readers_seen).toEqual(['A', 'B']);
    expect(cbore.missing_from).toEqual(['C']);

    const r5 = byText(inv, 'R5');
    expect(r5.status).toBe('partial');
    expect(r5.readers_seen).toEqual(['C']);
  });

  it('merges notes without a value and tolerates loc jitter', () => {
    const note = byText(inv, 'ALL UNMARKED FILLETS R2');
    expect(note.status).toBe('agreed');
    expect(note.value).toBeUndefined();

    const thick = byText(inv, '15');
    expect(thick.status).toBe('agreed'); // C's 0.05/0.03 jitter still aligns
  });

  it('merges the title block field-wise and flags contradictions', () => {
    expect(inv.title_block.units).toMatchObject({ value: 'mm', status: 'agreed', stated_by: 3 });
    expect(inv.title_block.material).toMatchObject({ value: '6061-T6', status: 'agreed', stated_by: 2 });
    expect(inv.title_block.general_tolerance.status).toBe('conflict');
    expect(inv.title_block.general_tolerance.variants).toEqual({ A: '±0.1', B: '±0.2' });
    expect(inv.title_block.projection.status).toBe('unstated');
    expect(inv.summary.title_block_conflicts).toEqual(['general_tolerance']);
  });

  it('assigns stable unique ids and dedupes reader questions', () => {
    const ids = inv.dimensions.map((d: any) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id: string) => /^d\d+$/.test(id))).toBe(true);
    expect(inv.questions).toHaveLength(2); // A and B asked the same question
  });

  it('keeps two nearby same-value callouts as separate entries', () => {
    const two = (label: string) => ({
      label,
      dimensions: [
        dim({ value: 5, kind: 'diameter', text: '⌀5', loc: [0.2, 0.5] }),
        dim({ value: 5, kind: 'diameter', text: '⌀5', loc: [0.28, 0.5] }),
      ],
    });
    const merged = mergeTranscriptions([two('A'), two('B')]);
    expect(merged.dimensions).toHaveLength(2);
    expect(merged.dimensions.every((d: any) => d.status === 'agreed')).toBe(true);
  });

  it('renders a report naming conflicts, partials, and questions', () => {
    const report = formatReport(inv);
    expect(report).toContain('CONFLICT');
    expect(report).toContain('MAJORITY');
    expect(report).toContain('PARTIAL');
    expect(report).toContain('TITLE BLOCK CONFLICTS');
    expect(report).toContain('general_tolerance');
    expect(report).toContain('Which revision governs');
  });

  it('runs as a CLI: merges files, writes the inventory, reports', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'merge-reads-'));
    try {
      const reads = makeReads();
      const files = reads.map((r) => {
        const { label, ...t } = r;
        const file = path.join(dir, `read-${label}.json`);
        writeFileSync(file, JSON.stringify(t));
        return file;
      });
      const out = path.join(dir, 'part.drawing.json');
      const res = spawnSync(
        process.execPath,
        [SCRIPT, ...files, '-o', out, '--source', 'bracket.png'],
        { encoding: 'utf8' },
      );
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('Merged 3 transcriptions');
      expect(res.stdout).toContain(`Wrote ${out}`);
      const written = JSON.parse(readFileSync(out, 'utf8'));
      expect(written.schema).toBe('fluidcad-drawing-inventory/v1');
      expect(written.source).toBe('bracket.png');
      expect(written.dimensions.length).toBe(inv.dimensions.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CLI exits 1 on invalid input, listing every error', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'merge-reads-bad-'));
    try {
      const good = path.join(dir, 'a.json');
      const bad = path.join(dir, 'b.json');
      const { label, ...t } = makeReads()[0];
      writeFileSync(good, JSON.stringify(t));
      writeFileSync(bad, JSON.stringify({ dimensions: [{ kind: 'linear', text: 'x' }] }));
      const res = spawnSync(process.execPath, [SCRIPT, good, bad], { encoding: 'utf8' });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('invalid input');
      expect(res.stderr).toContain('dimensions[0].view');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
