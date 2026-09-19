import { describe, expect, it } from 'vitest';
import { SketchExports } from '../src/apply-feature-edit.ts';
import { getJavaScriptParser } from '../src/code-editor.ts';
import type { SketchExportRequest, SolvedEmissionTarget } from '../../lib/selection/sketch-target.js';
import sketch from '../../lib/core/sketch.js';
import plane from '../../lib/core/plane.js';
import { line } from '../../lib/core/2d/index.js';
import { getSceneManager } from '../../lib/scene-manager.js';
import { render } from '../../lib/tests/setup.js';
import { PointResolver } from '../../lib/features/point-resolver.js';

const ref = (sketchLine: number, target: SolvedEmissionTarget): SketchExportRequest => ({
  sketch: { filePath: '/ws/model.fluid.js', line: sketchLine, column: 0 }, target,
});
const lineTarget = (line: number, role: 'start' | 'end' = 'start'): SolvedEmissionTarget => ({ line, featureType: 'line', role });

async function apply(code: string, refs: SketchExportRequest[], anchors: number[] = []) {
  const result = await SketchExports.applyCreates(code, refs, anchors);
  expect(result, 'error' in result ? result.error : '').not.toHaveProperty('error');
  if ('error' in result) {
    throw new Error(result.error);
  }
  const parser = await getJavaScriptParser();
  expect([...parser.parse(result.code).rootNode.namedChildren].length).toBeGreaterThan(0);
  return result;
}

