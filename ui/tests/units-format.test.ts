// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  convertLength,
  formatArea,
  formatLength,
  formatVolume,
  roundToUnitDecimals,
} from '../src/units/units';
import { applyUnitDefaults, niceDefault, unitStep } from '../src/units/apply-unit-defaults';
import { sceneUnit } from '../src/units/scene-unit';

// The formatter never converts for the common case: a number already in the
// document unit gets a suffix and per-unit decimals, nothing else.
describe('formatLength / formatArea / formatVolume', () => {
  it('appends the unit with its display decimals', () => {
    expect(formatLength(12.3456, 'mm')).toBe('12.35 mm');
    expect(formatLength(1.23456, 'in')).toBe('1.235 in');
    expect(formatLength(0.123456, 'm')).toBe('0.1235 m');
    expect(formatArea(2, 'in')).toBe('2.000 in²');
    expect(formatVolume(1, 'cm')).toBe('1.000 cm³');
  });

  it('honours explicit decimals and the suffix switch', () => {
    expect(formatLength(1.5, 'in', { decimals: 1, suffix: false })).toBe('1.5');
    expect(formatLength(-0.0001, 'mm')).toBe('0.00 mm');
  });

  it('converts between units through mm', () => {
    expect(convertLength(1, 'in', 'mm')).toBeCloseTo(25.4);
    expect(convertLength(25.4, 'mm', 'in')).toBeCloseTo(1);
    expect(convertLength(1, 'ft', 'in')).toBeCloseTo(12);
    expect(convertLength(3, 'm', 'cm')).toBeCloseTo(300);
  });

  it('rounds seeds to the unit decimals', () => {
    expect(roundToUnitDecimals(1.23456, 'mm')).toBe(1.23);
    expect(roundToUnitDecimals(0.0625, 'in')).toBe(0.063);
  });
});

describe('nice-number dialog defaults', () => {
  it('snaps mm defaults to nice values per unit', () => {
    expect(niceDefault(25, 'in')).toBe(1);
    expect(niceDefault(10, 'in')).toBe(0.5);
    expect(niceDefault(5, 'in')).toBe(0.25);
    expect(niceDefault(2, 'in')).toBe(0.1);
    expect(niceDefault(1, 'in')).toBe(0.05);
    expect(niceDefault(10, 'cm')).toBe(1);
    expect(niceDefault(25, 'cm')).toBe(2.5);
    expect(niceDefault(25, 'm')).toBe(0.025);
    expect(niceDefault(25, 'ft')).toBe(0.1);
    expect(niceDefault(25, 'mm')).toBe(25);
    expect(niceDefault(0, 'in')).toBe(0);
  });

  it('rewrites value/step of tagged inputs only, idempotently', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <input data-role="distance" data-unit="length" type="number" step="0.5" value="25" />
      <input data-role="draft" type="number" step="0.5" value="0" />
      <input data-role="offset" data-unit="length" type="number" step="any" placeholder="0" />
    `;
    const distance = root.querySelector<HTMLInputElement>('[data-role="distance"]')!;
    const draft = root.querySelector<HTMLInputElement>('[data-role="draft"]')!;
    const offset = root.querySelector<HTMLInputElement>('[data-role="offset"]')!;

    applyUnitDefaults(root, 'in');
    expect(distance.value).toBe('1');
    expect(distance.step).toBe(String(unitStep('in')));
    expect(draft.value).toBe('0');
    expect(draft.step).toBe('0.5');
    expect(offset.value).toBe('');
    expect(offset.step).toBe('any');

    // Re-applying for another unit starts from the mm originals again.
    applyUnitDefaults(root, 'cm');
    expect(distance.value).toBe('2.5');
    expect(distance.step).toBe('0.1');
    applyUnitDefaults(root, 'mm');
    expect(distance.value).toBe('25');
    expect(distance.step).toBe('0.5');
  });
});

describe('sceneUnit store', () => {
  it('defaults to mm, ignores unknown values, notifies on change only', () => {
    const seen: string[] = [];
    const off = sceneUnit.subscribe((u) => seen.push(u));
    expect(sceneUnit.current).toBe('mm');
    sceneUnit.set('in');
    sceneUnit.set('in');
    sceneUnit.set('yard');
    off();
    sceneUnit.set('mm');
    expect(seen).toEqual(['in', 'mm']);
  });
});
