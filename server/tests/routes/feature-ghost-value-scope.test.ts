import { describe, it, expect } from 'vitest';
import type { ParamSiteDefinition } from '../../src/apply-feature-edit/index.ts';
import { ValueScope, type GhostValueScope } from '../../src/routes/feature-ghost/value-scope.ts';

// The numbers a ghost's dialog values stand for, read where the dialog's
// statement sits. Since `param()` became part-only, a model's dimensions
// live in part bodies — a scope that only read the file's top level left
// every dialog naming one without a ghost.

const FILE = '/ws/cabinet.part.js';

/**
 * Two parts sharing the `'Width'` label, a top-level `width` both shadow, a
 * sketch that shadows `depth`, and a default written as an expression.
 */
const CABINET = [
  `import { part, param, sketch, extrude, line } from 'fluidcad/core';`,
  `const width = 999;`,
  `export const drawer = part('Drawer', () => {`,
  `  const width = param('Width', 400);`,
  `  const depth = param('depth', 500);`,
  `  const thickness = param('Thickness', 18);`,
  `  const frontWidth = param('frontWidth', width + 100);`,
  `  const half = depth / 2;`,
  `  const s = sketch('xz', () => {`,
  `    const depth = 7;`,
  `    line([0, 0], [half, 0]);`,
  `  });`,
  `  extrude(-depth + thickness, s);`,
  `});`,
  `export const box = part('Box', () => {`,
  `  const width = param('Width', 500);`,
  `  extrude(width);`,
  `});`,
].join('\n');

/** The Drawer's extrude — an edited statement. */
const DRAWER_EXTRUDE = 13;
/** The Box's extrude. */
const BOX_EXTRUDE = 17;
/** The `line()` inside the Drawer's sketch. */
const SKETCH_LINE = 11;

function statement(line: number, column = 3, filePath = FILE): GhostValueScope {
  return { kind: 'statement', filePath, line, column };
}

function append(line: number, column = 1): GhostValueScope {
  return { kind: 'append', filePath: FILE, line, column };
}

/** A definition the render captured for the `param()` call on `line`. */
function definedAt(label: string, currentValue: unknown, line: number): ParamSiteDefinition {
  return { label, currentValue, sourceLocation: { filePath: FILE, line } };
}

async function scopeAt(
  at: GhostValueScope | null,
  definitions: ParamSiteDefinition[] = [],
  code: string | null = CABINET,
): Promise<ValueScope> {
  return ValueScope.open({ code, filePath: FILE, definitions }, at);
}

describe('ValueScope — where names resolve', () => {
  it("reads a part body's params at an edited statement", async () => {
    const scope = await scopeAt(statement(DRAWER_EXTRUDE));
    expect(scope.resolve('depth')).toBe(500);
    expect(scope.resolve('-depth + thickness')).toBe(-482);
  });

  it('reads the names a created statement sees at the end of the active part', async () => {
    const scope = await scopeAt(append(3));
    expect(scope.resolve('depth')).toBe(500);
    expect(scope.resolve('half')).toBe(250);
    // A default written as an expression over the part's own params.
    expect(scope.resolve('frontWidth')).toBe(500);
  });

  it('lets the innermost declaration win', async () => {
    const inSketch = await scopeAt(statement(SKETCH_LINE, 5));
    expect(inSketch.resolve('depth')).toBe(7);
    expect(inSketch.resolve('width')).toBe(400);
    const topLevel = await scopeAt(null);
    expect(topLevel.resolve('width')).toBe(999);
  });

  /**
   * `half` is declared in the part body as `depth / 2` — it reads the part's
   * `depth`, whatever a nested block around the statement redeclares.
   */
  it('evaluates an initializer where it is written', async () => {
    const scope = await scopeAt(statement(SKETCH_LINE, 5));
    expect(scope.resolve('half')).toBe(250);
  });

  it("reads a created sketch op's names at the end of the sketch", async () => {
    const scope = await scopeAt(append(9));
    expect(scope.resolve('depth')).toBe(7);
    expect(scope.resolve('half')).toBe(250);
  });

  it("reads a column inside the indentation as the statement's first token", async () => {
    const scope = await scopeAt(statement(SKETCH_LINE, 0));
    expect(scope.resolve('depth')).toBe(7);
  });

  it('tells apart two statements sharing a row by their columns', async () => {
    const row = `part('P', () => { const d = 1; sketch('xy', () => { const d = 2; line([0, 0], [d, 0]) }); extrude(d) })`;
    const code = `import { part, sketch, line, extrude } from 'fluidcad/core';\n${row}`;
    const columnOf = (callee: string) => row.indexOf(callee) + 1;
    expect((await scopeAt(statement(2, columnOf('line(')), [], code)).resolve('d')).toBe(2);
    expect((await scopeAt(statement(2, columnOf('extrude(')), [], code)).resolve('d')).toBe(1);
  });
});

