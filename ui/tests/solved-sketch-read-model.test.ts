import { describe, it, expect } from 'vitest';
import {
  buildSolvedSketchModel,
  computeSketchDofState,
  isSolvedSketch,
  layoutConstraintGlyphs,
} from '../src/sketch-solver-client';
import type { SceneObjectRender } from '../src/types';

// ---------------------------------------------------------------------------
// Payload builders — the exact shapes the kernel serializes (P2):
// sketch: { plane, solvedMode, solver }, entities: { entityId, ...geometry },
// constraints: { kind, constraintId, spec, value }.
// ---------------------------------------------------------------------------

const PLANE = {
  origin: { x: 0, y: 0, z: 0 },
  center: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  xDirection: { x: 1, y: 0, z: 0 },
  yDirection: { x: 0, y: 1, z: 0 },
};

type Snapshot = {
  entities: { id: number; kind: string; fixed: boolean; paramOffset: number }[];
  constraints: { id: number; internal: boolean; spec: any }[];
  params: number[];
  outcome: string | null;
  dof: number | null;
  conflicting: number[];
  redundant: number[];
};

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    entities: [],
    constraints: [],
    params: [],
    outcome: 'solved',
    dof: 0,
    conflicting: [],
    redundant: [],
    ...overrides,
  };
}

function sketchObj(solver: Snapshot | null): SceneObjectRender {
  return {
    id: 'sketch-1',
    type: 'sketch',
    uniqueType: 'sketch',
    object: { plane: PLANE, solvedMode: true, solver },
    sceneShapes: [],
    ownShapes: [],
  } as SceneObjectRender;
}

let nextId = 0;

function child(uniqueType: string, object: any, extra: Partial<SceneObjectRender> = {}): SceneObjectRender {
  nextId += 1;
  return {
    id: `obj-${nextId}`,
    parentId: 'sketch-1',
    type: uniqueType.startsWith('constraint-') ? uniqueType.slice('constraint-'.length) : uniqueType,
    uniqueType,
    object,
    sceneShapes: [],
    ownShapes: [],
    sourceLocation: { filePath: '/w/part.fluid.js', line: nextId + 10, column: 1 },
    ...extra,
  } as SceneObjectRender;
}

function line(entityId: number, start: [number, number], end: [number, number]): SceneObjectRender {
  return child('solved-line', {
    entityId,
    start: { x: start[0], y: start[1] },
    end: { x: end[0], y: end[1] },
  });
}

function circle(entityId: number, center: [number, number], diameter: number): SceneObjectRender {
  return child('solved-circle', {
    entityId,
    center: { x: center[0], y: center[1] },
    diameter,
  });
}

function constraint(kind: string, constraintId: number, spec: any, value?: number): SceneObjectRender {
  return child(`constraint-${kind}`, { kind, constraintId, spec, value });
}

function glyphsOf(objects: SceneObjectRender[], solver: Snapshot | null = snapshot()) {
  const sketch = sketchObj(solver);
  const model = buildSolvedSketchModel(sketch, objects)!;
  return { model, glyphs: layoutConstraintGlyphs(model) };
}

// ---------------------------------------------------------------------------

