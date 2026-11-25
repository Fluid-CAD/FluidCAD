import { describe, it, expect } from 'vitest';
import {
  LiveSolvedSystem,
  buildSolvedSketchModel,
  ellipticalArcSpanOf,
  layoutConstraintGlyphs,
  solvedHitTest,
  tessellateSolvedEntity,
} from '../src/sketch-solver-client';
import { buildPositionWriteBack } from '../src/sketch-solver-client/write-back';
import { curveOf, curveIntersections } from '../src/sketch-solver-client/intersections';
import { entityAnchor, tangencyPoint } from '../src/sketch-solver-client/resolve';
import type { LiveEntityGeometry } from '../src/sketch-solver-client/live-system';
import type { SolvedEntityView, SolvedSketchModel } from '../src/sketch-solver-client/model';
import { entityKindLabel } from '../src/sketch-solver-client/model';
import {
  candidateSpec, constraintOptions, dimensionFormFor, ellipseRadiusAxis, measureDimension,
} from '../src/interactive/solved-constraint-toolbar/legality';
import { constraintTargetFor } from '../src/interactive/solved-constraint-toolbar/constraint-targets';
import { parseEmittedGeometry, solverEntityKind } from '../src/interactive/tools/emission-redundancy';
import { buildMirrorEmission } from '../src/interactive/tools/mirror-emission';
import { offsetSourcePicks } from '../src/interactive/tools/offset-emission';
import { cutRefusalFor } from '../src/interactive/tools/entity-cut-plan';
import { buildDeletePlan } from '../src/interactive/tools/delete-plan';
import { eArcText } from '../src/interactive/tools/solved-emission';
import { SnapManager } from '../src/snapping/snap-manager';
import type { SolvedPick } from '../src/interactive/sketch-hover-select-handler';
import type { SceneObjectRender } from '../src/types';
import { SketchSystem, diagnose, solve } from '../../lib/sketch-solver/index.js';

// The elliptical arc entity (`eArc`) through the UI's read model and every
// place that enumerates entity kinds: what the payload joins to, how it
// draws and picks, what the constraint bar offers on it, how a drag writes
// back, and which tools take it or turn it away.

const PLANE = {
  origin: { x: 0, y: 0, z: 0 },
  center: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  xDirection: { x: 1, y: 0, z: 0 },
  yDirection: { x: 0, y: 1, z: 0 },
};

const loc = (line: number) => ({ filePath: '/ws/m.fluid.js', line, column: 3 });

/** A quarter of a 40 × 20 ellipse around the origin, from (40, 0) up to (0, 20). */
function quarterView(overrides: Partial<SolvedEntityView> = {}): SolvedEntityView {
  return {
    entityId: 5,
    kind: 'eArc',
    obj: { id: 'ea', type: 'eArc', uniqueType: 'solved-earc', sourceLocation: loc(9), sceneShapes: [{ shapeId: 's-ea', meshes: [] }] } as any,
    center: [0, 0],
    radii: [40, 20],
    theta: 0,
    start: [40, 0],
    end: [0, 20],
    cw: false,
    guess: { start: [40, 0], end: [0, 20], center: [0, 0], rx: 40, ry: 20 },
    ...overrides,
  };
}

function modelWith(entities: SolvedEntityView[]): SolvedSketchModel {
  return {
    sketch: {} as any,
    plane: PLANE as any,
    solver: null,
    entities: new Map(entities.map(e => [e.entityId, e])),
    curves: new Map(),
    constraints: [],
    hasDatums: true,
    conflictingEntityIds: new Set(),
    constrainedEntityIds: new Set(),
    referenceProducers: new Map(),
    derivedProducers: new Map(),
    dof: null,
    outcome: null,
    fullyConstrained: false,
    conflictCount: 0,
    redundantCount: 0,
  };
}

const arcPick: SolvedPick = { entityId: 5, kind: 'eArc', sourceLocation: loc(9), shapeId: 's-ea' };
const linePick: SolvedPick = { entityId: 0, kind: 'line', sourceLocation: loc(5) };
const circlePick: SolvedPick = { entityId: 2, kind: 'circle', sourceLocation: loc(7) };
const pointPick: SolvedPick = { entityId: 0, kind: 'line', role: 'end', sourceLocation: loc(5) };

function enabledIds(picks: SolvedPick[]): string[] {
  return constraintOptions(picks).filter(o => o.enabled).map(o => o.id).sort();
}

