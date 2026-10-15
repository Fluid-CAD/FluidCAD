import { describe, it, expect } from 'vitest';
import { tessellateSpline, tessellateCurve, tessellateBezier } from '../src/sketch-solver-client/tessellate';
import {
  buildSolvedSketchModel, curveControlPoints, curveKindOf, curveViewForShape, pickForEntity,
} from '../src/sketch-solver-client/model';
import type { SolvedCurveView, SolvedEntityView, SolvedSketchModel } from '../src/sketch-solver-client/model';
import { entityIntersections } from '../src/sketch-solver-client/intersections';
import { buildMirrorEmission, mirrorTargetsFor } from '../src/interactive/tools/mirror-emission';
import { parseEmittedGeometry, solverEntityKind } from '../src/interactive/tools/emission-redundancy';
import { offsetNeedsStatement } from '../src/interactive/tools/offset-emission';
import { curveText, splineText } from '../src/interactive/tools/solved-emission';
import { interpolateBSpline2d } from '../../lib/math/bspline-interpolation.js';
import type { SceneObjectRender } from '../src/types';

// The spline on the UI's curve rails (the bezier's, generalized by kind):
// its own tessellation (the kernel's interpolation, evaluated client-side),
// the read-model join as a `spline-N` statement with fit-point anchors, the
// Mirror tool's reflected spline, Trim's crossings through its polyline,
// and the emission bookkeeping that keeps a spline out of the solver trial.

const PLANE = {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  xDirection: { x: 1, y: 0, z: 0 },
  yDirection: { x: 0, y: 1, z: 0 },
};
const FIT: [number, number][] = [[0, 0], [20, 30], [50, 10], [80, 40], [100, 0]];
const LOC = { line: 7, column: 3, filePath: '/ws/m.fluid.js' };

