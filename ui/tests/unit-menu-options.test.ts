// The unit chip's dropup rows: which entries a part vs. an assembly gets,
// and which one is checked — the declared unit, or "Same as project" when
// the file declares none.

import { describe, it, expect } from 'vitest';
import { buildUnitMenuOptions } from '../src/ui/measure/unit-menu-options';

const ALL_UNITS = ['mm', 'cm', 'm', 'in', 'ft'];

describe('buildUnitMenuOptions', () => {
  it('leads a part with "Same as project (<project unit>)", checked when nothing is declared', () => {
    const options = buildUnitMenuOptions({ kind: 'part', declaredUnit: null, projectUnit: 'mm' }, 'mm');
    expect(options[0]).toEqual({ label: 'Same as project (mm)', unit: null, current: true });
    expect(options.slice(1).map((o) => o.label)).toEqual(ALL_UNITS);
    expect(options.slice(1).every((o) => !o.current)).toBe(true);
  });

  it('offers every unit as its code, with the long name as the tooltip', () => {
    const options = buildUnitMenuOptions({ kind: 'part', declaredUnit: null, projectUnit: 'mm' }, 'mm');
    expect(options.slice(1).map((o) => [o.label, o.title, o.unit])).toEqual([
      ['mm', 'Millimeter', 'mm'],
      ['cm', 'Centimeter', 'cm'],
      ['m', 'Meter', 'm'],
      ['in', 'Inch', 'in'],
      ['ft', 'Foot', 'ft'],
    ]);
  });

  it('checks the declared unit, even when it equals the project unit', () => {
    const options = buildUnitMenuOptions({ kind: 'part', declaredUnit: 'mm', projectUnit: 'mm' }, 'mm');
    expect(options.map((o) => [o.label, o.current])).toEqual([
      ['Same as project (mm)', false],
      ['mm', true],
      ['cm', false],
      ['m', false],
      ['in', false],
      ['ft', false],
    ]);
  });

  it('labels the project entry with the live project unit', () => {
    const options = buildUnitMenuOptions({ kind: 'part', declaredUnit: 'in', projectUnit: 'ft' }, 'in');
    expect(options[0]).toEqual({ label: 'Same as project (ft)', unit: null, current: false });
    expect(options.filter((o) => o.current).map((o) => o.unit)).toEqual(['in']);
  });

  it('gives an assembly only the units, checked on the scene unit', () => {
    const options = buildUnitMenuOptions({ kind: 'assembly', declaredUnit: null, projectUnit: 'in' }, 'in');
    expect(options.map((o) => o.label)).toEqual(ALL_UNITS);
    expect(options.every((o) => o.unit === o.label)).toBe(true);
    expect(options.filter((o) => o.current).map((o) => o.unit)).toEqual(['in']);
  });
});