describe('ValueScope — without a site in the rendered file', () => {
  it('reads the top level when the request names no site', async () => {
    const scope = await scopeAt(null);
    expect(scope.resolve('width')).toBe(999);
    expect(scope.resolve('depth')).toBeNull();
  });

  it('reads the top level for a statement in another file', async () => {
    const scope = await scopeAt(statement(DRAWER_EXTRUDE, 3, '/ws/other.part.js'));
    expect(scope.resolve('width')).toBe(999);
    expect(scope.resolve('depth')).toBeNull();
  });

  it('reads the top level when the site no longer holds a body to append to', async () => {
    const scope = await scopeAt(append(5));
    expect(scope.resolve('width')).toBe(999);
    expect(scope.resolve('depth')).toBeNull();
  });

  it('reads the top level for a site past the end of the buffer', async () => {
    const scope = await scopeAt(statement(400));
    expect(scope.resolve('width')).toBe(999);
  });

  it('resolves nothing but numbers without a live buffer', async () => {
    const scope = await scopeAt(statement(DRAWER_EXTRUDE), [], null);
    expect(scope.resolve('depth')).toBeNull();
    expect(scope.resolve(42)).toBe(42);
    expect(scope.resolve('Math.PI * 2')).toBeCloseTo(Math.PI * 2);
  });
});

describe('ValueScope — param values', () => {
  it("reads the registry's value for the call site the name is bound to", async () => {
    const scope = await scopeAt(statement(DRAWER_EXTRUDE), [definedAt('depth', 600, 5)]);
    expect(scope.resolve('depth')).toBe(600);
    // A derived constant follows the value the model was built with.
    expect(scope.resolve('half')).toBe(300);
  });

  it('gives each part its own value of a shared label', async () => {
    // The label-keyed registry kept the Box's definition only.
    const definitions = [definedAt('Width', 520, 16)];
    expect((await scopeAt(statement(DRAWER_EXTRUDE), definitions)).resolve('width')).toBe(400);
    expect((await scopeAt(statement(BOX_EXTRUDE), definitions)).resolve('width')).toBe(520);
  });

  it('reads a default written as an expression through its own scope', async () => {
    const scope = await scopeAt(statement(DRAWER_EXTRUDE), [definedAt('Width', 450, 4)]);
    expect(scope.resolve('frontWidth')).toBe(550);
  });

  it('prefers the registry over a default expression', async () => {
    const scope = await scopeAt(statement(DRAWER_EXTRUDE), [definedAt('frontWidth', 640, 7)]);
    expect(scope.resolve('frontWidth')).toBe(640);
  });

  it('reads a param whose current value is not a number as no length', async () => {
    const scope = await scopeAt(statement(DRAWER_EXTRUDE), [definedAt('frontWidth', 'wide', 7)]);
    expect(scope.resolve('frontWidth')).toBeNull();
  });
});

describe('ValueScope — names with no single value', () => {
  const code = [
    `import { part, param, sketch, extrude } from 'fluidcad/core';`,
    `import { GAP } from './dims.js';`,
    `part('P', (opts) => {`,
    `  let grow = 5;`,
    `  grow = grow * 2;`,
    `  let steady = 5;`,
    `  const { a } = { a: 1 };`,
    `  const s = sketch('xy', () => {});`,
    `  const finish = param('Finish', '#ffffff', 'color');`,
    `  const x = y + 1;`,
    `  const y = x + 1;`,
    `  const big = 1_000;`,
    `  extrude(1, s);`,
    `});`,
  ].join('\n');

  it('refuses what a static read cannot pin down', async () => {
    const scope = await scopeAt(statement(13), [], code);
    for (const name of ['grow', 'a', 'opts', 'GAP', 's', 'finish', 'x', 'y', 'undeclared']) {
      expect(scope.resolve(name), name).toBeNull();
    }
  });

  it('reads a let nothing reassigns, and a separated numeric literal', async () => {
    const scope = await scopeAt(statement(13), [], code);
    expect(scope.resolve('steady')).toBe(5);
    expect(scope.resolve('big')).toBe(1000);
  });
});