function chordParams(points: [number, number][]): number[] {
  const params = [0];
  for (let i = 1; i < points.length; i++) {
    params.push(params[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  }
  return params.map(v => v / params[params.length - 1]);
}

describe('tessellateSpline', () => {
  it('walks the interpolating curve from the first point to the last, through every fit point', () => {
    const polyline = tessellateSpline(FIT, 400)!;
    expect(polyline).toHaveLength(401);
    expect(polyline[0]).toEqual(FIT[0]);
    expect(polyline[400]).toEqual(FIT[4]);
    for (const p of FIT) {
      const nearest = Math.min(...polyline.map(q => Math.hypot(q[0] - p[0], q[1] - p[1])));
      expect(nearest).toBeLessThan(0.3);
    }
    // The samples are uniform in the chord-length parameter: the sample at
    // a fit point's parameter IS the fit point.
    const params = chordParams(FIT);
    const data = interpolateBSpline2d(FIT.map(([x, y]) => ({ x, y })));
    expect(data.degree).toBe(3);
    const atParam = (t: number) => polyline[Math.round(t * 400)];
    for (const [i, p] of FIT.entries()) {
      const q = atParam(params[i]);
      expect(Math.hypot(q[0] - p[0], q[1] - p[1])).toBeLessThan(0.3);
    }
  });

  it('is a straight chord with two points and null below two distinct points', () => {
    const two = tessellateSpline([[0, 0], [40, 30]], 8)!;
    for (const [x, y] of two) {
      expect(Math.abs(x * 30 - y * 40)).toBeLessThan(1e-9);
    }
    expect(tessellateSpline([[3, 3]], 8)).toBeNull();
    expect(tessellateSpline([[3, 3], [3, 3], [3, 3]], 8)).toBeNull();
    expect(tessellateSpline(FIT, 0)).toBeNull();
  });

  it('dispatches by kind: a bezier on the same points is pulled, a spline passes through', () => {
    const spline = tessellateCurve('spline', FIT, 200)!;
    const bezier = tessellateCurve('bezier', FIT, 200)!;
    expect(bezier).toEqual(tessellateBezier(FIT, 200));
    const nearest = (polyline: [number, number][], p: [number, number]) =>
      Math.min(...polyline.map(q => Math.hypot(q[0] - p[0], q[1] - p[1])));
    expect(nearest(spline, [20, 30])).toBeLessThan(0.5);
    expect(nearest(bezier, [20, 30])).toBeGreaterThan(5);
  });
});

describe('curveKindOf', () => {
  it('reads the curve kind off the unique type', () => {
    expect(curveKindOf('spline-4')).toBe('spline');
    expect(curveKindOf('bezier-3')).toBe('bezier');
    expect(curveKindOf('solved-line')).toBeNull();
    expect(curveKindOf(undefined)).toBeNull();
  });
});

function splinePayload(): { sketch: SceneObjectRender; objects: SceneObjectRender[] } {
  const controls: [number, number][] = [[0, 0], [10, 30], [50, 0]];
  const solver = {
    entities: [
      ...controls.map((_, i) => ({ id: i, kind: 'point', fixed: false, paramOffset: i * 2 })),
      { id: 3, kind: 'line', fixed: false, paramOffset: 6 },
    ],
    params: [...controls.flat(), 0, 0, 40, 0],
    constraints: [],
    dof: 10,
    outcome: 'solved',
    underconstrainedEntities: [0, 1, 2, 3],
  };
  const sketch = {
    id: 'sk', type: 'sketch', uniqueType: 'sketch',
    object: { solvedMode: true, plane: PLANE, solver }, sceneShapes: [], ownShapes: [],
  } as unknown as SceneObjectRender;
  const spline = {
    id: 'sp1', parentId: 'sk', type: 'spline', uniqueType: 'spline-3', sourceLocation: LOC,
    object: {
      startPoint: controls[0],
      resolvedPoints: controls.slice(1),
      anchors: controls.map((p, i) => ({ pointIndex: i, entityId: i, guess: { x: p[0], y: p[1] } })),
      controlSources: controls.map((_, i) => ({ entityId: i, role: null })),
      sourceEntities: [0, 1, 2],
      sourcesSolved: true,
    },
    sceneShapes: [
      { shapeId: 'curve', shapeType: 'edge', meshes: [] },
      { shapeId: 'meta', shapeType: 'edge', meshes: [], isMetaShape: true },
    ],
    ownShapes: [],
  } as unknown as SceneObjectRender;
  const line = {
    id: 'l1', parentId: 'sk', type: 'line', uniqueType: 'solved-line',
    sourceLocation: { ...LOC, line: 6 },
    object: { entityId: 3, start: { x: 0, y: 0 }, end: { x: 40, y: 0 } },
    sceneShapes: [{ shapeId: 'line-edge', shapeType: 'edge', meshes: [] }],
    ownShapes: [],
  } as unknown as SceneObjectRender;
  return { sketch, objects: [sketch, spline, line] };
}

describe('read model — spline statements', () => {
  const { sketch, objects } = splinePayload();
  const model = buildSolvedSketchModel(sketch, objects)!;

  it('joins the spline as a curve of kind spline with fit-point anchors owned by the statement', () => {
    const view = model.curves.get('sp1')!;
    expect(view.kind).toBe('spline');
    expect(view.points).toEqual([[0, 0], [10, 30], [50, 0]]);
    expect(view.sources).toEqual([0, 1, 2].map(entityId => ({ entityId, role: null })));
    for (const i of [0, 1, 2]) {
      const anchor = model.entities.get(i)!;
      expect(anchor.anchor).toEqual({ owner: 'spline', pointIndex: i });
      expect(anchor.obj).toBe(objects[1]);
    }
    expect(model.derivedProducers.get('sp1')).toEqual([0, 1, 2]);
    expect(curveViewForShape(model, 'curve')).toBe(view);
    expect(curveViewForShape(model, 'meta')).toBeUndefined();
    expect(pickForEntity(model, model.entities.get(1)!, null)).toEqual({
      entityId: 1, kind: 'point', sourceLocation: LOC, role: null, anchor: { owner: 'spline', pointIndex: 1 },
    });
  });

  it('reads the fit points off their anchor views, so a live drag moves the curve', () => {
    const view = model.curves.get('sp1')!;
    model.entities.get(1)!.point = [12, 35];
    expect(curveControlPoints(model, view)).toEqual([[0, 0], [12, 35], [50, 0]]);
    model.entities.get(1)!.point = [10, 30];
  });
});

describe('Mirror tool — spline', () => {
  const { sketch, objects } = splinePayload();
  const model = buildSolvedSketchModel(sketch, objects)!;

  it('resolves the picked curve shape to its spline statement', () => {
    const { targets, unresolved } = mirrorTargetsFor(['curve'], [], model);
    expect(unresolved).toEqual([]);
    expect(targets).toEqual([{ curve: model.curves.get('sp1') }]);
  });

  it('writes a reflected spline() held by one symmetric per fit point', () => {
    const plan = buildMirrorEmission({
      targets: [{ curve: model.curves.get('sp1')! }],
      model,
      axis: { kind: 'datum', axis: 'y' },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.request.geometry).toEqual([{ kind: 'spline', text: 'spline([0, 0], [-10, 30], [-50, 0])' }]);
    expect(plan.preview).toEqual(['spline([0, 0], [-10, 30], [-50, 0])']);
    const axis = { datum: 'y-axis' };
    expect(plan.request.constraints).toEqual([0, 1, 2].map(i => ({
      kind: 'symmetric',
      targets: [
        { line: 7, featureType: 'spline', pointIndex: i },
        { newIndex: 0, featureType: 'spline', pointIndex: i },
        axis,
      ],
    })));
  });

  it('refuses a single-point spline by its own name', () => {
    const single: SolvedCurveView = {
      kind: 'spline', obj: objects[1], points: [[3, 3]], sources: [null],
    };
    const plan = buildMirrorEmission({ targets: [{ curve: single }], model, axis: { kind: 'datum', axis: 'x' } });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.reason).toMatch(/a picked spline has a single control point/);
    }
  });
});

describe('Trim crossings — spline', () => {
  it('crosses a spline through its interpolated polyline, naming no entity', () => {
    const l = { entityId: 1, kind: 'line', start: [0, 0], end: [100, 0] } as SolvedEntityView;
    // Through (10,-20), (30,20), (50,-20): a quadratic through symmetric
    // points, so it crosses y = 0 twice, mirror images about x = 30 —
    // x = 30 ∓ 20/√2 for the parabola x = 10 + 40t, y = -20 + 160t − 160t².
    const spline = {
      kind: 'spline', obj: {}, points: [[10, -20], [30, 20], [50, -20]], sources: [null, null, null],
    } as unknown as SolvedCurveView;
    const model = {
      entities: new Map([[1, l]]),
      curves: new Map([['s', spline]]),
      constraints: [],
      hasDatums: true,
    } as unknown as SolvedSketchModel;
    const crossings = entityIntersections(l, model).sort((a, b) => a.point[0] - b.point[0]);
    expect(crossings).toHaveLength(2);
    expect(crossings[0].point[0]).toBeCloseTo(30 - 20 * Math.SQRT1_2, 2);
    expect(crossings[1].point[0]).toBeCloseTo(30 + 20 * Math.SQRT1_2, 2);
    expect(crossings.every(c => c.entityId === null)).toBe(true);
  });
});

describe('emission bookkeeping — spline', () => {
  it('renders the statement text', () => {
    expect(splineText([[0, 0], [10.5, 2], [20, 0]])).toBe('spline([0, 0], [10.5, 2], [20, 0])');
    expect(curveText('spline', [[1, 2], [3, 4]])).toBe('spline([1, 2], [3, 4])');
    expect(curveText('bezier', [[1, 2], [3, 4]])).toBe('bezier([1, 2], [3, 4])');
  });

  it('keeps an emitted spline out of the redundancy trial, like a bezier', () => {
    expect(solverEntityKind('spline')).toBeNull();
    expect(parseEmittedGeometry('spline', 'spline([0, 0], [10, 10], [20, 0])')).toBeNull();
  });

  it('routes an offset holding a spline through the offset() statement', () => {
    expect(offsetNeedsStatement(['solved-line', 'spline-4'])).toBe(true);
    expect(offsetNeedsStatement(['solved-line', 'solved-arc'])).toBe(false);
  });
});
