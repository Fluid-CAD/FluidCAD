import { describe, it, expect } from 'vitest';
import { getJavaScriptParser, LexicalBindings, walkTree, type TSNode, type ValueKind } from '../src/code-editor/index.ts';

/**
 * The static kind of argument `index` of the `occurrence`-th call to
 * `callee` in `code` — the node a feature parse classifies.
 */
async function argKind(code: string, callee: string, index = 0, occurrence = 0): Promise<ValueKind> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const calls = [...walkTree(tree.rootNode)].filter((node: TSNode) => node.type === 'call_expression'
    && node.childForFieldName('function')?.text === callee);
  const call = calls[occurrence];
  if (!call) {
    throw new Error(`no call #${occurrence} to ${callee}()`);
  }
  const arg = call.childForFieldName('arguments')!.namedChildren[index];
  return new LexicalBindings(tree).kindOf(arg);
}

const CORE = `import { part, param, sketch, select, extrude } from 'fluidcad/core'`;

describe('LexicalBindings scope resolution', () => {
  it('reads a param() declared in the enclosing part body as a number', async () => {
    const code = [
      CORE,
      `export const drawer = part('Drawer', () => {`,
      `  const depth = param("depth", 50)`,
      `  const s = sketch('xz', () => {})`,
      `  extrude(depth, s)`,
      `})`,
    ].join('\n');
    expect(await argKind(code, 'extrude', 0)).toBe('number');
    expect(await argKind(code, 'extrude', 1)).toBe('other');
  });

  it('lets the innermost declaration shadow an outer one', async () => {
    const code = [
      CORE,
      `const depth = 30`,
      `export const box = part('Box', () => {`,
      `  const depth = select(face())`,
      `  extrude(depth)`,
      `})`,
      `extrude(depth)`,
    ].join('\n');
    expect(await argKind(code, 'extrude', 0, 0)).toBe('other');
    expect(await argKind(code, 'extrude', 0, 1)).toBe('number');
  });

  it("never sees another part's or a finished sketch's declarations", async () => {
    const code = [
      CORE,
      `export const a = part('A', () => {`,
      `  const depth = param('Depth', 10)`,
      `})`,
      `export const b = part('B', () => {`,
      `  sketch('xy', () => { const width = 5 })`,
      `  extrude(depth)`,
      `  extrude(width)`,
      `})`,
    ].join('\n');
    expect(await argKind(code, 'extrude', 0, 0)).toBe('unknown');
    expect(await argKind(code, 'extrude', 0, 1)).toBe('unknown');
  });

  it('follows chains of declarations and arithmetic', async () => {
    const code = [
      CORE,
      `part('P', () => {`,
      `  const height = param('Height', 250)`,
      `  const half = height / 2`,
      `  const total = half + 10`,
      `  extrude(total)`,
      `})`,
    ].join('\n');
    expect(await argKind(code, 'extrude')).toBe('number');
  });

  it('hoists a var out of its block to the function body', async () => {
    const code = [
      CORE,
      `part('P', () => {`,
      `  if (true) { var d = 12 }`,
      `  extrude(d)`,
      `})`,
    ].join('\n');
    expect(await argKind(code, 'extrude')).toBe('number');
  });

  it('reads function parameters by their default, and plain ones as unknown', async () => {
    const code = [
      CORE,
      `function boss(h, w = 10, { r } = {}) { extrude(h); extrude(w); extrude(r) }`,
    ].join('\n');
    expect(await argKind(code, 'extrude', 0, 0)).toBe('unknown');
    expect(await argKind(code, 'extrude', 0, 1)).toBe('number');
    expect(await argKind(code, 'extrude', 0, 2)).toBe('unknown');
  });

  it('reads a for-loop counter as a number', async () => {
    const code = `${CORE}\nfor (let i = 0; i < 3; i++) { extrude(i) }`;
    expect(await argKind(code, 'extrude')).toBe('number');
  });

  it('reads imports from other modules as unknown', async () => {
    const code = `import { DEPTH } from './dims.js'\n${CORE}\nextrude(DEPTH)`;
    expect(await argKind(code, 'extrude')).toBe('unknown');
  });
});