describe('ValueScope — dialog text', () => {
  it('works out arithmetic and Math over the scoped names', async () => {
    const scope = await scopeAt(statement(DRAWER_EXTRUDE));
    expect(scope.resolve('(depth - thickness) / 2')).toBe(241);
    expect(scope.resolve('Math.max(depth, 600)')).toBe(600);
    expect(scope.resolve('  depth  ')).toBe(500);
  });

  it('never calls anything the text names', async () => {
    const scope = await scopeAt(statement(DRAWER_EXTRUDE));
    for (const text of ['depth.toFixed(0)', "param('depth', 5)", 'depth = 1', 'depth / 0', 'depth ? 1 : 2']) {
      expect(scope.resolve(text), text).toBeNull();
    }
  });
});

describe('ValueScope.parse', () => {
  it('reads both kinds of site', () => {
    expect(ValueScope.parse({ kind: 'statement', filePath: FILE, line: 3, column: 5 }))
      .toEqual({ kind: 'statement', filePath: FILE, line: 3, column: 5 });
    expect(ValueScope.parse({ kind: 'append', filePath: FILE, line: 3, column: 0 }))
      .toEqual({ kind: 'append', filePath: FILE, line: 3, column: 0 });
  });

  it('reads an absent site as none', () => {
    expect(ValueScope.parse(undefined)).toBeNull();
    expect(ValueScope.parse(null)).toBeNull();
  });

  it('refuses a malformed site', () => {
    const malformed: unknown[] = [
      'line 3',
      { kind: 'nowhere', filePath: FILE, line: 3, column: 1 },
      { kind: 'statement', line: 3, column: 1 },
      { kind: 'statement', filePath: '', line: 3, column: 1 },
      { kind: 'statement', filePath: FILE, line: 0, column: 1 },
      { kind: 'statement', filePath: FILE, line: 2.5, column: 1 },
      { kind: 'statement', filePath: FILE, line: 3, column: -1 },
      { kind: 'append', filePath: FILE, line: 3 },
    ];
    for (const value of malformed) {
      expect(ValueScope.parse(value), JSON.stringify(value)).toBe('invalid');
    }
  });
});

