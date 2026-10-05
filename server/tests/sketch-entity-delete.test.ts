import { describe, it, expect } from 'vitest';
import { SketchEntityDelete } from '../src/sketch-entity-delete.ts';

// The sketcher's Delete key transform: the picked statements go in one
// edit, the constraints naming them go, geometry that borrowed one of
// their points keeps its place, derived-op lists drop them, and statements
// that consumed them are swept along with their own dependents.

const src = (...body: string[]): string => [
  `import { sketch, line, arc, circle, ellipse, bezier, text, mirror, copy, fillet, origin, yAxis } from "fluidcad/core";`,
  `import { coincident, horizontal, distance, equal, fix, diameter, tangent } from "fluidcad/constraints";`,
  ``,
  `sketch('xy', () => {`,
  ...body.map(l => `  ${l}`),
  `});`,
].join('\n');

const SKETCH = 4;
/** The 1-indexed source line of body row `i` (0-based). */
const row = (i: number): number => SKETCH + 1 + i;

describe('SketchEntityDelete.apply', () => {
  it('deletes a line with the constraints naming it and nothing else', async () => {
    const code = src(
      `const l1 = line([0, 0], [40, 0]);`,
      `const l2 = line([40, 0], [40, 20]);`,
      `coincident(l1.end(), l2.start());`,
      `horizontal(l1);`,
      `distance(l1.start(), l1.end(), 40);`,
      `coincident(l2.end(), origin());`,
    );
    const result = await SketchEntityDelete.apply(code, { sketchLine: SKETCH, lines: [row(0)] });
    expect(result.error).toBeUndefined();
    expect(result.removed).toEqual([
      { line: row(2), kind: 'coincident' },
      { line: row(3), kind: 'horizontal' },
      { line: row(4), kind: 'distance' },
    ]);
    expect(result.dependents).toBeUndefined();
    expect(result.newCode).toBe(src(
      `const l2 = line([40, 0], [40, 20]);`,
      `coincident(l2.end(), origin());`,
    ));
  });

  it('deletes several picked statements in one edit, a constraint between them once', async () => {
    const code = src(
      `const l1 = line([0, 0], [40, 0]);`,
      `const l2 = line([40, 0], [40, 20]);`,
      `const l3 = line([40, 20], [0, 20]);`,
      `coincident(l1.end(), l2.start());`,
      `coincident(l2.end(), l3.start());`,
      `horizontal(l3);`,
    );
    const result = await SketchEntityDelete.apply(code, { sketchLine: SKETCH, lines: [row(1), row(0), row(1)] });
    expect(result.error).toBeUndefined();
    expect(result.removed).toEqual([{ line: row(3), kind: 'coincident' }, { line: row(4), kind: 'coincident' }]);
    expect(result.newCode).toBe(src(
      `const l3 = line([40, 20], [0, 20]);`,
      `horizontal(l3);`,
    ));
  });

  it('removes an unbound statement outright', async () => {
    const code = src(
      `line([0, 0], [40, 0]);`,
      `const c1 = circle([5, 5], 20);`,
    );
    const result = await SketchEntityDelete.apply(code, { sketchLine: SKETCH, lines: [row(0)] });
    expect(result.error).toBeUndefined();
    expect(result.removed).toBeUndefined();
    expect(result.newCode).toBe(src(`const c1 = circle([5, 5], 20);`));
  });

  it('lets geometry that borrowed a point keep its place: the accessor becomes the argument it was drawn from', async () => {
    const code = src(
      `const l1 = line([0, 0], [w, 0]);`,
      `const l2 = line(l1.end(), [50, 50]);`,
      `const a1 = arc(l1.start(), [10, 10], [5, 5]);`,
      `tangent(l1, a1);`,
    );
    const result = await SketchEntityDelete.apply(code, { sketchLine: SKETCH, lines: [row(0)] });
    expect(result.error).toBeUndefined();
    expect(result.removed).toEqual([{ line: row(3), kind: 'tangent' }]);
    expect(result.newCode).toBe(src(
      `const l2 = line([w, 0], [50, 50]);`,
      `const a1 = arc([0, 0], [10, 10], [5, 5]);`,
    ));
  });

  it('substitutes a line midpoint between two literals, and refuses one it cannot place', async () => {
    const placed = await SketchEntityDelete.apply(src(
      `const l1 = line([0, 0], [40, 10]);`,
      `const c1 = circle(l1.mid(), 10);`,
    ), { sketchLine: SKETCH, lines: [row(0)] });
    expect(placed.error).toBeUndefined();
    expect(placed.newCode).toBe(src(`const c1 = circle([20, 5], 10);`));

    const unplaced = await SketchEntityDelete.apply(src(
      `const l1 = line([0, 0], [w, 10]);`,
      `const c1 = circle(l1.mid(), 10);`,
    ), { sketchLine: SKETCH, lines: [row(0)] });
    expect(unplaced.error).toBe(`line ${row(1)} uses l1.mid() — nothing stands in for that point, edit the statement first`);
    expect(unplaced.newCode).toBe(src(
      `const l1 = line([0, 0], [w, 10]);`,
      `const c1 = circle(l1.mid(), 10);`,
    ));
  });

  it('follows a borrowed point through a chain of deleted entities', async () => {
    const code = src(
      `const l0 = line([0, 0], [10, 0]);`,
      `const l1 = line(l0.end(), [20, 0]);`,
      `const l2 = line(l1.start(), [20, 20]);`,
      `const l3 = line(l1.end(), [30, 30]);`,
    );
    const result = await SketchEntityDelete.apply(code, { sketchLine: SKETCH, lines: [row(0), row(1)] });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(src(
      `const l2 = line([10, 0], [20, 20]);`,
      `const l3 = line([20, 0], [30, 30]);`,
    ));
  });

  it('keeps a borrowed point on an entity that stays', async () => {
    const code = src(
      `const l0 = line([0, 0], [10, 0]);`,
      `const l1 = line(l0.end(), [20, 0]);`,
      `const l2 = line(l1.start(), [20, 20]);`,
    );
    const result = await SketchEntityDelete.apply(code, { sketchLine: SKETCH, lines: [row(1)] });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(src(
      `const l0 = line([0, 0], [10, 0]);`,
      `const l2 = line(l0.end(), [20, 20]);`,
    ));
  });

  it('substitutes arc, circle, ellipse and bezier points by their arguments', async () => {
    const code = src(
      `const a1 = arc([0, 0], [10, 10], [10, 0]);`,
      `const c1 = circle([5, 5], 20);`,
      `const e1 = ellipse([1, 2], 10, 5);`,
      `const b1 = bezier([0, 0], [3, 4], [8, 8]);`,
      `const l1 = line(a1.center(), c1.center());`,
      `const l2 = line(e1.center(), b1.point(1));`,
      `const l3 = line(b1.start(), b1.end());`,
    );
    const result = await SketchEntityDelete.apply(code, { sketchLine: SKETCH, lines: [row(0), row(1), row(2), row(3)] });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(src(
      `const l1 = line([10, 0], [5, 5]);`,
      `const l2 = line([1, 2], [3, 4]);`,
      `const l3 = line([0, 0], [8, 8]);`,
    ));
  });

  it('refuses a point the primitive has no argument for', async () => {
    const result = await SketchEntityDelete.apply(src(
      `const a1 = arc([0, 0], [10, 10], [10, 0]);`,
      `const c1 = circle(a1.mid(), 4);`,
    ), { sketchLine: SKETCH, lines: [row(0)] });
    expect(result.error).toBe(`line ${row(1)} uses a1.mid() — nothing stands in for that point, edit the statement first`);
  });

  it('drops list members keeping the list formatting, and sweeps a derived op whose list would empty', async () => {
    const code = src(
      `const l1 = line([0, 0], [40, 0]);`,
      `const l2 = line([40, 0], [40, 20]);`,
      `const l3 = line([40, 20], [0, 20]);`,
      `mirror([l1, l2, l3], yAxis());`,
      `const dup = copy([l3, l1], { count: 3 });`,
      `copy([l2,  l3], { count: 2 });`,
      `coincident(dup.instance(1).start(), origin());`,
    );
    const result = await SketchEntityDelete.apply(code, { sketchLine: SKETCH, lines: [row(0), row(2)] });
    expect(result.error).toBeUndefined();
    expect(result.dependents).toEqual([{ line: row(4), kind: 'copy' }]);
    expect(result.removed).toEqual([{ line: row(6), kind: 'coincident' }]);
    expect(result.newCode).toBe(src(
      `const l2 = line([40, 0], [40, 20]);`,
      `mirror([l2], yAxis());`,
      `copy([l2], { count: 2 });`,
    ));
  });

  it('sweeps a derived op that takes the entity positionally, and what depended on it', async () => {
    const code = src(
      `const l1 = line([0, 0], [40, 0]);`,
      `const l2 = line([40, 0], [40, 20]);`,
      `const [f1, f2] = fillet(l1, l2, 4);`,
      `coincident(f2.end(), origin());`,
      `horizontal(l2);`,
    );
    const result = await SketchEntityDelete.apply(code, { sketchLine: SKETCH, lines: [row(0)] });
    expect(result.error).toBeUndefined();
    expect(result.dependents).toEqual([{ line: row(2), kind: 'fillet' }]);
    expect(result.removed).toEqual([{ line: row(3), kind: 'coincident' }]);
    expect(result.newCode).toBe(src(
      `const l2 = line([40, 0], [40, 20]);`,
      `horizontal(l2);`,
    ));
  });

  it('sweeps text that follows the deleted path', async () => {
    const code = src(
      `const a1 = arc([0, 0], [10, 10], [10, 0]);`,
      `text("Hi", a1);`,
      `const l1 = line([0, 0], [5, 5]);`,
    );
    const result = await SketchEntityDelete.apply(code, { sketchLine: SKETCH, lines: [row(0)] });
    expect(result.error).toBeUndefined();
    expect(result.dependents).toEqual([{ line: row(1), kind: 'text' }]);
    expect(result.newCode).toBe(src(`const l1 = line([0, 0], [5, 5]);`));
  });

  it('settles the sketch first, so a borrowed point is substituted at rest', async () => {
    const code = src(
      `const l1 = line([0, 0], [40, 0]);`,
      `const l2 = line(l1.end(), [50, 50]);`,
      `distance(l1.start(), l1.end(), 30);`,
    );
    const result = await SketchEntityDelete.apply(code, {
      sketchLine: SKETCH,
      lines: [row(0)],
      settle: [{ sourceLine: row(0), points: [{ pointIndex: 1, position: [30, 0], expected: [40, 0] }] }],
    });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(src(`const l2 = line([30, 0], [50, 50]);`));
  });

  it('refuses a looped statement, a statement outside the body and a moved source', async () => {
    const looped = await SketchEntityDelete.apply(src(
      `for (const i of [0, 1]) {`,
      `  line([i, 0], [i, 10]);`,
      `}`,
    ), { sketchLine: SKETCH, lines: [row(1)] });
    expect(looped.error).toBe(`line ${row(1)} is inside a loop — it draws every iteration, edit the source instead`);

    const outside = await SketchEntityDelete.apply(src(`const l1 = line([0, 0], [1, 1]);`), { sketchLine: SKETCH, lines: [1] });
    expect(outside.error).toBe('no sketch statement at line 1 — the source changed since the pick was made');

    const moved = await SketchEntityDelete.apply(src(`const l1 = line([0, 0], [1, 1]);`), { sketchLine: 2, lines: [row(0)] });
    expect(moved.error).toBe('no sketch statement at line 2 — the source changed since the pick was made');

    const empty = await SketchEntityDelete.apply(src(`const l1 = line([0, 0], [1, 1]);`), { sketchLine: SKETCH, lines: [] });
    expect(empty.error).toBe('nothing to delete');
  });

  it('refuses a statement sharing its row with other code', async () => {
    const result = await SketchEntityDelete.apply(src(
      `const l1 = line([0, 0], [1, 1]); const l2 = line([1, 1], [2, 2]);`,
    ), { sketchLine: SKETCH, lines: [row(0)] });
    expect(result.error).toBe(`line ${row(0)} holds more than the statement — remove it by hand first`);
  });
});