describe('LexicalBindings reassignment', () => {
  it('keeps a let that is only ever assigned numbers a number', async () => {
    const code = `${CORE}\nlet d = 5\nd += 2\nd++\nd = d * 2\nextrude(d)`;
    expect(await argKind(code, 'extrude')).toBe('number');
  });

  it('reads a let reassigned to a different kind as unknown', async () => {
    const code = `${CORE}\nlet d = 5\nd = select(face())\nextrude(d)`;
    expect(await argKind(code, 'extrude')).toBe('unknown');
  });

  it('ignores assignments to a shadowing binding of the same name', async () => {
    const code = [
      CORE,
      `let d = 5`,
      `function f() { let d = 'x'; d = select(face()) }`,
      `extrude(d)`,
    ].join('\n');
    expect(await argKind(code, 'extrude')).toBe('number');
  });

  it('sees a write through a shorthand destructuring pattern', async () => {
    const code = `${CORE};\nlet d = 5;\n({ d } = { d: select(face()) });\nextrude(d);`;
    expect(await argKind(code, 'extrude')).toBe('unknown');
  });

  it('reads a self-referencing declaration without looping', async () => {
    const code = `${CORE}\nlet a = b\nlet b = a\nextrude(a)`;
    expect(await argKind(code, 'extrude')).toBe('unknown');
  });
});

describe('LexicalBindings value kinds', () => {
  it("reads param() by its default's kind", async () => {
    const code = [
      CORE,
      `part('P', () => {`,
      `  const width = param('Width', 400, 'number', { min: 1 })`,
      `  const finish = param('Finish', '#e6e8eb', 'color')`,
      `  const rounded = param('Rounded', true, 'checkbox')`,
      `  const offset = param('Offset', -4)`,
      `  extrude(width); extrude(finish); extrude(rounded); extrude(offset)`,
      `})`,
    ].join('\n');
    expect(await argKind(code, 'extrude', 0, 0)).toBe('number');
    expect(await argKind(code, 'extrude', 0, 1)).toBe('other');
    expect(await argKind(code, 'extrude', 0, 2)).toBe('other');
    expect(await argKind(code, 'extrude', 0, 3)).toBe('number');
  });

  it('recognises param() through an alias and a namespace import', async () => {
    const aliased = [
      `import { part, param as p, extrude } from 'fluidcad/core'`,
      `part('P', () => { const w = p('W', 3); extrude(w) })`,
    ].join('\n');
    expect(await argKind(aliased, 'extrude')).toBe('number');
    const namespaced = [
      `import * as fc from 'fluidcad/core'`,
      `import { extrude } from 'fluidcad/core'`,
      `const w = fc.param('W', 3)`,
      `extrude(w)`,
    ].join('\n');
    expect(await argKind(namespaced, 'extrude')).toBe('number');
  });

  it('does not treat a local function named param as the API call', async () => {
    const code = `${CORE.replace('param, ', '')}\nfunction param(x) { return x }\nconst w = param('W', 3)\nextrude(w)`;
    expect(await argKind(code, 'extrude')).toBe('unknown');
  });

  it('reads the unit helpers as lengths only when imported from fluidcad/units', async () => {
    const imported = `import { inch } from 'fluidcad/units'\n${CORE}\nextrude(inch(1))`;
    expect(await argKind(imported, 'extrude')).toBe('number');
    const local = `${CORE}\nconst inch = (v) => v\nextrude(inch(1))`;
    expect(await argKind(local, 'extrude')).toBe('unknown');
  });

  it('reads FluidCAD API calls as non-numbers', async () => {
    const code = `${CORE}\nconst e = extrude(10)\nextrude(select(face()))\nextrude(e)`;
    expect(await argKind(code, 'extrude', 0, 1)).toBe('other');
    expect(await argKind(code, 'extrude', 0, 2)).toBe('other');
  });

  it('reads Math calls and constants as numbers, but not a bare Math method', async () => {
    const code = `${CORE}\nextrude(Math.max(1, 2))\nextrude(Math.PI)\nextrude(Math.max)`;
    expect(await argKind(code, 'extrude', 0, 0)).toBe('number');
    expect(await argKind(code, 'extrude', 0, 1)).toBe('number');
    expect(await argKind(code, 'extrude', 0, 2)).toBe('unknown');
  });

  it('reads operators by their result kind', async () => {
    const code = [
      `import { a, b } from './dims.js'`,
      CORE,
      `extrude(a + b)`,
      `extrude('w' + a)`,
      `extrude(a > b)`,
      `extrude(a ?? 20)`,
      `extrude(a ? 'x' : 'y')`,
      `extrude(-a)`,
      `extrude(!a)`,
    ].join('\n');
    expect(await argKind(code, 'extrude', 0, 0)).toBe('number');
    expect(await argKind(code, 'extrude', 0, 1)).toBe('other');
    expect(await argKind(code, 'extrude', 0, 2)).toBe('other');
    expect(await argKind(code, 'extrude', 0, 3)).toBe('number');
    expect(await argKind(code, 'extrude', 0, 4)).toBe('other');
    expect(await argKind(code, 'extrude', 0, 5)).toBe('number');
    expect(await argKind(code, 'extrude', 0, 6)).toBe('other');
  });
});

