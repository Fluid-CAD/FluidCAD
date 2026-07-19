import { describe, it, expect } from 'vitest';
import {
  applyVariableName, classifyCommit, filterSuggestions, trailingIdentifier,
} from '../src/ui/expression-core';

const VARS = [
  { name: 'height', initializer: '30' },
  { name: 'width', initializer: '100' },
  { name: 'holeDia', initializer: '6' },
  { name: 'housing', initializer: 'extrude(profile, 10)', numeric: false },
];

describe('classifyCommit', () => {
  it('passes a known variable through as the expression', () => {
    expect(classifyCommit('height', VARS, '25')).toEqual({ kind: 'expression', expression: 'height' });
  });

  it('declares a fresh name from the seed value', () => {
    expect(classifyCommit('depth', VARS, '25')).toEqual({ kind: 'declare', name: 'depth', initializer: '25' });
  });

  it('declares from an explicit name = value form', () => {
    expect(classifyCommit('depth = 12.5', VARS, '25'))
      .toEqual({ kind: 'declare', name: 'depth', initializer: '12.5' });
  });

  it('rejects redefining an existing variable', () => {
    expect(classifyCommit('height = 40', VARS, '25')).toMatchObject({ kind: 'error' });
  });

  it('rejects a reserved word as a new name', () => {
    expect(classifyCommit('class = 4', VARS, '25')).toMatchObject({ kind: 'error' });
    expect(classifyCommit('class', VARS, '25')).toEqual({ kind: 'expression', expression: 'class' });
  });

  it('rejects a fresh name with no seed to assign', () => {
    expect(classifyCommit('depth', VARS, '')).toMatchObject({ kind: 'error' });
  });

  it('passes arithmetic through as the expression', () => {
    expect(classifyCommit('height * 2', VARS, '25'))
      .toEqual({ kind: 'expression', expression: 'height * 2' });
  });

  it('numericOnly refuses identifiers', () => {
    expect(classifyCommit('height', VARS, '25', true)).toMatchObject({ kind: 'error' });
    expect(classifyCommit('12', VARS, '25', true)).toEqual({ kind: 'expression', expression: '12' });
  });
});

describe('filterSuggestions', () => {
  it('ranks exact, then prefix, then substring matches', () => {
    const names = filterSuggestions('h', VARS, 'h', '25').map(s => s.name);
    expect(names).toEqual(['height', 'holeDia', 'width', 'h']);
    expect(filterSuggestions('h', VARS, 'h', '25').at(-1)).toMatchObject({ isNew: true });
  });

  it('offers no new-variable entry mid-expression or without a seed', () => {
    expect(filterSuggestions('dep', VARS, '2 + dep', '25').some(s => s.isNew)).toBe(false);
    expect(filterSuggestions('dep', VARS, 'dep', '').some(s => s.isNew)).toBe(false);
  });

  it('hides non-numeric variables (feature results) from the dropdown', () => {
    expect(filterSuggestions('hous', VARS, 'hous', '25').map(s => s.name)).toEqual(['hous']);
    // ...but their name still blocks the new-variable offer and redeclaration.
    expect(filterSuggestions('housing', VARS, 'housing', '25').some(s => s.isNew)).toBe(false);
    expect(classifyCommit('housing = 4', VARS, '25')).toMatchObject({ kind: 'error' });
  });
});

describe('trailing identifier helpers', () => {
  it('finds the identifier being typed and replaces it on fill', () => {
    expect(trailingIdentifier('2 * hei')).toBe('hei');
    expect(trailingIdentifier('25')).toBeNull();
    expect(applyVariableName('2 * hei', 'height')).toBe('2 * height');
    expect(applyVariableName('2 * ', 'height')).toBe('2 * height');
  });
});
