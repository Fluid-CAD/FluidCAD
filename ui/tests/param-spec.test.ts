// The parameter editor's non-DOM half: what the dialog opens on, what happens
// to a default value when the control under it changes, and how a delete is
// worded when the model still reads the variable.

import { describe, it, expect } from 'vitest';
import type { UIParamDefinition } from '../src/types';
import {
  coerceDefaultValue,
  describeDeletion,
  effectiveParamType,
  specFromDefinition,
} from '../src/ui/param-spec';

function def(overrides: Partial<UIParamDefinition> = {}): UIParamDefinition {
  return {
    label: 'Width',
    defaultValue: 100,
    currentValue: 100,
    controlType: 'number',
    ...overrides,
  };
}

describe('effectiveParamType', () => {
  it('resolves an auto control the way param() would', () => {
    expect(effectiveParamType(def({ controlType: 'auto', defaultValue: 10 }))).toBe('number');
    expect(effectiveParamType(def({ controlType: 'auto', defaultValue: true }))).toBe('checkbox');
    expect(effectiveParamType(def({ controlType: 'auto', defaultValue: 'hi' }))).toBe('text');
  });

  it('keeps a declared control', () => {
    expect(effectiveParamType(def({ controlType: 'slider' }))).toBe('slider');
  });
});

describe('specFromDefinition', () => {
  it('seeds from the declared default, not the overridden value', () => {
    // The panel's slider sits at 250; the file still says 100, and that is
    // what an edit of the declaration must start from.
    const spec = specFromDefinition(def({ defaultValue: 100, currentValue: 250 }));
    expect(spec.defaultValue).toBe(100);
  });

  it('carries the control options across', () => {
    const spec = specFromDefinition(def({
      controlType: 'select',
      defaultValue: 'a',
      options: [{ label: 'A', value: 'a' }],
      multi: true,
      group: 'Body',
      description: 'Pick one',
      min: 1,
      max: 9,
      step: 2,
    }));
    expect(spec).toEqual({
      label: 'Width',
      defaultValue: 'a',
      type: 'select',
      group: 'Body',
      description: 'Pick one',
      min: 1,
      max: 9,
      step: 2,
      options: [{ label: 'A', value: 'a' }],
      multi: true,
      multiControlType: 'select',
    });
  });

  it('copies the options rather than aliasing the definition', () => {
    const source = def({ controlType: 'select', defaultValue: 'a', options: [{ label: 'A', value: 'a' }] });
    const spec = specFromDefinition(source);
    spec.options![0].label = 'edited';
    expect(source.options![0].label).toBe('A');
  });

  it('leaves unset options off entirely', () => {
    expect(specFromDefinition(def())).toEqual({ label: 'Width', defaultValue: 100, type: 'number' });
  });
});

describe('coerceDefaultValue', () => {
  it('keeps a value the new control can hold', () => {
    expect(coerceDefaultValue('slider', 100)).toBe(100);
    expect(coerceDefaultValue('checkbox', true)).toBe(true);
    expect(coerceDefaultValue('text', 'wide')).toBe('wide');
  });

  it('parses a numeric string into a number control', () => {
    expect(coerceDefaultValue('number', '42')).toBe(42);
  });

  it('falls back to the control\'s own neutral value', () => {
    expect(coerceDefaultValue('number', 'wide')).toBe(0);
    expect(coerceDefaultValue('checkbox', 100)).toBe(false);
    expect(coerceDefaultValue('color', 'not a colour')).toBe('#888888');
    expect(coerceDefaultValue('color', '#ff0000')).toBe('#ff0000');
  });

  it('renders a value as text when the control turns into one', () => {
    expect(coerceDefaultValue('text', 100)).toBe('100');
    expect(coerceDefaultValue('text', ['a', 'b'])).toBe('a');
  });

  it('holds a select to its own options', () => {
    const options = [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }];
    expect(coerceDefaultValue('select', 'b', options)).toBe('b');
    // The chosen option was just deleted — fall to the first that survives.
    expect(coerceDefaultValue('select', 'gone', options)).toBe('a');
    expect(coerceDefaultValue('select', ['gone', 'b'], options)).toBe('b');
    expect(coerceDefaultValue('select', 'a', [])).toBe('');
  });

  it('keeps every surviving choice of a multi-valued select', () => {
    const options = [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }];
    expect(coerceDefaultValue('select', ['a', 'b'], options, true)).toEqual(['a', 'b']);
    expect(coerceDefaultValue('select', ['a', 'gone'], options, true)).toEqual(['a']);
    // Nothing left to pick from, and nothing invented in its place.
    expect(coerceDefaultValue('select', ['a'], [], true)).toEqual([]);
    expect(coerceDefaultValue('select', 'gone', options, true)).toEqual([]);
  });
});

describe('describeDeletion', () => {
  it('says plainly that nothing breaks when nothing reads it', () => {
    const text = describeDeletion('Width', {
      label: 'Width', variable: 'width', references: 0, referenceLines: [], editable: true,
    });
    expect(text).toContain('Delete “Width”?');
    expect(text).not.toContain('break');
  });

  it('names the variable, the count and the lines that will break', () => {
    const text = describeDeletion('Width', {
      label: 'Width', variable: 'width', references: 2, referenceLines: [7, 10], editable: true,
    });
    expect(text).toContain('“width” is still used 2 times (lines 7, 10)');
    expect(text).toContain('break the model');
  });

  it('reads right for a single reference, and marks a truncated list', () => {
    const one = describeDeletion('Width', {
      label: 'Width', variable: 'width', references: 1, referenceLines: [7], editable: true,
    });
    expect(one).toContain('used once (line 7)');

    const many = describeDeletion('Width', {
      label: 'Width', variable: 'width', references: 9, referenceLines: [1, 2, 3, 4, 5], editable: true,
    });
    expect(many).toContain('(lines 1, 2, 3, 4, 5, …)');
  });

  it('degrades to the plain wording when the usage lookup failed', () => {
    expect(describeDeletion('Width', null)).toContain('removed from the code');
  });
});
