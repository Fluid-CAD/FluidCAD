import { describe, it, expect } from 'vitest';
import { DimensionLabel } from '../src/sketch-solved-edit/index.ts';
import { applyFeatureEdit, type ApplyFeatureEditSpec } from '../src/apply-feature-edit/index.ts';
import { updateDimensionExpressionWithVariable } from '../src/code-editor/index.ts';

// Dragging a dimension in the sketcher writes `.labelAt(u, v)` on its
// statement. The transform owns exactly that link of the chain: everything
// else on the statement — the value, `.max()`, `.name('…')`, comments,
// line breaks — has to come through untouched.

const SKETCH = [
  `import { sketch, line, arc, circle } from "fluidcad/core";`,
  `import { distance, radius, diameter, angle, offsetFrom, horizontal } from "fluidcad/constraints";`,
  ``,
  `sketch('xy', () => {`,
  `  const l1 = line([0, 0], [0, 100]);`,
  `  const a1 = arc([140, 30], [140, 70], [140, 50]);`,
  `  const c1 = circle([60, 60], 20);`,
  `  radius(a1, 20);`,
  `  distance(l1, a1, 130);`,
  `  diameter(c1, 40);`,
  `  horizontal(l1);`,
  `});`,
].join('\n');

const RADIUS_LINE = 8;
const DISTANCE_LINE = 9;
const DIAMETER_LINE = 10;
const HORIZONTAL_LINE = 11;

/** `SKETCH` with its distance statement swapped for `statement`. */
function withDistance(statement: string): string {
  return SKETCH.replace('  distance(l1, a1, 130);', statement);
}