/**
 * The bindings of `code`, and every call whose callee text is `callee`, in
 * source order.
 */
async function callsTo(code: string, callee: string): Promise<{ bindings: LexicalBindings; calls: TSNode[] }> {
  const parser = await getJavaScriptParser();
  const tree = parser.parse(code);
  const calls = [...walkTree(tree.rootNode)].filter((node: TSNode) => node.type === 'call_expression'
    && node.childForFieldName('function')?.text === callee);
  return { bindings: new LexicalBindings(tree), calls };
}

/** Whether `name`, as the `occurrence`-th call to `callee` sees it, is ever reassigned. */
async function reassignedAt(code: string, name: string, callee: string, occurrence = 0): Promise<boolean> {
  const { bindings, calls } = await callsTo(code, callee);
  const call = calls[occurrence];
  if (!call) {
    throw new Error(`no call #${occurrence} to ${callee}()`);
  }
  const binding = bindings.resolve(name, call);
  if (!binding) {
    throw new Error(`${name} is not declared where ${callee}() #${occurrence} sits`);
  }
  return bindings.isReassigned(binding);
}

describe('LexicalBindings.isReassigned', () => {
  it('never reads a const or an import as reassigned', async () => {
    const code = [
      `import { DEPTH } from './dims.js'`,
      CORE,
      `const d = 5`,
      `extrude(d, DEPTH)`,
    ].join('\n');
    expect(await reassignedAt(code, 'd', 'extrude')).toBe(false);
    expect(await reassignedAt(code, 'DEPTH', 'extrude')).toBe(false);
  });

  it('reads a let or var nothing writes as holding its initializer', async () => {
    const code = `${CORE}\nlet d = 5\nvar e = 6\nextrude(d + e)`;
    expect(await reassignedAt(code, 'd', 'extrude')).toBe(false);
    expect(await reassignedAt(code, 'e', 'extrude')).toBe(false);
  });

  it('catches every form of write', async () => {
    const writes = ['d = 7', 'd += 1', 'd++', '--d', '[d] = [1]', '({ d } = { d: 1 })', 'for (d of [1, 2]) {}'];
    for (const write of writes) {
      // Semicolons: a line opening with `[` or `(` would otherwise continue
      // the declaration above it.
      const code = `${CORE};\nlet d = 5;\n${write};\nextrude(d);`;
      expect(await reassignedAt(code, 'd', 'extrude'), write).toBe(true);
    }
  });

  it('counts a write from a nested function, but not one to a shadowing binding', async () => {
    const nested = `${CORE}\nlet d = 5\nfunction grow() { d = d * 2 }\nextrude(d)`;
    expect(await reassignedAt(nested, 'd', 'extrude')).toBe(true);
    const shadowed = `${CORE}\nlet d = 5\nfunction f() { let d = 1; d = 2 }\nextrude(d)`;
    expect(await reassignedAt(shadowed, 'd', 'extrude')).toBe(false);
  });
});

describe('LexicalBindings.fluidCadCallee', () => {
  async function calleeOf(code: string, callee: string): Promise<{ source: string; name: string } | null> {
    const { bindings, calls } = await callsTo(code, callee);
    return bindings.fluidCadCallee(calls[0]);
  }

  it('names the API a named, aliased or namespace import calls', async () => {
    expect(await calleeOf(`${CORE}\nparam('W', 1)`, 'param')).toEqual({ source: 'fluidcad/core', name: 'param' });
    expect(await calleeOf(`import { param as p } from 'fluidcad/core'\np('W', 1)`, 'p'))
      .toEqual({ source: 'fluidcad/core', name: 'param' });
    expect(await calleeOf(`import * as fc from 'fluidcad'\nfc.param('W', 1)`, 'fc.param'))
      .toEqual({ source: 'fluidcad', name: 'param' });
    expect(await calleeOf(`import { inch } from 'fluidcad/units'\ninch(1)`, 'inch'))
      .toEqual({ source: 'fluidcad/units', name: 'inch' });
  });

  it('reads a bare, unbound param() as the API', async () => {
    expect(await calleeOf(`part('P', () => { param('W', 1) })`, 'param'))
      .toEqual({ source: 'fluidcad/core', name: 'param' });
  });

  it('names nothing for a local function, another module, or a global', async () => {
    expect(await calleeOf(`function param(x) { return x }\nparam('W', 1)`, 'param')).toBeNull();
    expect(await calleeOf(`import { param } from './mine.js'\nparam('W', 1)`, 'param')).toBeNull();
    expect(await calleeOf(`Math.max(1, 2)`, 'Math.max')).toBeNull();
  });
});
