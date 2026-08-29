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
import { line } from '../../lib/core/2d/index.js';
import { Scene } from '../../lib/rendering/scene.js';
import { SceneObject } from '../../lib/common/scene-object.js';
import { Shape } from '../../lib/common/shape.js';
import { Edge } from '../../lib/common/edge.js';
import { Solid } from '../../lib/common/solid.js';
import { PlaneObjectBase } from '../../lib/features/plane-renderable-base.js';
import { Explorer } from '../../lib/oc/explorer.js';
import { EdgeOps } from '../../lib/oc/edge-ops.js';
import { FaceProps } from '../../lib/oc/face-props.js';
import { ShapeOps } from '../../lib/oc/shape-ops.js';
import { ShapeProps } from '../../lib/oc/props.js';
import { synthesizeApplyFeature } from '../../lib/selection/explain.js';
import { synthesizeSketchApplyFeature } from '../../lib/selection/sketch-apply.js';
import { scopedSceneBefore } from '../../lib/selection/types.js';
import type { PickRef } from '../../lib/selection/types.js';
import { applyFeatureEdit, makeProducerBindable, makeProducerNamer, type ApplyFeatureEditSpec } from '../src/apply-feature-edit.ts';

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

/** Solved-model stand-in for the legacy `rect(w, h)` fixture: four exact lines. */
function drawRect(w: number, h: number, x = 0, y = 0): void {
  line([x, y], [x + w, y]);
  line([x + w, y], [x + w, y + h]);
  line([x + w, y + h], [x, y + h]);
  line([x, y + h], [x, y]);
}