describe('solved sketch read model', () => {
  it('recognizes solved sketches only', () => {
    expect(isSolvedSketch(sketchObj(snapshot()))).toBe(true);
    const legacy = { type: 'sketch', object: { plane: PLANE }, sceneShapes: [], ownShapes: [] } as SceneObjectRender;
    expect(isSolvedSketch(legacy)).toBe(false);
    expect(buildSolvedSketchModel(legacy, [])).toBeNull();
  });

  it('joins entities and constraints and derives statuses from the snapshot', () => {
    const objects = [
      line(0, [0, 0], [100, 0]),
      line(1, [100, 0], [100, 50]),
      constraint('horizontal', 0, { kind: 'horizontal', a: { entity: 0 } }),
      constraint('distance', 1, { kind: 'distance', a: { entity: 0, point: 'start' }, b: { entity: 0, point: 'end' }, value: 100 }, 100),
    ];
    const { model } = glyphsOf(objects, snapshot({ dof: 3, conflicting: [1], redundant: [0], outcome: 'solved' }));

    expect(model.entities.size).toBe(2);
    expect(model.entities.get(0)!.start).toEqual([0, 0]);
    expect(model.constraints).toHaveLength(2);
    expect(model.constraints[0].status).toBe('redundant');
    expect(model.constraints[1].status).toBe('conflicting');
    // Members of the conflicting distance are tinted.
    expect(model.conflictingEntityIds.has(0)).toBe(true);
    expect(model.conflictingEntityIds.has(1)).toBe(false);
    expect(model.fullyConstrained).toBe(false);
  });

  it('maps internal (negative-id) conflicts to the owning entity', () => {
    const objects = [line(0, [0, 0], [10, 0])];
    const solver = snapshot({
      conflicting: [-1],
      constraints: [{ id: -1, internal: true, spec: { kind: 'arc-consistency', entity: 0 } }],
    });
    const { model } = glyphsOf(objects, solver);
    expect(model.conflictingEntityIds.has(0)).toBe(true);
  });

  it('is fully constrained only at 0 DOF, solved, without conflicts', () => {
    const objects = [line(0, [0, 0], [10, 0])];
    expect(glyphsOf(objects, snapshot({ dof: 0 })).model.fullyConstrained).toBe(true);
    expect(glyphsOf(objects, snapshot({ dof: 2 })).model.fullyConstrained).toBe(false);
    expect(glyphsOf(objects, snapshot({ dof: 0, outcome: 'singular' })).model.fullyConstrained).toBe(false);
    expect(glyphsOf(objects, snapshot({ dof: 0, conflicting: [7] })).model.fullyConstrained).toBe(false);
  });
});

