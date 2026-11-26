import { describe, it, expect } from 'vitest';
import { setupOC, render } from '../../lib/tests/setup.ts';
import { useLoadedBodies, loadShapes } from '../../lib/tests/helpers/loaded-bodies.ts';
import { TestCurves } from '../../lib/tests/helpers/curves.ts';
import { TestSheets } from '../../lib/tests/helpers/sheets.ts';
import { getSceneManager } from '../../lib/scene-manager.ts';
import sketch from '../../lib/core/sketch.ts';
import extrude from '../../lib/core/extrude.ts';
import helix from '../../lib/core/helix.ts';
import { circle } from '../../lib/core/2d/index.ts';
import type { SceneObject } from '../../lib/common/scene-object.ts';
import {
  applyFeatureEdit,
  FeatureCallees,
  parseFeatureStatement,
  type ApplyFeatureEditSpec,
  type FeatureCalleeSource,
  type StatementProduct,
} from '../src/apply-feature-edit/index.ts';
import { findEditableCallAt, getJavaScriptParser, splitLines, type TSNode } from '../src/code-editor/index.ts';
import { FluidCadServer } from '../src/fluidcad-server/index.ts';
import { SceneCallees } from '../src/scene-callees.ts';

const FILE = '/ws/model.fluid.js';

function src(...lines: string[]): string {
  return [...lines, ''].join('\n');
}

/** `load('spine')` on line 3, an extrude on line 5, the profile sketch on line 6. */
const CODE = src(
  `import { load, sketch, circle, extrude } from 'fluidcad/core'`,
  ``,
  `const spine = load('spine')`,
  `sketch('xy', () => { circle(20) })`,
  `const block = extrude(10)`,
  `sketch('xy', () => { circle(2) })`,
);

/** A sweep whose path is the statement at `line`, bound as a wire, along the sketch on line 6. */
function sweepAlong(line: number): ApplyFeatureEditSpec {
  return {
    feature: 'sweep',
    filePath: FILE,
    sweep: { op: 'add', thin: null, profile: 'implicit', path: { kind: 'sketch', producer: 0 } },
    producers: [
      { line, column: 0, featureType: 'wire', nameHint: 'p', bind: true },
      { line: 6, column: 0, featureType: 'sketch', nameHint: 's', bind: false },
    ],
    parts: [],
    imports: [],
  };
}

/** A callee source whose scene answers `products` by line. */
function sceneOf(products: Record<number, StatementProduct>): FeatureCalleeSource {
  return {
    calleesFor: async () => FeatureCallees.BUILT_IN.over({ at: site => products[site.line] ?? null }),
  };
}

describe('a wire input by what the scene says its statement left', () => {
  it('binds a statement the scene holds a curve of, whatever its callee', async () => {
    const callees = sceneOf({ 3: { curve: true, surface: false } });
    const result = await applyFeatureEdit(CODE, sweepAlong(3), { callees });

    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`const spine = load('spine')`);
    expect(result.newCode).toContain(`sweep(spine)`);
  });

  it('refuses a statement the scene holds no curve of', async () => {
    const callees = sceneOf({ 3: { curve: true, surface: false }, 5: { curve: false, surface: false } });
    const result = await applyFeatureEdit(CODE, sweepAlong(5), { callees });

    expect(result.error).toContain('the call at line 5 is extrude(), expected a sketch() or helix() call');
    expect(result.newCode).toBe(CODE);
  });

  it('reads the call alone when no scene answers: a sketch or a helix binds, a load does not', async () => {
    const refused = await applyFeatureEdit(CODE, sweepAlong(3));
    expect(refused.error).toContain('the call at line 3 is load(), expected a sketch() or helix() call');

    const unanswered = await applyFeatureEdit(CODE, sweepAlong(3), { callees: sceneOf({}) });
    expect(unanswered.error).toContain('expected a sketch() or helix() call');

    const sketched = await applyFeatureEdit(CODE, sweepAlong(4));
    expect(sketched.error).toBeUndefined();
    expect(sketched.newCode).toContain(`sweep(p)`);
  });

  it('binds a sketch or a helix by its call even when the scene has not rendered it', async () => {
    const code = CODE.replace(`const spine = load('spine')`, `const spring = helix('z').radius(10)`);
    const result = await applyFeatureEdit(code, sweepAlong(3), { callees: sceneOf({}) });

    expect(result.error).toBeUndefined();
    expect(result.newCode).toContain(`sweep(spring)`);
  });

  it('answers the callee-only gate by the calls a file is read as drawing a curve by', () => {
    expect(FeatureCallees.BUILT_IN.produces('wire', 'sketch')).toBe(true);
    expect(FeatureCallees.BUILT_IN.produces('wire', 'helix')).toBe(true);
    expect(FeatureCallees.BUILT_IN.produces('wire', 'extrude')).toBe(false);
    expect(FeatureCallees.BUILT_IN.produces('wire', 'load')).toBe(false);
  });
});

