// End-to-end select→apply-feature: build a scene, pick edges on the rendered
// solid, synthesize the selector (lib), run the tree-sitter transform on the
// matching source text (server), then EXECUTE the edited code against the real
// runtime and assert the feature landed. This is the whole pipeline minus
// HTTP/IPC plumbing.

import { describe, it, expect } from 'vitest';
import { setupOC, render } from '../../lib/tests/setup.js';
import { getSceneManager } from '../../lib/scene-manager.js';
import sketch from '../../lib/core/sketch.js';
import extrude from '../../lib/core/extrude.js';
import * as core from '../../lib/core/index.js';
import * as filters from '../../lib/filters/index.js';
import * as math from '../../lib/math/index.js';
import { rect } from '../../lib/core/2d/index.js';
import { Scene } from '../../lib/rendering/scene.js';
import { SceneObject } from '../../lib/common/scene-object.js';
import { Shape } from '../../lib/common/shape.js';
import { Edge } from '../../lib/common/edge.js';
import { Solid } from '../../lib/common/solid.js';
import { Explorer } from '../../lib/oc/explorer.js';
import { EdgeOps } from '../../lib/oc/edge-ops.js';
import { FaceProps } from '../../lib/oc/face-props.js';
import { ShapeProps } from '../../lib/oc/props.js';
import { synthesizeApplyFeature } from '../../lib/selection/explain.js';
import { scopedSceneBefore } from '../../lib/selection/types.js';
import type { PickRef } from '../../lib/selection/types.js';
import { applyFeatureEdit, type ApplyFeatureEditSpec } from '../src/apply-feature-edit.ts';

function findSolid(scene: Scene): Shape {
  const solid = scene.getAllSceneObjects()
    .flatMap(o => o.getShapes())
    .find(s => s.getType() === 'solid');
  expect(solid).toBeDefined();
  return solid!;
}

function topEdgeRefs(solid: Shape, z: number): PickRef[] {
  const refs: PickRef[] = [];
  Explorer.findEdgesWrapped(solid).forEach((e: Edge, index: number) => {
    if (Math.abs(EdgeOps.getEdgeMidPoint(e).z - z) < 1e-6) {
      refs.push({ shapeId: solid.id, sub: { type: 'edge', index } });
    }
  });
  return refs;
}

