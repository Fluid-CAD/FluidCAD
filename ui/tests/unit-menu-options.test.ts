// The unit chip's dropup rows: which entries a part vs. an assembly gets,
// and which one is checked — the declared unit, or "Same as project" when
// the file declares none.

import { describe, it, expect } from 'vitest';
import { buildUnitMenuOptions } from '../src/ui/measure/unit-menu-options';

describe('buildUnitMenuOptions', () => {
  it('leads a part with "Same as project (<project unit>)", checked when nothing is declared', () => {
    const options = buildUnitMenuOptions({ kind: 'part', declaredUnit: null, projectUnit: 'mm' }, 'mm');
    expect(options).toEqual([
      { label: 'Same as project (mm)', unit: null, current: true },
      { label: 'mm', unit: 'mm', current: false },
      { label: 'in', unit: 'in', current: false },
    ]);
  });

  it('checks the declared unit, even when it equals the project unit', () => {
    const options = buildUnitMenuOptions({ kind: 'part', declaredUnit: 'mm', projectUnit: 'mm' }, 'mm');
    expect(options.map((o) => [o.label, o.current])).toEqual([
      ['Same as project (mm)', false],
      ['mm', true],
      ['in', false],
    ]);
  });

  it('labels the project entry with the live project unit', () => {
    const options = buildUnitMenuOptions({ kind: 'part', declaredUnit: 'in', projectUnit: 'ft' }, 'in');
    expect(options[0]).toEqual({ label: 'Same as project (ft)', unit: null, current: false });
    expect(options.find((o) => o.unit === 'in')?.current).toBe(true);
  });

  it('appends an unusual current unit so the checked entry is always listed', () => {
    const options = buildUnitMenuOptions({ kind: 'part', declaredUnit: 'cm', projectUnit: 'mm' }, 'cm');
    expect(options.map((o) => o.label)).toEqual(['Same as project (mm)', 'mm', 'in', 'cm']);
    expect(options.filter((o) => o.current).map((o) => o.unit)).toEqual(['cm']);
  });

  it('gives an assembly only the units, checked on the scene unit', () => {
    const options = buildUnitMenuOptions({ kind: 'assembly', declaredUnit: null, projectUnit: 'in' }, 'in');
    expect(options).toEqual([
      { label: 'mm', unit: 'mm', current: false },
      { label: 'in', unit: 'in', current: true },
    ]);
  });
});
