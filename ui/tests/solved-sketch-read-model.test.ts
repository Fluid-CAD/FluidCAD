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
  underconstrainedEntities: number[] | null;
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
    underconstrainedEntities: [],
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

  it('derives per-entity constrained ids from the underconstrained verdict', () => {
    const objects = [line(0, [0, 0], [10, 0]), line(1, [10, 0], [10, 8])];
    const { model } = glyphsOf(objects, snapshot({ dof: 4, underconstrainedEntities: [1] }));
    expect(model.constrainedEntityIds.has(0)).toBe(true);
    expect(model.constrainedEntityIds.has(1)).toBe(false);
  });

  it('never reads a missing or unsolved verdict as constrained', () => {
    const objects = [line(0, [0, 0], [10, 0])];
    const noVerdict = glyphsOf(objects, snapshot({ underconstrainedEntities: null }));
    expect(noVerdict.model.constrainedEntityIds.size).toBe(0);
    const unsolved = glyphsOf(objects, snapshot({ outcome: 'didnt-converge' }));
    expect(unsolved.model.constrainedEntityIds.size).toBe(0);
  });

  it('joins copy-instance duplicates via the snapshot params, flagged copyInstance', () => {
    const solver = snapshot({
      entities: [
        { id: 0, kind: 'line', fixed: false, paramOffset: 0 },
        // Solver-backed duplicates: free entities, geometry in the params.
        { id: 5, kind: 'line', fixed: false, paramOffset: 4 },
        { id: 6, kind: 'circle', fixed: false, paramOffset: 8 },
      ],
      params: [0, 0, 10, 0, 0, 20, 10, 20, 30, 40, 7],
      dof: 8,
    });
    const copy = child('copy-linear-2d', {
      sourceEntities: [0],
      sourcesSolved: true,
      // slot is the instance() slot (the original owns its own slot and is
      // NOT in this array); shapeIndex addresses the rendered sceneShapes.
      entities: [
        { entityId: 5, kind: 'line', slot: 1, shapeIndex: 0 },
        { entityId: 6, kind: 'circle', slot: 2, shapeIndex: 1 },
      ],
    });
    const model = buildSolvedSketchModel(sketchObj(solver), [
      line(0, [0, 0], [10, 0]),
      copy,
    ])!;

    const dup = model.entities.get(5)!;
    expect(dup.kind).toBe('line');
    expect(dup.start).toEqual([0, 20]);
    expect(dup.end).toEqual([10, 20]);
    expect(dup.copyInstance).toEqual({ slot: 1 });
    // Never the reference shape — duplicates are free, not fixed.
    expect(dup.reference).toBeUndefined();
    // The view carries the copy STATEMENT — its sourceLocation (with any
    // loop occurrence) rides every pick made on the duplicate.
    expect(dup.obj).toBe(copy);

    const dupCircle = model.entities.get(6)!;
    expect(dupCircle.center).toEqual([30, 40]);
    expect(dupCircle.radius).toBe(7);
    expect(dupCircle.copyInstance).toEqual({ slot: 2 });

    // The whole-object derived tint join keeps working alongside.
    expect(model.derivedProducers.get(copy.id!)).toEqual([0]);
  });

  it('joins derived-op duplicates to their source entities', () => {
    const copy = child('copy-linear-2d', { sourceEntities: [0, 1], sourcesSolved: true });
    const unvouched = child('mirror-shape-2d', { sourceEntities: [0], sourcesSolved: false });
    const { model } = glyphsOf([
      line(0, [0, 0], [10, 0]),
      line(1, [0, 5], [10, 5]),
      copy,
      unvouched,
    ], snapshot({ dof: 0 }));
    expect(model.derivedProducers.get(copy.id!)).toEqual([0, 1]);
    // An op the kernel could not fully vouch for stays out — no verdict.
    expect(model.derivedProducers.has(unvouched.id!)).toBe(false);
  });

  it('excludes conflict members from the constrained set', () => {
    const objects = [
      line(0, [0, 0], [10, 0]),
      line(1, [10, 0], [10, 8]),
      constraint('distance', 0, { kind: 'distance', a: { entity: 0, point: 'start' }, b: { entity: 0, point: 'end' }, value: 100 }, 100),
    ];
    const { model } = glyphsOf(objects, snapshot({ dof: 0, conflicting: [0] }));
    expect(model.constrainedEntityIds.has(0)).toBe(false);
    expect(model.constrainedEntityIds.has(1)).toBe(true);
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

  it('lays a distance dimension as a leader LIFTED off the edge it measures, label at its midpoint', () => {
    const objects = [
      line(0, [0, 0], [100, 0]),
      constraint('distance', 0, { kind: 'distance', a: { entity: 0, point: 'start' }, b: { entity: 0, point: 'end' }, value: 100 }, 100),
    ];
    const { glyphs } = glyphsOf(objects);
    const leader = glyphs.find(g => g.type === 'leader') as any;
    const text = glyphs.find(g => g.type === 'text') as any;
    // The span runs endpoint-to-endpoint of the line itself, so drawing it
    // in place would bury it under the edge: it lifts 12% of the span,
    // with dashed witnesses tying the lifted ends back to the vertices.
    const y = 100 * 0.12;
    expect(leader.from).toEqual([0, y]);
    expect(leader.to).toEqual([100, y]);
    expect(leader.extensions).toEqual([[[0, 0], [0, y]], [[100, 0], [100, y]]]);
    expect(text.label).toBe('100');
    expect(text.at).toEqual([50, y]);
  });

  it('draws a distance between free-standing points in place', () => {
    const objects = [
      line(0, [0, 0], [100, 0]),
      // A span between vertices of DIFFERENT lines, off any edge.
      line(1, [20, 30], [80, 60]),
      constraint('distance', 0, { kind: 'distance', a: { entity: 0, point: 'end' }, b: { entity: 1, point: 'start' }, value: 0 }, 0),
    ];
    const { glyphs } = glyphsOf(objects);
    const leader = glyphs.find(g => g.type === 'leader') as any;
    expect(leader.from).toEqual([100, 0]);
    expect(leader.to).toEqual([20, 30]);
    expect(leader.extensions).toBeUndefined();
  });

  it('lays a radius dimension as a center→rim leader, R label riding the line', () => {
    const objects = [
      circle(0, [10, 10], 10),
      constraint('radius', 0, { kind: 'radius', a: { entity: 0 }, value: 5 }, 5),
    ];
    const { glyphs } = glyphsOf(objects);
    const leader = glyphs.find(g => g.type === 'leader') as any;
    const text = glyphs.find(g => g.type === 'text') as any;
    expect(leader.from).toEqual([10, 10]);
    // Only the rim end measures anything, so only it carries an arrowhead.
    expect(leader.arrows).toBe('end');
    expect(text.label).toBe('R5');
    expect(text.style).toBe('aligned');
    // The value rides the radius: anchored halfway along it and aligned to
    // it, rather than orbiting the rim on the end of a stub.
    expect(text.at[0]).toBeCloseTo((10 + leader.to[0]) / 2, 9);
    expect(text.at[1]).toBeCloseTo((10 + leader.to[1]) / 2, 9);
    expect(Math.hypot(text.at[0] - 10, text.at[1] - 10)).toBeCloseTo(2.5, 9);
    expect(text.slideRange).toBeCloseTo(2.5, 9);
    expect(text.leader).toEqual([leader.from, leader.to]);
    const dir = [(leader.to[0] - 10) / 5, (leader.to[1] - 10) / 5];
    expect(text.alongDir[0]).toBeCloseTo(dir[0], 9);
    expect(text.alongDir[1]).toBeCloseTo(dir[1], 9);
    expect(text.offsetDir[0] * dir[0] + text.offsetDir[1] * dir[1]).toBeCloseTo(0, 9);
  });

  it('lays a diameter dimension as a full chord, ⌀ label riding the line', () => {
    const objects = [
      circle(0, [10, 10], 10),
      constraint('diameter', 0, { kind: 'diameter', a: { entity: 0 }, value: 10 }, 10),
    ];
    const { glyphs } = glyphsOf(objects);
    const leader = glyphs.find(g => g.type === 'leader') as any;
    const text = glyphs.find(g => g.type === 'text') as any;
    // Rim to rim through the center — a leader that stops at the center
    // reads as a radius however the label is spelled.
    expect(Math.hypot(leader.from[0] - 10, leader.from[1] - 10)).toBeCloseTo(5, 9);
    expect(Math.hypot(leader.to[0] - 10, leader.to[1] - 10)).toBeCloseTo(5, 9);
    expect((leader.from[0] + leader.to[0]) / 2).toBeCloseTo(10, 9);
    expect((leader.from[1] + leader.to[1]) / 2).toBeCloseTo(10, 9);

    expect(text.label).toBe('⌀10');
    expect(text.style).toBe('aligned');
    // The value rides the chord: anchored ON the line, sliding along it,
    // pushed only across it — never pushed out past the rim.
    expect(text.at[0]).toBeCloseTo(10, 9);
    expect(text.at[1]).toBeCloseTo(10, 9);
    expect(text.slideRange).toBeCloseTo(5, 9);
    expect(text.leader).toEqual([leader.from, leader.to]);
    const dir = [(leader.to[0] - leader.from[0]) / 10, (leader.to[1] - leader.from[1]) / 10];
    expect(text.alongDir[0]).toBeCloseTo(dir[0], 9);
    expect(text.alongDir[1]).toBeCloseTo(dir[1], 9);
    expect(text.offsetDir[0] * dir[0] + text.offsetDir[1] * dir[1]).toBeCloseTo(0, 9);
  });

  it('aims the diameter chord away from what is inside the circle', () => {
    const objects = [
      circle(0, [0, 0], 20),
      // Clips the right of the circle — straight across the default 45°
      // chord, clear of the ones tilted further up.
      line(1, [5, -10], [5, 10]),
      constraint('diameter', 0, { kind: 'diameter', a: { entity: 0 }, value: 20 }, 20),
    ];
    const { glyphs } = glyphsOf(objects);
    const leader = glyphs.find(g => g.type === 'leader') as any;
    expect(Math.abs(leader.from[0])).toBeLessThan(5);
    expect(Math.abs(leader.to[0])).toBeLessThan(5);
  });

  it('fans concentric diameters apart instead of drawing one line for both', () => {
    const objects = [
      circle(0, [0, 0], 10),
      circle(1, [0, 0], 20),
      constraint('diameter', 0, { kind: 'diameter', a: { entity: 0 }, value: 10 }, 10),
      constraint('diameter', 1, { kind: 'diameter', a: { entity: 1 }, value: 20 }, 20),
    ];
    const { glyphs } = glyphsOf(objects);
    const [inner, outer] = glyphs.filter(g => g.type === 'leader') as any[];
    const angle = (g: any): number => Math.atan2(g.to[1] - g.from[1], g.to[0] - g.from[0]);
    expect(Math.abs(angle(outer) - angle(inner))).toBeGreaterThan(0.4);
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
    // Both segments extend along their sector rays — no extension
    // leaders, no tail stubs.
    expect(arc.extensions).toEqual([]);
    expect(arc.tails).toEqual([]);
  });

  it('draws dashed extension leaders when the segments stop short of the intersection', () => {
    const objects = [
      line(0, [0, 0], [40, 0]),
      line(1, [100, 80], [100, 20]),
      constraint('angle', 0, { kind: 'angle', a: { entity: 0 }, b: { entity: 1 }, value: Math.PI / 2 }, 90),
    ];
    const { glyphs } = glyphsOf(objects);
    const arc = glyphs[0] as any;
    expect(arc.type).toBe('angle-arc');
    expect(arc.at).toEqual([100, 0]);
    // Each extension runs from the segment's NEAREST endpoint to the
    // virtual intersection.
    expect(arc.extensions).toEqual([
      [[40, 0], [100, 0]],
      [[100, 20], [100, 0]],
    ]);
    // Neither segment covers its sector-boundary ray — both arc ends get
    // dashed tail stubs (along +da and +db).
    expect(arc.tails).toEqual([0, -Math.PI / 2]);
  });

  it('starts the angle arc on the ORIENTED ray — a start-point ref reverses its line', () => {
    const objects = [
      line(0, [0, 0], [100, 0]),
      line(1, [0, 0], [0, -80]),
      constraint('angle', 0, {
        kind: 'angle',
        a: { entity: 0, point: 'start' },
        b: { entity: 1 },
        value: Math.PI / 2,
      }, 90),
    ];
    const { glyphs } = glyphsOf(objects);
    const arc = glyphs[0] as any;
    expect(arc.type).toBe('angle-arc');
    // a oriented toward its start points at −x: the arc starts at ±180°
    // (atan2 of the negated axis) and sweeps CCW by 90° into the sector
    // between −x and −y, where b is.
    expect(Math.abs(arc.startAngle)).toBeCloseTo(Math.PI, 9);
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

  // Stacking itself moved to the screen-space declutterer (P5.5); the glyph
  // pass only has to hand it a shared anchor and the edge's two axes.
  it('gives badges sharing an anchor the same anchor and an along-edge axis', () => {
    const objects = [
      line(0, [0, 0], [100, 0]),
      line(1, [0, 0], [100, 0]),
      constraint('horizontal', 0, { kind: 'horizontal', a: { entity: 0 } }),
      constraint('equal', 1, { kind: 'equal', a: { entity: 0 }, b: { entity: 1 } }),
    ];
    const { glyphs } = glyphsOf(objects);
    const atMid = glyphs.filter(g => g.type === 'badge' && (g as any).at[0] === 50) as any[];
    expect(atMid.length).toBeGreaterThan(1);
    for (const badge of atMid) {
      expect(badge.at).toEqual([50, 0]);
      // Row axis runs ALONG the line, offset axis across it.
      expect(Math.abs(badge.alongDir[0])).toBeCloseTo(1, 9);
      expect(Math.abs(badge.offsetDir[1])).toBeCloseTo(1, 9);
    }
  });

  it('ranks visually-obvious constraints as the first to collapse', () => {
    const objects = [
      line(0, [0, 0], [100, 0]),
      circle(1, [50, 20], 20),
      constraint('horizontal', 0, { kind: 'horizontal', a: { entity: 0 } }),
      constraint('tangent', 1, { kind: 'tangent', a: { entity: 0 }, b: { entity: 1 } }),
    ];
    const { glyphs } = glyphsOf(objects);
    const rank = new Map(glyphs.map(g => [(g as any).label, (g as any).rank]));
    expect(rank.get('T')).toBeLessThan(rank.get('H'));
  });

  it('gives dimension labels a slide axis along their leader', () => {
    const objects = [
      line(0, [0, 0], [100, 0]),
      constraint('distance', 0, {
        kind: 'distance',
        a: { entity: 0, point: 'start' },
        b: { entity: 0, point: 'end' },
        value: 100,
      }, 100),
    ];
    const { glyphs } = glyphsOf(objects);
    const text = glyphs.find(g => g.type === 'text') as any;
    expect(text.style).toBe('span');
    expect(text.slideRange).toBeCloseTo(50, 9);
    expect(Math.abs(text.alongDir[0])).toBeCloseTo(1, 9);
    // The label rides the LIFTED leader (the span lies on the line itself).
    const y = 100 * 0.12;
    expect(text.leader).toEqual([[0, y], [100, y]]);
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
    // The x span runs along the (horizontal) line itself, so it lifts.
    const y = 25 + 50 * 0.12;
    expect(leaders[0].from).toEqual([30, y]);
    expect(leaders[0].to).toEqual([80, y]);
    // The degenerate y span has no length to ride anything — in place.
    expect(leaders[1].from).toEqual([30, 25]);
    expect(leaders[1].to).toEqual([30, 25]);
  });
});

describe('fixed reference entities (P6)', () => {
  it('joins projection children via the snapshot params, flagged reference', () => {
    const solver = snapshot({
      entities: [
        // Datums occupy the reserved negative ids.
        { id: -1, kind: 'point', fixed: true, paramOffset: 0 },
        { id: -2, kind: 'line', fixed: true, paramOffset: 2 },
        { id: -3, kind: 'line', fixed: true, paramOffset: 6 },
        { id: 0, kind: 'circle', fixed: true, paramOffset: 10 },
        { id: 1, kind: 'line', fixed: false, paramOffset: 13 },
      ],
      params: [0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 5, 7, 20, 30, -10, 30, 40],
      dof: 4,
    });
    const projection = child('projection', {
      objectIds: [],
      entities: [{ entityId: 0, kind: 'circle', edgeIndex: 0 }],
      edgeCount: 1,
    });
    const model = buildSolvedSketchModel(sketchObj(solver), [
      sketchObj(solver),
      projection,
      child('solved-line', { entityId: 1, start: { x: 30, y: -10 }, end: { x: 30, y: 40 } }),
    ])!;

    const ref = model.entities.get(0)!;
    expect(ref.kind).toBe('circle');
    expect(ref.center).toEqual([5, 7]);
    expect(ref.radius).toBe(20);
    // Single-entity producer → the terse direct emission form.
    expect(ref.reference).toEqual({ refIndex: null, producer: 'project' });

    // The free line still joins normally.
    expect(model.entities.get(1)!.reference).toBeUndefined();

    // The producer statement maps to its fixed entities — the mesh tints
    // its edges constrained (locked geometry cannot move).
    expect(model.referenceProducers.get(projection.id!)).toEqual([0]);
  });

  it('multi-edge producers carry their .ref(i) index', () => {
    const solver = snapshot({
      entities: [
        { id: 0, kind: 'line', fixed: true, paramOffset: 0 },
        { id: 1, kind: 'line', fixed: true, paramOffset: 4 },
      ],
      params: [0, 0, 10, 0, 10, 0, 10, 10],
    });
    const model = buildSolvedSketchModel(sketchObj(solver), [
      sketchObj(solver),
      child('intersect', {
        objectIds: [],
        entities: [
          { entityId: 0, kind: 'line', edgeIndex: 0 },
          { entityId: 1, kind: 'line', edgeIndex: 1 },
        ],
        edgeCount: 2,
      }),
    ])!;

    expect(model.entities.get(0)!.reference).toEqual({ refIndex: 0, producer: 'intersect' });
    expect(model.entities.get(1)!.reference).toEqual({ refIndex: 1, producer: 'intersect' });
    expect(model.entities.get(1)!.start).toEqual([10, 0]);
    expect(model.entities.get(1)!.end).toEqual([10, 10]);
  });
});

describe('anchor-point entities (P8)', () => {
  it('joins ellipse/text anchors via entityId and bezier control points via anchors[]', () => {
    const solver = snapshot({
      entities: [
        { id: 0, kind: 'point', fixed: false, paramOffset: 0 },  // ellipse center
        { id: 1, kind: 'point', fixed: false, paramOffset: 2 },  // text anchor
        { id: 2, kind: 'point', fixed: false, paramOffset: 4 },  // bezier cp 0
        { id: 3, kind: 'point', fixed: false, paramOffset: 6 },  // bezier cp 2
      ],
      params: [40, 25, 5, 7, 0, 0, 100, 0],
      dof: 8,
      underconstrainedEntities: [0, 1, 2, 3],
    });
    const ellipseObj = child('ellipse', {
      rx: 20, ry: 10, center: { x: 40, y: 25 },
      entityId: 0, guess: { center: { x: 3, y: 4 } },
    });
    const textObj = child('text', {
      text: 'Hi', entityId: 1,
      anchor: { x: 5, y: 7 }, guess: { anchor: { x: 5, y: 7 } },
    });
    const bezierObj = child('bezier-3', {
      startPoint: [0, 0], resolvedPoints: [[50, 50], [100, 0]],
      anchors: [
        { pointIndex: 0, entityId: 2, guess: { x: 0, y: 0 } },
        { pointIndex: 2, entityId: 3, guess: { x: 100, y: 0 } },
      ],
    });
    const model = buildSolvedSketchModel(sketchObj(solver), [
      sketchObj(solver), ellipseObj, textObj, bezierObj,
    ])!;

    const center = model.entities.get(0)!;
    expect(center.kind).toBe('point');
    expect(center.point).toEqual([40, 25]);
    expect(center.anchor).toEqual({ owner: 'ellipse', pointIndex: 0 });
    expect(center.guess).toEqual({ point: [3, 4] });
    expect(center.obj).toBe(ellipseObj);

    const anchor = model.entities.get(1)!;
    expect(anchor.point).toEqual([5, 7]);
    expect(anchor.anchor).toEqual({ owner: 'text', pointIndex: 0 });

    const cp0 = model.entities.get(2)!;
    const cp2 = model.entities.get(3)!;
    expect(cp0.anchor).toEqual({ owner: 'bezier', pointIndex: 0 });
    expect(cp0.point).toEqual([0, 0]);
    expect(cp2.anchor).toEqual({ owner: 'bezier', pointIndex: 2 });
    expect(cp2.point).toEqual([100, 0]);
    expect(cp2.guess).toEqual({ point: [100, 0] });
    // All statements share the bezier object so its sourceLocation rides picks.
    expect(cp0.obj).toBe(bezierObj);
  });

  it('joins the bezier curve and path text into the derived tint (sourcesSolved)', () => {
    const solver = snapshot({
      entities: [
        { id: 0, kind: 'point', fixed: false, paramOffset: 0 },
        { id: 1, kind: 'point', fixed: false, paramOffset: 2 },
      ],
      params: [0, 0, 100, 0],
    });
    const bezierObj = child('bezier-2', {
      startPoint: [0, 0], resolvedPoints: [[100, 0]],
      anchors: [
        { pointIndex: 0, entityId: 0, guess: { x: 0, y: 0 } },
        { pointIndex: 1, entityId: 1, guess: { x: 100, y: 0 } },
      ],
      sourceEntities: [0, 1],
      sourcesSolved: true,
    });
    const pathText = child('text', {
      text: 'Hi', sourceEntities: [0, 1], sourcesSolved: true,
    });
    const model = buildSolvedSketchModel(sketchObj(solver), [
      sketchObj(solver), bezierObj, pathText,
    ])!;
    // The curve and the glyphs wear their sources' verdict.
    expect(model.derivedProducers.get(bezierObj.id!)).toEqual([0, 1]);
    expect(model.derivedProducers.get(pathText.id!)).toEqual([0, 1]);
    // Path text has no anchor entity of its own.
    expect(model.entities.size).toBe(2);
  });

  it('ignores path text and legacy payloads without join fields', () => {
    const solver = snapshot({ entities: [], params: [] });
    const model = buildSolvedSketchModel(sketchObj(solver), [
      sketchObj(solver),
      child('text', { text: 'Hi' }),          // path form: no entityId
      child('ellipse', { rx: 5, ry: 3 }),     // legacy: no entityId
      child('bezier-2', { startPoint: [0, 0], resolvedPoints: [[1, 1]] }),
    ])!;
    expect(model.entities.size).toBe(0);
  });
});
