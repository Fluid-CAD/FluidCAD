import { describe, it, expect } from 'vitest';
import { SketchSplit, type SketchSplitSpec } from '../src/sketch-split.ts';

// The sketch Split tool's statement transform: the statement keeps the first
// piece and its name, the second piece binds right after it, references and
// constraints follow the rule table, and the junction coincident(s) land
// through the emission rail.

const src = (...body: string[]): string => [
  `import { sketch, line, arc, circle } from "fluidcad/core";`,
  `import { coincident, horizontal, distance, equal } from "fluidcad/constraints";`,
  ``,
  `sketch('xy', () => {`,
  ...body.map(l => `  ${l}`),
  `});`,
].join('\n');

const LINE_PIECES: SketchSplitSpec['pieces'] = [
  { kind: 'line', start: [0, 0], end: [10, 0] },
  { kind: 'line', start: [10, 0], end: [40, 0] },
];

describe('SketchSplit.apply', () => {
  it('splits a line: first piece keeps the name, second binds after it, junction appended', async () => {
    const code = src(
      `const l1 = line([0, 0], [40, 0]);`,
      `const l2 = line([40, 0], [40, 20]);`,
      `coincident(l1.end(), l2.start());`,
      `horizontal(l1);`,
    );
    const result = await SketchSplit.apply(code, { sketchLine: 4, line: 5, pieces: LINE_PIECES });
    expect(result.error).toBeUndefined();
    expect(result.names).toEqual(['l1', 'l3']);
    expect(result.newCode).toBe(src(
      `const l1 = line([0, 0], [10, 0]);`,
      `const l3 = line([10, 0], [40, 0]);`,
      `const l2 = line([40, 0], [40, 20]);`,
      `coincident(l3.end(), l2.start());`,
      `horizontal(l1);`,
      `horizontal(l3);`,
      `coincident(l1.end(), l3.start());`,
    ));
  });

  it('keeps the untouched argument expressions verbatim and hoists an unbound statement', async () => {
    const code = src(
      `line([0, 0], [w, h]);`,
    );
    const result = await SketchSplit.apply(code, { sketchLine: 4, line: 5, pieces: LINE_PIECES });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(src(
      `const l1 = line([0, 0], [10, 0]);`,
      `const l2 = line([10, 0], [w, h]);`,
      `coincident(l1.end(), l2.start());`,
    ));
  });

  it('carries a length dimension across both pieces and drops what no piece can hold', async () => {
    const code = src(
      `const l1 = line([0, 0], [40, 0]);`,
      `const l2 = line([0, 10], [40, 10]);`,
      `distance(l1.start(), l1.end(), 40);`,
      `equal(l1, l2);`,
    );
    const result = await SketchSplit.apply(code, { sketchLine: 4, line: 5, pieces: LINE_PIECES });
    expect(result.error).toBeUndefined();
    expect(result.removed).toEqual([{ line: 8, kind: 'equal' }]);
    expect(result.newCode).toBe(src(
      `const l1 = line([0, 0], [10, 0]);`,
      `const l3 = line([10, 0], [40, 0]);`,
      `const l2 = line([0, 10], [40, 10]);`,
      `distance(l1.start(), l3.end(), 40);`,
      `coincident(l1.end(), l3.start());`,
    ));
  });

  it('moves a position-bound constraint to the piece its locus falls on', async () => {
    const code = src(
      `const l1 = line([0, 0], [40, 0]);`,
      `const p1 = point([30, 0]);`,
      `const p2 = point([5, 0]);`,
      `coincident(p1, l1);`,
      `coincident(p2, l1);`,
    );
    const result = await SketchSplit.apply(code, {
      sketchLine: 4, line: 5, pieces: LINE_PIECES,
      assignments: [{ line: 8, piece: 1 }, { line: 9, piece: 0 }],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`coincident(p1, l2);`);
    expect(result.newCode).toContain(`coincident(p2, l1);`);
  });

  it('lists the second piece next to the first in an array argument', async () => {
    const code = src(
      `const l1 = line([0, 0], [40, 0]);`,
      `const l2 = line([0, 10], [40, 10]);`,
      `mirror([l1, l2], yAxis());`,
    );
    const result = await SketchSplit.apply(code, { sketchLine: 4, line: 5, pieces: LINE_PIECES });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`mirror([l1, l3, l2], yAxis());`);
  });

  it('splits an arc: modifiers copied, center coincident added, radius kept on the first piece', async () => {
    const code = src(
      `const a1 = arc([10, 0], [0, 10], [0, 0]).cw().guide();`,
      `radius(a1, 10);`,
      `coincident(a1.end(), origin());`,
    );
    const result = await SketchSplit.apply(code, {
      sketchLine: 4, line: 5,
      pieces: [
        { kind: 'arc', start: [10, 0], end: [0, -10], center: [0, 0], cw: true },
        { kind: 'arc', start: [0, -10], end: [0, 10], center: [0, 0], cw: true },
      ],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(src(
      `const a1 = arc([10, 0], [0, -10], [0, 0]).cw().guide();`,
      `const a2 = arc([0, -10], [0, 10], [0, 0]).cw().guide();`,
      `radius(a1, 10);`,
      `coincident(a2.end(), origin());`,
      `coincident(a1.end(), a2.start());`,
      `coincident(a1.center(), a2.center());`,
    ));
  });

  it('turns a circle into a full-turn arc and imports arc', async () => {
    const code = [
      `import { sketch, circle } from "fluidcad/core";`,
      `import { diameter } from "fluidcad/constraints";`,
      ``,
      `sketch('xy', () => {`,
      `  const c1 = circle([5, 5], 20);`,
      `  diameter(c1, 20);`,
      `});`,
    ].join('\n');
    const result = await SketchSplit.apply(code, {
      sketchLine: 4, line: 5,
      pieces: [{ kind: 'arc', start: [5, 15], end: [5, 15], center: [5, 5], cw: false }],
    });
    expect(result.error).toBeUndefined();
    expect(result.names).toEqual(['c1']);
    expect(result.newCode).toContain(`const c1 = arc([5, 15], [5, 15], [5, 5]);`);
    expect(result.newCode).toContain(`diameter(c1, 20);`);
    expect(result.newCode).toMatch(/import \{ arc, sketch, circle \} from "fluidcad\/core";/);
    expect(result.sketchLine).toBe(4);
  });

  it('settles the sketch on the solved geometry before cutting', async () => {
    const code = src(
      `const l1 = line([0, 5], [40, 5]);`,
      `horizontal(l1);`,
    );
    const result = await SketchSplit.apply(code, {
      sketchLine: 4, line: 5, pieces: LINE_PIECES,
      settle: [{ sourceLine: 5, points: [
        { pointIndex: 0, position: [0, 0], expected: [0, 5] },
        { pointIndex: 1, position: [40, 0], expected: [40, 5] },
      ] }],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(src(
      `const l1 = line([0, 0], [10, 0]);`,
      `const l2 = line([10, 0], [40, 0]);`,
      `horizontal(l1);`,
      `horizontal(l2);`,
      `coincident(l1.end(), l2.start());`,
    ));
  });

  it('refuses a midpoint reference in geometry, a looped statement and a non-entity statement', async () => {
    const mid = await SketchSplit.apply(src(
      `const l1 = line([0, 0], [40, 0]);`,
      `line(l1.mid(), [20, 20]);`,
    ), { sketchLine: 4, line: 5, pieces: LINE_PIECES });
    expect(mid.error).toMatch(/l1\.mid\(\)/);

    const loop = await SketchSplit.apply(src(
      `for (let i = 0; i < 2; i++) {`,
      `  line([0, i], [40, i]);`,
      `}`,
    ), { sketchLine: 4, line: 6, pieces: LINE_PIECES });
    expect(loop.error).toMatch(/inside a loop/);

    const notEntity = await SketchSplit.apply(src(
      `const l1 = line([0, 0], [40, 0]);`,
      `horizontal(l1);`,
    ), { sketchLine: 4, line: 6, pieces: LINE_PIECES });
    expect(notEntity.error).toMatch(/horizontal\(\) statement/);

    const drifted = await SketchSplit.apply(src(
      `const l1 = line([0, 0], [40, 0]);`,
    ), { sketchLine: 4, line: 5, pieces: [{ kind: 'arc', start: [0, 0], end: [1, 1], center: [0, 1], cw: false }] });
    expect(drifted.error).toMatch(/source changed/);
  });

  it('removes a midpoint constraint on the line and reports it', async () => {
    const code = src(
      `const l1 = line([0, 0], [40, 0]);`,
      `const p1 = point([20, 0]);`,
      `coincident(p1, l1.mid());`,
    );
    const result = await SketchSplit.apply(code, { sketchLine: 4, line: 5, pieces: LINE_PIECES });
    expect(result.error).toBeUndefined();
    expect(result.removed).toEqual([{ line: 7, kind: 'coincident' }]);
    expect(result.newCode).not.toContain('mid()');
  });
});
