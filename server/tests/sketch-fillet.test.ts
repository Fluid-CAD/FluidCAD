import { describe, it, expect } from 'vitest';
import { SketchFillet, type SketchFilletCorner, type SketchFilletEnd } from '../src/sketch-fillet.ts';

// The sketch Fillet tool's statement transform: each edge's corner end moves
// to its tangent point, the corner coincident goes, constraints on a corner
// move to a virtual sharp held on both edges, geometry that borrowed the
// corner's position keeps it as a literal, and the arc recipe rides the
// emission rail.

const src = (imports: string, ...body: string[]): string => [
  `import { sketch, line, ${imports} } from "fluidcad/core";`,
  `import { coincident, horizontal, vertical, distance, fix } from "fluidcad/constraints";`,
  ``,
  `sketch('xy', () => {`,
  ...body.map(l => `  ${l}`),
  `});`,
].join('\n');

const lineEnd = (line: number, role: 'start' | 'end'): SketchFilletEnd => ({ line, featureType: 'line', role });

/** A 100 × 50 rectangle from the origin, drawn counter-clockwise from the bottom edge (lines 5–8). */
const RECT = [
  `const l1 = line([0, 0], [100, 0]);`,
  `const l2 = line([100, 0], [100, 50]);`,
  `const l3 = line([100, 50], [0, 50]);`,
  `const l4 = line([0, 50], [0, 0]);`,
  `coincident(l1.end(), l2.start());`,
  `coincident(l2.end(), l3.start());`,
  `coincident(l3.end(), l4.start());`,
  `coincident(l4.end(), l1.start());`,
  `horizontal(l1);`,
  `vertical(l2);`,
  `horizontal(l3);`,
  `vertical(l4);`,
];

/** Its four corners at radius 5, as the UI plans them. */
const RECT_CORNERS: SketchFilletCorner[] = [
  { a: lineEnd(5, 'end'), b: lineEnd(6, 'start'), at: [100, 0], start: [95, 0], end: [100, 5], center: [95, 5], cw: false },
  { a: lineEnd(6, 'end'), b: lineEnd(7, 'start'), at: [100, 50], start: [100, 45], end: [95, 50], center: [95, 45], cw: false },
  { a: lineEnd(7, 'end'), b: lineEnd(8, 'start'), at: [0, 50], start: [5, 50], end: [0, 45], center: [5, 45], cw: false },
  { a: lineEnd(8, 'end'), b: lineEnd(5, 'start'), at: [0, 0], start: [0, 5], end: [5, 0], center: [5, 5], cw: false },
];

