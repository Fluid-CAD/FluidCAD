import { describe, it, expect } from 'vitest';
import { updateSketchPositions } from '../src/code-editor.ts';

// The solved-sketch batch write-back (sketch-rewrite P4): one parse, one
// splice pass across many statements, all-or-nothing drift refusal.

const SKETCH = [
  `import { sketch, line, arc, circle, point } from "fluidcad/core";`,
  `import { coincident, horizontal, distance } from "fluidcad/constraints";`,
  ``,
  `const profile = sketch('xy', () => {`,
  `  const a = line([0, 0], [100, 0]);`,
  `  const b = line([100, 0], [100, 50]);`,
  `  const c = circle([50, 25], 20);`,
  `  const d = arc([0, 50], [50, 100], [50, 50]).cw();`,
  `  const p = point([-10, -10]);`,
  `  coincident(a.end(), b.start());`,
  `  horizontal(a);`,
  `});`,
].join('\n');

describe('updateSketchPositions', () => {
  it('splices literals across multiple statements in one pass', async () => {
    const result = await updateSketchPositions(SKETCH, [
      { sourceLine: 5, points: [
        { pointIndex: 0, position: [1.5, 2.5], expected: [0, 0] },
        { pointIndex: 1, position: [101.5, 2.5], expected: [100, 0] },
      ] },
      { sourceLine: 6, points: [
        { pointIndex: 0, position: [101.5, 2.5], expected: [100, 0] },
      ] },
      { sourceLine: 9, points: [
        { pointIndex: 0, position: [-12, -14], expected: [-10, -10] },
      ] },
    ]);
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const a = line([1.5, 2.5], [101.5, 2.5]);`);
    expect(result.newCode).toContain(`const b = line([101.5, 2.5], [100, 50]);`);
    expect(result.newCode).toContain(`const p = point([-12, -14]);`);
    // Untouched statements are byte-identical.
    expect(result.newCode).toContain(`const c = circle([50, 25], 20);`);
  });

  it('splice ordering is offset-safe within one statement (later args first)', async () => {
    const result = await updateSketchPositions(SKETCH, [
      { sourceLine: 8, points: [
        { pointIndex: 0, position: [0.11, 50.22] },
        { pointIndex: 1, position: [50.33, 100.44] },
        { pointIndex: 2, position: [50.55, 50.66] },
      ] },
    ]);
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(
      `const d = arc([0.11, 50.22], [50.33, 100.44], [50.55, 50.66]).cw();`,
    );
  });

  it('rounds spliced values to 2dp', async () => {
    const result = await updateSketchPositions(SKETCH, [
      { sourceLine: 5, points: [{ pointIndex: 0, position: [1.23456, -0.005] }] },
    ]);
    expect(result.newCode).toContain(`line([1.23, 0], [100, 0])`);
  });

  it('updates a circle diameter scalar with the points', async () => {
    const result = await updateSketchPositions(SKETCH, [
      { sourceLine: 7, points: [{ pointIndex: 0, position: [52, 27], expected: [50, 25] }],
        scalar: { value: 24.5, expected: 20 } },
    ]);
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const c = circle([52, 27], 24.5);`);
  });

  it('refuses the whole batch when a literal drifted', async () => {
    const result = await updateSketchPositions(SKETCH, [
      { sourceLine: 5, points: [{ pointIndex: 0, position: [1, 1], expected: [0, 0] }] },
      { sourceLine: 6, points: [{ pointIndex: 0, position: [9, 9], expected: [123, 0] }] },
    ]);
    expect(result.error).toContain('line 6 changed since this drag started');
    expect(result.newCode).toBe(SKETCH);
  });

  it('refuses when the statement is gone', async () => {
    const result = await updateSketchPositions(SKETCH, [
      { sourceLine: 3, points: [{ pointIndex: 0, position: [1, 1] }] },
    ]);
    expect(result.error).toContain('no editable statement at line 3');
    expect(result.newCode).toBe(SKETCH);
  });

  it('refuses a missing point index', async () => {
    const result = await updateSketchPositions(SKETCH, [
      { sourceLine: 5, points: [{ pointIndex: 5, position: [1, 1] }] },
    ]);
    expect(result.error).toContain('line 5 has no point argument 5');
    expect(result.newCode).toBe(SKETCH);
  });

  it('skips accessor and expression slots silently', async () => {
    const code = SKETCH.replace(
      `const b = line([100, 0], [100, 50]);`,
      `const b = line(a.end(), [100, 50]);`,
    ).replace(
      `const c = circle([50, 25], 20);`,
      `const c = circle([w, 25], d);`,
    );
    const result = await updateSketchPositions(code, [
      // Accessor start slot skipped; literal end slot spliced.
      { sourceLine: 6, points: [
        { pointIndex: 0, position: [1, 1] },
        { pointIndex: 1, position: [100, 60], expected: [100, 50] },
      ] },
      // Expression center + variable diameter both skipped.
      { sourceLine: 7, points: [{ pointIndex: 0, position: [2, 2] }],
        scalar: { value: 30 } },
    ]);
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const b = line(a.end(), [100, 60]);`);
    expect(result.newCode).toContain(`const c = circle([w, 25], d);`);
  });

  it('drift guard tolerates float noise but not real edits', async () => {
    const ok = await updateSketchPositions(SKETCH, [
      { sourceLine: 5, points: [{ pointIndex: 0, position: [3, 3], expected: [1e-9, -1e-9] }] },
    ]);
    expect(ok.error).toBeUndefined();
    const drifted = await updateSketchPositions(SKETCH, [
      { sourceLine: 5, points: [{ pointIndex: 0, position: [3, 3], expected: [0.01, 0] }] },
    ]);
    expect(drifted.error).toContain('changed since this drag started');
  });

  it('refuses duplicate lines in one batch', async () => {
    const result = await updateSketchPositions(SKETCH, [
      { sourceLine: 5, points: [{ pointIndex: 0, position: [1, 1] }] },
      { sourceLine: 5, points: [{ pointIndex: 1, position: [2, 2] }] },
    ]);
    expect(result.error).toContain('duplicate position edit for line 5');
  });

  it('scalar drift refuses the batch', async () => {
    const result = await updateSketchPositions(SKETCH, [
      { sourceLine: 7, scalar: { value: 30, expected: 21 } },
    ]);
    expect(result.error).toContain('line 7 changed since this drag started');
  });
});
