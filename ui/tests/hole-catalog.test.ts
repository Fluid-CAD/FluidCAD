import { describe, expect, it } from 'vitest';
import {
  coarsePitch, defaultDrilledDiameter, pitchOptions, sizeLabels, standardOf, tableCounterbore, tableCountersink,
  tableDiameter,
} from '../src/interactive/create-feature/hole/hole-catalog';

// The catalog the Hole dialog reads: the standard tables, expressed in the
// document's unit and rounded to what that unit displays.

describe('hole catalog', () => {
  it('lists the sizes of each standard in table order', () => {
    expect(sizeLabels('metric').slice(0, 4)).toEqual(['M1.6', 'M2', 'M2.5', 'M3']);
    expect(sizeLabels('inch')).toContain('1/4');
    expect(sizeLabels('inch')).toContain('#10');
  });

  it('derives clearance and tap-drill diameters in millimetres for a metric size', () => {
    expect(tableDiameter('M6', 'clearance', { fit: 'close' }, 'mm')).toBe(6.4);
    expect(tableDiameter('M6', 'clearance', { fit: 'normal' }, 'mm')).toBe(6.6);
    expect(tableDiameter('M6', 'tapped', { pitch: null }, 'mm')).toBe(5);
    expect(tableDiameter('M6', 'tapped', { pitch: 0.75 }, 'mm')).toBe(5.25);
    expect(tableDiameter('M6', 'tapped', { pitch: 1.5 }, 'mm')).toBeNull();
    expect(tableDiameter('M6', 'drilled', {}, 'mm')).toBeNull();
  });

  it('converts inch tables into the document unit', () => {
    // 0.266 in → 6.7564 mm, shown at the millimetre's two decimals.
    expect(tableDiameter('1/4', 'clearance', { fit: 'normal' }, 'mm')).toBe(6.76);
    expect(tableDiameter('1/4', 'clearance', { fit: 'normal' }, 'in')).toBe(0.266);
    // M6 in an inch document: 6.6 mm → 0.26 in (three decimals).
    expect(tableDiameter('M6', 'clearance', { fit: 'normal' }, 'in')).toBe(0.26);
  });

  it('seeds counterbore and countersink values from the tables', () => {
    expect(tableCounterbore('M6', 'mm')).toEqual({ diameter: 11, depth: 6.8 });
    expect(tableCountersink('M6', 'mm')).toEqual({ diameter: 13.44, angle: 90 });
    expect(tableCountersink('1/4', 'in')).toEqual({ diameter: 0.507, angle: 82 });
    expect(tableCounterbore('M99', 'mm')).toBeNull();
  });

  it('labels pitches with their unit and marks the coarse one', () => {
    expect(pitchOptions('M6')).toEqual([
      { value: 1, label: '1 mm (coarse)' },
      { value: 0.75, label: '0.75 mm (fine)' },
    ]);
    expect(pitchOptions('1/4')[0]).toEqual({ value: 20, label: '20 tpi (coarse)' });
    expect(coarsePitch('M8')).toBe(1.25);
    expect(pitchOptions('M99')).toEqual([]);
  });

  it('tells a size label\'s standard and falls back for unknown labels', () => {
    expect(standardOf('M6')).toBe('metric');
    expect(standardOf('#10')).toBe('inch');
    expect(standardOf(null)).toBe('metric');
    expect(standardOf('bogus', 'inch')).toBe('inch');
  });

  it('starts a drilled hole at 6 mm in the document unit', () => {
    expect(defaultDrilledDiameter('mm')).toBe(6);
    expect(defaultDrilledDiameter('in')).toBe(0.236);
  });
});
