import { describe, expect, it } from 'vitest';
import type { VariableInfo } from '../src/ui/expression-core';
import { LiteralExpressions } from '../src/ui/literal-expressions';

// The value a row shows beside its expression: the dialog-side twin of the
// server's preview evaluator, over the variables the scope lists — the same
// whitelist, JavaScript's semantics on scalars, and nothing where the
// dialog cannot vouch for a value.

const VARIABLES: VariableInfo[] = [
  { name: 'left', initializer: "param('Left panel', false, 'checkbox')", numeric: true, value: false },
  { name: 'span', initializer: "param('Panel span', 600)", numeric: true, value: 600 },
  { name: 'ribs', initializer: '7', numeric: true, value: 7 },
  { name: 'kind', initializer: "'naca'", numeric: false, value: 'naca' },
  { name: 'coats', initializer: "['prime', 2]", numeric: false, value: ['prime', 2] },
  { name: 'side', initializer: 'left ? -1 : 1', numeric: true },
  { name: 'panel', initializer: "left ? 'left' : 'right'", numeric: false },
  { name: 'big', initializer: 'span > 500 && !left', numeric: false },
  { name: 'half', initializer: 'property("Half", "half", span / 2)', numeric: true },
  { name: 'loop', initializer: 'loop + 1', numeric: true },
  { name: 'body', initializer: 'extrude(profile, 10)', numeric: false },
  { name: 'inst.properties.kind', initializer: '"m4"', numeric: false, value: 'm4' },
  { name: 'stock', initializer: "'m4'", numeric: false, value: 'm4', global: { file: 'shop.params.js', label: 'Stock size', imported: true } },
];

const value = (text: string) => LiteralExpressions.evaluate(text, VARIABLES);

describe('LiteralExpressions', () => {
  it('reads the literals, the names, and a conditional over a checkbox parameter', () => {
    expect(value("left ? 'left' : 'right'")).toBe('right');
    expect(value('panel')).toBe('right');
    expect(value('side')).toBe(1);
    expect(value('side * span')).toBe(600);
    expect(value('half')).toBe(300);
    expect(value('big')).toBe(true);
    expect(value('stock')).toBe('m4');
    expect(value("inst.properties.kind === 'm4' ? 'yes' : 'no'")).toBe('yes');
    expect(value('1_000 + .5')).toBe(1000.5);
    expect(value('true')).toBe(true);
    expect(value("'a\\nb'")).toBe('a\nb');
    expect(value('"it\'s"')).toBe("it's");
    expect(value('[kind, ribs, -1]')).toEqual(['naca', 7, -1]);
    expect(value('coats')).toEqual(['prime', 2]);
    expect(LiteralExpressions.evaluate("left ? 'left' : 'right'", [{ ...VARIABLES[0], value: true }])).toBe('left');
  });

  it('applies the comparison, equality and logical operators as JavaScript does on scalars', () => {
    const cases: [string, unknown][] = [
      ['span > 500', true], ['span >= 600', true], ['span < 600', false], ['span <= 599', false],
      ['ribs === 7', true], ['ribs !== 7', false], ["ribs == '7'", true], ["ribs === '7'", false], ["ribs != '7'", false],
      ["kind === 'naca'", true], ["'a' < 'b'", true],
      ['!left', true], ['!!left', false], ['!ribs', false], ['-ribs', -7], ['+kind', undefined],
      ['left && ribs', false], ['big && ribs', 7], ['left || ribs', 7], ['0 || kind', 'naca'], ['ribs || 0', 7],
      ['left ?? ribs', false], ['ribs ?? 0', 7],
      ["'m' + ribs", 'm7'], ["kind + ''", 'naca'], ["'3' * 2", 6], ['2 ** 3 ** 2', 512], ['7 % 3', 1],
    ];
    for (const [text, expected] of cases) {
      expect(value(text), text).toBe(expected);
    }
  });

  it("keeps JavaScript's precedence and short-circuits", () => {
    expect(value('1 + 2 * 3')).toBe(7);
    expect(value('(1 + 2) * 3')).toBe(9);
    expect(value('ribs > 5 && span > 500 || left')).toBe(true);
    expect(value("left || ribs > 5 ? 'a' : 'b'")).toBe('a');
    expect(value("ribs > 5 ? span > 500 ? 'a' : 'b' : 'c'")).toBe('a');
    expect(value('1 < 2 === true')).toBe(true);
    expect(value("ribs ? 'seven' : nowhere")).toBe('seven');
    expect(value("left ? nowhere : 'right'")).toBe('right');
    expect(value('ribs || nowhere')).toBe(7);
    expect(value('left && nowhere')).toBe(false);
    expect(value('ribs ?? nowhere')).toBe(7);
    expect(value("nowhere || 'x'")).toBeUndefined();
    expect(value("nowhere ? 'a' : 'b'")).toBeUndefined();
    expect(value('ribs ?? 1 || 2')).toBeUndefined();
    expect(value('(ribs ?? 1) || 2')).toBe(7);
    expect(value('-2 ** 2')).toBeUndefined();
  });

  it('reads template strings, with their substitutions evaluated', () => {
    expect(value('`${kind}-${ribs}`')).toBe('naca-7');
    expect(value('`rib ${ribs > 5 ? "many" : "few"}\\t!`')).toBe('rib many\t!');
    expect(value('`${`${ribs}`}x`')).toBe('7x');
    expect(value('`${coats}`')).toBeUndefined();
    expect(value('`${nowhere}`')).toBeUndefined();
    expect(value('`open')).toBeUndefined();
  });

  it('works Math out, and nothing else that is called or reached into', () => {
    expect(value('Math.max(ribs, 10) > 9')).toBe(true);
    expect(value('Math.PI > 3')).toBe(true);
    expect(value('Math.hypot(3, 4)')).toBe(5);
    for (const text of ['Math.constructor', 'Math.toString()', 'Math.random.call()', 'kind.length', 'kind.toUpperCase()', 'body', 'extrude(1)', 'Math.max(kind)']) {
      expect(value(text), text).toBeUndefined();
    }
  });

  it('says nothing for what the whitelist leaves out, a cycle, or no finite number', () => {
    for (const text of [
      'ribs / 0', 'span = 1', 'ribs++', 'ribs; span', '{ a: 1 }', '() => 1', 'new Date()', 'typeof ribs', 'undefined', 'null', 'this',
      'loop', 'coats + 1', '[coats]', '[left]', 'coats === coats', '', '  ', 'a b', '(ribs', 'ribs +', "'open", 'ribs ? 1', '[1,, 2]', 'x'.repeat(2001),
    ]) {
      expect(value(text), text).toBeUndefined();
    }
    expect(value("coats ? 'a' : 'b'")).toBe('a');
  });
});
