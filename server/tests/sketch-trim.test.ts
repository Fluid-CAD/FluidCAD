import { describe, it, expect } from 'vitest';
import { SketchTrim, type SketchTrimSpec } from '../src/sketch-trim.ts';

// The sketch Trim tool's statement transform: the statement keeps the first
// surviving piece and its name, a second survivor binds after it, references
// to a vanished point become literals in geometry and delete the constraints
// that named them, whole-entity constraints follow the rule tables, and an
// entity nothing survives of is deleted outright.

const src = (...body: string[]): string => [
  `import { sketch, line, arc, circle } from "fluidcad/core";`,
  `import { coincident, horizontal, distance, equal, fix, diameter } from "fluidcad/constraints";`,
  ``,
  `sketch('xy', () => {`,
  ...body.map(l => `  ${l}`),
  `});`,
].join('\n');

type Pieces = SketchTrimSpec['pieces'];

/** A 40-long line cut at 10 and 30. */
const THREE: Pieces = [
  { kind: 'line', start: [0, 0], end: [10, 0] },
  { kind: 'line', start: [10, 0], end: [30, 0] },
  { kind: 'line', start: [30, 0], end: [40, 0] },
];
/** A 40-long line cut at 10. */
const TWO: Pieces = [
  { kind: 'line', start: [0, 0], end: [10, 0] },
  { kind: 'line', start: [10, 0], end: [40, 0] },
];
const ONE: Pieces = [{ kind: 'line', start: [0, 0], end: [40, 0] }];

