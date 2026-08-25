import { describe, it, expect } from 'vitest';
import { SketchSystem } from '../../lib/sketch-solver/index.js';
import type { SketchSolverSystem } from '../../lib/sketch-solver/types.js';
import { LiveSolvedSystem } from '../src/sketch-solver-client/live-system';
import { solvedHitTest } from '../src/sketch-solver-client/hit-test';
import type { SolvedEntityView, SolvedSketchModel } from '../src/sketch-solver-client/model';

// ---------------------------------------------------------------------------
// Snapshot builders — assemble a kernel-side system, solve nothing (params
// stay at guesses), and snapshot it the way the render payload would.
// ---------------------------------------------------------------------------

/** Dimensioned rectangle: 4 lines, 4 coincidents, H/V, fix, two dims.
 * Guesses are already the solved configuration, so the live system's warm
 * start is exact. */
function rectangleSnapshot(): {
  snapshot: SketchSolverSystem;
  ids: { bottom: number; right: number; top: number; left: number };
} {
  const sys = new SketchSystem();
  const bottom = sys.line(0, 0, 100, 0);
  const right = sys.line(100, 0, 100, 50);
  const top = sys.line(100, 50, 0, 50);
  const left = sys.line(0, 50, 0, 0);
  sys.constrain({ kind: 'coincident', a: { entity: bottom, point: 'end' }, b: { entity: right, point: 'start' } });
  sys.constrain({ kind: 'coincident', a: { entity: right, point: 'end' }, b: { entity: top, point: 'start' } });
  sys.constrain({ kind: 'coincident', a: { entity: top, point: 'end' }, b: { entity: left, point: 'start' } });
  sys.constrain({ kind: 'coincident', a: { entity: left, point: 'end' }, b: { entity: bottom, point: 'start' } });
  sys.constrain({ kind: 'horizontal', a: { entity: bottom } });
  sys.constrain({ kind: 'horizontal', a: { entity: top } });
  sys.constrain({ kind: 'vertical', a: { entity: right } });
  sys.constrain({ kind: 'vertical', a: { entity: left } });
  sys.constrain({ kind: 'fix', p: { entity: bottom, point: 'start' } });
  return { snapshot: sys.snapshot({ outcome: 'solved' }), ids: { bottom, right, top, left } };
}

/** Free rhombus: 4 lines + 4 coincidents + equal lengths, one fixed corner.
 * Plenty of DOF left so drags visibly deform it. */
function rhombusSnapshot(): { snapshot: SketchSolverSystem; ids: number[] } {
  const sys = new SketchSystem();
  const a = sys.line(0, 0, 10, 0);
  const b = sys.line(10, 0, 10, 10);
  const c = sys.line(10, 10, 0, 10);
  const d = sys.line(0, 10, 0, 0);
  const pairs: [number, number][] = [[a, b], [b, c], [c, d], [d, a]];
  for (const [u, v] of pairs) {
    sys.constrain({ kind: 'coincident', a: { entity: u, point: 'end' }, b: { entity: v, point: 'start' } });
  }
  sys.constrain({ kind: 'equal', a: { entity: a }, b: { entity: b } });
  sys.constrain({ kind: 'equal', a: { entity: b }, b: { entity: c } });
  sys.constrain({ kind: 'equal', a: { entity: c }, b: { entity: d } });
  sys.constrain({ kind: 'fix', p: { entity: a, point: 'start' } });
  return { snapshot: sys.snapshot({ outcome: 'solved' }), ids: [a, b, c, d] };
}