describe('SketchFillet.apply', () => {
  it('keeps a rectangle anchored and dimensioned at its corners on virtual sharps', async () => {
    const code = src('origin', ...RECT,
      `coincident(l1.start(), origin());`,
      `distance(l1.start(), l1.end(), 100);`,
      `distance(l2.start(), l2.end(), 50);`,
    );
    const result = await SketchFillet.apply(code, { sketchLine: 4, corners: RECT_CORNERS, radiusExpr: '5' });
    expect(result.error).toBeUndefined();
    expect(result.names).toEqual(['a1', 'a2', 'a3', 'a4']);
    // The top-left corner pinned nothing beyond its coincident: no sharp.
    expect(result.sharps).toEqual(['p1', 'p2', 'p3']);
    expect(result.newCode).toBe([
      `import { point, arc, sketch, line, origin } from "fluidcad/core";`,
      `import { equal, radius, tangent, coincident, horizontal, vertical, distance, fix } from "fluidcad/constraints";`,
      ``,
      `sketch('xy', () => {`,
      `  const l1 = line([5, 0], [95, 0]);`,
      `  const l2 = line([100, 5], [100, 45]);`,
      `  const l3 = line([95, 50], [5, 50]);`,
      `  const l4 = line([0, 45], [0, 5]);`,
      `  const p1 = point([100, 0]);`,
      `  const p2 = point([100, 50]);`,
      `  const p3 = point([0, 0]);`,
      `  const a1 = arc([95, 0], [100, 5], [95, 5]);`,
      `  const a2 = arc([100, 45], [95, 50], [95, 45]);`,
      `  const a3 = arc([5, 50], [0, 45], [5, 45]);`,
      `  const a4 = arc([0, 5], [5, 0], [5, 5]);`,
      `  horizontal(l1);`,
      `  vertical(l2);`,
      `  horizontal(l3);`,
      `  vertical(l4);`,
      `  coincident(p3, origin());`,
      `  distance(p3, p1, 100);`,
      `  distance(p1, p2, 50);`,
      `  coincident(a1.start(), l1.end());`,
      `  coincident(a1.end(), l2.start());`,
      `  tangent(l1, a1);`,
      `  tangent(a1, l2);`,
      `  coincident(p1, l1);`,
      `  coincident(p1, l2);`,
      `  coincident(a2.start(), l2.end());`,
      `  coincident(a2.end(), l3.start());`,
      `  tangent(l2, a2);`,
      `  tangent(a2, l3);`,
      `  coincident(p2, l2);`,
      `  coincident(p2, l3);`,
      `  coincident(a3.start(), l3.end());`,
      `  coincident(a3.end(), l4.start());`,
      `  tangent(l3, a3);`,
      `  tangent(a3, l4);`,
      `  coincident(a4.start(), l4.end());`,
      `  coincident(a4.end(), l1.start());`,
      `  tangent(l4, a4);`,
      `  tangent(a4, l1);`,
      `  coincident(p3, l4);`,
      `  coincident(p3, l1);`,
      `  radius(a1, 5);`,
      `  equal(a1, a2);`,
      `  equal(a1, a3);`,
      `  equal(a1, a4);`,
      `});`,
    ].join('\n'));
  });

  it('needs no sharp when only the corner coincident named the corner', async () => {
    const code = src('origin',
      `const l1 = line([0, 0], [100, 0]);`,
      `const l2 = line([100, 0], [100, 50]);`,
      `coincident(l1.end(), l2.start());`,
      `horizontal(l1);`,
    );
    const result = await SketchFillet.apply(code, { sketchLine: 4, corners: [RECT_CORNERS[0]], radiusExpr: '5' });
    expect(result.error).toBeUndefined();
    expect(result.sharps).toBeUndefined();
    expect(result.newCode).toBe([
      `import { arc, sketch, line, origin } from "fluidcad/core";`,
      `import { radius, tangent, coincident, horizontal, vertical, distance, fix } from "fluidcad/constraints";`,
      ``,
      `sketch('xy', () => {`,
      `  const l1 = line([0, 0], [95, 0]);`,
      `  const l2 = line([100, 5], [100, 50]);`,
      `  const a1 = arc([95, 0], [100, 5], [95, 5]);`,
      `  horizontal(l1);`,
      `  coincident(a1.start(), l1.end());`,
      `  coincident(a1.end(), l2.start());`,
      `  tangent(l1, a1);`,
      `  tangent(a1, l2);`,
      `  radius(a1, 5);`,
      `});`,
    ].join('\n'));
  });

  it('keeps a borrowed corner position as a literal and a constraint on the corner on the sharp', async () => {
    const code = src('origin',
      `const l1 = line([0, 0], [100, 0]);`,
      `const l2 = line(l1.end(), [100, 50]);`,
      `const l3 = line(l1.end(), [150, -20]);`,
      `coincident(l1.end(), l2.start());`,
      `fix(l1.end(), [100, 0]);`,
    );
    const result = await SketchFillet.apply(code, { sketchLine: 4, corners: [RECT_CORNERS[0]], radiusExpr: '5' });
    expect(result.error).toBeUndefined();
    expect(result.sharps).toEqual(['p1']);
    expect(result.newCode).toContain(`const l2 = line([100, 5], [100, 50]);`);
    expect(result.newCode).toContain(`const l3 = line([100, 0], [150, -20]);`);
    expect(result.newCode).toContain(`const p1 = point([100, 0]);`);
    expect(result.newCode).toContain(`fix(p1, [100, 0]);`);
    expect(result.newCode).not.toContain(`coincident(l1.end(), l2.start());`);
  });

  it('trims an arc edge at its corner end, keeping its center and direction', async () => {
    const code = src('arc',
      `const l1 = line([0, 0], [100, 0]);`,
      `const a1 = arc([100, 0], [150, 50], [150, 0]).cw();`,
      `coincident(l1.end(), a1.start());`,
    );
    const corner: SketchFilletCorner = {
      a: lineEnd(5, 'end'),
      b: { line: 6, featureType: 'arc', role: 'start' },
      at: [100, 0], start: [97.29, 0], end: [97.73, 4.47], center: [97.29, 5], cw: false,
    };
    const result = await SketchFillet.apply(code, { sketchLine: 4, corners: [corner], radiusExpr: '5' });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const a1 = arc([97.73, 4.47], [150, 50], [150, 0]).cw();`);
    expect(result.newCode).toContain(`const l1 = line([0, 0], [97.29, 0]);`);
    expect(result.newCode).toContain(`const a2 = arc([97.29, 0], [97.73, 4.47], [97.29, 5]);`);
    expect(result.newCode).toContain(`coincident(a2.end(), a1.start());`);
    expect(result.newCode).toContain(`tangent(a2, a1);`);
  });

  it('settles the sketch before rounding it', async () => {
    const code = src('origin',
      `const l1 = line([0, 0], [100, 0]);`,
      `const l2 = line([100, 0], [100, 50]);`,
      `const l3 = line([7, 7], [8, 8]);`,
      `coincident(l1.end(), l2.start());`,
    );
    const result = await SketchFillet.apply(code, {
      sketchLine: 4,
      corners: [RECT_CORNERS[0]],
      radiusExpr: '5',
      settle: [{ sourceLine: 7, points: [{ pointIndex: 0, position: [10, 10], expected: [7, 7] }] }],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const l3 = line([10, 10], [8, 8]);`);
    expect(result.newCode).toContain(`const l1 = line([0, 0], [95, 0]);`);
  });

  it('declares a radius typed as a new variable', async () => {
    const code = src('origin',
      `const l1 = line([0, 0], [100, 0]);`,
      `const l2 = line([100, 0], [100, 50]);`,
      `coincident(l1.end(), l2.start());`,
    );
    const result = await SketchFillet.apply(code, {
      sketchLine: 4,
      corners: [RECT_CORNERS[0]],
      radiusExpr: 'r',
      newVariables: [{ name: 'r', initializer: '5' }],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const r = 5;`);
    expect(result.newCode).toContain(`radius(a1, r);`);
    expect(result.newCode).toContain(`coincident(a1.start(), l1.end());`);
  });

  it('refuses when the edge statement changed under the pick', async () => {
    const code = src('circle',
      `const l1 = line([0, 0], [100, 0]);`,
      `const c1 = circle([100, 0], 10);`,
    );
    const result = await SketchFillet.apply(code, { sketchLine: 4, corners: [RECT_CORNERS[0]], radiusExpr: '5' });
    expect(result.error).toMatch(/source changed/);
    expect(result.newCode).toBe(code);
  });

  it('refuses one end joining two corners', async () => {
    const code = src('origin', ...RECT);
    const twice: SketchFilletCorner = { ...RECT_CORNERS[1], a: lineEnd(5, 'end') };
    const result = await SketchFillet.apply(code, { sketchLine: 4, corners: [RECT_CORNERS[0], twice], radiusExpr: '5' });
    expect(result.error).toMatch(/joins two corners/);
  });

  it('refuses a corner end held by an alias it cannot follow', async () => {
    const code = src('origin',
      `const l1 = line([0, 0], [100, 0]);`,
      `const l2 = line([100, 0], [100, 50]);`,
      `const corner = l1.end();`,
      `coincident(corner, origin());`,
    );
    const result = await SketchFillet.apply(code, { sketchLine: 4, corners: [RECT_CORNERS[0]], radiusExpr: '5' });
    expect(result.error).toMatch(/line 7 uses l1\.end\(\)/);
  });
});