describe('DimensionLabel.apply', () => {
  it('appends .labelAt() to a bare dimension statement', async () => {
    const result = await DimensionLabel.apply(SKETCH, { line: DISTANCE_LINE, position: [4, -12.5] });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(withDistance(`  distance(l1, a1, 130).labelAt(4, -12.5);`));
  });

  it('places every dimension command, and only its own statement', async () => {
    const radiusEdit = await DimensionLabel.apply(SKETCH, { line: RADIUS_LINE, kind: 'radius', position: [6, 6] });
    expect(radiusEdit.newCode).toContain(`radius(a1, 20).labelAt(6, 6);`);
    expect(radiusEdit.newCode).toContain(`distance(l1, a1, 130);`);

    const diameterEdit = await DimensionLabel.apply(SKETCH, { line: DIAMETER_LINE, kind: 'diameter', position: [0, 30] });
    expect(diameterEdit.newCode).toContain(`diameter(c1, 40).labelAt(0, 30);`);

    const more = SKETCH.replace(
      `  horizontal(l1);`,
      [`  angle(l1, l1, 90);`, `  offsetFrom([l1], [l1], 5);`].join('\n'),
    );
    const angleEdit = await DimensionLabel.apply(more, { line: 11, kind: 'angle', position: [18, 0] });
    expect(angleEdit.newCode).toContain(`angle(l1, l1, 90).labelAt(18, 0);`);
    const offsetEdit = await DimensionLabel.apply(more, { line: 12, kind: 'offsetFrom', position: [1, 2] });
    expect(offsetEdit.newCode).toContain(`offsetFrom([l1], [l1], 5).labelAt(1, 2);`);
  });

  it('moves an existing placement in place, keeping the rest of the chain', async () => {
    const chained = withDistance(`  distance(l1, a1, 130).labelAt(1, 2).max().name('gap');`);
    const result = await DimensionLabel.apply(chained, { line: DISTANCE_LINE, position: [30, 8] });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(withDistance(`  distance(l1, a1, 130).labelAt(30, 8).max().name('gap');`));
  });

  it('appends after the other chained calls when there is no placement yet', async () => {
    const chained = withDistance(`  distance(l1, a1, 130).max().name('gap');`);
    const result = await DimensionLabel.apply(chained, { line: DISTANCE_LINE, position: [30, 8] });
    expect(result.newCode).toBe(withDistance(`  distance(l1, a1, 130).max().name('gap').labelAt(30, 8);`));
  });

  it('collapses repeated placements onto the one in force', async () => {
    const twice = withDistance(`  distance(l1, a1, 130).labelAt(1, 2).max().labelAt(3, 4);`);
    const result = await DimensionLabel.apply(twice, { line: DISTANCE_LINE, position: [9, 9] });
    expect(result.newCode).toBe(withDistance(`  distance(l1, a1, 130).max().labelAt(9, 9);`));
  });

  it('strips the placement on a null position', async () => {
    const chained = withDistance(`  distance(l1, a1, 130).labelAt(1, 2).max();`);
    const result = await DimensionLabel.apply(chained, { line: DISTANCE_LINE, position: null });
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(withDistance(`  distance(l1, a1, 130).max();`));

    const bare = await DimensionLabel.apply(SKETCH, { line: DISTANCE_LINE, position: null });
    expect(bare.error).toBeUndefined();
    expect(bare.newCode).toBe(SKETCH);
  });

  it('handles a bound statement and a chain broken over lines', async () => {
    const bound = withDistance(`  const gap = distance(l1, a1, 130);`);
    const boundEdit = await DimensionLabel.apply(bound, { line: DISTANCE_LINE, position: [2, 3] });
    expect(boundEdit.newCode).toBe(withDistance(`  const gap = distance(l1, a1, 130).labelAt(2, 3);`));

    const broken = withDistance([
      `  distance(l1, a1, 130) // the gap`,
      `    .labelAt(`,
      `      1,`,
      `      2,`,
      `    )`,
      `    .max();`,
    ].join('\n'));
    const brokenEdit = await DimensionLabel.apply(broken, { line: DISTANCE_LINE, position: [7, -7] });
    expect(brokenEdit.newCode).toBe(withDistance([
      `  distance(l1, a1, 130) // the gap`,
      `    .labelAt(7, -7)`,
      `    .max();`,
    ].join('\n')));
  });

  it('leaves a labelAt-looking argument of the dimension alone', async () => {
    // Only links of the statement's OWN chain count — never a call nested
    // in its arguments.
    const nested = withDistance(`  distance(l1, a1, pick.labelAt(1, 2));`);
    const result = await DimensionLabel.apply(nested, { line: DISTANCE_LINE, position: [5, 5] });
    expect(result.newCode).toBe(withDistance(`  distance(l1, a1, pick.labelAt(1, 2)).labelAt(5, 5);`));
  });

  it('writes tidy literals: rounded, no float noise, no negative zero', async () => {
    const result = await DimensionLabel.apply(SKETCH, {
      line: DISTANCE_LINE, position: [0.1 + 0.2, -0.00001],
    });
    expect(result.newCode).toContain(`distance(l1, a1, 130).labelAt(0.3, 0);`);
  });

  it('is idempotent', async () => {
    const once = await DimensionLabel.apply(SKETCH, { line: DISTANCE_LINE, position: [4, 12] });
    const twice = await DimensionLabel.apply(once.newCode, { line: DISTANCE_LINE, position: [4, 12] });
    expect(twice.newCode).toBe(once.newCode);
  });

  it('refuses a line that is not a dimension statement', async () => {
    for (const line of [HORIZONTAL_LINE, 5, 3, 999]) {
      const result = await DimensionLabel.apply(SKETCH, { line, position: [1, 1] });
      expect(result.error).toContain('not a dimension statement');
      expect(result.newCode).toBe(SKETCH);
    }
  });

  it('refuses when the statement is no longer the dimension the drag saw', async () => {
    const result = await DimensionLabel.apply(SKETCH, { line: RADIUS_LINE, kind: 'distance', position: [1, 1] });
    expect(result.error).toContain('radius() statement, not distance()');
    expect(result.newCode).toBe(SKETCH);
  });

  it('refuses a malformed position', async () => {
    for (const position of [[1], [1, Number.NaN], [1, Infinity], ['1', 2], [1, 2, 3]]) {
      const result = await DimensionLabel.apply(SKETCH, { line: DISTANCE_LINE, position: position as any });
      expect(result.error).toContain('two finite numbers');
      expect(result.newCode).toBe(SKETCH);
    }
  });
});

describe('dimension label — the apply-feature-edit round trip', () => {
  const spec = (dimensionLabel: ApplyFeatureEditSpec['dimensionLabel']): ApplyFeatureEditSpec => ({
    feature: 'sketch',
    filePath: '/ws/model.fluid.js',
    producers: [],
    parts: [],
    imports: [],
    dimensionLabel,
  });

  it('routes the sub-spec to the transform', async () => {
    const result = await applyFeatureEdit(SKETCH, spec({ line: DISTANCE_LINE, kind: 'distance', position: [4, 12] }));
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe(withDistance(`  distance(l1, a1, 130).labelAt(4, 12);`));
  });

  it('surfaces a refusal without touching the code', async () => {
    const result = await applyFeatureEdit(SKETCH, spec({ line: HORIZONTAL_LINE, position: [4, 12] }));
    expect(result.error).toContain('not a dimension statement');
    expect(result.newCode).toBe(SKETCH);
  });
});

describe('a placed dimension stays editable', () => {
  it("the value rail still rewrites the dimension's own scalar, not the label's", async () => {
    // The label's numbers are trailing scalars too — the rail filters on the
    // dimension's callee, so a double-click edit lands on the value.
    const placed = withDistance(`  distance(l1, a1, 130).labelAt(4, 12);`);
    const result = await updateDimensionExpressionWithVariable(
      placed, DISTANCE_LINE, '150', DISTANCE_LINE, null, 0, 'distance',
    );
    expect(result.newCode).toBe(withDistance(`  distance(l1, a1, 150).labelAt(4, 12);`));
  });
});
