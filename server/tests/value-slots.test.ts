import { describe, it, expect, beforeAll } from 'vitest';
import { getJavaScriptParser, type TSNode } from '../src/code-editor/index.ts';
import { ValueSlots } from '../src/apply-feature-edit/index.ts';
import { GhostSlots } from '../src/routes/feature-ghost/slots.ts';
import { ValueScope } from '../src/routes/feature-ghost/value-scope.ts';

// The one reader and writer of a dialog's typed-in slots, which the built-in
// parsers and a custom feature's kinds share: a boolean, a text, a choice
// or a number argument reads as its literal, a choice's reference, or the
// expression as written; a dialog's value for it is checked for writing —
// the statement's own expression passes whatever its text, typed text is
// held to a number row's rules — and rendered bare or quoted; and the ghost
// resolves a slot to the literal the kernel takes, or says why it can't.

let parser: Awaited<ReturnType<typeof getJavaScriptParser>>;

beforeAll(async () => {
  parser = await getJavaScriptParser();
});

/** The argument nodes of `f(<args>)`. */
function args(text: string): TSNode[] {
  const root = parser.parse(`f(${text})`).rootNode;
  const call = root.namedChildren[0].namedChildren[0];
  return call.childForFieldName('arguments')!.namedChildren.filter(node => node.type !== 'comment');
}

function arg(text: string): TSNode {
  return args(text)[0];
}

describe('ValueSlots — reading', () => {
  it('reads a boolean argument as the flag, or as its expression', () => {
    expect(ValueSlots.boolean(arg('true'))).toBe(true);
    expect(ValueSlots.boolean(arg('false'))).toBe(false);
    expect(ValueSlots.boolean(arg('flag'))).toEqual({ expr: 'flag' });
    expect(ValueSlots.boolean(arg('count > 4 && !left'))).toEqual({ expr: 'count > 4 && !left' });
    expect(ValueSlots.boolean(arg("'yes'"))).toEqual({ expr: "'yes'" });
    expect(ValueSlots.boolean(arg('...flags'))).toBeNull();
  });

  it('reads a text argument as the string it denotes, or as its expression — a template string included', () => {
    expect(ValueSlots.text(arg("'rib'"))).toBe('rib');
    expect(ValueSlots.text(arg('"it\\u0027s"'))).toBe("it's");
    expect(ValueSlots.text(arg('`rib-${n}`'))).toEqual({ expr: '`rib-${n}`' });
    expect(ValueSlots.text(arg('label'))).toEqual({ expr: 'label' });
    expect(ValueSlots.text(arg("left ? 'l' : 'r'"))).toEqual({ expr: "left ? 'l' : 'r'" });
    expect(ValueSlots.text(arg('...parts'))).toBeNull();
  });

  it('reads a choice argument as the option, a reference, or an expression — a literal that is no option is nothing', () => {
    const KEEPS = ['both', 'front', 'back'] as const;
    expect(ValueSlots.choice(arg("'front'"), KEEPS)).toBe('front');
    expect(ValueSlots.choice(arg("'sideways'"), KEEPS)).toBeNull();
    expect(ValueSlots.choice(arg('700'), [400, 700])).toBe(700);
    expect(ValueSlots.choice(arg('750'), [400, 700])).toBeNull();
    expect(ValueSlots.choice(arg('side'), KEEPS)).toEqual({ ref: 'side' });
    expect(ValueSlots.choice(arg('inst.properties.side'), KEEPS)).toEqual({ ref: 'inst.properties.side' });
    expect(ValueSlots.choice(arg("flag ? 'front' : 'back'"), KEEPS)).toEqual({ expr: "flag ? 'front' : 'back'" });
    expect(ValueSlots.choice(arg('sides[0]'), KEEPS)).toEqual({ expr: 'sides[0]' });
    expect(ValueSlots.choice(arg('pick()'), KEEPS)).toEqual({ expr: 'pick()' });
    // Without options, any string or number literal is the choice — a custom feature's kinds read this way.
    expect(ValueSlots.choice(arg("'m9'"))).toBe('m9');
    expect(ValueSlots.choice(arg('-2'))).toBe(-2);
  });

  it('reads a number argument as a literal or as bare expression text', () => {
    expect(ValueSlots.number(arg('12.5'))).toBe(12.5);
    expect(ValueSlots.number(arg('-3'))).toBe(-3);
    expect(ValueSlots.number(arg('h * 2'))).toBe('h * 2');
    // Text a statement can't carry as one argument on one line is no number slot.
    expect(ValueSlots.number(arg('a\n  + b'))).toBeNull();
  });
});