describe('a surface input by what the scene says its statement left', () => {
  /** The statement call on `line` of {@link CODE}. */
  async function callAt(line: number): Promise<TSNode> {
    const tree = (await getJavaScriptParser()).parse(CODE);
    return findEditableCallAt(tree, splitLines(CODE), line)!;
  }

  it('binds a statement the scene holds a surface of and refuses one it holds none of', async () => {
    const callees = FeatureCallees.BUILT_IN.over({
      at: site => site.line === 3 ? { curve: false, surface: true } : { curve: false, surface: false },
    });

    expect(callees.binds({ featureType: 'surface', line: 3 }, await callAt(3))).toBe(true);
    expect(callees.identityMismatch({ featureType: 'surface', line: 3 }, await callAt(3))).toBeNull();
    expect(callees.binds({ featureType: 'surface', line: 5 }, await callAt(5))).toBe(false);
    expect(callees.identityMismatch({ featureType: 'surface', line: 5 }, await callAt(5))).toBe('a statement that holds a surface');
  });

  it('takes any feature statement when no scene answers: a call does not tell a surface from a solid', async () => {
    expect(FeatureCallees.BUILT_IN.binds({ featureType: 'surface', line: 3 }, await callAt(3))).toBe(true);
    expect(FeatureCallees.BUILT_IN.binds({ featureType: 'surface', line: 5 }, await callAt(5))).toBe(true);
    expect(FeatureCallees.BUILT_IN.binds({ featureType: 'surface', line: 4 }, await callAt(4))).toBe(false);
  });
});

describe('a plane base bound to a statement that left a curve', () => {
  const PLANE = src(
    `import { load, plane } from 'fluidcad/core'`,
    ``,
    `const spine = load('spine')`,
    `plane(spine, 0.5)`,
  );

  it('reads as an edge base when the scene holds a curve of the statement', async () => {
    const callees = FeatureCallees.BUILT_IN.over({ at: site => site.line === 3 ? { curve: true, surface: false } : null });
    const result = await parseFeatureStatement(PLANE, 4, callees);

    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'plane', type: 'edge', position: 0.5, bases: [{ text: 'spine', kind: 'edge' }] },
    });
  });

  it('reads as a plane variable when nothing says the statement left a curve', async () => {
    const result = await parseFeatureStatement(PLANE, 4);

    expect(result).toMatchObject({
      ok: true,
      parsed: { feature: 'plane', type: 'offset', offset: 0.5, bases: [{ text: 'spine', kind: 'plane' }] },
    });
  });

  it('still reads a helix or a sketch variable as an edge base with no scene', async () => {
    const code = PLANE.replace(`load('spine')`, `helix('z').radius(10)`);
    const result = await parseFeatureStatement(code, 4);

    expect(result).toMatchObject({ ok: true, parsed: { type: 'edge', bases: [{ kind: 'edge' }] } });
  });
});

describe('the scene question through the server', () => {
  setupOC();
  useLoadedBodies();

  const at = (obj: unknown, line: number, column: number): void => {
    (obj as SceneObject).setSourceLocation({ filePath: FILE, line, column });
  };

  /** A loaded curve on line 3, a block on line 5, a loaded surface on line 7, a helix on line 9. */
  function stage(): FluidCadServer {
    at(loadShapes([TestCurves.threeEdges()]), 3, 14);
    sketch('xy', () => {
      circle([100, 0], 20);
    });
    at(extrude(10), 5, 14);
    at(loadShapes([TestSheets.plate(10, 10)]), 7, 0);
    at(helix('z').radius(10).pitch(5).turns(2), 9, 0);
    const server = new FluidCadServer();
    server.setSceneManager(getSceneManager() as any);
    server._setSceneForTesting(FILE, render(), -1);
    return server;
  }

  it('answers what each statement left, and null where the scene built nothing', () => {
    const server = stage();

    expect(server.statementProduct({ filePath: FILE, line: 3, column: 14 })).toEqual({ curve: true, surface: false });
    expect(server.statementProduct({ filePath: FILE, line: 5 })).toEqual({ curve: false, surface: false });
    expect(server.statementProduct({ filePath: FILE, line: 7 })).toEqual({ curve: false, surface: true });
    expect(server.statementProduct({ filePath: FILE, line: 9 })).toEqual({ curve: true, surface: false });
    expect(server.statementProduct({ filePath: FILE, line: 40 })).toBeNull();
    expect(new FluidCadServer().statementProduct({ filePath: FILE, line: 3 })).toBeNull();
  });

  it('binds a loaded curve as a sweep path through the scene callees, and refuses the block', async () => {
    const callees = new SceneCallees(FeatureCallees.BUILT_IN_SOURCE, stage());
    const path = (line: number): ApplyFeatureEditSpec => {
      const spec = sweepAlong(line);
      spec.producers[0].column = 14;
      return spec;
    };

    const bound = await applyFeatureEdit(CODE, path(3), { callees });
    expect(bound.error).toBeUndefined();
    expect(bound.newCode).toContain(`sweep(spine)`);

    const refused = await applyFeatureEdit(CODE, path(5), { callees });
    expect(refused.error).toContain('the call at line 5 is extrude(), expected a sketch() or helix() call');
  });
});
