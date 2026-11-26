import { describe, expect, it, vi } from 'vitest';

// A wire source is what a sweep path, a loft guide or a from-edge plane
// takes whole: a sketch, or a curve object. Which rows are curve objects is
// asked of what they hold — nothing but edges and wires — never of their
// type, so a helix, a copy of one and a curve tool's result are all taken
// without being listed anywhere.

import { holdsSurface, isCurveObject, modelShapeIdsOf } from '../src/helpers/scene-utils';
import {
  collectWireSources, isSingleEdgeWire, labelWithSketchNames, resolveCurveObjectByShapeId, resolveWireByShapeId,
  resolveWireRow, sketchWireShapeIds,
} from '../src/interactive/create-feature/sketch-profiles';
import type { SceneObjectPart, SceneObjectRender, ShapeType } from '../src/types';

const FILE = '/ws/m.fluid.js';
const MESH = [{ vertices: [0, 0, 0, 1, 0, 0], normals: [], indices: [0, 1] }];

function shape(shapeId: string, shapeType: ShapeType, extra: Partial<SceneObjectPart> = {}): SceneObjectPart {
  return { shapeId, shapeType, meshes: MESH, ...extra };
}

function row(r: Partial<SceneObjectRender> & { id: string }, line: number): SceneObjectRender {
  return { sourceLocation: { filePath: FILE, line, column: 0 }, sceneShapes: [], ownShapes: [], ...r };
}

const SKETCH = row({ id: 'sk', type: 'sketch', name: 'Sketch 1', isContainer: true }, 2);
// Geometry inside a sketch: an offset drawn there rides its sketch.
const CIRCLE = row({ id: 'ci', type: 'offset', parentId: 'sk', sceneShapes: [shape('circle-wire', 'edge')] }, 3);
const BLOCK = row({ id: 'bl', type: 'extrude', name: 'Extrude 1', sceneShapes: [shape('block', 'solid')] }, 5);
const HELIX = row({ id: 'hx', type: 'helix', name: 'Helix 1', sceneShapes: [shape('coil', 'edge')] }, 6);
// A curve of several edges that is no helix: a copy of a curve keeps being one.
const RAIL = row({ id: 'ra', type: 'copy-linear', name: 'Copy 1', sceneShapes: [shape('rail', 'wire')] }, 7);
const RAIL_CLONE = row({ id: 'rc', type: 'copy-linear', name: 'Copy 1', sceneShapes: [shape('rail-2', 'wire')] }, 7);
const PATCH = row({ id: 'pa', type: 'loft', name: 'Loft 1', sceneShapes: [shape('patch', 'surface')] }, 8);
const PICKED = row({ id: 'se', type: 'select', sceneShapes: [shape('coil', 'edge')] }, 9);
const AXIS = row({ id: 'ax', type: 'axis', name: 'Axis 1', sceneShapes: [shape('axis-line', 'edge', { isMetaShape: true })] }, 10);
const MIXED = row({ id: 'mx', type: 'mirror', name: 'Mirror 1', sceneShapes: [shape('body', 'solid'), shape('trace', 'wire')] }, 11);
const SWEEP = row({ id: 'sw', type: 'pipe', name: 'Sweep 1', sceneShapes: [shape('pipe', 'solid')] }, 13);
/** A helix its sweep hid: off the screen, still read by later features. */
const USED_HELIX = row({ id: 'uh', type: 'helix', name: 'Helix 2', consumedBy: 'sw', hiddenShapes: [shape('used-coil', 'edge')] }, 12);
/** A face offset outside a sketch carries its outline on itself. */
const OUTLINE = row({ id: 'of', type: 'offset', name: 'Offset 1', sceneShapes: [shape('outline', 'edge'), shape('outline-2', 'edge')] }, 14);

const SCENE = [SKETCH, CIRCLE, BLOCK, HELIX, RAIL, RAIL_CLONE, PATCH, PICKED, AXIS, MIXED, USED_HELIX, SWEEP, OUTLINE];

describe('what a row holds', () => {
  it('a row holding nothing but edges and wires is a curve object, whatever made it', () => {
    expect(isCurveObject(HELIX, SCENE)).toBe(true);
    expect(isCurveObject(RAIL, SCENE)).toBe(true);
    expect(isCurveObject(OUTLINE, SCENE)).toBe(true);
  });

  it('a curve its consumer hid is still one', () => {
    expect(isCurveObject(USED_HELIX, SCENE)).toBe(true);
  });

  it('a sketch, its geometry, a selection, a construction line and a body are not', () => {
    expect(isCurveObject(SKETCH, SCENE)).toBe(false);
    expect(isCurveObject(CIRCLE, SCENE)).toBe(false);
    expect(isCurveObject(PICKED, SCENE)).toBe(false);
    expect(isCurveObject(AXIS, SCENE)).toBe(false);
    expect(isCurveObject(BLOCK, SCENE)).toBe(false);
    // A curve beside a body: the row is not a curve of its own.
    expect(isCurveObject(MIXED, SCENE)).toBe(false);
  });

  it('a row holds a surface when one of its shapes is one', () => {
    expect(holdsSurface(PATCH)).toBe(true);
    expect(holdsSurface(BLOCK)).toBe(false);
    expect(holdsSurface(HELIX)).toBe(false);
  });

  it('lists every body and curve a row holds, for a whole-object highlight', () => {
    expect(modelShapeIdsOf(MIXED, SCENE)).toEqual(['body', 'trace']);
    expect(modelShapeIdsOf(MIXED, SCENE, ['solid'])).toEqual(['body']);
    expect(modelShapeIdsOf(HELIX, SCENE)).toEqual(['coil']);
    // A selection's edges belong to the object they were picked on.
    expect(modelShapeIdsOf(PICKED, SCENE)).toEqual([]);
  });
});