describe('constraint glyph layout', () => {
  it('places an H badge at the line midpoint, offset perpendicular', () => {
    const objects = [
      line(0, [0, 0], [100, 0]),
      constraint('horizontal', 0, { kind: 'horizontal', a: { entity: 0 } }),
    ];
    const { glyphs } = glyphsOf(objects);
    expect(glyphs).toHaveLength(1);
    const badge = glyphs[0] as any;
    expect(badge.type).toBe('badge');
    expect(badge.label).toBe('H');
    expect(badge.at).toEqual([50, 0]);
    expect(Math.abs(badge.offsetDir[0])).toBeCloseTo(0, 9);
    expect(Math.abs(badge.offsetDir[1])).toBeCloseTo(1, 9);
    expect(badge.refEntityIds).toEqual([0]);
  });

  it('renders point-point coincidence as one deduped dot at the shared point', () => {
    const objects = [
      line(0, [0, 0], [100, 0]),
      line(1, [100, 0], [100, 50]),
      constraint('coincident', 0, { kind: 'coincident', a: { entity: 0, point: 'end' }, b: { entity: 1, point: 'start' } }),
      constraint('coincident', 1, { kind: 'coincident', a: { entity: 1, point: 'start' }, b: { entity: 0, point: 'end' } }),
    ];
    const { glyphs } = glyphsOf(objects);
    const dots = glyphs.filter(g => g.type === 'dot') as any[];
    expect(dots).toHaveLength(1);
    expect(dots[0].at).toEqual([100, 0]);
  });

  it('renders point-on-entity coincidence as the ⊙ badge at the point', () => {
    const objects = [
      line(0, [0, 0], [100, 0]),
      circle(1, [50, 30], 20),
      constraint('coincident', 0, { kind: 'coincident', a: { entity: 0, point: 'end' }, b: { entity: 1 } }),
    ];
    const { glyphs } = glyphsOf(objects);
    expect(glyphs).toHaveLength(1);
    const badge = glyphs[0] as any;
    expect(badge.type).toBe('badge');
    expect(badge.label).toBe('⊙');
    expect(badge.at).toEqual([100, 0]);
  });

  it('lays a distance dimension as leader plus midpoint label', () => {
    const objects = [
      line(0, [0, 0], [100, 0]),
      constraint('distance', 0, { kind: 'distance', a: { entity: 0, point: 'start' }, b: { entity: 0, point: 'end' }, value: 100 }, 100),
    ];
    const { glyphs } = glyphsOf(objects);
    const leader = glyphs.find(g => g.type === 'leader') as any;
    const text = glyphs.find(g => g.type === 'text') as any;
    expect(leader.from).toEqual([0, 0]);
    expect(leader.to).toEqual([100, 0]);
    expect(text.label).toBe('100');
    expect(text.at).toEqual([50, 0]);
  });

  it('lays a radius dimension as center leader plus R label on the rim', () => {
    const objects = [
      circle(0, [10, 10], 10),
      constraint('radius', 0, { kind: 'radius', a: { entity: 0 }, value: 5 }, 5),
    ];
    const { glyphs } = glyphsOf(objects);
    const leader = glyphs.find(g => g.type === 'leader') as any;
    const text = glyphs.find(g => g.type === 'text') as any;
    expect(leader.from).toEqual([10, 10]);
    expect(text.label).toBe('R5');
    const rimDist = Math.hypot(text.at[0] - 10, text.at[1] - 10);
    expect(rimDist).toBeCloseTo(5, 9);
  });

  it('lays an angle dimension as an arc at the line intersection', () => {
    const objects = [
      line(0, [0, 0], [100, 0]),
      line(1, [0, 0], [0, 80]),
      constraint('angle', 0, { kind: 'angle', a: { entity: 0 }, b: { entity: 1 }, value: Math.PI / 2 }, 90),
    ];
    const { glyphs } = glyphsOf(objects);
    expect(glyphs).toHaveLength(1);
    const arc = glyphs[0] as any;
    expect(arc.type).toBe('angle-arc');
    expect(arc.at[0]).toBeCloseTo(0, 9);
    expect(arc.at[1]).toBeCloseTo(0, 9);
    expect(arc.label).toBe('90°');
    expect(arc.sweep).toBeCloseTo(Math.PI / 2, 9);
  });

  it('falls back to a text readout for near-parallel angle members', () => {
    const objects = [
      line(0, [0, 0], [100, 0]),
      line(1, [0, 10], [100, 10]),
      constraint('angle', 0, { kind: 'angle', a: { entity: 0 }, b: { entity: 1 }, value: 0 }, 0),
    ];
    const { glyphs } = glyphsOf(objects);
    expect(glyphs).toHaveLength(1);
    expect(glyphs[0].type).toBe('text');
  });

  it('stacks badges sharing an anchor', () => {
    const objects = [
      line(0, [0, 0], [100, 0]),
      line(1, [0, 0], [100, 0]),
      constraint('horizontal', 0, { kind: 'horizontal', a: { entity: 0 } }),
      constraint('equal', 1, { kind: 'equal', a: { entity: 0 }, b: { entity: 1 } }),
    ];
    const { glyphs } = glyphsOf(objects);
    const atMid = glyphs.filter(g => g.type === 'badge' && (g as any).at[0] === 50) as any[];
    const indices = atMid.map(g => g.stackIndex).sort();
    expect(new Set(indices).size).toBe(atMid.length);
  });

  it('carries diagnostic colors onto glyphs', () => {
    const objects = [
      line(0, [0, 0], [100, 0]),
      constraint('horizontal', 0, { kind: 'horizontal', a: { entity: 0 } }),
      constraint('vertical', 1, { kind: 'vertical', a: { entity: 0 } }),
      constraint('equal', 2, { kind: 'equal', a: { entity: 0 }, b: { entity: 0 } }),
    ];
    const { glyphs } = glyphsOf(objects, snapshot({ conflicting: [1], redundant: [2] }));
    const byLabel = new Map(glyphs.map(g => [(g as any).label, g.color]));
    expect(byLabel.get('H')).toBe('normal');
    expect(byLabel.get('V')).toBe('conflict');
    expect(byLabel.get('=')).toBe('redundant');
  });
});

