import { describe, expect, it } from 'vitest';

// A pasted cell's text read as a value of the parameter's own type.

import { ParamTextParser } from '../src/ui/param-text-parser';
import type { UIParamDefinition } from '../src/types';

const param = (def: Partial<UIParamDefinition>): UIParamDefinition => ({
  label: 'P', kind: 'assembly', defaultValue: 0, currentValue: 0, controlType: 'number', ...def,
});

describe('ParamTextParser', () => {
  it('reads a blank cell as no value, whatever the type', () => {
    expect(ParamTextParser.parse(param({}), '  ')).toEqual({ value: null });
    expect(ParamTextParser.parse(param({ controlType: 'checkbox', defaultValue: true }), '')).toEqual({ value: null });
  });

  it('reads numbers within the bounds, sliders and auto numbers included', () => {
    expect(ParamTextParser.parse(param({}), ' 1 400.5 ')).toEqual({ value: 1400.5 });
    expect(ParamTextParser.parse(param({ controlType: 'slider', min: 0, max: 10 }), '10')).toEqual({ value: 10 });
    expect(ParamTextParser.parse(param({ controlType: 'auto', defaultValue: 3 }), '-2')).toEqual({ value: -2 });
    expect(ParamTextParser.parse(param({}), 'wide')).toEqual({ error: '“wide” is not a number' });
    expect(ParamTextParser.parse(param({ min: 8, max: 24 }), '30')).toEqual({ error: '30 is outside 8–24' });
    expect(ParamTextParser.parse(param({ min: 8 }), '2')).toEqual({ error: '2 is outside the minimum 8' });
  });

  it('reads yes / no in the forms spreadsheets write them', () => {
    const lid = param({ controlType: 'checkbox', defaultValue: true });
    for (const text of ['TRUE', 'yes', 'Y', '1', 'on']) {
      expect(ParamTextParser.parse(lid, text)).toEqual({ value: true });
    }
    for (const text of ['FALSE', 'No', '0', 'off']) {
      expect(ParamTextParser.parse(lid, text)).toEqual({ value: false });
    }
    expect(ParamTextParser.parse(lid, 'maybe')).toEqual({ error: '“maybe” is not yes or no' });
  });

  it('reads an option by its value or label, keeping the value\'s type', () => {
    const finish = param({
      controlType: 'select', defaultValue: 'raw',
      options: [{ label: 'Raw', value: 'raw' }, { label: 'Painted', value: 'paint' }],
    });
    expect(ParamTextParser.parse(finish, 'paint')).toEqual({ value: 'paint' });
    expect(ParamTextParser.parse(finish, 'painted')).toEqual({ value: 'paint' });
    expect(ParamTextParser.parse(finish, 'Gold')).toEqual({ error: '“Gold” is not one of Raw, Painted' });
    const size = param({ controlType: 'select', defaultValue: 4, options: [{ label: 'M4', value: 4 }, { label: 'M6', value: 6 }] });
    expect(ParamTextParser.parse(size, '6')).toEqual({ value: 6 });
  });

  it('reads a multi-select as its comma separated options', () => {
    const extras = param({
      controlType: 'select', multi: true, defaultValue: [],
      options: [{ label: 'Feet', value: 'feet' }, { label: 'Handles', value: 'handles' }],
    });
    expect(ParamTextParser.parse(extras, 'Handles, feet; handles')).toEqual({ value: ['handles', 'feet'] });
    expect(ParamTextParser.parse(extras, 'feet, wheels')).toEqual({ error: '“wheels” is not one of Feet, Handles' });
  });

  it('reads colours as #rrggbb, short forms expanded', () => {
    const tint = param({ controlType: 'color', defaultValue: '#000000' });
    expect(ParamTextParser.parse(tint, '#4A90D9')).toEqual({ value: '#4a90d9' });
    expect(ParamTextParser.parse(tint, 'f80')).toEqual({ value: '#ff8800' });
    expect(ParamTextParser.parse(tint, 'red')).toEqual({ error: '“red” is not a #rrggbb colour' });
  });

  it('keeps text as written', () => {
    expect(ParamTextParser.parse(param({ controlType: 'text', defaultValue: '' }), ' GB-1')).toEqual({ value: ' GB-1' });
  });
});