describe('LiveSolvedSystem.fromSnapshot', () => {
  it('rebuilds entities and params exactly from the snapshot', () => {
    const { snapshot, ids } = rectangleSnapshot();
    const live = LiveSolvedSystem.fromSnapshot(snapshot);
    expect(live).not.toBeNull();
    expect(live!.entityIds().sort()).toEqual(
      snapshot.entities.map(e => e.id).sort(),
    );
    expect(live!.entityGeometry(ids.bottom)).toEqual({
      kind: 'line',
      start: [0, 0],
      end: [100, 0],
    });
    expect(live!.entityGeometry(ids.left)).toEqual({
      kind: 'line',
      start: [0, 50],
      end: [0, 0],
    });
  });

  it('rebuilds arcs with the snapshot radius, not the endpoint-derived guess', () => {
    const sys = new SketchSystem();
    const arc = sys.arc(0, 0, 10, 0, 0, 10);
    // Skew the radius param away from what arc() would derive.
    sys.values[2] = 42;
    const live = LiveSolvedSystem.fromSnapshot(sys.snapshot());
    expect(live).not.toBeNull();
    expect(live!.entityGeometry(arc)!.radius).toBe(42);
  });

  it('returns null for empty and missing snapshots', () => {
    expect(LiveSolvedSystem.fromSnapshot(null)).toBeNull();
    expect(LiveSolvedSystem.fromSnapshot(undefined)).toBeNull();
    const sys = new SketchSystem();
    expect(LiveSolvedSystem.fromSnapshot(sys.snapshot())).toBeNull();
  });

  it('returns null when a constraint spec fails validation', () => {
    const { snapshot } = rectangleSnapshot();
    const broken: SketchSolverSystem = {
      ...snapshot,
      constraints: [
        ...snapshot.constraints,
        { id: 999, internal: false, spec: { kind: 'horizontal', a: { entity: 12345 } } },
      ],
    };
    expect(LiveSolvedSystem.fromSnapshot(broken)).toBeNull();
  });
});

describe('LiveSolvedSystem drag', () => {
  it('a fully constrained rectangle refuses to deform under drag', () => {
    const sysWithDims = (() => {
      const { snapshot } = rectangleSnapshot();
      const live = LiveSolvedSystem.fromSnapshot(snapshot)!;
      live.constrain({ kind: 'distance', a: { entity: 0, point: 'start' }, b: { entity: 0, point: 'end' }, value: 100 });
      live.constrain({ kind: 'distance', a: { entity: 1, point: 'start' }, b: { entity: 1, point: 'end' }, value: 50 });
      return live;
    })();
    const outcome = sysWithDims.dragSolve([
      { ref: { entity: 2, point: 'start' }, x: 130, y: 80 },
    ]);
    expect(outcome).toBe('solved');
    // Constraints win: the corner stays put.
    const g = sysWithDims.entityGeometry(2)!;
    expect(g.start![0]).toBeCloseTo(100, 6);
    expect(g.start![1]).toBeCloseTo(50, 6);
  });

  it('rhombus drag: corners follow, coincidence and equality hold', () => {
    const { snapshot, ids } = rhombusSnapshot();
    const live = LiveSolvedSystem.fromSnapshot(snapshot)!;
    const outcome = live.dragSolve([
      { ref: { entity: ids[1], point: 'start' }, x: 14, y: 2 },
    ]);
    expect(outcome).toBe('solved');
    const a = live.entityGeometry(ids[0])!;
    const b = live.entityGeometry(ids[1])!;
    // Coincidence: a.end === b.start, moved toward the target.
    expect(a.end![0]).toBeCloseTo(b.start![0], 6);
    expect(a.end![1]).toBeCloseTo(b.start![1], 6);
    expect(a.end![0]).toBeGreaterThan(10.5);
    // Equal lengths still hold.
    const len = (g: typeof a) => Math.hypot(g.end![0] - g.start![0], g.end![1] - g.start![1]);
    expect(len(b)).toBeCloseTo(len(a), 6);
    // The fixed corner never moves.
    expect(a.start![0]).toBeCloseTo(0, 9);
    expect(a.start![1]).toBeCloseTo(0, 9);
  });

  it('successive warm drags terminate and track the cursor', () => {
    const { snapshot, ids } = rhombusSnapshot();
    const live = LiveSolvedSystem.fromSnapshot(snapshot)!;
    for (let i = 1; i <= 20; i++) {
      const outcome = live.dragSolve([
        { ref: { entity: ids[1], point: 'start' }, x: 10 + i * 0.2, y: i * 0.1 },
      ]);
      expect(outcome).toBe('solved');
    }
    const b = live.entityGeometry(ids[1])!;
    expect(b.start![0]).toBeCloseTo(14, 1);
    expect(b.start![1]).toBeCloseTo(2, 1);
  });

  it('reset() restores the snapshot params after a drag', () => {
    const { snapshot, ids } = rhombusSnapshot();
    const live = LiveSolvedSystem.fromSnapshot(snapshot)!;
    live.dragSolve([{ ref: { entity: ids[1], point: 'start' }, x: 17, y: 4 }]);
    live.reset(snapshot);
    expect(live.entityGeometry(ids[0])).toEqual({
      kind: 'line',
      start: [0, 0],
      end: [10, 0],
    });
  });
});

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

