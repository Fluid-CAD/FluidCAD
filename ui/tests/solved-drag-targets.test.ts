import { describe, it, expect } from 'vitest';
import { updateDragTargets } from '../src/sketch-solver-client/drag-targets';
import type { SolvedDragTarget } from '../src/sketch-solver-client/drag-targets';

function target(entity: number, x: number, y: number, point?: 'start' | 'end' | 'center'): SolvedDragTarget {
  return { point: { ref: point ? { entity, point } : { entity }, x, y }, origin: [x, y] };
}

describe('updateDragTargets', () => {
  it('a vertex grab chases the snapped cursor', () => {
    const targets = [target(0, 10, 0, 'end')];
    updateDragTargets('vertex', targets, [10.2, 0.1], [14, 2]);
    expect([targets[0].point.x, targets[0].point.y]).toEqual([14, 2]);
  });

  it('REGRESSION: a circle grabbed at its rim keeps the rim under the cursor — the single center target translates by the delta, it must NOT jump onto the pointer', () => {
    // Circle center (205, 77), grabbed on the rim at (245, 77); cursor moves +10, +5.
    const targets = [target(2, 205, 77, 'center')];
    updateDragTargets('body', targets, [245, 77], [255, 82]);
    expect([targets[0].point.x, targets[0].point.y]).toEqual([215, 82]);
  });

  it('a line body grab translates both endpoints rigidly by the cursor delta', () => {
    const targets = [target(0, 0, 0, 'start'), target(0, 100, 0, 'end')];
    updateDragTargets('body', targets, [40, 0.5], [47, -2.5]);
    expect([targets[0].point.x, targets[0].point.y]).toEqual([7, -3]);
    expect([targets[1].point.x, targets[1].point.y]).toEqual([107, -3]);
  });

  it('body deltas stay relative to the gesture-start origins across moves', () => {
    const targets = [target(1, 205, 77, 'center')];
    updateDragTargets('body', targets, [245, 77], [250, 77]);
    updateDragTargets('body', targets, [245, 77], [260, 77]);
    expect(targets[0].point.x).toBe(220);
  });
});
