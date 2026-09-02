import { describe, it, expect } from 'vitest';
import {
  DEFAULT_GRID_FIXED_SPACING,
  formatGridLabel,
  resolveGridSpacing,
} from '../src/grid/grid-spacing';
import type { GridPrefs } from '../src/grid/grid-spacing';

const adaptive: GridPrefs = {
  adaptive: true,
  minCellPx: 20,
  fixedSpacing: DEFAULT_GRID_FIXED_SPACING,
  majorEvery: 10,
};

/** A 500 px tall canvas showing `worldHeight` document units. */
const zoom = (worldHeight: number): number => worldHeight / 500;

describe('resolveGridSpacing — metric ladder', () => {
  it('walks 1-2-5 decades up as the view widens', () => {
    // 120 mm view → 0.24 mm/px → 20 px = 4.8 mm → 5 mm cell.
    expect(resolveGridSpacing('mm', zoom(120), adaptive)).toEqual({ minor: 5, major: 50 });
    // 500 mm view → 20 mm target → 20.
    expect(resolveGridSpacing('mm', zoom(500), adaptive)).toEqual({ minor: 20, major: 200 });
    // 2 m view in mm → 80 mm target → 100.
    expect(resolveGridSpacing('mm', zoom(2000), adaptive)).toEqual({ minor: 100, major: 1000 });
  });

  it('subdivides below the base rung when zoomed in', () => {
    // 5 mm view → 0.2 mm target → 0.2 mm; the old snapper floored at 10.
    expect(resolveGridSpacing('mm', zoom(5), adaptive)).toEqual({ minor: 0.2, major: 2 });
    // 0.3 mm view → 0.012 target → 0.02.
    const deep = resolveGridSpacing('mm', zoom(0.3), adaptive);
    expect(deep.minor).toBeCloseTo(0.02, 12);
    expect(deep.major).toBeCloseTo(0.2, 12);
  });

  it('never returns a cell narrower than minCellPx', () => {
    for (const worldHeight of [0.01, 0.7, 3, 42, 120, 999, 12345, 1e6]) {
      const wupp = zoom(worldHeight);
      const { minor, major } = resolveGridSpacing('m', wupp, adaptive);
      expect(minor / wupp).toBeGreaterThanOrEqual(20 - 1e-9);
      // …and is the SMALLEST such rung: the next rung down (÷2 or ÷2.5)
      // would be too narrow.
      expect((minor / 2.5) / wupp).toBeLessThan(20);
      expect(major).toBeCloseTo(minor * 10, 12);
    }
  });
});

describe('resolveGridSpacing — inch ladder', () => {
  it('picks binary fractions when zoomed in, with major = 4 × minor', () => {
    // 4 in view → 0.16 in target → 1/4 in.
    expect(resolveGridSpacing('in', zoom(4), adaptive)).toEqual({ minor: 1 / 4, major: 1 });
    // 1 in view → 0.04 target → 1/16 in.
    expect(resolveGridSpacing('in', zoom(1), adaptive)).toEqual({ minor: 1 / 16, major: 1 / 4 });
  });

  it('lands on customary units when zoomed out', () => {
    // 20 in view → 0.8 target → 1 in, major at a foot.
    expect(resolveGridSpacing('in', zoom(20), adaptive)).toEqual({ minor: 1, major: 12 });
    // 60 in view → 2.4 target → 3 in.
    expect(resolveGridSpacing('in', zoom(60), adaptive)).toEqual({ minor: 3, major: 12 });
    // 500 in view → 20 target → 36 in (yard), major 120.
    expect(resolveGridSpacing('in', zoom(500), adaptive)).toEqual({ minor: 36, major: 120 });
    // 5000 in → 200 target → 600.
    expect(resolveGridSpacing('in', zoom(5000), adaptive)).toEqual({ minor: 600, major: 6000 });
  });

  it('extends the table at both ends', () => {
    // 0.1 in view → 0.004 target → 1/128 in (below the table), major 4×.
    expect(resolveGridSpacing('in', zoom(0.1), adaptive)).toEqual({ minor: 1 / 128, major: 1 / 32 });
    // 1e5 in view → 4000 target → 6000 (above the table), major 10×.
    expect(resolveGridSpacing('in', zoom(1e5), adaptive)).toEqual({ minor: 6000, major: 60000 });
  });
});

describe('resolveGridSpacing — foot ladder', () => {
  it('uses inch-of-a-foot rungs with the foot as their major', () => {
    // 2 ft view → 0.08 target → 1/12 ft, major 1 ft.
    expect(resolveGridSpacing('ft', zoom(2), adaptive)).toEqual({ minor: 1 / 12, major: 1 });
    // 10 ft → 0.4 target → 1/2 ft.
    expect(resolveGridSpacing('ft', zoom(10), adaptive)).toEqual({ minor: 1 / 2, major: 1 });
    // 100 ft → 4 target → 5 ft, major 50.
    expect(resolveGridSpacing('ft', zoom(100), adaptive)).toEqual({ minor: 5, major: 50 });
  });
});

describe('resolveGridSpacing — fixed mode', () => {
  it('ignores zoom and multiplies the major by majorEvery', () => {
    const fixed: GridPrefs = { ...adaptive, adaptive: false, majorEvery: 5 };
    expect(resolveGridSpacing('mm', zoom(1), fixed)).toEqual({ minor: 10, major: 50 });
    expect(resolveGridSpacing('mm', zoom(10000), fixed)).toEqual({ minor: 10, major: 50 });
    expect(resolveGridSpacing('in', zoom(10000), fixed)).toEqual({ minor: 0.5, major: 2.5 });
  });

  it('falls back to the unit default for a bad fixed spacing', () => {
    const fixed: GridPrefs = {
      ...adaptive,
      adaptive: false,
      fixedSpacing: { ...DEFAULT_GRID_FIXED_SPACING, cm: 0 },
    };
    expect(resolveGridSpacing('cm', zoom(1), fixed)).toEqual({ minor: 1, major: 10 });
  });

  it('adaptive mode with no zoom yet uses the unit default', () => {
    expect(resolveGridSpacing('m', 0, adaptive)).toEqual({ minor: 0.1, major: 1 });
  });
});

describe('formatGridLabel', () => {
  it('reads imperial sub-unit rungs as fractions', () => {
    expect(formatGridLabel(1 / 8, 'in')).toBe('1/8 in');
    expect(formatGridLabel(1 / 64, 'in')).toBe('1/64 in');
    expect(formatGridLabel(1 / 128, 'in')).toBe('1/128 in');
    expect(formatGridLabel(1 / 12, 'ft')).toBe('1/12 ft');
    expect(formatGridLabel(1 / 4, 'ft')).toBe('1/4 ft');
  });

  it('reads whole and metric rungs as trimmed decimals', () => {
    expect(formatGridLabel(1, 'ft')).toBe('1 ft');
    expect(formatGridLabel(12, 'in')).toBe('12 in');
    expect(formatGridLabel(10, 'mm')).toBe('10 mm');
    expect(formatGridLabel(0.2, 'mm')).toBe('0.2 mm');
    expect(formatGridLabel(0.1, 'm')).toBe('0.1 m');
    expect(formatGridLabel(0.02, 'mm')).toBe('0.02 mm');
  });

  it('falls back to a decimal for a non-ladder imperial value', () => {
    expect(formatGridLabel(0.3, 'in')).toBe('0.3 in');
  });
});
