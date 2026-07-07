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
import type { PickRef } from '../../lib/selection/types.js';
import { applyFeatureEdit } from '../src/apply-feature-edit.ts';

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