describe('elliptical arc: read model', () => {
  it('joins the statement payload: ellipse, ends, side and guesses', () => {
    const sketch = {
      id: 'sk', type: 'sketch', sceneShapes: [], ownShapes: [],
      object: {
        plane: PLANE, solvedMode: true,
        solver: {
          entities: [{ id: 0, kind: 'eArc', fixed: false, paramOffset: 0 }],
          constraints: [{ id: -1, internal: true, spec: { kind: 'arc-consistency', entity: 0 } }],
          params: [1, 2, 40, 20, Math.PI / 6, 30, 20, -10, 30],
          outcome: 'solved', dof: 7, conflicting: [], redundant: [], underconstrainedEntities: [0],
        },
      },
    } as unknown as SceneObjectRender;
    const child = {
      id: 'ea', parentId: 'sk', type: 'eArc', uniqueType: 'solved-earc', sceneShapes: [], ownShapes: [],
      sourceLocation: loc(4),
      object: {
        entityId: 0, cw: true,
        center: { x: 1, y: 2 }, rx: 40, ry: 20, rotation: 30,
        start: { x: 30, y: 20 }, end: { x: -10, y: 30 },
        guess: { start: { x: 30, y: 20 }, end: { x: -10, y: 30 }, center: { x: 1, y: 2 }, rx: 40, ry: 20, rotation: 30 },
      },
    } as unknown as SceneObjectRender;

    const model = buildSolvedSketchModel(sketch, [sketch, child])!;
    const view = model.entities.get(0)!;
    expect(view.kind).toBe('eArc');
    expect(view.center).toEqual([1, 2]);
    expect(view.radii).toEqual([40, 20]);
    expect(view.theta).toBeCloseTo(Math.PI / 6, 12);
    expect(view.start).toEqual([30, 20]);
    expect(view.end).toEqual([-10, 30]);
    expect(view.cw).toBe(true);
    expect(view.guess).toEqual({ start: [30, 20], end: [-10, 30], center: [1, 2], rx: 40, ry: 20, rotation: 30 });
    expect(model.dof).toBe(7);
  });

  it('rebuilds a live system from the snapshot that solves and diagnoses like the kernel', () => {
    const sys = new SketchSystem();
    sys.ensureDatums();
    const arc = sys.eArc(0, 0, 40, 20, 0, 40, 0, 0, 20);
    sys.constrain({ kind: 'radius', a: { entity: arc }, value: 40, axis: 'x' });
    const outcome = solve(sys).outcome;
    const snapshot = sys.snapshot({ outcome, diagnostics: diagnose(sys) });

    const live = LiveSolvedSystem.fromSnapshot(snapshot)!;
    expect(live).not.toBeNull();
    expect(live.entityKind(arc)).toBe('eArc');
    expect(live.solve()).toBe('solved');
    expect(live.diagnose().dof).toBe(6);
    const g = live.entityGeometry(arc)!;
    expect(g.kind).toBe('eArc');
    expect(g.radii).toEqual([40, 20]);
    expect(g.start![0]).toBeCloseTo(40, 9);
    expect(g.end![1]).toBeCloseTo(20, 9);

    // Dragging an end keeps it on the ellipse.
    expect(live.dragSolve([{ ref: { entity: arc, point: 'end' }, x: -30, y: 30 }])).toBe('solved');
    // The arc is free apart from RX, so its ellipse moves with the drag:
    // the end is read against the ellipse as it now stands.
    const moved = live.entityGeometry(arc)!;
    const c = Math.cos(moved.theta!);
    const sn = Math.sin(moved.theta!);
    const dx = moved.end![0] - moved.center![0];
    const dy = moved.end![1] - moved.center![1];
    const f = ((dx * c + dy * sn) / moved.radii![0]) ** 2 + ((-dx * sn + dy * c) / moved.radii![1]) ** 2;
    expect(f).toBeCloseTo(1, 5);
    expect(moved.radii![0]).toBeCloseTo(40, 6);
    expect(moved.end![0]).toBeLessThan(-5);
  });

  it('adds a not-yet-rendered elliptical arc to a live system for the redundancy trial', () => {
    const base = new SketchSystem();
    base.ensureDatums();
    base.line(0, 0, 10, 0);
    const live = LiveSolvedSystem.fromSnapshot(base.snapshot())!;
    const id = live.addEntity('eArc', [0, 0, 40, 20, 0, 40, 0, 0, 20]);
    expect(live.entityKind(id)).toBe('eArc');
    expect(live.solve()).toBe('solved');
    // The line's 4 plus the arc's 7.
    expect(live.diagnose().dof).toBe(11);
  });
});