describe('ValueSlots — the expressions a statement already holds', () => {
  it('collects every { expr } of a parsed statement, wherever it sits', () => {
    const kept = ValueSlots.kept({
      feature: 'text', text: { expr: '`a-${n}`' }, size: 'h * 2', italic: { expr: 'flag\n  && bold' },
      conditions: [{ type: { expr: 'kind' }, magnitude: 1 }, null], nested: { deep: { expr: 'x' } },
    });
    expect([...kept].sort()).toEqual(['`a-${n}`', 'flag\n  && bold', 'kind', 'x']);
  });

  it('lets a kept expression through whatever its text, and holds a typed one to a number row\'s rules', () => {
    const kept = new Set(['`a-${n}`', 'flag\n  && bold']);
    expect(ValueSlots.validExpr({ expr: '`a-${n}`' }, kept)).toBe(true);
    expect(ValueSlots.validExpr({ expr: 'flag\n  && bold' }, kept)).toBe(true);
    expect(ValueSlots.validExpr({ expr: '`a-${n}`' })).toBe(false);
    expect(ValueSlots.validExpr({ expr: 'flag\n  && bold' })).toBe(false);
    expect(ValueSlots.validExpr({ expr: 'count > 4' })).toBe(true);
    expect(ValueSlots.validExpr({ expr: 'a, b' }, kept)).toBe(false);
    expect(ValueSlots.validExpr({ expr: ' ' }, kept)).toBe(false);
    expect(ValueSlots.validExpr('count > 4')).toBe(false);
  });
});

describe('ValueSlots — checking and writing', () => {
  it('checks each kind: its literal, a well-formed reference where a choice takes one, an expression', () => {
    expect(ValueSlots.validBoolean(true)).toBe(true);
    expect(ValueSlots.validBoolean({ expr: '!left' })).toBe(true);
    expect(ValueSlots.validBoolean('true')).toBe(false);
    expect(ValueSlots.validBoolean({ ref: 'left' })).toBe(false);
    expect(ValueSlots.validText('rib')).toBe(true);
    expect(ValueSlots.validText('x'.repeat(ValueSlots.TEXT_LIMIT + 1))).toBe(false);
    expect(ValueSlots.validText('xyz', undefined, 2)).toBe(false);
    expect(ValueSlots.validText({ expr: 'label + 1' })).toBe(true);
    expect(ValueSlots.validText({ ref: 'label' })).toBe(false);
    const KEEPS = ['both', 'front', 'back'] as const;
    expect(ValueSlots.validChoice('front', KEEPS)).toBe(true);
    expect(ValueSlots.validChoice('sideways', KEEPS)).toBe(false);
    expect(ValueSlots.validChoice({ ref: 'side' }, KEEPS)).toBe(true);
    expect(ValueSlots.validChoice({ ref: 'side()' }, KEEPS)).toBe(false);
    expect(ValueSlots.validChoice({ expr: "flag ? 'front' : 'back'" }, KEEPS)).toBe(true);
    expect(ValueSlots.validChoice(700, [400, 700])).toBe(true);
    expect(ValueSlots.validChoice(750, [400, 700])).toBe(false);
  });

  it('tells a slot\'s shape before the statement is known: a literal the kind takes, a reference, non-blank expression text', () => {
    const boolean = (literal: unknown) => typeof literal === 'boolean';
    expect(ValueSlots.shaped(true, boolean)).toBe(true);
    expect(ValueSlots.shaped('true', boolean)).toBe(false);
    expect(ValueSlots.shaped({ expr: '`a-${n}`' }, boolean)).toBe(true);
    expect(ValueSlots.shaped({ expr: '  ' }, boolean)).toBe(false);
    expect(ValueSlots.shaped({ ref: 'a.b' }, boolean)).toBe(true);
    expect(ValueSlots.shaped({ ref: 'a b' }, boolean)).toBe(false);
  });

  it('writes an expression and a reference bare, a literal through the feature\'s own quoting', () => {
    expect(ValueSlots.source(false, String)).toBe('false');
    expect(ValueSlots.source({ expr: ' !left ' }, String)).toBe('!left');
    expect(ValueSlots.source<string>('front', value => `'${value}'`)).toBe("'front'");
    expect(ValueSlots.source<string>({ ref: 'side' }, value => `'${value}'`)).toBe('side');
    expect(ValueSlots.source<string>({ expr: "flag ? 'front' : 'back'" }, value => `'${value}'`)).toBe("flag ? 'front' : 'back'");
    expect(ValueSlots.literal('front')).toBe('front');
    expect(ValueSlots.literal({ ref: 'side' })).toBeUndefined();
    expect(ValueSlots.literal({ expr: "'front'" })).toBeUndefined();
  });
});