function entityView(entityId: number, fields: Partial<SolvedEntityView> & { kind: SolvedEntityView['kind'] }): SolvedEntityView {
  return { entityId, obj: { id: `obj-${entityId}` } as any, ...fields };
}

function modelWith(entities: SolvedEntityView[]): SolvedSketchModel {
  return {
    sketch: {} as any,
    plane: {} as any,
    solver: null,
    entities: new Map(entities.map(e => [e.entityId, e])),
    constraints: [],
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

describe('solvedHitTest', () => {
  const model = modelWith([
    entityView(0, { kind: 'line', start: [0, 0], end: [10, 0] }),
    entityView(1, { kind: 'circle', center: [20, 0], radius: 5 }),
    entityView(2, { kind: 'arc', center: [0, 10], radius: 5, start: [5, 10], end: [0, 15] }),
    entityView(3, { kind: 'point', point: [-5, -5] }),
  ]);

  it('grabs a line endpoint ahead of its own body', () => {
    const hit = solvedHitTest(model, [9.8, 0.1], 0.5, 0.5)!;
    expect(hit.type).toBe('vertex');
    expect(hit).toMatchObject({ entityId: 0, role: 'end' });
  });

  it('falls back to the line body between endpoints', () => {
    const hit = solvedHitTest(model, [5, 0.2], 0.5, 0.5)!;
    expect(hit).toMatchObject({ type: 'edge', entityId: 0, kind: 'line' });
  });

  it('hits the circle rim, not its interior', () => {
    expect(solvedHitTest(model, [25.2, 0], 0.1, 0.5)).toMatchObject({ type: 'edge', entityId: 1 });
    expect(solvedHitTest(model, [22, 0], 0.1, 0.5)).toBeNull();
  });

  it('grabs the circle center vertex', () => {
    const hit = solvedHitTest(model, [20.1, 0.1], 0.5, 0.5)!;
    expect(hit).toMatchObject({ type: 'vertex', entityId: 1, role: 'center' });
    expect((hit as any).ref).toEqual({ entity: 1, point: 'center' });
  });

  it('arc body only hits on the drawn sweep', () => {
    // Mid-sweep point (ccw quarter arc from [5,10] to [0,15]).
    const mid: [number, number] = [Math.SQRT1_2 * 5, 10 + Math.SQRT1_2 * 5];
    expect(solvedHitTest(model, mid, 0.1, 0.5)).toMatchObject({ type: 'edge', entityId: 2 });
    // Opposite side of the circle: not on the arc.
    expect(solvedHitTest(model, [-Math.SQRT1_2 * 5, 10 - Math.SQRT1_2 * 5], 0.1, 0.3)).toBeNull();
  });

  it('point entities hit as vertices with an entity-only ref', () => {
    const hit = solvedHitTest(model, [-5.1, -5], 0.5, 0.5)!;
    expect(hit).toMatchObject({ type: 'vertex', entityId: 3, role: null });
    expect((hit as any).ref).toEqual({ entity: 3 });
  });

  it('misses when outside every threshold', () => {
    expect(solvedHitTest(model, [50, 50], 1, 1)).toBeNull();
  });
});