describe('elliptical arc: drawing and picking', () => {
  it('tessellates the drawn piece only, landing on both ends', () => {
    const view = quarterView();
    const points = tessellateSolvedEntity(view, 16)!;
    expect(points).toHaveLength(17);
    expect(points[0]).toEqual([40, 0]);
    expect(points[16]).toEqual([0, 20]);
    for (const [x, y] of points) {
      expect((x / 40) ** 2 + (y / 20) ** 2).toBeCloseTo(1, 9);
      expect(x).toBeGreaterThanOrEqual(-1e-9);
      expect(y).toBeGreaterThanOrEqual(-1e-9);
    }
    // The clockwise piece between the same ends is the other three quarters.
    const other = tessellateSolvedEntity(quarterView({ cw: true }), 16)!;
    expect(other.some(([x]) => x < -39)).toBe(true);
    expect(other.some(([, y]) => y < -19)).toBe(true);
    expect(ellipticalArcSpanOf(quarterView({ cw: true }))!.sweep).toBeCloseTo(-1.5 * Math.PI, 9);
  });

  it('hit tests its three points, then its drawn piece, never the rest of the ellipse', () => {
    const model = modelWith([quarterView()]);
    const start = solvedHitTest(model, [40.2, 0.1], 1, 1);
    expect(start).toMatchObject({ type: 'vertex', entityId: 5, role: 'start' });
    const center = solvedHitTest(model, [0.1, -0.1], 1, 1);
    expect(center).toMatchObject({ type: 'vertex', entityId: 5, role: 'center' });
    // On the outline halfway round the quarter.
    const mid = entityAnchor(quarterView())!;
    expect((mid[0] / 40) ** 2 + (mid[1] / 20) ** 2).toBeCloseTo(1, 9);
    expect(solvedHitTest(model, [mid[0] + 0.2, mid[1]], 0.01, 1)).toMatchObject({ type: 'edge', entityId: 5, kind: 'eArc' });
    // The far side of the ellipse is not drawn.
    expect(solvedHitTest(model, [-40, 0], 0.01, 1)).toBeNull();
    expect(solvedHitTest(model, [0, -20], 0.01, 1)).toBeNull();
  });

  it('crosses other entities on its drawn piece only', () => {
    const arc = curveOf(quarterView())!;
    const through = curveOf({ entityId: 1, kind: 'line', start: [-60, 10], end: [60, 10] })!;
    const hits = curveIntersections(arc, through);
    expect(hits).toHaveLength(1);
    expect(hits[0][0]).toBeGreaterThan(0);
    expect(hits[0][1]).toBeCloseTo(10, 6);
  });

  it('snaps to its start, end and center with its own statement as provenance', () => {
    const sketch = {
      id: 'sk', type: 'sketch', sceneShapes: [], ownShapes: [],
      object: {
        plane: PLANE, solvedMode: true,
        solver: {
          entities: [{ id: 0, kind: 'eArc', fixed: false, paramOffset: 0 }],
          constraints: [], params: [0, 0, 40, 20, 0, 40, 0, 0, 20],
          outcome: 'solved', dof: 7, conflicting: [], redundant: [], underconstrainedEntities: [0],
        },
      },
    } as unknown as SceneObjectRender;
    const child = {
      id: 'ea', parentId: 'sk', type: 'eArc', uniqueType: 'solved-earc', sceneShapes: [], ownShapes: [],
      sourceLocation: loc(4),
      object: {
        entityId: 0, cw: false, center: { x: 0, y: 0 }, rx: 40, ry: 20, rotation: 0,
        start: { x: 40, y: 0 }, end: { x: 0, y: 20 },
      },
    } as unknown as SceneObjectRender;
    const manager = SnapManager.fromSceneObjects([sketch, child], 'sk', PLANE as any);
    const at = (p: [number, number]) => manager.snap(p, PLANE as any).ref;
    expect(at([40, 0])).toEqual({ line: 4, role: 'start', featureType: 'eArc' });
    expect(at([0, 20])).toEqual({ line: 4, role: 'end', featureType: 'eArc' });
  });
});