// An insert's dialog values may read another instance's computed
// properties — `drawer.properties.frontWidth` — the one member access the
// preview evaluates, from the values the last render gave that instance.
describe('ValueScope — instance properties', () => {
  const ASSEMBLY_FILE = '/ws/kitchen.assembly.js';
  const KITCHEN = [
    `import { assembly, insert } from 'fluidcad/core';`,
    `import { Drawer } from './drawer.part.js';`,
    `export const kitchen = assembly('kitchen', () => {`,
    `  const drawer = insert(Drawer, {`,
    `    Width: 400,`,
    `  });`,
    `  const gap = drawer.properties.frontWidth / 10;`,
    `  const second = insert(Drawer, { Width: drawer.properties.frontWidth });`,
    `  const box1 = insert(Drawer, { Width: 600 }).grounded();`,
    `  return { drawer, second, box1 };`,
    `});`,
  ].join('\n');
  const rendered = [
    { sourceLocation: { filePath: ASSEMBLY_FILE, line: 4, column: 18 }, properties: { frontWidth: 480, finish: 'oak' } },
    { sourceLocation: { filePath: ASSEMBLY_FILE, line: 8, column: 18 }, properties: { frontWidth: 560, finish: 'oak' } },
    { sourceLocation: { filePath: ASSEMBLY_FILE, line: 9, column: 16 }, properties: { frontWidth: 680 } },
  ];
  /** The second insert — an edited statement. */
  const SECOND_INSERT = 8;

  async function kitchenScope(at: GhostValueScope | null, instances = rendered): Promise<ValueScope> {
    return ValueScope.open({ code: KITCHEN, filePath: ASSEMBLY_FILE, definitions: [], instances }, at);
  }

  it('reads a rendered property through its binding, in arithmetic too', async () => {
    const scope = await kitchenScope(statement(SECOND_INSERT, 3, ASSEMBLY_FILE));
    expect(scope.resolve('drawer.properties.frontWidth')).toBe(480);
    expect(scope.resolve('drawer.properties.frontWidth - 2 * 18')).toBe(444);
    // A source binding over the property evaluates the same way.
    expect(scope.resolve('gap')).toBe(48);
    // A handle bound through its own methods still reads its instance.
    expect(scope.resolve('box1.properties.frontWidth')).toBe(680);
  });

  it('refuses what is not a numeric property of an inserted instance', async () => {
    const scope = await kitchenScope(statement(SECOND_INSERT, 3, ASSEMBLY_FILE));
    expect(scope.resolve('drawer.properties.finish')).toBeNull();
    expect(scope.resolve('drawer.properties.depth')).toBeNull();
    expect(scope.resolve('drawer.frontWidth')).toBeNull();
    expect(scope.resolve('drawer.paramValues.Width')).toBeNull();
    expect(scope.resolve('Drawer.properties.frontWidth')).toBeNull();
    // `Math` keeps its own members.
    expect(scope.resolve('Math.PI')).toBeCloseTo(Math.PI);
  });

  it('reads nothing without a render behind the binding', async () => {
    const scope = await kitchenScope(statement(SECOND_INSERT, 3, ASSEMBLY_FILE), []);
    expect(scope.resolve('drawer.properties.frontWidth')).toBeNull();
  });
});

// A part file's dialog values may read another definition's computed
// properties — `box.properties.lidClearance` — the default variant's, as
// `def.properties` serves them, from the values the last render gave it.
describe('ValueScope — part definition properties', () => {
  const PART_FILE = '/ws/box.part.js';
  const BOX = [
    `import { part, param, property, sketch, extrude } from 'fluidcad/core';`,
    `export const box = part('Box', () => {`,
    `  const lidClearance = param('Lid Clearance', 1);`,
    `  property('Lid clearance', 'lidClearance', lidClearance);`,
    `  property('Finish', 'finish', 'oak');`,
    `}).name('Carcase');`,
    `const gap = box.properties.lidClearance * 2;`,
    `export const lid = part('Lid', () => {`,
    `  const s = sketch('xy', () => {`,
    `  });`,
    `  extrude(2, s);`,
    `});`,
  ].join('\n');
  const rendered = [
    { sourceLocation: { filePath: PART_FILE, line: 2, column: 20 }, properties: { lidClearance: 1, finish: 'oak' } },
    { sourceLocation: { filePath: PART_FILE, line: 8, column: 20 }, properties: {} },
  ];
  /** The lid's extrude — an edited statement. */
  const LID_EXTRUDE = 11;

  async function boxScope(at: GhostValueScope | null, parts = rendered): Promise<ValueScope> {
    return ValueScope.open({ code: BOX, filePath: PART_FILE, definitions: [], parts }, at);
  }

  it('reads a rendered property through the definition, in arithmetic and through a source binding', async () => {
    const scope = await boxScope(statement(LID_EXTRUDE, 3, PART_FILE));
    expect(scope.resolve('box.properties.lidClearance')).toBe(1);
    expect(scope.resolve('box.properties.lidClearance + 0.5')).toBe(1.5);
    expect(scope.resolve('gap')).toBe(2);
  });

  it('refuses what is not a numeric property of a definition', async () => {
    const scope = await boxScope(statement(LID_EXTRUDE, 3, PART_FILE));
    expect(scope.resolve('box.properties.finish')).toBeNull();
    expect(scope.resolve('box.properties.depth')).toBeNull();
    expect(scope.resolve('lid.properties.lidClearance')).toBeNull();
    expect(scope.resolve('box.lidClearance')).toBeNull();
  });

  it('reads nothing without a render behind the definition', async () => {
    const scope = await boxScope(statement(LID_EXTRUDE, 3, PART_FILE), []);
    expect(scope.resolve('box.properties.lidClearance')).toBeNull();
  });
});