describe('GhostSlots — resolving a slot for the preview', () => {
  const CODE = [
    `const flag = param('Flag', true, 'checkbox');`,
    `const side = flag ? 'front' : 'back';`,
    `const label = 'rib';`,
    `const n = 3;`,
    `const dims = [1, 2];`,
  ].join('\n');

  async function slots(): Promise<GhostSlots> {
    return new GhostSlots(await ValueScope.open({ code: CODE, filePath: '/ws/m.fluid.js', definitions: [] }, null));
  }

  it('passes a literal of the kind, and refuses one of another', async () => {
    const ghost = await slots();
    expect(ghost.boolean(false, 'Drill')).toEqual({ value: false });
    expect(ghost.boolean('false', 'Drill')).toEqual({ reason: 'Drill must be true or false' });
    expect(ghost.text('rib', 'Text')).toEqual({ value: 'rib' });
    expect(ghost.choice('front', ['both', 'front', 'back'], 'Keep')).toEqual({ value: 'front' });
    expect(ghost.choice('up', ['both', 'front', 'back'], 'Keep')).toEqual({ reason: 'Keep must be one of "both", "front", "back"' });
  });

  it('evaluates a reference or an expression where the statement sits, and checks what comes out by kind', async () => {
    const ghost = await slots();
    expect(ghost.boolean({ expr: 'flag' }, 'Drill')).toEqual({ value: true });
    expect(ghost.boolean({ expr: 'n > 4 || !flag' }, 'Drill')).toEqual({ value: false });
    expect(ghost.choice({ ref: 'side' }, ['both', 'front', 'back'], 'Keep')).toEqual({ value: 'front' });
    expect(ghost.choice({ expr: "flag ? 'back' : 'front'" }, ['both', 'front', 'back'], 'Keep')).toEqual({ value: 'back' });
    expect(ghost.text({ expr: '`${label}-${n}`' }, 'Text')).toEqual({ value: 'rib-3' });
    expect(ghost.boolean({ expr: 'n' }, 'Drill')).toEqual({ reason: 'Drill is n, which comes to 3 — not true or false' });
    expect(ghost.choice({ expr: 'label' }, ['both', 'front', 'back'], 'Keep'))
      .toEqual({ reason: 'Keep is label, which comes to "rib" — not one of "both", "front", "back"' });
    expect(ghost.text({ expr: 'dims' }, 'Text')).toEqual({ reason: 'Text is dims, which comes to [1,2] — not text' });
  });

  it('says when it cannot work a value out: a name with no value here, a call the whitelist refuses', async () => {
    const ghost = await slots();
    expect(ghost.boolean({ expr: 'solid' }, 'Drill')).toEqual({ reason: 'Drill is solid, which the preview cannot work out here' });
    expect(ghost.choice({ ref: 'solid' }, ['front'], 'Keep')).toEqual({ reason: 'Keep names solid, which has no value here' });
    expect(ghost.text({ expr: 'pick()' }, 'Text')).toEqual({ reason: 'Text is pick(), which the preview cannot work out here' });
  });
});