describe('elliptical arc: constraint bar', () => {
  it('offers on the arc what an ellipse takes, and on its points what any point takes', () => {
    expect(enabledIds([arcPick])).toEqual(['dimension', 'horizontal', 'vertical']);
    expect(enabledIds([arcPick, linePick])).toEqual(['tangent']);
    expect(enabledIds([arcPick, circlePick])).toEqual(['concentric', 'tangent']);
    expect(enabledIds([pointPick, arcPick])).toEqual(['coincident']);
    const start: SolvedPick = { ...arcPick, role: 'start' };
    const end: SolvedPick = { ...arcPick, role: 'end' };
    expect(enabledIds([start, end])).toEqual(['coincident', 'dimension', 'horizontal', 'vertical']);
    expect(enabledIds([{ ...arcPick, role: 'center' }])).toEqual(['fix']);
  });

  it('mirrors two elliptical arcs across a line, never an arc onto an ellipse', () => {
    const twin: SolvedPick = { entityId: 6, kind: 'eArc', sourceLocation: loc(10) };
    const ellipse: SolvedPick = { entityId: 7, kind: 'ellipse', sourceLocation: loc(11) };
    expect(enabledIds([arcPick, twin, linePick])).toContain('symmetric');
    expect(enabledIds([arcPick, ellipse, linePick])).not.toContain('symmetric');
  });

  it('dimensions one semi-radius, picked by where the click landed', () => {
    const model = modelWith([quarterView()]);
    expect(dimensionFormFor([arcPick])).toEqual({ kind: 'radius', axisChoice: false, tangencyChoice: false });
    const nearRx: SolvedPick = { ...arcPick, at: [39, 3] };
    const nearRy: SolvedPick = { ...arcPick, at: [3, 19.5] };
    expect(ellipseRadiusAxis(model, nearRx)).toBe('x');
    expect(ellipseRadiusAxis(model, nearRy)).toBe('y');
    expect(measureDimension(model, [nearRy], { kind: 'radius', axisChoice: false, tangencyChoice: false }, 'y')).toBe(20);
    expect(candidateSpec('dimension', [nearRy], 25, 'y')).toEqual({ kind: 'radius', a: { entity: 5 }, value: 25, axis: 'y' });
    expect(candidateSpec('horizontal', [arcPick])).toEqual({ kind: 'horizontal', a: { entity: 5 } });
  });

  it('addresses the arc and its points by its own statement', () => {
    expect(constraintTargetFor(arcPick)).toEqual({ line: 9, featureType: 'eArc' });
    expect(constraintTargetFor({ ...arcPick, role: 'end' })).toEqual({ line: 9, role: 'end', featureType: 'eArc' });
  });

  it('lays a radius dimension along the semi-axis the arc actually reaches', () => {
    // The left half's quarter: RX's positive end (40, 0) is off the piece.
    const left = quarterView({ start: [0, 20], end: [-40, 0] });
    const model: SolvedSketchModel = {
      ...modelWith([left]),
      constraints: [{
        obj: { id: 'r', sourceLocation: loc(12) } as any, kind: 'radius',
        spec: { kind: 'radius', a: { entity: 5 }, value: 40, axis: 'x' }, value: 40, status: 'ok',
      }],
    };
    const leader = layoutConstraintGlyphs(model).find(g => g.type === 'leader') as any;
    expect(leader.from).toEqual([0, 0]);
    expect(leader.to[0]).toBeCloseTo(-40, 9);
    expect(leader.to[1]).toBeCloseTo(0, 9);
  });

  it('puts a tangent badge on the drawn piece', () => {
    // A line above the ellipse touches it at the top; a horizontal line
    // below would touch the undrawn bottom, so the badge takes an end.
    const arc = quarterView();
    const above: SolvedEntityView = { entityId: 1, kind: 'line', start: [-50, 22], end: [50, 22] };
    const below: SolvedEntityView = { entityId: 2, kind: 'line', start: [-50, -22], end: [50, -22] };
    const top = tangencyPoint(arc, above)!;
    expect(top[0]).toBeCloseTo(0, 6);
    expect(top[1]).toBeCloseTo(20, 6);
    const bottom = tangencyPoint(arc, below)!;
    expect([[40, 0], [0, 20]]).toContainEqual(bottom);
  });
});