describe('SketchTrim.apply', () => {
  it('removes the middle of a line: two pieces, no junction, .end() and the span dimension follow the last', async () => {
    const code = src(
      `const l1 = line([0, 0], [40, 0]);`,
      `const l2 = line([40, 0], [40, 20]);`,
      `coincident(l1.end(), l2.start());`,
      `horizontal(l1);`,
      `distance(l1.start(), l1.end(), 40);`,
    );
    const result = await SketchTrim.apply(code, { sketchLine: 4, line: 5, pieces: THREE, removed: 1 });
    expect(result.error).toBeUndefined();
    expect(result.names).toEqual(['l1', 'l3']);
    expect(result.deleted).toBeUndefined();
    expect(result.newCode).toBe(src(
      `const l1 = line([0, 0], [10, 0]);`,
      `const l3 = line([30, 0], [40, 0]);`,
      `const l2 = line([40, 0], [40, 20]);`,
      `coincident(l3.end(), l2.start());`,
      `horizontal(l1);`,
      `horizontal(l3);`,
      `distance(l1.start(), l3.end(), 40);`,
    ));
  });

  it('removes the end of a line: the constraint on the end goes, geometry hanging off it keeps its place', async () => {
    const code = src(
      `const l1 = line([0, 0], [40, 0]);`,
      `const l2 = line(l1.end(), [50, 50]);`,
      `coincident(l1.end(), l2.start());`,
      `distance(l1.start(), l1.end(), 40);`,
      `horizontal(l1);`,
    );
    const result = await SketchTrim.apply(code, { sketchLine: 4, line: 5, pieces: TWO, removed: 1 });
    expect(result.error).toBeUndefined();
    expect(result.names).toEqual(['l1']);
    expect(result.removed).toEqual([{ line: 7, kind: 'coincident' }, { line: 8, kind: 'distance' }]);
    expect(result.newCode).toBe(src(
      `const l1 = line([0, 0], [10, 0]);`,
      `const l2 = line([40, 0], [50, 50]);`,
      `horizontal(l1);`,
    ));
  });

  it('removes the start of a line: the statement keeps its name, the start pin goes, .end() stays', async () => {
    const code = src(
      `const l1 = line([0, 0], [40, 0]);`,
      `fix(l1.start(), [0, 0]);`,
      `coincident(l1.end(), origin());`,
    );
    const result = await SketchTrim.apply(code, { sketchLine: 4, line: 5, pieces: TWO, removed: 0 });
    expect(result.error).toBeUndefined();
    expect(result.removed).toEqual([{ line: 6, kind: 'fix' }]);
    expect(result.newCode).toBe(src(
      `const l1 = line([10, 0], [40, 0]);`,
      `coincident(l1.end(), origin());`,
    ));
  });

  it('keeps the untouched argument expressions verbatim and leaves an unbound statement unbound', async () => {
    const result = await SketchTrim.apply(src(`line([0, 0], [w, h]);`), { sketchLine: 4, line: 5, pieces: TWO, removed: 1 });
    expect(result.error).toBeUndefined();
    expect(result.names).toEqual([]);
    expect(result.newCode).toBe(src(`line([0, 0], [10, 0]);`));
  });

  it('replaces a midpoint used by geometry with its literal', async () => {
    const code = src(
      `const l1 = line([0, 0], [40, 0]);`,
      `line(l1.mid(), [20, 20]);`,
      `coincident(l1.mid(), origin());`,
    );
    const result = await SketchTrim.apply(code, { sketchLine: 4, line: 5, pieces: TWO, removed: 1 });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`line([20, 0], [20, 20]);`);
    expect(result.newCode).not.toContain('mid()');
    expect(result.removed).toEqual([{ line: 7, kind: 'coincident' }]);
  });

  it('moves a position-bound constraint with its piece and drops one on the removed piece', async () => {
    const code = src(
      `const l1 = line([0, 0], [40, 0]);`,
      `const p1 = point([35, 0]);`,
      `const p2 = point([20, 0]);`,
      `coincident(p1, l1);`,
      `coincident(p2, l1);`,
    );
    const result = await SketchTrim.apply(code, {
      sketchLine: 4, line: 5, pieces: THREE, removed: 1,
      assignments: [{ line: 8, piece: 2 }, { line: 9, piece: 1 }],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const l2 = line([30, 0], [40, 0]);`);
    expect(result.newCode).toContain(`coincident(p1, l2);`);
    expect(result.newCode).not.toContain(`coincident(p2`);
    expect(result.removed).toEqual([{ line: 9, kind: 'coincident' }]);
  });

  it('deletes an entity nothing survives of, with its constraints; its points become literals, its list entry drops', async () => {
    const code = src(
      `const c1 = circle([5, 5], 20);`,
      `const l2 = line(c1.center(), [9, 9]);`,
      `diameter(c1, 20);`,
      `coincident(c1.center(), origin());`,
      `mirror([c1, l2], yAxis());`,
    );
    const result = await SketchTrim.apply(code, {
      sketchLine: 4, line: 5, pieces: [{ kind: 'circle', center: [5, 5], radius: 10 }], removed: 0,
    });
    expect(result.error).toBeUndefined();
    expect(result.deleted).toBe(true);
    expect(result.names).toEqual([]);
    expect(result.removed).toEqual([{ line: 7, kind: 'diameter' }, { line: 8, kind: 'coincident' }]);
    expect(result.newCode).toBe(src(
      `const l2 = line([5, 5], [9, 9]);`,
      `mirror([l2], yAxis());`,
    ));
  });

  it('refuses to delete an entity a derived op needs', async () => {
    const positional = await SketchTrim.apply(src(
      `const l1 = line([0, 0], [40, 0]);`,
      `const l2 = line([40, 0], [40, 20]);`,
      `fillet(l1, l2, 4);`,
    ), { sketchLine: 4, line: 5, pieces: ONE, removed: 0 });
    expect(positional.error).toMatch(/line 7 uses l1/);

    const sole = await SketchTrim.apply(src(
      `const l1 = line([0, 0], [40, 0]);`,
      `mirror([l1], yAxis());`,
    ), { sketchLine: 4, line: 5, pieces: ONE, removed: 0 });
    expect(sole.error).toMatch(/line 6 uses l1/);
  });

  it('turns a circle into the arc that survives and imports arc', async () => {
    const code = [
      `import { sketch, circle } from "fluidcad/core";`,
      `import { diameter } from "fluidcad/constraints";`,
      ``,
      `sketch('xy', () => {`,
      `  const c1 = circle([5, 5], 20);`,
      `  diameter(c1, 20);`,
      `});`,
    ].join('\n');
    const result = await SketchTrim.apply(code, {
      sketchLine: 4, line: 5,
      pieces: [
        { kind: 'arc', start: [15, 5], end: [5, 15], center: [5, 5], cw: false },
        { kind: 'arc', start: [5, 15], end: [15, 5], center: [5, 5], cw: false },
      ],
      removed: 0,
    });
    expect(result.error).toBeUndefined();
    expect(result.names).toEqual(['c1']);
    expect(result.newCode).toContain(`const c1 = arc([5, 15], [15, 5], [5, 5]);`);
    expect(result.newCode).toContain(`diameter(c1, 20);`);
    expect(result.newCode).toMatch(/import \{ arc, sketch, circle \} from "fluidcad\/core";/);
    expect(result.sketchLine).toBe(4);
  });

  it('keeps the two arcs of a trimmed arc on one circle: modifiers copied, center coincident and equal radii appended', async () => {
    const code = src(
      `const a1 = arc([10, 0], [0, 10], [0, 0]).cw().guide();`,
      `radius(a1, 10);`,
      `coincident(a1.end(), origin());`,
    );
    const result = await SketchTrim.apply(code, {
      sketchLine: 4, line: 5,
      pieces: [
        { kind: 'arc', start: [10, 0], end: [0, -10], center: [0, 0], cw: true },
        { kind: 'arc', start: [0, -10], end: [-10, 0], center: [0, 0], cw: true },
        { kind: 'arc', start: [-10, 0], end: [0, 10], center: [0, 0], cw: true },
      ],
      removed: 1,
    });
    expect(result.error).toBeUndefined();
    expect(result.names).toEqual(['a1', 'a2']);
    expect(result.newCode).toBe(src(
      `const a1 = arc([10, 0], [0, -10], [0, 0]).cw().guide();`,
      `const a2 = arc([-10, 0], [0, 10], [0, 0]).cw().guide();`,
      `radius(a1, 10);`,
      `coincident(a2.end(), origin());`,
      `coincident(a1.center(), a2.center());`,
      `equal(a1, a2);`,
    ));
  });

  it('pins each new end to the edge that cut it, addressing it where the rewrite left it', async () => {
    // The circle's statement sits after the line, so the second piece's
    // insertion pushes it down one line before the coincidents name it.
    const code = src(
      `const l1 = line([0, 0], [40, 0]);`,
      `const c1 = circle([20, 0], 20);`,
      `horizontal(l1);`,
    );
    const circle = { line: 6, featureType: 'circle' as const };
    const result = await SketchTrim.apply(code, {
      sketchLine: 4, line: 5, pieces: THREE, removed: 1, cutters: [circle, circle],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(src(
      `const l1 = line([0, 0], [10, 0]);`,
      `const l2 = line([30, 0], [40, 0]);`,
      `const c1 = circle([20, 0], 20);`,
      `horizontal(l1);`,
      `horizontal(l2);`,
      `coincident(l1.end(), c1);`,
      `coincident(l2.start(), c1);`,
    ));
  });

  it('pins a cut at another edge\'s end to that end, and an unbound survivor by line', async () => {
    const code = src(
      `line([0, 0], [40, 0]);`,
      `const l2 = line([10, 0], [10, 20]);`,
    );
    const result = await SketchTrim.apply(code, {
      sketchLine: 4, line: 5, pieces: TWO, removed: 1,
      cutters: [{ line: 6, featureType: 'line', role: 'start' }],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(src(
      `const l1 = line([0, 0], [10, 0]);`,
      `const l2 = line([10, 0], [10, 20]);`,
      `coincident(l1.end(), l2.start());`,
    ));
  });

  it('pins both ends of the arc a circle survives as', async () => {
    const code = src(
      `const c1 = circle([5, 5], 20);`,
      `const l1 = line([-20, 15], [30, 15]);`,
    );
    const cutter = { line: 6, featureType: 'line' as const };
    const result = await SketchTrim.apply(code, {
      sketchLine: 4, line: 5,
      pieces: [
        { kind: 'arc', start: [15, 5], end: [5, 15], center: [5, 5], cw: false },
        { kind: 'arc', start: [5, 15], end: [15, 5], center: [5, 5], cw: false },
      ],
      removed: 0,
      cutters: [cutter, cutter],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const c1 = arc([5, 15], [15, 5], [5, 5]);`);
    expect(result.newCode).toContain(`coincident(c1.end(), l1);`);
    expect(result.newCode).toContain(`coincident(c1.start(), l1);`);
  });

  it('drops the point-on-curve pins an earlier trim left on the cutters\' ends, superseded end to end', async () => {
    // The lines were trimmed against the circle first, which pinned their
    // ends onto it. Trimming the circle at those ends pins end to end and
    // takes the looser pins away without reporting them.
    const code = src(
      `const c1 = circle([5, 5], 20);`,
      `const l1 = line([-20, 15], [5, 15]);`,
      `const l2 = line([15, 5], [30, 5]);`,
      `coincident(l1.end(), c1);`,
      `coincident(l2.start(), c1);`,
      `diameter(c1, 20);`,
    );
    const result = await SketchTrim.apply(code, {
      sketchLine: 4, line: 5,
      pieces: [
        { kind: 'arc', start: [15, 5], end: [5, 15], center: [5, 5], cw: false },
        { kind: 'arc', start: [5, 15], end: [15, 5], center: [5, 5], cw: false },
      ],
      removed: 0,
      cutters: [{ line: 7, featureType: 'line', role: 'start' }, { line: 6, featureType: 'line', role: 'end' }],
      assignments: [{ line: 8, piece: 1 }, { line: 9, piece: 1 }],
    });
    expect(result.error).toBeUndefined();
    expect(result.removed).toBeUndefined();
    expect(result.newCode).toBe(src(
      `const c1 = arc([5, 15], [15, 5], [5, 5]);`,
      `const l1 = line([-20, 15], [5, 15]);`,
      `const l2 = line([15, 5], [30, 5]);`,
      `diameter(c1, 20);`,
      `coincident(c1.end(), l2.start());`,
      `coincident(c1.start(), l1.end());`,
    ));
  });

  it('refuses cutters that do not match the cuts', async () => {
    const result = await SketchTrim.apply(src(`const l1 = line([0, 0], [40, 0]);`), {
      sketchLine: 4, line: 5, pieces: TWO, removed: 1, cutters: [null, null],
    });
    expect(result.error).toMatch(/cut 1 time/);
  });

  it('settles every drifted literal on the solved geometry before cutting, so nothing moves', async () => {
    // The literals are guesses 5 above where the solve put the lines; the
    // trim writes the solved positions first, then cuts — one edit.
    const code = src(
      `const l1 = line([0, 5], [40, 5]);`,
      `const l2 = line([40, 5], [40, 20]);`,
      `coincident(l1.end(), l2.start());`,
    );
    const result = await SketchTrim.apply(code, {
      sketchLine: 4, line: 5, pieces: TWO, removed: 1,
      settle: [
        { sourceLine: 5, points: [
          { pointIndex: 0, position: [0, 0], expected: [0, 5] },
          { pointIndex: 1, position: [40, 0], expected: [40, 5] },
        ] },
        { sourceLine: 6, points: [{ pointIndex: 0, position: [40, 0], expected: [40, 5] }] },
      ],
    });
    expect(result.error).toBeUndefined();
    expect(result.removed).toEqual([{ line: 7, kind: 'coincident' }]);
    expect(result.newCode).toBe(src(
      `const l1 = line([0, 0], [10, 0]);`,
      `const l2 = line([40, 0], [40, 20]);`,
    ));
  });

  it('refuses to cut when the source drifted from what the settle expected', async () => {
    const code = src(`const l1 = line([0, 9], [40, 5]);`);
    const result = await SketchTrim.apply(code, {
      sketchLine: 4, line: 5, pieces: TWO, removed: 1,
      settle: [{ sourceLine: 5, points: [{ pointIndex: 0, position: [0, 0], expected: [0, 5] }] }],
    });
    expect(result.error).toMatch(/changed since/);
    expect(result.newCode).toBe(code);
  });

  it('refuses a looped statement, a non-entity statement, drifted pieces and a bad piece index', async () => {
    const loop = await SketchTrim.apply(src(
      `for (let i = 0; i < 2; i++) {`,
      `  line([0, i], [40, i]);`,
      `}`,
    ), { sketchLine: 4, line: 6, pieces: TWO, removed: 1 });
    expect(loop.error).toMatch(/inside a loop/);

    const notEntity = await SketchTrim.apply(src(
      `const l1 = line([0, 0], [40, 0]);`,
      `horizontal(l1);`,
    ), { sketchLine: 4, line: 6, pieces: TWO, removed: 1 });
    expect(notEntity.error).toMatch(/horizontal\(\) statement/);

    const drifted = await SketchTrim.apply(src(
      `const l1 = line([0, 0], [40, 0]);`,
    ), { sketchLine: 4, line: 5, pieces: [{ kind: 'arc', start: [0, 0], end: [1, 1], center: [0, 1], cw: false }], removed: 0 });
    expect(drifted.error).toMatch(/source changed/);

    const index = await SketchTrim.apply(src(
      `const l1 = line([0, 0], [40, 0]);`,
    ), { sketchLine: 4, line: 5, pieces: TWO, removed: 2 });
    expect(index.error).toMatch(/not one of the pieces/);
  });
});