describe('collectWireSources', () => {
  it('offers the sketches, then every curve object, one option per statement', () => {
    const options = collectWireSources(SCENE);
    expect(options.map(o => [o.feature, o.label, o.line])).toEqual([
      ['sketch', 'Sketch', 2],
      ['curve', 'Helix 1', 6],
      ['curve', 'Copy 1', 7],
      ['curve', 'Helix 2 · used by Sweep 1', 12],
      ['curve', 'Offset 1', 14],
    ]);
  });

  it('carries a curve\'s row type for the name lookup, and its consumer for the reveal', () => {
    const options = collectWireSources(SCENE);
    expect(options.find(o => o.line === 6)).toMatchObject({ callee: 'helix', hasGeometry: true });
    expect(options.find(o => o.line === 6)?.consumer).toBeUndefined();
    expect(options.find(o => o.line === 12)).toMatchObject({ callee: 'helix', consumer: 'Sweep 1' });
  });
});

describe('resolving a row or a picked shape to its wire source', () => {
  it('a curve object\'s row is its own source; a sketch entity resolves to its sketch', () => {
    expect(resolveWireRow(HELIX, SCENE)).toBe(HELIX);
    expect(resolveWireRow(RAIL, SCENE)).toBe(RAIL);
    expect(resolveWireRow(CIRCLE, SCENE)).toBe(SKETCH);
    expect(resolveWireRow(BLOCK, SCENE)).toBeUndefined();
    expect(resolveWireRow(PATCH, SCENE)).toBeUndefined();
  });

  it('an edge of a curve object resolves to the object, an edge of a body to nothing', () => {
    expect(resolveCurveObjectByShapeId('coil', SCENE)).toBe(HELIX);
    expect(resolveCurveObjectByShapeId('rail-2', SCENE)).toBe(RAIL_CLONE);
    expect(resolveCurveObjectByShapeId('block', SCENE)).toBeUndefined();
    expect(resolveCurveObjectByShapeId('circle-wire', SCENE)).toBeUndefined();
  });

  it('a picked wire resolves to its sketch or its curve object', () => {
    expect(resolveWireByShapeId('circle-wire', SCENE)).toBe(SKETCH);
    expect(resolveWireByShapeId('coil', SCENE)).toBe(HELIX);
    // Shown again after its consumer hid it, a curve is clicked on its hidden shape.
    expect(resolveWireByShapeId('used-coil', SCENE)).toBe(USED_HELIX);
    expect(resolveWireByShapeId('block', SCENE)).toBeUndefined();
  });
});

describe('a wire source\'s shapes', () => {
  it('are the sketch\'s entities\', or every row of the curve\'s statement', () => {
    expect(sketchWireShapeIds({ filePath: FILE, line: 2 }, SCENE)).toEqual(['circle-wire']);
    expect(sketchWireShapeIds({ filePath: FILE, line: 6 }, SCENE)).toEqual(['coil']);
    expect(sketchWireShapeIds({ filePath: FILE, line: 7 }, SCENE)).toEqual(['rail', 'rail-2']);
    expect(sketchWireShapeIds({ filePath: FILE, line: 12 }, SCENE)).toEqual(['used-coil']);
    // A body's statement is no wire source.
    expect(sketchWireShapeIds({ filePath: FILE, line: 5 }, SCENE)).toEqual([]);
  });

  it('make a single-edge source only when one edge is all there is', () => {
    expect(isSingleEdgeWire({ filePath: FILE, line: 6 }, SCENE)).toBe(true);
    expect(isSingleEdgeWire({ filePath: FILE, line: 7 }, SCENE)).toBe(false);
  });
});

describe('labelWithSketchNames', () => {
  it('asks for each option by its statement\'s callee, and for a curve of any other callee by its line alone', async () => {
    const lookup = vi.fn(async (lines: number[], callee?: string): Promise<(string | null)[]> =>
      lines.map(line => (callee === 'helix' && line === 6 ? 'spring' : callee === 'any' && line === 7 ? 'rails' : null)));
    const labeled = await labelWithSketchNames(collectWireSources(SCENE), lookup);

    expect(lookup.mock.calls.map(call => [call[1], call[0]])).toEqual([
      ['sketch', [2]],
      ['helix', [6, 12]],
      ['any', [7]],
      ['offset', [14]],
    ]);
    expect(labeled.map(o => o.label)).toEqual(['Sketch', 'spring', 'rails', 'Helix 2 · used by Sweep 1', 'Offset 1']);
  });
});