describe('elliptical arc: write-back and emission', () => {
  it('writes drifted points by argument position, the semi-radii, and appends a rotation', () => {
    const model = modelWith([quarterView()]);
    const live: LiveEntityGeometry = {
      kind: 'eArc', center: [1, 0], radii: [42, 20.001], theta: Math.PI / 6,
      start: [37.37, 21], end: [0, 20],
    };
    const { edits, filePath } = buildPositionWriteBack(model, () => live);
    expect(filePath).toBe('/ws/m.fluid.js');
    expect(edits).toEqual([{
      sourceLine: 9,
      points: [
        { pointIndex: 0, position: [37.37, 21], expected: [40, 0] },
        { pointIndex: 2, position: [1, 0], expected: [0, 0] },
      ],
      radii: { rx: { value: 42, expected: 40 } },
      rotation: { value: 30 },
    }]);
  });

  it('renders the statement text, rotation and side included', () => {
    expect(eArcText([40, 0], [0, 20], [0, 0], 40, 20)).toBe('eArc([40, 0], [0, 20], [0, 0], 40, 20)');
    expect(eArcText([40.004, 0], [0, 20], [0, 0], 'w', 20.5, 15, true))
      .toBe('eArc([40, 0], [0, 20], [0, 0], w, 20.5, 15).cw()');
  });

  it('reads an emitted statement back as solver params, ends on the ellipse', () => {
    expect(solverEntityKind('eArc')).toBe('eArc');
    const params = parseEmittedGeometry('eArc', 'eArc([44, 0], [0, 23], [0, 0], 40, 20).cw()')!;
    expect(params.slice(0, 5)).toEqual([0, 0, 40, 20, 0]);
    expect(params[5]).toBeCloseTo(40, 9);
    expect(params[6]).toBeCloseTo(0, 9);
    expect(params[7]).toBeCloseTo(0, 9);
    expect(params[8]).toBeCloseTo(20, 9);
    const turned = parseEmittedGeometry('eArc', 'eArc([0, 40], [-20, 0], [0, 0], 40, 20, 90)')!;
    expect(turned[4]).toBeCloseTo(Math.PI / 2, 12);
    // A typed expression leaves the trial without a value for it.
    expect(parseEmittedGeometry('eArc', 'eArc([40, 0], [0, 20], [0, 0], w, 20)')).toBeNull();
    expect(parseEmittedGeometry('eArc', 'eArc([40, 0], [0, 20], [0, 0], 40)')).toBeNull();
  });

  it('mirrors as a reflected statement that runs the other way round, with one symmetric', () => {
    const view = quarterView({ center: [50, 0], start: [90, 0], end: [50, 20] });
    const plan = buildMirrorEmission({
      targets: [{ pick: arcPick }],
      model: modelWith([view]),
      axis: { kind: 'datum', axis: 'y' },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.request.geometry).toEqual([
      { kind: 'eArc', text: 'eArc([-90, 0], [-50, 20], [-50, 0], 40, 20, 180).cw()' },
    ]);
    expect(plan.request.constraints).toEqual([{
      kind: 'symmetric',
      targets: [{ line: 9, featureType: 'eArc' }, { newIndex: 0 }, { datum: 'y-axis' }],
    }]);
  });
});

describe('elliptical arc: the tools that turn it away', () => {
  it('Split and Trim refuse it in plain words', () => {
    const at: SolvedPick = { ...arcPick, at: [30, 13] };
    expect(cutRefusalFor(at, { verb: 'split', past: 'split', where: 'Click where to split' }))
      .toBe("Elliptical arcs can't be split yet");
    expect(cutRefusalFor(at, { verb: 'trim', past: 'trimmed', where: 'Click what to trim' }))
      .toBe("Elliptical arcs can't be trimmed yet");
  });

  it('the constrained offset refuses it, naming it in plain words', () => {
    const result = offsetSourcePicks([arcPick]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/^an elliptical arc cannot be offset as constrained geometry/);
    expect(entityKindLabel('eArc')).toBe('an elliptical arc');
  });

  it('Delete takes it like any statement', () => {
    const obj = {
      id: 'ea', type: 'eArc', uniqueType: 'solved-earc', sourceLocation: loc(9),
      sceneShapes: [{ shapeId: 's-ea', meshes: [] }], ownShapes: [],
    } as unknown as SceneObjectRender;
    const plan = buildDeletePlan(['s-ea'], [obj]);
    expect(plan).toMatchObject({ ok: true, targets: [{ line: 9, type: 'eArc' }] });
    expect(plan && plan.ok && plan.label).toMatch(/elliptical arc/);
  });
});
