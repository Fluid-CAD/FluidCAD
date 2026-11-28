import { describe, it, expect } from 'vitest';
import { Box3, Vector3 } from 'three';
import { InsertPlacement } from '../src/ui/insert-part/insert-placement';

function box(min: [number, number, number], max: [number, number, number]): Box3 {
  return new Box3(new Vector3(...min), new Vector3(...max));
}

describe('InsertPlacement', () => {
  it('leaves the first part of an empty assembly at the origin', () => {
    const placement = new InsertPlacement(null);
    expect(placement.next(box([0, 0, 0], [100, 50, 20]))).toBeNull();
  });

  it('puts each next part one gap past everything before it, along X only', () => {
    const placement = new InsertPlacement(null);
    const part = box([0, 0, 0], [100, 50, 20]);
    placement.next(part);
    // Gap: a tenth of the largest side (10), so the low side lands at 110.
    expect(placement.next(part)).toEqual([110, 0, 0]);
    expect(placement.next(part)).toEqual([220, 0, 0]);
  });

  it('starts beside what the assembly already shows', () => {
    const placement = new InsertPlacement(box([-40, -40, 0], [250, 40, 30]));
    expect(placement.next(box([0, 0, 0], [100, 50, 20]))).toEqual([260, 0, 0]);
  });

  it('clears a part that reaches behind its own origin', () => {
    const placement = new InsertPlacement(box([0, 0, 0], [100, 100, 100]));
    // Centred on its origin: its low side is at -30, so it moves 30 further.
    expect(placement.next(box([-30, -30, -30], [30, 30, 30]))).toEqual([136, 0, 0]);
  });

  it('rounds the distance up to the magnitude of the gap', () => {
    const placement = new InsertPlacement(box([0, 0, 0], [1.234, 1, 1]));
    // Gap 0.25 → tenths: 1.234 + 0.25 = 1.484 → 1.5.
    const position = placement.next(box([0, 0, 0], [2.5, 1, 1]));
    expect(position![0]).toBeCloseTo(1.5, 9);
  });

  it('places a part it could not measure beside the rest all the same', () => {
    const placement = new InsertPlacement(box([0, 0, 0], [200, 50, 50]));
    expect(placement.next(null)).toEqual([220, 0, 0]);
    expect(placement.next(null)).toEqual([250, 0, 0]);
  });
});
