import { describe, it, expect } from 'vitest';
import {
  applyVariableName, classifyCommit, declaredVariableName, filterSuggestions,
  resolveExpressionValue, trailingIdentifier,
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

  it('wraps a declaration initializer as param() when asParam is set', () => {
    expect(classifyCommit('depth = 12.5', VARS, '25', false, true))
      .toEqual({ kind: 'declare', name: 'depth', initializer: 'param("depth", 12.5)' });
    expect(classifyCommit('depth = height * 2', VARS, '25', false, true))
      .toEqual({ kind: 'declare', name: 'depth', initializer: 'param("depth", height * 2)' });
    expect(classifyCommit('depth', VARS, '25', false, true))
      .toEqual({ kind: 'declare', name: 'depth', initializer: 'param("depth", 25)' });
  });

  it('numericOnly refuses identifiers', () => {
    expect(classifyCommit('height', VARS, '25', true)).toMatchObject({ kind: 'error' });
    expect(classifyCommit('12', VARS, '25', true)).toEqual({ kind: 'expression', expression: '12' });
  });
});

describe('declaredVariableName', () => {
  it('yields the name for a name = value input', () => {
    expect(declaredVariableName('depth = 12.5', VARS, '25')).toBe('depth');
    expect(declaredVariableName('depth=height * 2', VARS, '25')).toBe('depth');
  });

  it('yields a fresh identifier with no variable match, given a seed', () => {
    expect(declaredVariableName('depth', VARS, '25')).toBe('depth');
    expect(declaredVariableName('depth', VARS, '')).toBeNull();
    expect(declaredVariableName('height', VARS, '25')).toBeNull();
  });

  it('yields null for plain expressions and errors', () => {
    expect(declaredVariableName('height * 2', VARS, '25')).toBeNull();
    expect(declaredVariableName('height = 40', VARS, '25')).toBeNull();
    expect(declaredVariableName('class = 4', VARS, '25')).toBeNull();
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

describe('resolveExpressionValue', () => {
  it('resolves numbers, negatives and scientific notation', () => {
    expect(resolveExpressionValue('20', VARS)).toBe(20);
    expect(resolveExpressionValue('-12.5', VARS)).toBe(-12.5);
    expect(resolveExpressionValue('1.5e2', VARS)).toBe(150);
  });

  it('evaluates arithmetic with precedence, parens and unary sign', () => {
    expect(resolveExpressionValue('5*4', VARS)).toBe(20);
    expect(resolveExpressionValue('2 + 3 * 4', VARS)).toBe(14);
    expect(resolveExpressionValue('(2 + 3) * 4', VARS)).toBe(20);
    expect(resolveExpressionValue('10 % 3', VARS)).toBe(1);
    expect(resolveExpressionValue('-(2 + 3)', VARS)).toBe(-5);
  });

  it('resolves variables through their initializers', () => {
    expect(resolveExpressionValue('width', VARS)).toBe(100);
    expect(resolveExpressionValue('width / 2', VARS)).toBe(50);
    expect(resolveExpressionValue('width / 2 - holeDia', VARS)).toBe(44);
  });

  it('resolves chained and param()-wrapped initializers', () => {
    const vars = [
      { name: 'w', initializer: 'param("w", 40)' },
      { name: 'half', initializer: 'w / 2' },
    ];
    expect(resolveExpressionValue('w', vars)).toBe(40);
    expect(resolveExpressionValue('half + 1', vars)).toBe(21);
  });

  it('uses the pending declaration for its own name', () => {
    expect(resolveExpressionValue('cx', VARS, { name: 'cx', initializer: '25' })).toBe(25);
    expect(resolveExpressionValue('cx', VARS, { name: 'cx', initializer: 'param("cx", 7)' })).toBe(7);
  });

  it('returns null for calls, unknown names, cycles and non-finite results', () => {
    expect(resolveExpressionValue('housing', VARS)).toBeNull();
    expect(resolveExpressionValue('Math.max(2, 3)', VARS)).toBeNull();
    expect(resolveExpressionValue('nope + 1', VARS)).toBeNull();
    expect(resolveExpressionValue('1 / 0', VARS)).toBeNull();
    expect(resolveExpressionValue('', VARS)).toBeNull();
    const cyclic = [
      { name: 'a', initializer: 'b + 1' },
      { name: 'b', initializer: 'a + 1' },
    ];
    expect(resolveExpressionValue('a', cyclic)).toBeNull();
  });
});
