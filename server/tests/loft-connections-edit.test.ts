import { describe, expect, it } from 'vitest';
import { applyFeatureEdit, parseFeatureStatement, type ApplyFeatureEditSpec, type LoftConnectionSpec } from '../src/apply-feature-edit.ts';

const FILE = '/ws/model.fluid.js';
const CODE = `const a = sketch('xy', () => {
  line([0, 0], [20, 0]);
});
const b = sketch(plane('xy', { offset: 40 }), () => {
  const side = line([0, 0], [20, 0]);
  return { rim: side };
});`;

const connections: LoftConnectionSpec[] = [{ kind: 'points', points: [
  { kind: 'sketch', producer: 0, target: { line: 2, featureType: 'line', role: 'start' } },
  { kind: 'sketch', producer: 1, target: { line: 5, featureType: 'line', role: 'end' } },
] }];
function spec(overrides: Partial<ApplyFeatureEditSpec> = {}): ApplyFeatureEditSpec {
  return {
    feature: 'loft', filePath: FILE, imports: [], parts: [],
    producers: [{ line: 1, column: 0, featureType: 'sketch', nameHint: 's', bind: true },
      { line: 4, column: 0, featureType: 'sketch', nameHint: 's', bind: true }],
    loft: { op: 'add', thin: null, profiles: [{ kind: 'sketch', producer: 0 }, { kind: 'sketch', producer: 1 }], connections },
    ...overrides,
  };
}
function edit(connections?: LoftConnectionSpec[]): ApplyFeatureEditSpec {
  return spec({ loft: undefined, edit: { line: 8, column: 0, loft: { op: 'add', thin: null, connections } } });
}

