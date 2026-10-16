import { describe, it, expect } from 'vitest';
import {
  applyVariableName, classifyCommit, declaredVariableName, filterSuggestions, paramInitializer,
  resolveExpressionValue, suggestionItemHtml, suggestionKind, suggestsExistingName,
  suggestionValueHint, trailingIdentifier,
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
    expect(classifyCommit('depth', VARS, '25'))
      .toEqual({ kind: 'declare', name: 'depth', initializer: '25', expression: 'depth' });
  });

  it('declares from an explicit name = value form', () => {
    expect(classifyCommit('depth = 12.5', VARS, '25'))
      .toEqual({ kind: 'declare', name: 'depth', initializer: '12.5', expression: 'depth' });
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
      .toEqual({ kind: 'declare', name: 'depth', initializer: "param('depth', 12.5)", expression: 'depth' });
    expect(classifyCommit('depth = height * 2', VARS, '25', false, true))
      .toEqual({
        kind: 'declare', name: 'depth', initializer: "param('depth', height * 2)", expression: 'depth',
      });
    expect(classifyCommit('depth', VARS, '25', false, true))
      .toEqual({ kind: 'declare', name: 'depth', initializer: "param('depth', 25)", expression: 'depth' });
  });

  it('writes the param() label single-quoted, escaping quotes and backslashes', () => {
    expect(paramInitializer('length', '60')).toBe("param('length', 60)");
    expect(paramInitializer("it's", '1')).toBe("param('it\\'s', 1)");
    expect(paramInitializer('a\\b', '1')).toBe("param('a\\\\b', 1)");
  });

  describe('a property the part publishes without binding it', () => {
    const POCKET = "property('Pocket diameter', 'pocketDiameter', width - 2 * wall)";
    const vars = [
      ...VARS,
      { name: 'wall', initializer: '4' },
      { name: 'pocketDiameter', initializer: POCKET, numeric: true, unbound: true },
      { name: 'boltCount', initializer: "property('Bolt count', 'boltCount', 4)", numeric: true, unbound: true },
      { name: 'lipHeight', initializer: "property('Lip', 'lipHeight', wall / 2)" },
    ];

    it('reads as the expression typed and declares the name over the property call', () => {
      expect(classifyCommit('pocketDiameter', vars, '25')).toEqual({
        kind: 'declare', name: 'pocketDiameter', initializer: POCKET, expression: 'pocketDiameter', property: true,
      });
      expect(classifyCommit('pocketDiameter / 2 + height', vars, '25')).toEqual({
        kind: 'declare',
        name: 'pocketDiameter',
        initializer: POCKET,
        expression: 'pocketDiameter / 2 + height',
        property: true,
      });
    });

    it('never wraps the bind as a param(), whatever the toggle says', () => {
      expect(classifyCommit('pocketDiameter', vars, '25', false, true)).toMatchObject({ initializer: POCKET });
    });

    it('is a plain expression once bound, and a member read is no use of it', () => {
      expect(classifyCommit('lipHeight * 2', vars, '25')).toEqual({ kind: 'expression', expression: 'lipHeight * 2' });
      expect(classifyCommit('box.properties.pocketDiameter', vars, '25'))
        .toEqual({ kind: 'expression', expression: 'box.properties.pocketDiameter' });
    });

    it('binds one property per commit', () => {
      expect(classifyCommit('pocketDiameter + boltCount', vars, '25')).toMatchObject({ kind: 'error' });
      expect(classifyCommit('gap = pocketDiameter - 1', vars, '25')).toMatchObject({ kind: 'error' });
      expect(classifyCommit('pocketDiameter = 4', vars, '25')).toMatchObject({ kind: 'error' });
    });
  });

  it('numericOnly refuses identifiers', () => {
    expect(classifyCommit('height', VARS, '25', true)).toMatchObject({ kind: 'error' });
    expect(classifyCommit('12', VARS, '25', true)).toEqual({ kind: 'expression', expression: '12' });
  });

  it('arithmeticOnly passes numbers and arithmetic through', () => {
    expect(classifyCommit('12.5', [], '0', false, false, true))
      .toEqual({ kind: 'expression', expression: '12.5' });
    expect(classifyCommit('50*2', [], '0', false, false, true))
      .toEqual({ kind: 'expression', expression: '50*2' });
    expect(classifyCommit('25/2 + 1', [], '0', false, false, true))
      .toEqual({ kind: 'expression', expression: '25/2 + 1' });
    expect(classifyCommit('-(3 % 2)', [], '0', false, false, true))
      .toEqual({ kind: 'expression', expression: '-(3 % 2)' });
  });

  it('arithmeticOnly resolves known variables but never declares', () => {
    expect(classifyCommit('height * 2', VARS, '0', false, false, true))
      .toEqual({ kind: 'expression', expression: 'height * 2' });
    // A bare unknown identifier would DECLARE in the default mode — here it errors.
    expect(classifyCommit('depth', [], '25', false, false, true)).toMatchObject({ kind: 'error' });
    expect(classifyCommit('depth = 12', [], '25', false, false, true)).toMatchObject({ kind: 'error' });
  });

  it('arithmeticOnly refuses non-finite and non-arithmetic input', () => {
    expect(classifyCommit('1 / 0', [], '0', false, false, true)).toMatchObject({ kind: 'error' });
    expect(classifyCommit('Math.max(2, 3)', [], '0', false, false, true)).toMatchObject({ kind: 'error' });
    expect(classifyCommit('5 mm', [], '0', false, false, true)).toMatchObject({ kind: 'error' });
    expect(classifyCommit('', [], '0', false, false, true)).toMatchObject({ kind: 'error' });
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

  it('yields null for a property bind — the P toggle has nothing to wrap', () => {
    const vars = [...VARS, { name: 'lip', initializer: "property('Lip', 'lip', 3)", unbound: true }];
    expect(declaredVariableName('lip', vars, '25')).toBeNull();
    expect(declaredVariableName('lip * 2', vars, '25')).toBeNull();
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

describe('suggestsExistingName', () => {
  it('holds while the dropdown lists an existing variable for the bare name', () => {
    expect(suggestsExistingName('hei', filterSuggestions('hei', VARS, 'hei', '25'))).toBe(true);
  });

  it('clears once only the new-variable offer is left, or nothing is listed', () => {
    expect(suggestsExistingName('depth', filterSuggestions('depth', VARS, 'depth', '25'))).toBe(false);
    expect(suggestsExistingName('hei', [])).toBe(false);
  });

  it('ignores matches that complete the value of an explicit declaration', () => {
    const value = 'depth = hei';
    expect(suggestsExistingName(value, filterSuggestions('hei', VARS, value, '25'))).toBe(false);
  });
});

describe('suggestionKind', () => {
  it('reads param(), plain values and computed expressions off the initializer', () => {
    expect(suggestionKind({ name: 'w', initializer: "param('w', 40)" }, false)).toBe('param');
    expect(suggestionKind({ name: 'w', initializer: "param('w', 40, 'number', { min: 1 })" }, false))
      .toBe('param');
    expect(suggestionKind({ name: 'height', initializer: '30' }, false)).toBe('variable');
    expect(suggestionKind({ name: 'offset', initializer: '-2.5' }, false)).toBe('variable');
    expect(suggestionKind({ name: 'scale', initializer: '1e3' }, false)).toBe('variable');
    expect(suggestionKind({ name: 'half', initializer: 'w / 2' }, false)).toBe('expression');
    expect(suggestionKind({ name: 'alias', initializer: 'w' }, false)).toBe('expression');
    expect(suggestionKind({ name: 'angle', initializer: 'Math.PI / 4' }, false)).toBe('expression');
  });

  it('treats an import, whose value the file does not show, as a variable', () => {
    expect(suggestionKind({ name: 'thickness' }, false)).toBe('variable');
  });

  it('reads a property() off the initializer, bound or not', () => {
    const call = "property('Pocket diameter', 'pocketDiameter', w - 2 * wall)";
    expect(suggestionKind({ name: 'pocketDiameter', initializer: call, unbound: true }, false)).toBe('property');
    expect(suggestionKind({ name: 'pocketDiameter', initializer: call }, false)).toBe('property');
    expect(suggestionKind({ name: 'count', initializer: 'property("Bolt count", "count", 4)' }, false))
      .toBe('property');
  });

  it('chips the new-variable offer as what its commit would declare', () => {
    const [offer] = filterSuggestions('depth', VARS, 'depth', '25');
    expect(offer).toMatchObject({ isNew: true });
    expect(suggestionKind(offer, true)).toBe('param');
    expect(suggestionKind(offer, false)).toBe('variable');
  });
});

describe('suggestionItemHtml', () => {
  it('leads with the kind chip and shows no initializer preview', () => {
    const html = suggestionItemHtml({ name: 'half', initializer: 'w / 2' }, 0, false, false);
    expect(html.indexOf('>E</span>')).toBeGreaterThan(-1);
    expect(html.indexOf('>E</span>')).toBeLessThan(html.indexOf('>half</span>'));
    expect(html).not.toContain('w / 2');
    expect(html).not.toContain('= ');
  });

  it('wears the P toggle blue for params and the variable pink for plain values', () => {
    expect(suggestionItemHtml({ name: 'w', initializer: "param('w', 40)" }, 0, false, false))
      .toContain('bg-primary/20 text-primary border-primary/40');
    expect(suggestionItemHtml({ name: 'height', initializer: '30' }, 0, false, false))
      .toContain('bg-variable/20 text-variable border-variable/40');
  });

  it('chips a property Pr in its own teal, with no value hint', () => {
    const html = suggestionItemHtml(
      { name: 'lip', initializer: "property('Lip', 'lip', wall / 2)", unbound: true }, 0, false, false,
    );
    expect(html).toContain('>Pr</span>');
    expect(html).toContain('bg-property/20 text-property border-property/40');
    expect(html).not.toContain('wall / 2');
  });
});

describe('trailing identifier helpers', () => {
  it('finds the identifier being typed and replaces it on fill', () => {
    expect(trailingIdentifier('2 * hei')).toBe('hei');
    expect(trailingIdentifier('25')).toBeNull();
    expect(applyVariableName('2 * hei', 'height')).toBe('2 * height');
    expect(applyVariableName('2 * ', 'height')).toBe('2 * height');
  });

  // An inserted instance's property is spelled `drawer.properties.width`:
  // the token being typed keeps its dots, so the dropdown matches the whole
  // spelling and a fill replaces all of it.
  it('reads a dotted name as one token', () => {
    expect(trailingIdentifier('2 * drawer.prop')).toBe('drawer.prop');
    expect(trailingIdentifier('drawer.')).toBe('drawer.');
    expect(trailingIdentifier('2.5')).toBeNull();
    expect(applyVariableName('2 * drawer.prop', 'drawer.properties.width')).toBe('2 * drawer.properties.width');
    expect(applyVariableName('drawer.', 'drawer.properties.width')).toBe('drawer.properties.width');
  });

  it('offers an instance property while its binding stays hidden', () => {
    const vars = [
      ...VARS,
      { name: 'drawer', initializer: 'insert(Drawer, { Width: 400 })', numeric: false },
      { name: 'drawer.properties.frontWidth', initializer: '480', numeric: true },
      { name: 'drawer.properties.finish', initializer: '"oak"', numeric: false },
    ];
    expect(filterSuggestions('drawer', vars, 'drawer', '25').map(s => s.name)).toEqual(['drawer.properties.frontWidth']);
    expect(filterSuggestions('drawer.', vars, '2 * drawer.', '25').map(s => s.name)).toEqual(['drawer.properties.frontWidth']);
    expect(filterSuggestions('drawer.properties.frontWidth', vars, 'drawer.properties.frontWidth', '25').some(s => s.isNew)).toBe(false);
    expect(classifyCommit('drawer.properties.frontWidth - 36', vars, '25'))
      .toEqual({ kind: 'expression', expression: 'drawer.properties.frontWidth - 36' });
  });

  it("shows an instance property's rendered value beside its name, and nothing for other rows", () => {
    const property = { name: 'drawer.properties.frontWidth', initializer: '480', numeric: true };
    expect(suggestionValueHint(property)).toBe('480');
    expect(suggestionItemHtml(property, 0, false, false)).toContain('>480</span>');
    expect(suggestionValueHint({ name: 'drawer.properties.finish', initializer: '"oak"' })).toBeNull();
    expect(suggestionValueHint(VARS[0])).toBeNull();
    expect(suggestionItemHtml(VARS[0], 0, false, false)).not.toContain('>30</span>');
    expect(suggestionValueHint({ name: 'x.properties.y', initializer: '12', isNew: true })).toBeNull();
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
      { name: 'w', initializer: "param('w', 40)" },
      { name: 'half', initializer: 'w / 2' },
    ];
    expect(resolveExpressionValue('w', vars)).toBe(40);
    expect(resolveExpressionValue('half + 1', vars)).toBe(21);
  });

  it('uses the pending declaration for its own name', () => {
    expect(resolveExpressionValue('cx', VARS, { name: 'cx', initializer: '25' })).toBe(25);
    expect(resolveExpressionValue('cx', VARS, { name: 'cx', initializer: "param('cx', 7)" })).toBe(7);
  });

  it('unwraps a property() to the value it publishes, listed or pending as a bind', () => {
    const call = "property('Pocket diameter', 'pocketDiameter', width - 2 * wall)";
    const vars = [...VARS, { name: 'wall', initializer: '4' }];
    expect(resolveExpressionValue('pocketDiameter', [...vars, { name: 'pocketDiameter', initializer: call, unbound: true }]))
      .toBe(92);
    expect(resolveExpressionValue('pocketDiameter / 2', vars, { name: 'pocketDiameter', initializer: call })).toBe(46);
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
