import { describe, it, expect } from 'vitest';
import { applySolvedEmission } from '../src/sketch-solved-edit/index.ts';

// Text statements riding a solved emission: what a drawing import writes
// for the drawing's text — after the constraints, a turned text along a
// guide line of the same emission, a fixed anchor stated right after it.

const EMPTY_SKETCH = [
  `import { sketch } from "fluidcad/core";`,
  ``,
  `sketch('xy', () => {`,
  `});`,
].join('\n');

const bodyOf = (code: string) => code.split('\n').map((line) => line.trim()).filter((line) => line !== '');

describe('applySolvedEmission: texts', () => {
  it('writes a text after the geometry and the constraints, bound to a name of its own', async () => {
    const result = await applySolvedEmission(EMPTY_SKETCH, {
      sketchLine: 3,
      geometry: [{ kind: 'line', text: 'line([0, 0], [40, 0])' }],
      constraints: [{ kind: 'fix', targets: [{ newIndex: 0, role: 'start' }] }],
      texts: [{ string: '"Plate A"', chain: ".font('Liberation Sans').size(7.25).at([10, 20])" }],
    });
    expect(result.error).toBeUndefined();
    const lines = bodyOf(result.newCode);
    const at = (text: string) => lines.indexOf(text);
    expect(at(`const t1 = text("Plate A").font('Liberation Sans').size(7.25).at([10, 20]);`)).toBeGreaterThan(at('fix(l1.start());'));
    expect(at('fix(l1.start());')).toBeGreaterThan(at('const l1 = line([0, 0], [40, 0]);'));
    expect(result.newCode).toMatch(/import \{[^}]*\btext\b[^}]*\} from "fluidcad\/core"/);
    expect(result.names).toEqual(['l1']);
  });

  it('fixes a text by its anchor, right after it, and imports fix for that alone', async () => {
    const result = await applySolvedEmission(EMPTY_SKETCH, {
      sketchLine: 3,
      geometry: [],
      constraints: [],
      texts: [
        { string: '"A"', chain: '.size(5).at([1, 2])', fix: true },
        { string: '"B"', chain: '.size(5).at([3, 4])', fix: true },
      ],
    });
    expect(result.error).toBeUndefined();
    const lines = bodyOf(result.newCode);
    expect(lines.slice(lines.indexOf(`sketch('xy', () => {`) + 1, -1)).toEqual([
      'const t1 = text("A").size(5).at([1, 2]);',
      'const t2 = text("B").size(5).at([3, 4]);',
      'fix(t1.anchor());',
      'fix(t2.anchor());',
    ]);
    expect(result.newCode).toMatch(/import \{[^}]*\bfix\b[^}]*\} from ['"]fluidcad\/constraints['"]/);
  });

  it('writes a turned text along a guide line of the same emission, by the name the line is given', async () => {
    const result = await applySolvedEmission(EMPTY_SKETCH, {
      sketchLine: 3,
      geometry: [
        { kind: 'line', text: 'line([0, 0], [40, 0])' },
        { kind: 'line', text: 'line([30, 20], [30, 45])', guide: true },
      ],
      constraints: [
        { kind: 'fix', targets: [{ newIndex: 1, role: 'start' }] },
        { kind: 'fix', targets: [{ newIndex: 1, role: 'end' }] },
      ],
      texts: [{ string: '"SIDE"', chain: ".font('Liberation Sans').size(5).align('center')", path: 1 }],
    });
    expect(result.error).toBeUndefined();
    const lines = bodyOf(result.newCode);
    expect(lines).toContain('const l2 = line([30, 20], [30, 45]).guide();');
    expect(lines).toContain(`const t1 = text("SIDE", l2).font('Liberation Sans').size(5).align('center');`);
    expect(lines.indexOf(`const t1 = text("SIDE", l2).font('Liberation Sans').size(5).align('center');`)).toBeGreaterThan(lines.indexOf('fix(l2.end());'));
  });

  it('keeps a string as it is written: quotes, a line break, a backslash', async () => {
    const string = JSON.stringify('6" x 4"\nC:\\parts');
    const result = await applySolvedEmission(EMPTY_SKETCH, { sketchLine: 3, geometry: [], constraints: [], texts: [{ string, chain: '' }] });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const t1 = text(${string});`);
    expect(result.newCode).toContain('text("6\\" x 4\\"\\nC:\\\\parts")');
  });

  it('puts a text after the derived operations and before the region declarations of a sketch that has them', async () => {
    const code = [
      `import { sketch, circle, offset, region, text } from "fluidcad/core";`,
      `import { fix } from "fluidcad/constraints";`,
      ``,
      `sketch('xy', () => {`,
      `  const c1 = circle([0, 0], 20);`,
      `  fix(c1.center());`,
      `  const o1 = offset(c1, 2);`,
      `  const t1 = text("old");`,
      `  region('r1', c1);`,
      `});`,
    ].join('\n');
    const result = await applySolvedEmission(code, {
      sketchLine: 4,
      geometry: [{ kind: 'line', text: 'line([0, 0], [40, 0])' }],
      constraints: [{ kind: 'fix', targets: [{ newIndex: 0, role: 'start' }] }],
      texts: [{ string: '"new"', chain: '.at([5, 5])', fix: true }],
    });
    expect(result.error).toBeUndefined();
    const lines = bodyOf(result.newCode);
    expect(lines.slice(lines.indexOf(`sketch('xy', () => {`) + 1, -1)).toEqual([
      'const c1 = circle([0, 0], 20);',
      'const l1 = line([0, 0], [40, 0]);',
      'fix(c1.center());',
      'fix(l1.start());',
      'const o1 = offset(c1, 2);',
      'const t1 = text("old");',
      'const t2 = text("new").at([5, 5]);',
      'fix(t2.anchor());',
      `region('r1', c1);`,
    ]);
  });

  it('writes texts before a trailing return and before an active breakpoint', async () => {
    const returning = [
      `import { sketch, line } from "fluidcad/core";`,
      ``,
      `sketch('xy', () => {`,
      `  const a = line([0, 0], [10, 0]);`,
      `  return { a };`,
      `});`,
    ].join('\n');
    const result = await applySolvedEmission(returning, { sketchLine: 3, geometry: [], constraints: [], texts: [{ string: '"A"', chain: '' }] });
    const lines = bodyOf(result.newCode);
    expect(lines.indexOf('const t1 = text("A");')).toBeLessThan(lines.indexOf('return { a };'));
    expect(lines.indexOf('const t1 = text("A");')).toBeGreaterThan(lines.indexOf('const a = line([0, 0], [10, 0]);'));
  });

  it('refuses a text that is not a string literal, options that are not a chain of plain calls, and a bad path', async () => {
    const emit = (texts: { string: string; chain: string; path?: number; fix?: boolean }[]) => applySolvedEmission(EMPTY_SKETCH, {
      sketchLine: 3,
      geometry: [{ kind: 'point', text: 'point([0, 0])' }, { kind: 'line', text: 'line([0, 0], [1, 0])' }],
      constraints: [],
      texts,
    });
    expect((await emit([{ string: 'process.exit()', chain: '' }])).error).toBe('a text is written as a string literal');
    expect((await emit([{ string: '"a" + evil()', chain: '' }])).error).toBe('a text is written as a string literal');
    expect((await emit([{ string: '"a"', chain: '.size(evil())' }])).error).toBe('invalid text options');
    expect((await emit([{ string: '"a"', chain: '; evil()' }])).error).toBe('invalid text options');
    expect((await emit([{ string: '"a"', chain: '', path: 7 }])).error).toBe('text path 7 is out of range');
    expect((await emit([{ string: '"a"', chain: '', path: 0 }])).error).toBe('a text cannot follow a point');
    expect((await emit([{ string: '"a"', chain: '', path: 1, fix: true }])).error).toBe('a text on a path has no anchor to fix');
    expect((await emit([{ string: '"a"', chain: '', path: 1 }])).error).toBeUndefined();
  });
});
