import { describe, it, expect } from 'vitest';
import { SectionPlaneMath, type SectionSpec } from '../src/scene/section-spec';

describe('SectionPlaneMath.resolve', () => {
  it('resolves the named datum planes to the world origin and their +axis normal', () => {
    expect(SectionPlaneMath.resolve({ plane: 'xy' }).normal).toEqual([0, 0, 1]);
    expect(SectionPlaneMath.resolve({ plane: 'yz' }).normal).toEqual([1, 0, 0]);
    expect(SectionPlaneMath.resolve({ plane: 'xz' }).normal).toEqual([0, 1, 0]);
    expect(SectionPlaneMath.resolve({ plane: 'xy' }).point).toEqual([0, 0, 0]);
  });

  it('normalizes an explicit normal and keeps the origin', () => {
    const section = SectionPlaneMath.resolve({ plane: { origin: [1, 2, 3], normal: [0, 3, 0] } });
    expect(section.normal).toEqual([0, 1, 0]);
    expect(section.point).toEqual([1, 2, 3]);
  });

  it('moves the cut point along the normal by offset, in document units', () => {
    expect(SectionPlaneMath.resolve({ plane: 'xy', offset: 10 }).point).toEqual([0, 0, 10]);
    expect(SectionPlaneMath.resolve({ plane: 'yz', offset: -2.5 }).point).toEqual([-2.5, 0, 0]);
    const tilted = SectionPlaneMath.resolve({ plane: { origin: [0, 0, 0], normal: [0, 4, 3] }, offset: 5 });
    expect(tilted.point[1]).toBeCloseTo(4, 9);
    expect(tilted.point[2]).toBeCloseTo(3, 9);
  });

  it('removes the half the normal points at by default, so a point above an xy section is cut and a point below kept', () => {
    const section = SectionPlaneMath.resolve({ plane: 'xy', offset: 10 });
    expect(section.removedDirection).toEqual([0, 0, 1]);
    expect(section.keptDirection).toEqual([-0, -0, -1]);
    expect(SectionPlaneMath.keeps(section, [0, 0, 5])).toBe(true);
    expect(SectionPlaneMath.keeps(section, [0, 0, 15])).toBe(false);
    expect(SectionPlaneMath.keeps(section, [7, -3, 10])).toBe(true);
    expect(SectionPlaneMath.signedDistance(section, [0, 0, 4])).toBeCloseTo(6, 9);
    expect(SectionPlaneMath.signedDistance(section, [0, 0, 12])).toBeCloseTo(-2, 9);
  });

  it('flip keeps the half the normal points at instead', () => {
    const section = SectionPlaneMath.resolve({ plane: 'xy', offset: 10, flip: true });
    expect(section.removedDirection).toEqual([-0, -0, -1]);
    expect(section.keptDirection).toEqual([0, 0, 1]);
    expect(SectionPlaneMath.keeps(section, [0, 0, 5])).toBe(false);
    expect(SectionPlaneMath.keeps(section, [0, 0, 15])).toBe(true);
    expect(SectionPlaneMath.keeps(section, [0, 0, 10])).toBe(true);
  });

  it('expresses the cut as a three.js material clipping plane (normal = kept direction, constant through the point)', () => {
    const section = SectionPlaneMath.resolve({ plane: 'yz', offset: 4 });
    expect(section.clipPlane.normal).toEqual([-1, -0, -0]);
    expect(section.clipPlane.constant).toBeCloseTo(4, 9);
    const flipped = SectionPlaneMath.resolve({ plane: 'yz', offset: 4, flip: true });
    expect(flipped.clipPlane.normal).toEqual([1, 0, 0]);
    expect(flipped.clipPlane.constant).toBeCloseTo(-4, 9);
    // The same plane is the same cut whichever way it was spelled.
    const explicit = SectionPlaneMath.resolve({ plane: { origin: [4, 9, 9], normal: [2, 0, 0] } });
    expect(explicit.clipPlane.normal).toEqual(section.clipPlane.normal);
    expect(explicit.clipPlane.constant).toBeCloseTo(section.clipPlane.constant, 9);
  });
});

describe('SectionPlaneMath.validate', () => {
  it('accepts a named plane, an explicit plane, offset and flip, returning a clean copy', () => {
    expect(SectionPlaneMath.validate({ plane: 'xz' })).toEqual({ plane: 'xz' });
    const explicit = { origin: [1, 2, 3], normal: [0, 0, -1] };
    const spec = SectionPlaneMath.validate({ plane: explicit, offset: 2, flip: true, extra: 1 }) as SectionSpec;
    expect(spec).toEqual({ plane: { origin: [1, 2, 3], normal: [0, 0, -1] }, offset: 2, flip: true });
    expect((spec.plane as { origin: number[] }).origin).not.toBe(explicit.origin);
  });

  it('names the field that is wrong', () => {
    expect(SectionPlaneMath.validate(null)).toContain('section must be an object');
    expect(SectionPlaneMath.validate({})).toContain('section.plane must be one of xy, yz, xz');
    expect(SectionPlaneMath.validate({ plane: 'ab' })).toContain('section.plane');
    expect(SectionPlaneMath.validate({ plane: { origin: [0, 0], normal: [0, 0, 1] } })).toContain('section.plane.origin');
    expect(SectionPlaneMath.validate({ plane: { origin: [0, 0, 0], normal: [0, 0, 0] } })).toContain('zero vector');
    expect(SectionPlaneMath.validate({ plane: { origin: [0, 0, 0], normal: [0, 0, Number.NaN] } })).toContain('section.plane.normal');
    expect(SectionPlaneMath.validate({ plane: 'xy', offset: '10' })).toContain('section.offset');
    expect(SectionPlaneMath.validate({ plane: 'xy', offset: Number.POSITIVE_INFINITY })).toContain('section.offset');
    expect(SectionPlaneMath.validate({ plane: 'xy', flip: 1 })).toContain('section.flip');
    expect(SectionPlaneMath.validate({ plane: 'xy' }, 'image.section')).toEqual({ plane: 'xy' });
    expect(SectionPlaneMath.validate({ plane: 3 }, 'image.section')).toContain('image.section.plane');
  });
});