describe('SketchExports', () => {
  it('executes the emitted references in world space and follows parameter changes', async () => {
    const code = `const a = sketch(plane('yz', { offset: 40 }), () => {
  line([0, 0], [width, 0]);
});`;
    const result = await apply(code, [ref(1, lineTarget(2)), ref(1, lineTarget(2, 'end'))]);
    const run = new Function('sketch', 'plane', 'line', 'width', `${result.code}\nreturn [${result.expressions.join(', ')}];`);
    for (const width of [20, 35]) {
      getSceneManager().startScene();
      const refs = run(sketch, plane, line, width);
      render();
      expect(refs.map(point => PointResolver.toWorld(point).toArray())).toEqual([[40, 0, 0], [40, width, 0]]);
    }
  });

  it('hoists unnamed geometry once, binds its sketch, and appends an object return', async () => {
    const code = `sketch('xy', () => {
  line([0, 0], [20, 0]);
});`;
    const result = await apply(code, [ref(1, lineTarget(2)), ref(1, lineTarget(2, 'end'))]);
    expect(result.expressions).toEqual(['s.geometries.l1.start()', 's.geometries.l1.end()']);
    expect(result.code).toContain('const s = sketch(');
    expect(result.code.match(/const l1 =/g)).toHaveLength(1);
    expect(result.code).toContain('return { l1 };');
  });

  it('reuses an alias and leaves an already exported sketch unchanged', async () => {
    const code = `const a = sketch('xy', () => {
  const side = line([0, 0], [20, 0]);
  return { rim: side };
});`;
    const result = await apply(code, [ref(1, lineTarget(2))]);
    expect(result.code).toBe(code);
    expect(result.expressions).toEqual(['a.geometries.rim.start()']);
  });

  it('extends object returns, avoiding colliding property and variable names', async () => {
    const code = `const l1 = 42;
const s = sketch('xy', () => {
  line([0, 0], [20, 0]);
  return { l2: 99, /* retained */ };
});`;
    const result = await apply(code, [ref(2, lineTarget(3))]);
    expect(result.code).toContain('const l3 = line(');
    expect(result.code).toContain('return { l2: 99, l3, /* retained */ };');
    expect(result.expressions).toEqual(['s.geometries.l3.start()']);
  });

  it('exports all mirror dependencies and preserves copy/ref/bezier addressing', async () => {
    const code = `const a = sketch('xy', () => {
  const side = line([0, 0], [20, 0]);
  const cp = copy(side).times(3);
  const m = mirror('x', cp);
  const prj = project(other);
  const bz = bezier([0, 0], [1, 2], [3, 0]);
});`;
    const result = await apply(code, [
      ref(1, { line: 4, featureType: 'mirror', role: 'end', source: { line: 3, featureType: 'copy', instanceIndex: 2 } }),
      ref(1, { line: 5, featureType: 'project', refIndex: 2, role: 'start' }),
      ref(1, { line: 6, featureType: 'bezier', pointIndex: 2 }),
    ]);
    expect(result.expressions).toEqual(['a.geometries.m.instance(a.geometries.cp.instance(2)).end()',
      'a.geometries.prj.ref(2).start()', 'a.geometries.bz.point(2)']);
    expect(result.code).toContain('return { m, cp, prj, bz };');
  });

  it('relocates a later sketch and its consumer after staging multiple exports', async () => {
    const code = `const a = sketch('xy', () => {
  line([0, 0], [20, 0]);
});
const b = sketch('xy', () => {
  line([0, 0], [40, 0]);
});
loft(a, b);`;
    const result = await apply(code, [ref(1, lineTarget(2)), ref(4, lineTarget(5))], [4, 7]);
    const rows = result.code.split('\n');
    expect(rows[result.anchors[0] - 1]).toContain('const b = sketch(');
    expect(rows[result.anchors[1] - 1]).toBe('loft(a, b);');
    expect(result.expressions).toEqual(['a.geometries.l1.start()', 'b.geometries.l2.start()']);
    const again = await apply(result.code, [ref(1, lineTarget(2))]);
    expect(again.code).toBe(result.code);
  });

  it('keeps a one-property-per-line return object laid out that way', async () => {
    const code = `const a = sketch('xy', () => {
  const side = line([0, 0], [20, 0]);
  line([20, 0], [20, 20]);
  line([20, 20], [0, 20]);
  return {
    side,
  };
});`;
    const result = await apply(code, [ref(1, lineTarget(3)), ref(1, lineTarget(4))]);
    expect(result.code).toContain('  return {\n    side,\n    l1,\n    l2,\n  };');
    expect(result.expressions).toEqual(['a.geometries.l1.start()', 'a.geometries.l2.start()']);
  });

  it.each([
    { name: 'an expression-bodied callback', code: "const a = sketch('xy', () => line([0, 0], [20, 0]));", target: 1, reason: /expression body.*block body/ },
    { name: 'an object-returning arrow', code: "const a = sketch('xy', () => ({ side: line([0, 0], [20, 0]) }));", target: 1, reason: /expression body.*block body/ },
    { name: 'geometry on the sketch() line', code: "const a = sketch('xy', () => { line([0, 0], [20, 0]); });", target: 1, reason: /shares its line with the sketch\(\) call/ },
    { name: 'two statements on one line', code: "const a = sketch('xy', () => {\n  line([0, 0], [20, 0]); line([20, 0], [20, 20]);\n});", target: 2, reason: /line 2 holds several statements/ },
  ])('refuses $name and says why', async ({ code, target, reason }) => {
    const result = await SketchExports.applyCreates(code, [ref(1, lineTarget(target))]);
    expect(result).toMatchObject({ error: expect.stringMatching(reason) });
    expect(result).not.toHaveProperty('code');
  });

  it.each(['return side;', 'return getGeometry();', 'return;', 'if (flag) { return { side }; }',
    'return { ...extra };', 'return { [name]: side };', 'return { side, side };'])('refuses unsupported returns atomically: %s', async returned => {
    const code = `const a = sketch('xy', () => {
  line([0, 0], [20, 0]);
});
const b = sketch('xy', () => {
  const side = line([0, 0], [40, 0]);
  ${returned}
});`;
    const result = await SketchExports.applyCreates(code, [ref(1, lineTarget(2)), ref(4, lineTarget(5))]);
    expect(result).toHaveProperty('error');
    expect(result).not.toHaveProperty('code');
  });

  it.each([
    { body: '  arc([0, 0], [1, 0], [0, 1]);', target: lineTarget(2) },
    { body: '  for (let i = 0; i < 3; i++) {\n    line([i, 0], [i, 20]);\n  }', target: lineTarget(3) },
    { body: '  function make() {\n    line([0, 0], [20, 0]);\n  }\n  make();', target: lineTarget(3) },
    { body: '  const { side } = line([0, 0], [20, 0]);', target: lineTarget(2) },
    { body: '  consume(line([0, 0], [20, 0]));', target: lineTarget(2) },
    { body: '  line([0, 0], [20, 0]);', target: { ...lineTarget(2), occurrence: 0 } },
    { body: '  let side = line([0, 0], [20, 0]);\n  side = other;', target: lineTarget(2) },
  ])('refuses stale/ambiguous entity source $body', async ({ body, target }) => {
    const code = `const a = sketch('xy', () => {\n${body}\n});`;
    expect(await SketchExports.applyCreates(code, [ref(1, target)])).toHaveProperty('error');
  });
});