describe('sketch DOF pill state', () => {
  it('hides for legacy sketches and empty solved sketches', () => {
    expect(computeSketchDofState(null)).toEqual({ result: 'hidden' });
    const empty = buildSolvedSketchModel(sketchObj(snapshot()), [])!;
    expect(computeSketchDofState(empty)).toEqual({ result: 'hidden' });
  });

  it('reports remaining DOF with the redundant count', () => {
    const model = buildSolvedSketchModel(sketchObj(snapshot({ dof: 3, redundant: [4] })), [
      line(0, [0, 0], [10, 0]),
    ])!;
    expect(computeSketchDofState(model)).toEqual({ result: 'under', dof: 3, redundant: 1 });
  });

  it('reports fully constrained at 0 DOF', () => {
    const model = buildSolvedSketchModel(sketchObj(snapshot({ dof: 0 })), [
      line(0, [0, 0], [10, 0]),
    ])!;
    expect(computeSketchDofState(model)).toEqual({ result: 'constrained', redundant: 0 });
  });

  it('lists conflicting statements with their source lines', () => {
    const distance = constraint('distance', 0, { kind: 'distance', a: { entity: 0, point: 'start' }, b: { entity: 0, point: 'end' }, value: 100 }, 100);
    const model = buildSolvedSketchModel(sketchObj(snapshot({ conflicting: [0] })), [
      line(0, [0, 0], [10, 0]),
      distance,
    ])!;
    const state = computeSketchDofState(model);
    expect(state.result).toBe('conflict');
    if (state.result === 'conflict') {
      expect(state.failed).toHaveLength(1);
      expect(state.failed[0].label).toBe(`distance (line ${distance.sourceLocation!.line})`);
      expect(state.failed[0].sourceLocation).toEqual(distance.sourceLocation);
    }
  });

  it('names the owning entity for internal conflicts', () => {
    const arcLine = line(0, [0, 0], [10, 0]);
    const solver = snapshot({
      conflicting: [-1],
      constraints: [{ id: -1, internal: true, spec: { kind: 'arc-consistency', entity: 0 } }],
    });
    const model = buildSolvedSketchModel(sketchObj(solver), [arcLine])!;
    const state = computeSketchDofState(model);
    expect(state.result).toBe('conflict');
    if (state.result === 'conflict') {
      expect(state.failed[0].sourceLocation).toEqual(arcLine.sourceLocation);
    }
  });

  it('surfaces non-converged outcomes without named conflicts', () => {
    const model = buildSolvedSketchModel(sketchObj(snapshot({ outcome: 'didnt-converge', dof: 0 })), [
      line(0, [0, 0], [10, 0]),
    ])!;
    expect(computeSketchDofState(model)).toEqual({ result: 'unsolved', outcome: 'didnt-converge' });
  });
});

describe('axis-locked distance leaders', () => {
  it('draws x/y distances axis-aligned from the first point', () => {
    const objects = [
      line(0, [30, 25], [80, 25]),
      constraint('distance', 0, { kind: 'distance', a: { entity: 0, point: 'start' }, b: { entity: 0, point: 'end' }, value: 50, axis: 'x' }, 50),
      constraint('distance', 1, { kind: 'distance', a: { entity: 0, point: 'start' }, b: { entity: 0, point: 'end' }, value: 0, axis: 'y' }, 0),
    ];
    const { glyphs } = glyphsOf(objects);
    const leaders = glyphs.filter(g => g.type === 'leader') as any[];
    expect(leaders[0].from).toEqual([30, 25]);
    expect(leaders[0].to).toEqual([80, 25]);
    expect(leaders[1].from).toEqual([30, 25]);
    expect(leaders[1].to).toEqual([30, 25]);
  });
});