describe('loft connection source edits', () => {
  it('parses repeatable connections and preserves their argument text', async () => {
    const code = `loft(a, b).connect(a.geometries.side.start(), /* top */ b.geometries.rim.end())
  .connect( [20, 0, 0],\n    [20, 0, 40] ).startCondition('normal')`;
    const result = await parseFeatureStatement(code, 1);
    expect(result).toMatchObject({ ok: true, parsed: {
      feature: 'loft', connectionTexts: [
        ['a.geometries.side.start()', 'b.geometries.rim.end()'], ['[20, 0, 0]', '[20, 0, 40]'],
      ], connectionArgs: ['a.geometries.side.start(), /* top */ b.geometries.rim.end()', ' [20, 0, 0],\n    [20, 0, 40] '],
    } });
  });

  it.each(['loft(a, b).connect(a.start())', 'loft(a, b).connect(...points)',
    'loft(a, b).connect(a, b).color("red").connect(c, d)'])('refuses unsupported connection syntax: %s', async code => {
    expect(await parseFeatureStatement(code, 1)).toMatchObject({ ok: false });
  });

  it('creates exports and the consuming loft together, reusing an existing alias', async () => {
    const result = await applyFeatureEdit(CODE, spec());
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain('const l1 = line(');
    expect(result.newCode).toContain('return { l1 };');
    expect(result.newCode).toContain('loft(a, b).connect(a.geometries.l1.start(), b.geometries.rim.end())');
    expect(result.newCode).not.toContain('return { rim: side,');
  });

  it('relocates the edited loft after export edits and preserves untouched rows verbatim', async () => {
    const original = `loft(a, b).connect( [0, 0, 0], /* seam */ [0, 0, 40] )`;
    const request = edit([{ kind: 'verbatim', sourceIndex: 0 }, ...connections]);
    request.edit!.expectedStatement = original;
    const result = await applyFeatureEdit(`${CODE}\n${original};`, request);
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`${original}.connect(a.geometries.l1.start(), b.geometries.rim.end())`);
    expect(result.newCode.match(/loft\(a, b\)/g)).toHaveLength(1);
  });

  it('replaces one point in a row while retaining the other point’s original expression', async () => {
    const original = `loft(a, b).connect(a.geometries.old.start(), b.geometries.rim.end())`;
    const request = edit([{ kind: 'points', points: [
      { kind: 'sketch', producer: 0, target: { line: 2, featureType: 'line', role: 'end' } },
      { kind: 'verbatim', sourceIndex: 0, pointIndex: 1 },
    ] }]);
    const result = await applyFeatureEdit(`${CODE}\n${original};`, request);
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain('loft(a, b).connect(a.geometries.l1.end(), b.geometries.rim.end())');
  });

  it('distinguishes omitted connections from an empty replacement list', async () => {
    const code = `${CODE}\nloft(a, b).connect( [0, 0, 0], /* keep */ [0, 0, 40] );`;
    const kept = await applyFeatureEdit(code, edit());
    const removed = await applyFeatureEdit(code, edit([]));
    expect(kept.error).toBeUndefined();
    expect(removed.error).toBeUndefined();
    expect(kept.newCode).toContain('.connect( [0, 0, 0], /* keep */ [0, 0, 40] )');
    expect(removed.newCode).not.toContain('.connect(');
  });

  it('renders solid points with the existing selector binding and endpoint suffix', async () => {
    const request = spec();
    request.producers.push({ line: 8, column: 0, featureType: 'extrude', nameHint: 'e', bind: true });
    request.loft!.connections = [{ kind: 'points', points: [
      { kind: 'edge', selector: { producer: 2, accessor: 'startEdges', indices: [0], filterArgs: null }, role: 'start' },
      { kind: 'edge', selector: { producer: 2, accessor: 'endEdges', indices: [2], filterArgs: null }, role: 'end' },
    ] }];
    const result = await applyFeatureEdit(`${CODE}\nextrude(40, a);`, request);
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain('const e = extrude(40, a)');
    expect(result.newCode).toContain('.connect(e.startEdges(0).start(), e.endEdges(2).end())');
  });

  it('declares a global selection point before the loft instead of inside .connect()', async () => {
    const request = spec();
    request.imports = ['select', 'edge'];
    request.loft!.connections = [{ kind: 'points', points: [
      { kind: 'edge', selector: { producer: null, accessor: 'select', filterArgs: "edge().farthest('x')" }, role: 'end' },
      { kind: 'edge', selector: { producer: null, accessor: 'select', filterArgs: "edge().nearest('x')" }, role: 'start' },
    ] }];
    const result = await applyFeatureEdit(`${CODE}\nconst sel = 1;`, request);
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain([
      `const sel2 = select(edge().farthest('x'));`,
      `const sel3 = select(edge().nearest('x'));`,
      `loft(a, b).connect(sel2.end(), sel3.start());`,
    ].join('\n'));
  });

  it('lifts new and kept inline selections on edit, inside the part body the loft lives in', async () => {
    const original = `loft(a, b).connect(select(edge().farthest('x')).end(), [0, 0, 40])`;
    const code = `part('P', () => {\n  ${CODE.split('\n').join('\n  ')}\n  ${original};\n});`;
    const request = edit([{ kind: 'verbatim', sourceIndex: 0 }, { kind: 'points', points: [
      { kind: 'edge', selector: { producer: null, accessor: 'select', filterArgs: "edge().nearest('x')" }, role: 'start' },
      { kind: 'verbatim', sourceIndex: 0, pointIndex: 1 },
    ] }]);
    request.producers = request.producers.map(producer => ({ ...producer, line: producer.line + 1 }));
    request.edit!.line = 9;
    const result = await applyFeatureEdit(code, request);
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain([
      `  const sel = select(edge().farthest('x'));`,
      `  const sel2 = select(edge().nearest('x'));`,
      `  loft(a, b).connect(sel.end(), [0, 0, 40]).connect(sel2.start(), [0, 0, 40]);`,
    ].join('\n'));
  });

  it('removes a connection\'s selection with the connection, and keeps one still in use', async () => {
    const code = [CODE,
      `const sel = select(edge().farthest('x'));`,
      `const sel2 = select(edge().nearest('x'));`,
      `loft(a, b).connect(sel.end(), [0, 0, 40]).connect(sel2.start(), [0, 0, 40]);`,
    ].join('\n');
    const request = edit([{ kind: 'verbatim', sourceIndex: 1 }]);
    request.edit!.line = 10;
    const result = await applyFeatureEdit(code, request);
    expect(result.error).toBeUndefined();
    expect(result.newCode).toBe([`import { loft } from 'fluidcad/core';`, CODE,
      `const sel2 = select(edge().nearest('x'));`,
      `loft(a, b).connect(sel2.start(), [0, 0, 40]);`,
    ].join('\n'));
  });

  it('refuses stale consumers without returning staged exports', async () => {
    const code = `${CODE}\nloft(a, b).new();`;
    const request = edit(connections);
    request.edit!.expectedStatement = 'loft(a, b)';
    const result = await applyFeatureEdit(code, request);
    expect(result.error).toContain('changed since');
    expect(result.newCode).toBe(code);
  });

  it.each(['thin', 'guides'])('composes %s with connections in one edit', async kind => {
    const code = `${CODE}\nloft(a, b);`;
    const request = edit(connections);
    if (kind === 'thin') {
      request.edit!.loft!.thin = [1];
    } else {
      request.edit!.loft!.guides = [{ kind: 'sketch', producer: 0 }];
    }
    const result = await applyFeatureEdit(code, request);
    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain('.connect(a.geometries.l1.start(), b.geometries.rim.end())');
    expect(result.newCode).toContain(kind === 'thin' ? '.thin(1)' : '.guides(a)');
  });

  it.each(['arity', 'kept'])('refuses invalid %s connections atomically', async kind => {
    const code = `${CODE}\nloft(a, b);`;
    const request = edit(connections);
    if (kind === 'arity') {
      request.edit!.loft!.connections = [{ kind: 'points', points: [connections[0].kind === 'points' ? connections[0].points[0] : null!] }];
    } else {
      request.edit!.loft!.connections = [{ kind: 'verbatim', sourceIndex: 1 }];
    }
    const result = await applyFeatureEdit(code, request);
    expect(result.error).toBeDefined();
    expect(result.newCode).toBe(code);
  });
});