const IMPORT_LINE_RE = /^\s*import\s[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm;

/** Execute a .fluid.js source string against the real runtime (fresh scene). */
function runFluid(source: string): Scene {
  getSceneManager()!.startScene();
  const globals: Record<string, unknown> = { ...core, ...filters, ...math };
  const names = Object.keys(globals);
  const values = names.map(n => globals[n]);
  const fn = new Function(...names, `"use strict";\n${source.replace(IMPORT_LINE_RE, '')}`);
  fn(...values);
  return render();
}

describe('select→apply-feature end to end', () => {
  setupOC();

  it('fillets the picked whole top rim through synthesized code', async () => {
    const code = [
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    // Build the same model in-process and stamp the extrude with the line it
    // occupies in `code`, as the live-render stack capture would.
    sketch('xy', () => { rect(100, 50) });
    const e = extrude(30);
    (e as unknown as SceneObject).setSourceLocation({ filePath: '/ws/model.fluid.js', line: 4, column: 0 });

    const scene = render();
    const solid = findSolid(scene);
    const picks = topEdgeRefs(solid, 30);
    expect(picks).toHaveLength(4);

    const synthesis = synthesizeApplyFeature(scene, picks, 'fillet', 3);
    expect(synthesis.ok).toBe(true);
    if (synthesis.ok !== true) {
      return;
    }
    expect(synthesis.preview).toBe('fillet(3, e.endEdges())');

    const edited = await applyFeatureEdit(code, synthesis.spec);
    expect(edited.error).toBeUndefined();
    expect(edited.newCode).toContain('const e = extrude(30)');
    expect(edited.newCode).toContain('fillet(3, e.endEdges())');

    // Execute the edited program: each rim edge becomes a cylindrical fillet
    // face and material is removed.
    const rerun = runFluid(edited.newCode);
    const newSolid = findSolid(rerun) as Solid;
    const cylinders = newSolid.getFaces()
      .filter(f => FaceProps.getProperties(f.getShape()).surfaceType === 'cylinder');
    expect(cylinders.length).toBeGreaterThanOrEqual(4);
    expect(ShapeProps.getProperties(newSolid.getShape()).volumeMm3).toBeLessThan(100 * 50 * 30);
  });

  it('fillets a picked face through a synthesized face selector', async () => {
    const code = [
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    sketch('xy', () => { rect(100, 50) });
    const e = extrude(30);
    (e as unknown as SceneObject).setSourceLocation({ filePath: '/ws/model.fluid.js', line: 4, column: 0 });

    const scene = render();
    const solid = findSolid(scene);
    // Pick the top face (the only face whose edges all sit at z = 30).
    const picks: PickRef[] = [];
    Explorer.findFacesWrapped(solid).forEach((f, index) => {
      const mids = f.getEdges().map(eg => EdgeOps.getEdgeMidPoint(eg));
      if (mids.every(m => Math.abs(m.z - 30) < 1e-6)) {
        picks.push({ shapeId: solid.id, sub: { type: 'face', index } });
      }
    });
    expect(picks).toHaveLength(1);

    const synthesis = synthesizeApplyFeature(scene, picks, 'fillet', 3);
    expect(synthesis.ok).toBe(true);
    if (synthesis.ok !== true) {
      return;
    }
    expect(synthesis.preview).toBe('fillet(3, e.endFaces())');

    const edited = await applyFeatureEdit(code, synthesis.spec);
    expect(edited.error).toBeUndefined();

    // Executing the edit fillets every edge of the top face (the whole rim).
    const rerun = runFluid(edited.newCode);
    const newSolid = findSolid(rerun) as Solid;
    const cylinders = newSolid.getFaces()
      .filter(f => FaceProps.getProperties(f.getShape()).surfaceType === 'cylinder');
    expect(cylinders.length).toBeGreaterThanOrEqual(4);
  });

  it('fillets one repeat instance through a synthesized scene-wide select()', async () => {
    const code = [
      `import { sketch, rect, extrude, repeat } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(20, 20) })`,
      `const e = extrude(10).new()`,
      `repeat('linear', 'x', { count: 3, offset: 40 }, e)`,
      ``,
    ].join('\n');

    sketch('xy', () => { rect(20, 20) });
    const e = (extrude(10) as any).new();
    (e as unknown as SceneObject).setSourceLocation({ filePath: '/ws/model.fluid.js', line: 4, column: 0 });
    const r = core.repeat('linear', 'x', { count: 3, offset: 40 }, e);
    (r as unknown as SceneObject).setSourceLocation({ filePath: '/ws/model.fluid.js', line: 5, column: 0 });

    const scene = render();
    const solids: Shape[] = [];
    const seen = new Set<string>();
    for (const obj of scene.getAllSceneObjects()) {
      if (obj.isContainer()) {
        continue;
      }
      for (const shape of obj.getShapes()) {
        if (shape.getType() === 'solid' && !seen.has(shape.id)) {
          seen.add(shape.id);
          solids.push(shape);
        }
      }
    }
    expect(solids).toHaveLength(3);

    // The middle instance (x ∈ [40, 60]) is a clone — no variable to bind.
    const middle = solids.find(s => {
      const xs = Explorer.findEdgesWrapped(s).map(eg => EdgeOps.getEdgeMidPoint(eg).x);
      return Math.min(...xs) > 30 && Math.max(...xs) < 70;
    })!;
    expect(middle).toBeDefined();
    const picks = topEdgeRefs(middle, 10);
    expect(picks).toHaveLength(4);

    const synthesis = synthesizeApplyFeature(scene, picks, 'fillet', 2);
    expect(synthesis.ok).toBe(true);
    if (synthesis.ok !== true) {
      return;
    }
    expect(synthesis.preview).toMatch(/^fillet\(2, select\(edge\(\)\./);

    const edited = await applyFeatureEdit(code, synthesis.spec);
    expect(edited.error).toBeUndefined();
    expect(edited.newCode).toContain(`import { edge } from 'fluidcad/filters';`);
    expect(edited.newCode).toContain('fillet(2, select(edge().');
    // The repeat statement is untouched — no variable was bound to a clone.
    expect(edited.newCode).toContain(`repeat('linear', 'x', { count: 3, offset: 40 }, e)`);

    // Execute the edited program: exactly one instance gains fillet
    // cylinders, the other two stay plain boxes.
    const rerun = runFluid(edited.newCode);
    const rerunSolids: Solid[] = [];
    const rerunSeen = new Set<string>();
    for (const obj of rerun.getAllSceneObjects()) {
      if (obj.isContainer()) {
        continue;
      }
      for (const shape of obj.getShapes()) {
        if (shape.getType() === 'solid' && !rerunSeen.has(shape.id)) {
          rerunSeen.add(shape.id);
          rerunSolids.push(shape as Solid);
        }
      }
    }
    expect(rerunSolids).toHaveLength(3);

    const cylinderCounts = rerunSolids.map(s => s.getFaces()
      .filter(f => FaceProps.getProperties(f.getShape()).surfaceType === 'cylinder').length);
    expect(cylinderCounts.filter(c => c >= 4)).toHaveLength(1);
    expect(cylinderCounts.filter(c => c === 0)).toHaveLength(2);
  });

  it('shells the picked top face through synthesized code', async () => {
    const code = [
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    sketch('xy', () => { rect(100, 50) });
    const e = extrude(30);
    (e as unknown as SceneObject).setSourceLocation({ filePath: '/ws/model.fluid.js', line: 4, column: 0 });

    const scene = render();
    const solid = findSolid(scene);
    const picks: PickRef[] = [];
    Explorer.findFacesWrapped(solid).forEach((f, index) => {
      const mids = f.getEdges().map(eg => EdgeOps.getEdgeMidPoint(eg));
      if (mids.every(m => Math.abs(m.z - 30) < 1e-6)) {
        picks.push({ shapeId: solid.id, sub: { type: 'face', index } });
      }
    });
    expect(picks).toHaveLength(1);

    const synthesis = synthesizeApplyFeature(scene, picks, 'shell', -2);
    expect(synthesis.ok).toBe(true);
    if (synthesis.ok !== true) {
      return;
    }
    expect(synthesis.preview).toBe('shell(-2, e.endFaces())');

    const edited = await applyFeatureEdit(code, synthesis.spec);
    expect(edited.error).toBeUndefined();
    expect(edited.newCode).toContain('const e = extrude(30)');
    expect(edited.newCode).toContain('shell(-2, e.endFaces())');

    // Executing the edit hollows the box: material removed, inner walls added.
    const rerun = runFluid(edited.newCode);
    const newSolid = findSolid(rerun) as Solid;
    expect(ShapeProps.getProperties(newSolid.getShape()).volumeMm3).toBeLessThan(100 * 50 * 30);
    expect(newSolid.getFaces().length).toBeGreaterThan(6);
  });

  it('inserts an empty sketch on the picked face and the model still renders green', async () => {
    const code = [
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    sketch('xy', () => { rect(100, 50) });
    const e = extrude(30);
    (e as unknown as SceneObject).setSourceLocation({ filePath: '/ws/model.fluid.js', line: 4, column: 0 });

    const scene = render();
    const solid = findSolid(scene);
    const picks: PickRef[] = [];
    Explorer.findFacesWrapped(solid).forEach((f, index) => {
      const mids = f.getEdges().map(eg => EdgeOps.getEdgeMidPoint(eg));
      if (mids.every(m => Math.abs(m.z - 30) < 1e-6)) {
        picks.push({ shapeId: solid.id, sub: { type: 'face', index } });
      }
    });
    expect(picks).toHaveLength(1);

    // Sketch has no numeric parameter.
    const synthesis = synthesizeApplyFeature(scene, picks, 'sketch');
    expect(synthesis.ok).toBe(true);
    if (synthesis.ok !== true) {
      return;
    }
    expect(synthesis.preview).toBe('sketch(e.endFaces(), () => { ... })');
    expect(synthesis.spec.value).toBeUndefined();

    const edited = await applyFeatureEdit(code, synthesis.spec);
    expect(edited.error).toBeUndefined();
    expect(edited.newCode).toContain([
      `sketch(e.endFaces(), () => {`,
      ``,
      `})`,
    ].join('\n'));

    // The empty sketch must not break the model: no compile error (runFluid
    // would throw) and no feature errors on any scene object.
    const rerun = runFluid(edited.newCode);
    const errors = rerun.getAllSceneObjects()
      .map(o => o.getError())
      .filter(Boolean);
    expect(errors).toEqual([]);
    const newSolid = findSolid(rerun) as Solid;
    expect(ShapeProps.getProperties(newSolid.getShape()).volumeMm3).toBeCloseTo(100 * 50 * 30, 1);
  });

  it('refuses a sketch over more than one face', () => {
    sketch('xy', () => { rect(100, 50) });
    const e = extrude(30);
    (e as unknown as SceneObject).setSourceLocation({ filePath: '/ws/model.fluid.js', line: 4, column: 0 });

    const scene = render();
    const solid = findSolid(scene);
    const picks: PickRef[] = [
      { shapeId: solid.id, sub: { type: 'face', index: 0 } },
      { shapeId: solid.id, sub: { type: 'face', index: 1 } },
    ];

    const synthesis = synthesizeApplyFeature(scene, picks, 'sketch');
    expect(synthesis.ok).toBe(false);
    if (synthesis.ok !== false) {
      return;
    }
    expect(synthesis.reason).toContain('single face');
  });

  it('refuses a sketch on an edge pick', () => {
    sketch('xy', () => { rect(100, 50) });
    const e = extrude(30);
    (e as unknown as SceneObject).setSourceLocation({ filePath: '/ws/model.fluid.js', line: 4, column: 0 });

    const scene = render();
    const solid = findSolid(scene);
    const picks = topEdgeRefs(solid, 30).slice(0, 1);
    expect(picks).toHaveLength(1);

    const synthesis = synthesizeApplyFeature(scene, picks, 'sketch');
    expect(synthesis.ok).toBe(false);
    if (synthesis.ok !== false) {
      return;
    }
    expect(synthesis.reason).toContain('single face');
  });

  it('re-picks a shell face against the pre-shell world and re-executes', async () => {
    const code = [
      `import { sketch, rect, extrude, shell } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `const e = extrude(30)`,
      `shell(-2, e.endFaces())`,
      ``,
    ].join('\n');

    sketch('xy', () => { rect(100, 50) });
    const e = extrude(30);
    (e as unknown as SceneObject).setSourceLocation({ filePath: '/ws/model.fluid.js', line: 4, column: 0 });
    const sh = core.shell(-2, (e as any).endFaces());
    (sh as unknown as SceneObject).setSourceLocation({ filePath: '/ws/model.fluid.js', line: 5, column: 0 });

    const scene = render();
    const shellIndex = scene.getAllSceneObjects().findIndex(o => o.getType() === 'shell');
    expect(shellIndex).toBeGreaterThan(0);

    // The box solid pre-shell — removed by the shell in the full render, but
    // its owner object still holds it, exactly what a rollback displays.
    const box = scene.getAllSceneObjects()
      .find(o => o.getType() === 'extrude')!
      .getAddedShapes()
      .find(s => s.getType() === 'solid')!;
    expect(box).toBeDefined();

    // Re-pick: open a SIDE face instead of the top (all edge mids at y = 0).
    const picks: PickRef[] = [];
    Explorer.findFacesWrapped(box).forEach((f, index) => {
      const mids = f.getEdges().map(eg => EdgeOps.getEdgeMidPoint(eg));
      if (mids.every(m => Math.abs(m.y) < 1e-6)) {
        picks.push({ shapeId: box.id, sub: { type: 'face', index } });
      }
    });
    expect(picks).toHaveLength(1);

    // Synthesis runs against the scene truncated to before the shell — the
    // world the shell's arguments see at build time.
    const synthesis = synthesizeApplyFeature(scopedSceneBefore(scene, shellIndex), picks, 'shell', -3);
    expect(synthesis.ok).toBe(true);
    if (synthesis.ok !== true) {
      return;
    }

    const spec: ApplyFeatureEditSpec = {
      feature: 'shell',
      value: -3,
      filePath: '/ws/model.fluid.js',
      producers: synthesis.spec.producers,
      parts: synthesis.spec.parts,
      imports: synthesis.spec.imports,
      edit: { line: 5, column: 0, expectedStatement: 'shell(-2, e.endFaces())' },
    };
    const edited = await applyFeatureEdit(code, spec);
    expect(edited.error).toBeUndefined();
    expect(edited.newCode).not.toContain('endFaces');
    expect(edited.newCode).toMatch(/shell\(-3, e\./);

    // Executing the edit hollows through the side: material removed, no errors.
    const rerun = runFluid(edited.newCode);
    const errors = rerun.getAllSceneObjects().map(o => o.getError()).filter(Boolean);
    expect(errors).toEqual([]);
    const newSolid = findSolid(rerun) as Solid;
    expect(ShapeProps.getProperties(newSolid.getShape()).volumeMm3).toBeLessThan(100 * 50 * 30);
  });

  it('chamfers a picked subset through synthesized bucket indices', async () => {
    const code = [
      `import { sketch, rect, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { rect(100, 50) })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    sketch('xy', () => { rect(100, 50) });
    const e = extrude(30);
    (e as unknown as SceneObject).setSourceLocation({ filePath: '/ws/model.fluid.js', line: 4, column: 0 });

    const scene = render();
    const solid = findSolid(scene);
    const picks = topEdgeRefs(solid, 30).slice(0, 2);
    expect(picks).toHaveLength(2);

    const synthesis = synthesizeApplyFeature(scene, picks, 'chamfer', 2);
    expect(synthesis.ok).toBe(true);
    if (synthesis.ok !== true) {
      return;
    }
    expect(synthesis.spec.parts[0].indices).toHaveLength(2);

    const edited = await applyFeatureEdit(code, synthesis.spec);
    expect(edited.error).toBeUndefined();

    const rerun = runFluid(edited.newCode);
    const newSolid = findSolid(rerun) as Solid;
    // Two chamfered edges shave off two 45° wedges: 2 · (½·2·2·edgeLength).
    // Face count grows by exactly the two bevel faces.
    expect(newSolid.getFaces().length).toBe(8);
  });
});