/** The same four-line body as source text, for the code-string fixtures. */
function rectBodySrc(w: number, h: number, x = 0, y = 0): string {
  const n = (v: number) => String(Math.round(v * 1000) / 1000);
  return `line([${n(x)}, ${n(y)}], [${n(x + w)}, ${n(y)}]); `
    + `line([${n(x + w)}, ${n(y)}], [${n(x + w)}, ${n(y + h)}]); `
    + `line([${n(x + w)}, ${n(y + h)}], [${n(x)}, ${n(y + h)}]); `
    + `line([${n(x)}, ${n(y + h)}], [${n(x)}, ${n(y)}])`;
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
      `import { sketch, line, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ${rectBodySrc(100, 50)} })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    // Build the same model in-process and stamp the extrude with the line it
    // occupies in `code`, as the live-render stack capture would.
    sketch('xy', () => { drawRect(100, 50) });
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
      `import { sketch, line, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ${rectBodySrc(100, 50)} })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    sketch('xy', () => { drawRect(100, 50) });
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

  it('shells a filleted extrude through a plane-reference selector', async () => {
    const code = [
      `import { sketch, line, extrude, fillet } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ${rectBodySrc(123.28, 56.07, -123.28 / 2, -56.07 / 2)} })`,
      `const e = extrude(25)`,
      `fillet(10, e.sideEdges())`,
      ``,
    ].join('\n');

    sketch('xy', () => { drawRect(123.28, 56.07, -123.28 / 2, -56.07 / 2) });
    const e = extrude(25);
    (e as unknown as SceneObject).setSourceLocation({ filePath: '/ws/model.fluid.js', line: 4, column: 0 });
    const f = core.fillet(10, (e as any).sideEdges());
    (f as unknown as SceneObject).setSourceLocation({ filePath: '/ws/model.fluid.js', line: 5, column: 0 });

    const scene = render();
    const solid = findSolid(scene);
    // The fillet reshaped the top face (rounded corners): it belongs to no
    // bucket, so synthesis goes scene-wide — but it must name the plane
    // through the extrude's end face, not bake `onPlane('xy', 25)` in.
    const picks: PickRef[] = [];
    Explorer.findFacesWrapped(solid).forEach((fc, index) => {
      const mids = fc.getEdges().map(eg => EdgeOps.getEdgeMidPoint(eg));
      if (mids.every(m => Math.abs(m.z - 25) < 1e-6)) {
        picks.push({ shapeId: solid.id, sub: { type: 'face', index } });
      }
    });
    expect(picks).toHaveLength(1);

    const synthesis = synthesizeApplyFeature(scene, picks, 'shell', -2);
    expect(synthesis.ok).toBe(true);
    if (synthesis.ok !== true) {
      return;
    }
    expect(synthesis.preview).toBe('shell(-2, select(face().onPlane(e.endFaces())))');

    const edited = await applyFeatureEdit(code, synthesis.spec);
    expect(edited.error).toBeUndefined();
    expect(edited.newCode).toContain(`import { face } from 'fluidcad/filters';`);
    expect(edited.newCode).toMatch(/import \{[^}]*\bselect\b[^}]*\} from 'fluidcad\/core'/);
    expect(edited.newCode).toContain('shell(-2, select(face().onPlane(e.endFaces())))');

    // Execute the edited program: the top opens and the solid hollows out.
    const rerun = runFluid(edited.newCode);
    const newSolid = findSolid(rerun) as Solid;
    expect(ShapeProps.getProperties(newSolid.getShape()).volumeMm3)
      .toBeLessThan(ShapeProps.getProperties((solid as Solid).getShape()).volumeMm3 * 0.5);
  });

  it('fillets one repeat instance through a synthesized scene-wide select()', async () => {
    const code = [
      `import { sketch, line, extrude, repeat } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ${rectBodySrc(20, 20)} })`,
      `const e = extrude(10).new()`,
      `repeat('linear', 'x', { count: 3, offset: 40 }, e)`,
      ``,
    ].join('\n');

    sketch('xy', () => { drawRect(20, 20) });
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
      `import { sketch, line, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ${rectBodySrc(100, 50)} })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    sketch('xy', () => { drawRect(100, 50) });
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

  it('offsets the picked top face outline through synthesized code', async () => {
    const code = [
      `import { sketch, line, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ${rectBodySrc(100, 50)} })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    sketch('xy', () => { drawRect(100, 50) });
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

    const synthesis = synthesizeApplyFeature(scene, picks, 'offset', 5);
    expect(synthesis.ok).toBe(true);
    if (synthesis.ok !== true) {
      return;
    }
    expect(synthesis.preview).toBe('offset(5, e.endFaces())');

    const edited = await applyFeatureEdit(code, synthesis.spec);
    expect(edited.error).toBeUndefined();
    expect(edited.newCode).toContain('const e = extrude(30)');
    expect(edited.newCode).toContain('offset(5, e.endFaces())');

    // Executing the edit traces the top outline 5 outside the face, on the
    // face plane (z = 30): the rect grows from 100×50 to 110×60.
    const rerun = runFluid(edited.newCode);
    const off = rerun.getAllSceneObjects().find(o => o.getType() === 'offset');
    expect(off).toBeDefined();
    expect(off!.getError?.()).toBeFalsy();
    const edges = off!.getShapes().filter((s): s is Edge => s instanceof Edge);
    expect(edges.length).toBeGreaterThan(0);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const edge of edges) {
      const b = ShapeOps.getBoundingBox(edge.getShape());
      minX = Math.min(minX, b.minX);
      maxX = Math.max(maxX, b.maxX);
      minZ = Math.min(minZ, b.minZ);
      maxZ = Math.max(maxZ, b.maxZ);
    }
    // BRepBndLib folds edge tolerances into the box (~0.1 per side on
    // MakeOffset output) — assert within ±0.5.
    expect(maxX - minX).toBeCloseTo(110, 0);
    expect(minZ).toBeCloseTo(30, 0);
    expect(maxZ).toBeCloseTo(30, 0);
  });

  it('re-picks an offset face against the pre-offset world and re-executes', async () => {
    const code = [
      `import { sketch, line, extrude, offset } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ${rectBodySrc(100, 50)} })`,
      `const e = extrude(30)`,
      `offset(-5, e.endFaces())`,
      ``,
    ].join('\n');

    sketch('xy', () => { drawRect(100, 50) });
    const e = extrude(30);
    (e as unknown as SceneObject).setSourceLocation({ filePath: '/ws/model.fluid.js', line: 4, column: 0 });
    const off = core.offset(-5, (e as any).endFaces());
    (off as unknown as SceneObject).setSourceLocation({ filePath: '/ws/model.fluid.js', line: 5, column: 0 });

    const scene = render();
    const offsetIndex = scene.getAllSceneObjects().findIndex(o => o.getType() === 'offset');
    expect(offsetIndex).toBeGreaterThan(0);
    const box = scene.getAllSceneObjects()
      .find(o => o.getType() === 'extrude')!
      .getAddedShapes()
      .find(s => s.getType() === 'solid')!;

    // Re-pick: the START face (all edge mids at z = 0) instead of the top.
    const picks: PickRef[] = [];
    Explorer.findFacesWrapped(box).forEach((f, index) => {
      const mids = f.getEdges().map(eg => EdgeOps.getEdgeMidPoint(eg));
      if (mids.every(m => Math.abs(m.z) < 1e-6)) {
        picks.push({ shapeId: box.id, sub: { type: 'face', index } });
      }
    });
    expect(picks).toHaveLength(1);

    const synthesis = synthesizeApplyFeature(
      scopedSceneBefore(scene, offsetIndex), picks, 'offset', -5,
    );
    expect(synthesis.ok).toBe(true);
    if (synthesis.ok !== true) {
      return;
    }

    const spec: ApplyFeatureEditSpec = {
      feature: 'offset',
      value: -5,
      filePath: '/ws/model.fluid.js',
      producers: synthesis.spec.producers,
      parts: synthesis.spec.parts,
      imports: synthesis.spec.imports,
      offset: { close: false },
      edit: { line: 5, column: 0, expectedStatement: 'offset(-5, e.endFaces())' },
    };
    const edited = await applyFeatureEdit(code, spec);
    expect(edited.error).toBeUndefined();
    expect(edited.newCode).not.toContain('endFaces');
    expect(edited.newCode).toMatch(/offset\(-5, e\.startFaces\(\)\)/);

    // Executing the edit moves the outline to the bottom plane (z = 0).
    const rerun = runFluid(edited.newCode);
    const errors = rerun.getAllSceneObjects().map(o => o.getError()).filter(Boolean);
    expect(errors).toEqual([]);
    const newOffset = rerun.getAllSceneObjects().find(o => o.getType() === 'offset')!;
    const edges = newOffset.getShapes().filter((s): s is Edge => s instanceof Edge);
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) {
      const b = ShapeOps.getBoundingBox(edge.getShape());
      expect(Math.abs(b.minZ)).toBeLessThan(0.5);
      expect(Math.abs(b.maxZ)).toBeLessThan(0.5);
    }
  });

  it('extrudes a bound face-offset profile through the offset callee guard', async () => {
    const code = [
      `import { sketch, line, extrude, offset } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ${rectBodySrc(100, 50)} })`,
      `const e = extrude(30)`,
      `offset(-5, e.endFaces())`,
      ``,
    ].join('\n');

    // The extrude create spec the route builds for an offset profile: one
    // bound producer under the 'offset' callee guard, no selector parts.
    const spec: ApplyFeatureEditSpec = {
      feature: 'extrude',
      extrude: {
        op: 'new', distance: 10, distance2: null, symmetric: false,
        draft: null, endOffset: null, drill: true, thin: null, profile: 'bound',
      },
      filePath: '/ws/model.fluid.js',
      producers: [{ line: 5, column: 0, featureType: 'offset', nameHint: 'o', bind: true }],
      parts: [],
      imports: [],
    };
    const edited = await applyFeatureEdit(code, spec);
    expect(edited.error).toBeUndefined();
    expect(edited.newCode).toContain('const o = offset(-5, e.endFaces())');
    expect(edited.newCode).toContain('extrude(10, o).new()');

    // Executing the edit builds the rim solid on the top plane.
    const rerun = runFluid(edited.newCode);
    const errors = rerun.getAllSceneObjects().map(o => o.getError()).filter(Boolean);
    expect(errors).toEqual([]);
    const rim = rerun.getAllSceneObjects()
      .filter(o => o.getType() === 'extrude')
      .flatMap(o => o.getShapes())
      .filter(s => s.getType() === 'solid')
      .map(s => ShapeOps.getBoundingBox(s))
      .find(b => b.maxZ > 35);
    expect(rim).toBeDefined();
    expect(rim!.minZ).toBeCloseTo(30, 0);
    expect(rim!.maxZ).toBeCloseTo(40, 0);
  });

  it('refuses an offset over edge picks', () => {
    sketch('xy', () => { drawRect(100, 50) });
    const e = extrude(30);
    (e as unknown as SceneObject).setSourceLocation({ filePath: '/ws/model.fluid.js', line: 4, column: 0 });

    const scene = render();
    const solid = findSolid(scene);
    const picks = topEdgeRefs(solid, 30);
    expect(picks.length).toBeGreaterThan(0);

    const synthesis = synthesizeApplyFeature(scene, picks, 'offset', 5);
    expect(synthesis.ok).toBe(false);
    if (synthesis.ok !== false) {
      return;
    }
    expect(synthesis.reason).toContain('faces');
  });

  it('inserts an empty sketch on the picked face and the model still renders green', async () => {
    const code = [
      `import { sketch, line, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ${rectBodySrc(100, 50)} })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    sketch('xy', () => { drawRect(100, 50) });
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
    sketch('xy', () => { drawRect(100, 50) });
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
    sketch('xy', () => { drawRect(100, 50) });
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
      `import { sketch, line, extrude, shell } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ${rectBodySrc(100, 50)} })`,
      `const e = extrude(30)`,
      `shell(-2, e.endFaces())`,
      ``,
    ].join('\n');

    sketch('xy', () => { drawRect(100, 50) });
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
      `import { sketch, line, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ${rectBodySrc(100, 50)} })`,
      `extrude(30)`,
      ``,
    ].join('\n');

    sketch('xy', () => { drawRect(100, 50) });
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

  /** Distinct non-container solids of a scene (repeat clones included). */
  function distinctSolids(scene: Scene): Shape[] {
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
    return solids;
  }

  it('repeats a picked feature across two directions through the array forms', async () => {
    const code = [
      `import { sketch, line, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ${rectBodySrc(20, 20)} })`,
      `extrude(10).new()`,
      ``,
    ].join('\n');

    sketch('xy', () => { drawRect(20, 20) });
    const e = (extrude(10) as any).new();
    (e as unknown as SceneObject).setSourceLocation({ filePath: '/ws/model.fluid.js', line: 4, column: 0 });
    render();

    const spec: ApplyFeatureEditSpec = {
      feature: 'repeat',
      repeat: {
        kind: 'linear',
        spacingMode: 'offset',
        directions: [
          { axis: { kind: 'standard', axis: 'x' }, count: 3, value: 40 },
          { axis: { kind: 'standard', axis: 'y' }, count: 2, value: 30 },
        ],
        targets: [{ producer: 0 }],
      },
      filePath: '/ws/model.fluid.js',
      producers: [{ line: 4, column: 0, featureType: 'feature', nameHint: 'f', bind: true }],
      parts: [],
      imports: [],
    };
    const edited = await applyFeatureEdit(code, spec);
    expect(edited.error).toBeUndefined();
    expect(edited.newCode).toContain(
      `repeat('linear', ['x', 'y'], { count: [3, 2], offset: [40, 30] }, f)`,
    );

    // A 3x2 grid: the original plus five clones.
    const rerun = runFluid(edited.newCode);
    expect(distinctSolids(rerun)).toHaveLength(6);
  });

  it('repeats a picked feature linearly through the dialog spec', async () => {
    const code = [
      `import { sketch, line, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ${rectBodySrc(20, 20)} })`,
      `extrude(10).new()`,
      ``,
    ].join('\n');

    sketch('xy', () => { drawRect(20, 20) });
    const e = (extrude(10) as any).new();
    (e as unknown as SceneObject).setSourceLocation({ filePath: '/ws/model.fluid.js', line: 4, column: 0 });
    render();

    const spec: ApplyFeatureEditSpec = {
      feature: 'repeat',
      repeat: {
        kind: 'linear',
        spacingMode: 'offset',
        directions: [{ axis: { kind: 'standard', axis: 'x' }, count: 3, value: 40 }],
        targets: [{ producer: 0 }],
      },
      filePath: '/ws/model.fluid.js',
      producers: [{ line: 4, column: 0, featureType: 'feature', nameHint: 'f', bind: true }],
      parts: [],
      imports: [],
    };
    const edited = await applyFeatureEdit(code, spec);
    expect(edited.error).toBeUndefined();
    expect(edited.newCode).toContain('const f = extrude(10).new()');
    expect(edited.newCode).toContain(`repeat('linear', 'x', { count: 3, offset: 40 }, f)`);

    const rerun = runFluid(edited.newCode);
    expect(distinctSolids(rerun)).toHaveLength(3);
  });

  it('mirrors a picked feature across its own picked face through plane(<selector>)', async () => {
    const code = [
      `import { sketch, line, extrude } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ${rectBodySrc(20, 20)} })`,
      `extrude(10).new()`,
      ``,
    ].join('\n');

    sketch('xy', () => { drawRect(20, 20) });
    const e = (extrude(10) as any).new();
    (e as unknown as SceneObject).setSourceLocation({ filePath: '/ws/model.fluid.js', line: 4, column: 0 });
    const scene = render();
    const solid = findSolid(scene);

    // Pick the side face normal to X with the largest x (every edge midpoint
    // shares that x).
    let pick: PickRef | null = null;
    let bestX = -Infinity;
    Explorer.findFacesWrapped(solid).forEach((f, index) => {
      const xs = f.getEdges().map(eg => EdgeOps.getEdgeMidPoint(eg).x);
      const flat = xs.every(x => Math.abs(x - xs[0]) < 1e-6);
      if (flat && xs[0] > bestX) {
        bestX = xs[0];
        pick = { shapeId: solid.id, sub: { type: 'face', index } };
      }
    });
    expect(pick).not.toBeNull();

    // The route's shape: one synthesis call for the mirror face ('plane'
    // kind), its producers merged with the target by call site.
    const synthesis = synthesizeApplyFeature(scene, [pick!], 'plane', undefined);
    expect(synthesis.ok).toBe(true);
    if (synthesis.ok !== true) {
      return;
    }
    const producers: ApplyFeatureEditSpec['producers'] = [
      { line: 4, column: 0, featureType: 'feature', nameHint: 'f', bind: true },
    ];
    const remap = synthesis.spec.producers.map(p => {
      const existing = producers.findIndex(q => q.line === p.line && q.column === p.column);
      if (existing >= 0) {
        return existing;
      }
      producers.push(p);
      return producers.length - 1;
    });
    const parts = synthesis.spec.parts.map(p => ({
      ...p, producer: p.producer === null ? null : remap[p.producer],
    }));
    const spec: ApplyFeatureEditSpec = {
      feature: 'repeat',
      repeat: {
        kind: 'mirror',
        plane: { kind: 'selector', part: 0 },
        targets: [{ producer: 0 }],
      },
      filePath: '/ws/model.fluid.js',
      producers,
      parts,
      imports: [...synthesis.spec.imports, 'plane'],
    };
    const edited = await applyFeatureEdit(code, spec);
    expect(edited.error).toBeUndefined();
    expect(edited.newCode).toContain('const f = extrude(10).new()');
    expect(edited.newCode).toContain(`repeat('mirror', plane(f.`);

    // Executing the edit replays the extrude mirrored across the face.
    const rerun = runFluid(edited.newCode);
    expect(distinctSolids(rerun)).toHaveLength(2);
  });

  it('edits an existing repeat statement in place and re-executes', async () => {
    const code = [
      `import { sketch, line, extrude, repeat } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ${rectBodySrc(20, 20)} })`,
      `const f = extrude(10).new()`,
      `repeat('linear', 'x', { count: 3, offset: 40 }, f)`,
      ``,
    ].join('\n');

    // The double-click → dialog round trip: count and spacing change, the
    // axis and target stay the statement's own expressions.
    const spec: ApplyFeatureEditSpec = {
      feature: 'repeat',
      filePath: '/ws/model.fluid.js',
      producers: [],
      parts: [],
      imports: [],
      edit: {
        line: 5, column: 0,
        expectedStatement: `repeat('linear', 'x', { count: 3, offset: 40 }, f)`,
        repeat: {
          kind: 'linear',
          spacingMode: 'offset',
          directions: [{ axis: { kind: 'keep', sourceIndex: 0 }, count: 4, value: 30 }],
        },
      },
    };
    const edited = await applyFeatureEdit(code, spec);
    expect(edited.error).toBeUndefined();
    expect(edited.newCode).toContain(`repeat('linear', 'x', { count: 4, offset: 30 }, f)`);

    const rerun = runFluid(edited.newCode);
    expect(distinctSolids(rerun)).toHaveLength(4);
  });

  /**
   * The plane a rerun's LAST plane statement produced. Every sketch registers
   * its own implicit plane and a mid plane registers its bases, so the
   * statement's result is the last plane in scene order.
   */
  function lastPlane(scene: Scene): PlaneObjectBase {
    const planes = scene.getAllSceneObjects()
      .filter((o): o is PlaneObjectBase => o instanceof PlaneObjectBase);
    expect(planes.length).toBeGreaterThanOrEqual(1);
    return planes[planes.length - 1];
  }

  it('edits an existing plane statement in place and re-executes', async () => {
    const code = [
      `import { sketch, line, extrude, plane } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ${rectBodySrc(20, 20)} })`,
      `extrude(10)`,
      `plane('xy', 30)`,
      ``,
    ].join('\n');

    // The double-click → dialog round trip: the offset changes, the base
    // stays the statement's own expression.
    const spec: ApplyFeatureEditSpec = {
      feature: 'plane',
      filePath: '/ws/model.fluid.js',
      producers: [],
      parts: [],
      imports: [],
      edit: {
        line: 5, column: 0,
        expectedStatement: `plane('xy', 30)`,
        plane: {
          type: 'offset', offset: 45, rotateX: null, rotateY: null, rotateZ: null, position: null,
        },
      },
    };
    const edited = await applyFeatureEdit(code, spec);
    expect(edited.error).toBeUndefined();
    expect(edited.newCode).toContain(`plane('xy', 45)`);

    const rerun = runFluid(edited.newCode);
    expect(lastPlane(rerun).getPlane().origin.z).toBeCloseTo(45);
  });

  it('lifts a kept face selector into plane() when the edit makes it a mid plane', async () => {
    const code = [
      `import { sketch, line, extrude, plane } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => { ${rectBodySrc(20, 20)} })`,
      `const e = extrude(10)`,
      `plane(e.endFaces(), 4)`,
      ``,
    ].join('\n');

    // The type dropdown moves to Mid plane and an origin plane joins as the
    // second base; the picked face rides along as the statement's own text,
    // which a mid plane needs lifted into a plane-like.
    const spec: ApplyFeatureEditSpec = {
      feature: 'plane',
      filePath: '/ws/model.fluid.js',
      producers: [],
      parts: [],
      imports: [],
      edit: {
        line: 5, column: 0,
        expectedStatement: `plane(e.endFaces(), 4)`,
        plane: {
          type: 'mid', offset: null, rotateX: null, rotateY: null, rotateZ: null, position: null,
          bases: [{ kind: 'verbatim', sourceIndex: 0 }, { kind: 'standard', plane: 'xy' }],
        },
      },
    };
    const edited = await applyFeatureEdit(code, spec);
    expect(edited.error).toBeUndefined();
    expect(edited.newCode).toContain(`plane(plane(e.endFaces()), 'xy')`);

    // Executing it: the mid plane sits halfway between the extrude's top face
    // (z = 10) and the XY origin plane.
    const rerun = runFluid(edited.newCode);
    expect(lastPlane(rerun).getPlane().origin.z).toBeCloseTo(5);
  });
  /** Every distinct non-meta edge in the scene — a sketch's rendered geometry. */
  function sketchEdgeIds(scene: Scene): Set<string> {
    const ids = new Set<string>();
    for (const obj of scene.getAllSceneObjects()) {
      for (const shape of obj.getShapes()) {
        if (shape instanceof Edge && !shape.isMetaShape() && !shape.isGuideShape()) {
          ids.add(shape.id);
        }
      }
    }
    return ids;
  }

  it('offsets picked sketch edges, capping the open ends through .close()', async () => {
    const code = [
      `import { sketch, line, offset } from 'fluidcad/core'`,
      ``,
      `sketch('xy', () => {`,
      `  line([0, 0], [40, 0])`,
      `  line([40, 0], [40, 20])`,
      `})`,
      ``,
    ].join('\n');

    // The same open profile in-process, its statements stamped with the lines
    // they occupy in `code` — what the live-render stack capture records.
    let h: SceneObject;
    let v: SceneObject;
    sketch('xy', () => {
      h = core.line([0, 0], [40, 0]) as unknown as SceneObject;
      v = core.line([40, 0], [40, 20]) as unknown as SceneObject;
    });
    h!.setSourceLocation({ filePath: '/ws/model.fluid.js', line: 4, column: 2 });
    v!.setSourceLocation({ filePath: '/ws/model.fluid.js', line: 5, column: 2 });
    const scene = render();

    const picks = [h!, v!]
      .flatMap(o => o.getShapes().filter((s): s is Edge => s instanceof Edge))
      .map(edge => ({ shapeId: edge.id }));

    // The dialog with "Close ends" checked.
    const synthesis = synthesizeSketchApplyFeature(
      scene, picks, 'offset', 3, { offset: { close: true } },
    );
    expect(synthesis.ok).toBe(true);
    if (!synthesis.ok) {
      return;
    }
    expect(synthesis.preview).toBe(`offset(3, ${synthesis.args}).close()`);

    const edited = await applyFeatureEdit(code, synthesis.spec);
    expect(edited.error).toBeUndefined();
    expect(edited.newCode).toContain(`.close()`);

    // Two source edges, two offset edges, and the two caps joining them.
    const closed = runFluid(edited.newCode);
    expect(sketchEdgeIds(closed).size).toBe(6);

    // The same statement edited back to the plain form: the caps go away.
    const reopened = await applyFeatureEdit(edited.newCode, {
      feature: 'offset',
      value: 3,
      offset: { close: false },
      filePath: '/ws/model.fluid.js',
      producers: [],
      parts: [],
      imports: [],
      edit: { line: 6, column: 2 },
    });
    expect(reopened.error).toBeUndefined();
    expect(reopened.newCode).not.toContain(`.close()`);
    expect(sketchEdgeIds(runFluid(reopened.newCode)).size).toBe(4);
  });

});

describe('cross-part sketch on a face whose producer variable is reassigned', () => {
  setupOC();

  // `let body; body = extrude(30); body = shell(-2, …)` — the transform
  // refuses to reference the extrude ('body' is reassigned after it), so the
  // file-coupled bindable probe must steer the exposure's selector to the
  // constant datum form, and the foreign sketch then lands in the active
  // part referencing it. This is the whole route flow minus HTTP.
  it('publishes the rim through a constant-plane exposure and sketches on it', async () => {
    const code = [
      `import { extrude, line, part, shell, sketch } from "fluidcad/core";`,
      ``,
      `export const boxBody = part("Box Body", () => {`,
      `    sketch("top", () => {`,
      `        ${rectBodySrc(100, 60, -50, -30)}`,
      `    });`,
      ``,
      `    let body;`,
      ``,
      `    body = extrude(30)`,
      ``,
      `    body = shell(-2, body.endFaces())`,
      `});`,
      ``,
      `export const boxLid = part("Box Lid", () => {`,
      ``,
      `});`,
      ``,
    ].join('\n');

    getSceneManager()!.startScene();
    const bodyPart = core.part('Box Body', () => {
      sketch('top', () => { drawRect(100, 60, -50, -30); });
      const e = extrude(30);
      (e as unknown as SceneObject).setSourceLocation({ filePath: '/ws/model.fluid.js', line: 10, column: 4 });
      const sh = core.shell(-2, (e as any).endFaces());
      (sh as unknown as SceneObject).setSourceLocation({ filePath: '/ws/model.fluid.js', line: 12, column: 4 });
    });
    (bodyPart as unknown as SceneObject).setSourceLocation({ filePath: '/ws/model.fluid.js', line: 3, column: 23 });

    const scene = render();
    const solid = findSolid(scene);
    // The rim: the only planar face whose edges all sit at z = 30.
    const picks: PickRef[] = [];
    Explorer.findFacesWrapped(solid).forEach((f, index) => {
      const mids = f.getEdges().map(eg => EdgeOps.getEdgeMidPoint(eg));
      if (mids.length > 0 && mids.every(m => Math.abs(m.z - 30) < 1e-6)) {
        picks.push({ shapeId: solid.id, sub: { type: 'face', index } });
      }
    });
    expect(picks).toHaveLength(1);

    // The file-coupled options the route builds (synthesisOptionsForFile).
    const namer = await makeProducerNamer(code);
    const bindable = await makeProducerBindable(code);
    const synthesis = synthesizeApplyFeature(scene, picks, 'expose', 'lidSeat', [], { namer, bindable });
    expect(synthesis.ok).toBe(true);
    if (synthesis.ok !== true) {
      return;
    }
    // No plane reference to the unbindable extrude — a constant datum plane,
    // binding no variable at all.
    expect(synthesis.preview).toBe("expose('lidSeat', select(face().onPlane('xy', 30)))");
    expect(synthesis.spec.producers.filter(p => p.bind)).toHaveLength(0);
    expect(synthesis.spec.expose?.part).toEqual({ line: 3, column: 23 });

    // The foreign-sketch spec the route composes for a same-file donor.
    const edited = await applyFeatureEdit(code, {
      feature: 'sketch',
      filePath: '/ws/model.fluid.js',
      producers: [],
      parts: [],
      imports: [],
      activePart: { line: 15, column: 22 },
      sketchForeign: {
        exposeName: 'lidSeat',
        donor: { line: 3, column: 23 },
        create: synthesis.spec,
      },
    });
    expect(edited.error).toBeUndefined();
    const lines = edited.newCode.split('\n');
    const exposeRow = lines.findIndex(l => l.includes("expose('lidSeat', select(face().onPlane('xy', 30)))"));
    const lidRow = lines.findIndex(l => l.includes('part("Box Lid"'));
    const sketchRow = lines.findIndex(l => l.includes('sketch(boxBody.features.lidSeat, () => {'));
    expect(exposeRow).toBeGreaterThan(-1);
    expect(exposeRow).toBeLessThan(lidRow);
    expect(sketchRow).toBeGreaterThan(lidRow);

    // Execute the edited program: the exposure must resolve the rim and the
    // lid's foreign sketch must build on it.
    getSceneManager()!.startScene();
    const globals: Record<string, unknown> = { ...core, ...filters, ...math };
    const names = Object.keys(globals);
    const src = edited.newCode.replace(IMPORT_LINE_RE, '').replace(/^export /gm, '');
    const fn = new Function(...names, `"use strict";\n${src}\nreturn { boxBody, boxLid };`);
    const handles = fn(...names.map(n => globals[n])) as { boxBody: any; boxLid: any };
    expect(handles.boxBody.features.lidSeat).toBeDefined();
    handles.boxLid.materialize();
    const rerun = render();
    for (const obj of rerun.getAllSceneObjects()) {
      expect(obj.getError?.() ?? null).toBeNull();
    }
  });
});
