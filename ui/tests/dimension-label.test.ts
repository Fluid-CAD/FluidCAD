import { describe, it, expect } from 'vitest';
import {
  buildSolvedSketchModel,
  dimensionFrame,
  labelAttach,
  labelCenter,
  labelCoordsForCenter,
  labelCoordsOf,
  layoutConstraintGlyphs,
  placedDimension,
  readingSide,
} from '../src/sketch-solver-client';
import type {
  AngularFrame, DimensionFrame, LabelCoords, RadialFrame, SpanFrame,
} from '../src/sketch-solver-client';
import { declutterAnnotations, GeometryIndex } from '../src/sketch-solver-client/declutter';
import type { DimensionItem, Pt } from '../src/sketch-solver-client/declutter';
import { boxReach, placedLabelOffsetPx, PLACED_LABEL_GAP_PX } from '../src/meshes/containers/glyph-box';
import type { SceneObjectRender } from '../src/types';

// ---------------------------------------------------------------------------
// `.labelAt(u, v)`: a dimension's value parked where the user dragged it.
//
// Everything below the sprite layer is pure sketch-plane math — no camera,
// no Three, no DOM — so the frames, the placed geometry and the drag's
// cursor→placement inversion are all checked from plain numbers.
// ---------------------------------------------------------------------------

type V2 = [number, number];

function close(actual: V2, expected: V2, digits = 9): void {
  expect(actual[0]).toBeCloseTo(expected[0], digits);
  expect(actual[1]).toBeCloseTo(expected[1], digits);
}

const HORIZONTAL: SpanFrame = {
  type: 'span', from: [0, 0], to: [100, 0], toAnchor: [100, 0], arrows: 'both', aligned: false,
};
/** The same span, measured the other way round. */
const REVERSED: SpanFrame = { ...HORIZONTAL, from: [100, 0], to: [0, 0], toAnchor: [0, 0] };
const VERTICAL: SpanFrame = { ...HORIZONTAL, from: [0, 0], to: [0, 60], toAnchor: [0, 60] };
const CIRCLE: RadialFrame = { type: 'radial', center: [10, 20], radius: 10, diameter: false };
const DIAMETER: RadialFrame = { ...CIRCLE, diameter: true };
/** A quarter arc from 0° to 90° around the origin. */
const QUARTER_ARC: RadialFrame = {
  type: 'radial', center: [0, 0], radius: 10, diameter: false, arc: { a0: 0, sweep: Math.PI / 2 },
};
/** A right angle at (5, 5): from the +x ray to the +y ray. */
const RIGHT_ANGLE: AngularFrame = { type: 'angular', at: [5, 5], startAngle: 0, sweep: Math.PI / 2 };

/** A fixed clearance, the way an aligned (rolled) label reaches. */
const flat = (k: number) => () => k;

describe('label frames', () => {
  it('span: u runs along the measured span from its middle, v off it', () => {
    close(labelAttach(HORIZONTAL, [0, 0]), [50, 0]);
    close(labelAttach(HORIZONTAL, [20, 12]), [70, 12]);
    close(labelAttach(HORIZONTAL, [-60, -8]), [-10, -8]);
    // The frame turns with the span: `v` is always off it, never "sketch y".
    close(labelAttach(VERTICAL, [10, 12]), [-12, 40]);
  });

  it('radial: (u, v) from the center, along the sketch axes', () => {
    close(labelAttach(CIRCLE, [3, -4]), [13, 16]);
  });

  it('angular: u out along the bisector from the corner, v to its side', () => {
    const r = Math.SQRT1_2;
    close(labelAttach(RIGHT_ANGLE, [10, 0]), [5 + 10 * r, 5 + 10 * r]);
    close(labelAttach(RIGHT_ANGLE, [0, 10]), [5 - 10 * r, 5 + 10 * r]);
  });

  it('round-trips a point through every frame', () => {
    const frames: DimensionFrame[] = [HORIZONTAL, REVERSED, VERTICAL, CIRCLE, QUARTER_ARC, RIGHT_ANGLE];
    const coords: LabelCoords[] = [[0, 0], [12.5, -7], [-40, 33], [0.01, 250]];
    for (const frame of frames) {
      for (const c of coords) {
        close(labelCoordsOf(frame, labelAttach(frame, c)), c);
      }
    }
  });

  it('follows the geometry: the same placement on a moved, turned span', () => {
    const coords: LabelCoords = [10, 15];
    // Translated by (30, 40) and turned a quarter turn about its start.
    const moved: SpanFrame = { ...HORIZONTAL, from: [30, 40], to: [30, 140], toAnchor: [30, 140] };
    // 10 past the middle along the (now vertical) span, 15 off it.
    close(labelAttach(moved, coords), [15, 100]);
  });
});

describe('reading side', () => {
  it('puts a value above its line, and left of a vertical one', () => {
    expect(readingSide([0, 1])).toBe(1);
    expect(readingSide([0, -1])).toBe(-1);
    expect(readingSide([-1, 0])).toBe(1);
    expect(readingSide([1, 0])).toBe(-1);
    expect(readingSide([0.6, 0.8])).toBe(1);
    expect(readingSide([-0.6, -0.8])).toBe(-1);
  });

  it('does not depend on which way the span was measured', () => {
    close(placedDimension(HORIZONTAL, [0, 5])!.push, [0, 1]);
    close(placedDimension(REVERSED, [0, 5])!.push, [0, 1]);
    close(placedDimension(VERTICAL, [0, 5])!.push, [-1, 0]);
  });
});

describe('placed span dimensions', () => {
  it('shifts the dimension line off the span and ties it back with witnesses', () => {
    const placed = placedDimension(HORIZONTAL, [0, 12])!;
    close(placed.attach, [50, 12]);
    expect(placed.line!.from).toEqual([0, 12]);
    expect(placed.line!.to).toEqual([100, 12]);
    expect(placed.line!.arrows).toBe('both');
    expect(placed.line!.witnesses).toEqual([[[0, 0], [0, 12]], [[100, 0], [100, 12]]]);
    expect(placed.line!.tail).toBeUndefined();
    close(placed.along, [1, 0]);
  });

  it('draws in place, without witnesses, on the span itself', () => {
    const placed = placedDimension(HORIZONTAL, [10, 0])!;
    expect(placed.line!.from).toEqual([0, 0]);
    expect(placed.line!.to).toEqual([100, 0]);
    expect(placed.line!.witnesses).toEqual([]);
  });

  it('runs a tail out to a value parked beyond either end', () => {
    const past = placedDimension(HORIZONTAL, [70, 12])!;
    expect(past.line!.tail).toEqual([[100, 12], [120, 12]]);
    const before = placedDimension(HORIZONTAL, [-80, 12])!;
    expect(before.line!.tail).toEqual([[0, 12], [-30, 12]]);
    // Exactly on the end is still on the line.
    expect(placedDimension(HORIZONTAL, [50, 12])!.line!.tail).toBeUndefined();
  });

  it('ties an axis-locked span back to the real second point', () => {
    // distance(a, b, v, 'x') with a = (0, 0), b = (100, 30): the span ends
    // on the synthetic corner (100, 0), level with a.
    const axisLocked: SpanFrame = { ...HORIZONTAL, toAnchor: [100, 30] };
    const lifted = placedDimension(axisLocked, [0, -10])!;
    expect(lifted.line!.witnesses).toEqual([[[0, 0], [0, -10]], [[100, 30], [100, -10]]]);
    // Left on the span, the corner still needs its tie to the point.
    const inPlace = placedDimension(axisLocked, [0, 0])!;
    expect(inPlace.line!.witnesses).toEqual([[[100, 0], [100, 30]]]);
  });

  it('refuses a zero-length span', () => {
    const collapsed: SpanFrame = { ...HORIZONTAL, to: [0, 0], toAnchor: [0, 0] };
    expect(placedDimension(collapsed, [0, 5])).toBeNull();
  });
});

describe('placed radial dimensions', () => {
  it('turns a radius leader to pass through the value', () => {
    const placed = placedDimension(CIRCLE, [0, 6])!;
    close(placed.line!.from, [10, 20]);
    close(placed.line!.to, [10, 30]);
    expect(placed.line!.arrows).toBe('end');
    expect(placed.line!.tail).toBeUndefined();
    close(placed.attach, [10, 26]);
    close(placed.along, [0, 1]);
  });

  it('continues the leader past the rim to a value outside the circle', () => {
    const placed = placedDimension(CIRCLE, [25, 0])!;
    close(placed.line!.to, [20, 20]);
    close(placed.line!.tail![0], [20, 20]);
    close(placed.line!.tail![1], [35, 20]);
  });

  it('lays a diameter rim to rim through the center, at the value\'s bearing', () => {
    const placed = placedDimension(DIAMETER, [-3, 0])!;
    close(placed.line!.from, [20, 20]);
    close(placed.line!.to, [0, 20]);
    expect(placed.line!.arrows).toBe('both');
  });

  it('keeps the automatic 45° bearing for a value sitting on the center', () => {
    const placed = placedDimension(CIRCLE, [0, 0])!;
    const r = 10 * Math.SQRT1_2;
    close(placed.line!.to, [10 + r, 20 + r]);
  });

  it('continues an arc, dashed, to a leader that lands off it', () => {
    // On the arc: nothing to add.
    expect(placedDimension(QUARTER_ARC, [5, 5])!.line!.witnessArcs).toEqual([]);
    // 120°: 30° past the arc's END (90°) — the shorter way round.
    const past = placedDimension(QUARTER_ARC, [-5, 5 * Math.sqrt(3)])!.line!.witnessArcs;
    expect(past).toHaveLength(1);
    expect(past[0].a0).toBeCloseTo(Math.PI / 2, 9);
    expect(past[0].sweep).toBeCloseTo(Math.PI / 6, 9);
    expect(past[0].radius).toBe(10);
    // -45°: 45° before the arc's START, continued backwards from it.
    const before = placedDimension(QUARTER_ARC, [5, -5])!.line!.witnessArcs;
    expect(before).toHaveLength(1);
    expect(before[0].a0).toBeCloseTo(0, 9);
    expect(before[0].sweep).toBeCloseTo(-Math.PI / 4, 9);
  });

  it('continues a clockwise arc the right way round', () => {
    // From 90° clockwise down to 0°.
    const cw: RadialFrame = { ...QUARTER_ARC, arc: { a0: Math.PI / 2, sweep: -Math.PI / 2 } };
    expect(placedDimension(cw, [5, 5])!.line!.witnessArcs).toEqual([]);
    // -45° lies 45° past its END (0°), going clockwise.
    const [witness] = placedDimension(cw, [5, -5])!.line!.witnessArcs;
    expect(witness.a0).toBeCloseTo(0, 9);
    expect(witness.sweep).toBeCloseTo(-Math.PI / 4, 9);
  });

  it('gives a diameter on an arc a witness for each rim off it', () => {
    const arcDiameter: RadialFrame = { ...QUARTER_ARC, diameter: true };
    // Chord at 45°: one rim on the arc, the opposite one (225°) off it.
    const arcs = placedDimension(arcDiameter, [5, 5])!.line!.witnessArcs;
    expect(arcs).toHaveLength(1);
    expect(Math.abs(arcs[0].sweep)).toBeCloseTo((3 * Math.PI) / 4, 9);
  });
});

describe('placed angle dimensions', () => {
  it('draws the arc through the value, at its distance from the corner', () => {
    const placed = placedDimension(RIGHT_ANGLE, [20, 0])!;
    expect(placed.arc!.radius).toBeCloseTo(20, 9);
    expect(placed.arc!.witness).toBeUndefined();
    const r = Math.SQRT1_2;
    close(placed.push, [r, r]);
    close(placed.attach, [5 + 20 * r, 5 + 20 * r]);
  });

  it('continues the arc to a value dragged outside the sector', () => {
    // Straight left of the corner: 180°, 90° past the sector's end.
    const coords = labelCoordsOf(RIGHT_ANGLE, [-10, 5]);
    const placed = placedDimension(RIGHT_ANGLE, coords)!;
    expect(placed.arc!.radius).toBeCloseTo(15, 9);
    expect(placed.arc!.witness!.a0).toBeCloseTo(Math.PI / 2, 9);
    expect(placed.arc!.witness!.sweep).toBeCloseTo(Math.PI / 2, 9);
  });

  it('cannot draw a value sitting on the corner itself', () => {
    expect(placedDimension(RIGHT_ANGLE, [0, 0])).toBeNull();
  });
});

describe('dragging: the text follows the cursor', () => {
  /** Where the text is drawn for the placement a drag to `center` yields. */
  function redrawn(frame: DimensionFrame, center: V2, clearance: (push: V2) => number): V2 {
    const coords = labelCoordsForCenter(frame, center, { clearance });
    return labelCenter(placedDimension(frame, coords)!, clearance);
  }

  it('span: exact on both sides of the span, and past its ends', () => {
    for (const frame of [HORIZONTAL, REVERSED, VERTICAL]) {
      for (const center of [[50, 30], [50, -30], [140, 12], [-25, -4], [50, 2], [3, 0]] as V2[]) {
        close(redrawn(frame, center, flat(14)), center);
      }
    }
  });

  it('span: the dimension line trails one clearance behind the text', () => {
    // Text asked for 30 above the span, reading side up: line at 30 - 14.
    close(labelCoordsForCenter(HORIZONTAL, [50, 30], { clearance: flat(14) }), [0, 16]);
    // Below the span the text still sits ABOVE its line, which goes lower.
    close(labelCoordsForCenter(HORIZONTAL, [50, -30], { clearance: flat(14) }), [0, -44]);
    // A reversed span stores the mirrored pair for the same picture.
    close(labelCoordsForCenter(REVERSED, [50, 30], { clearance: flat(14) }), [0, -16]);
  });

  it('span: an upright label clears a slanted line by its reach along the push', () => {
    // The clearance is asked for along the frame's own push direction.
    const seen: V2[] = [];
    labelCoordsForCenter(VERTICAL, [-40, 30], { clearance: (push) => { seen.push(push); return 20; } });
    expect(seen).toHaveLength(1);
    close(seen[0], [-1, 0]);
  });

  it('radial: exact all the way round, inside and outside the rim', () => {
    // Every bearing, straight up and straight down included — the text sits
    // on one fixed side of its leader, so there is no wedge it cannot reach.
    for (const frame of [CIRCLE, DIAMETER, QUARTER_ARC]) {
      for (let deg = -180; deg < 180; deg += 15) {
        for (const length of [6, 18, 40]) {
          const a = (deg * Math.PI) / 180;
          const center: V2 = [frame.center[0] + Math.cos(a) * length, frame.center[1] + Math.sin(a) * length];
          close(redrawn(frame, center, flat(4)), center, 7);
        }
      }
    }
  });

  it('radial: the leader points one lean clockwise of the text it carries', () => {
    // Text asked for straight above the center, 5 up, clearance 3: the
    // attach point is 4 from the center (3-4-5), text on its CCW side.
    const coords = labelCoordsForCenter(CIRCLE, [10, 25], { clearance: flat(3) });
    expect(Math.hypot(coords[0], coords[1])).toBeCloseTo(4, 9);
    expect(coords[0]).toBeGreaterThan(0);
    close(placedDimension(CIRCLE, coords)!.push, [-coords[1] / 4, coords[0] / 4]);
  });

  it('radial: a value pulled inside its own clearance parks on the center', () => {
    expect(labelCoordsForCenter(CIRCLE, [10, 20], { clearance: flat(4) })).toEqual([0, 0]);
    expect(labelCoordsForCenter(CIRCLE, [12, 21], { clearance: flat(4) })).toEqual([0, 0]);
  });

  it('angular: exact wherever the arc has room, the arc one clearance inside', () => {
    for (const center of [[40, 40], [5, 60], [-30, 5], [25, -20]] as V2[]) {
      close(redrawn(RIGHT_ANGLE, center, flat(14)), center);
    }
    const coords = labelCoordsForCenter(RIGHT_ANGLE, [5 + 50, 5], { clearance: flat(14) });
    expect(placedDimension(RIGHT_ANGLE, coords)!.arc!.radius).toBeCloseTo(36, 9);
  });

  it('angular: never drags the arc tighter than its minimum radius', () => {
    const coords = labelCoordsForCenter(RIGHT_ANGLE, [8, 6], { clearance: flat(14), minArcRadius: 6 });
    expect(placedDimension(RIGHT_ANGLE, coords)!.arc!.radius).toBeCloseTo(6, 9);
    // On the corner itself there is no bearing: the bisector stands in.
    const onCorner = labelCoordsForCenter(RIGHT_ANGLE, [5, 5], { clearance: flat(14), minArcRadius: 6 });
    close(onCorner, [6, 0]);
  });
});

// ---------------------------------------------------------------------------
// Through the read model: what the glyph pass makes of a placed statement.
// ---------------------------------------------------------------------------

const PLANE = {
  origin: { x: 0, y: 0, z: 0 },
  center: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  xDirection: { x: 1, y: 0, z: 0 },
  yDirection: { x: 0, y: 1, z: 0 },
};

let nextId = 0;

function child(uniqueType: string, object: any): SceneObjectRender {
  nextId += 1;
  return {
    id: `obj-${nextId}`,
    parentId: 'sketch-1',
    type: uniqueType,
    uniqueType,
    object,
    sceneShapes: [],
    ownShapes: [],
    sourceLocation: { filePath: '/w/part.fluid.js', line: nextId + 10, column: 1 },
  } as SceneObjectRender;
}

function line(entityId: number, start: V2, end: V2): SceneObjectRender {
  return child('solved-line', {
    entityId, start: { x: start[0], y: start[1] }, end: { x: end[0], y: end[1] },
  });
}

function circle(entityId: number, center: V2, diameter: number): SceneObjectRender {
  return child('solved-circle', { entityId, center: { x: center[0], y: center[1] }, diameter });
}

function arc(entityId: number, center: V2, radius: number, start: V2, end: V2): SceneObjectRender {
  return child('solved-arc', {
    entityId, center: { x: center[0], y: center[1] }, radius,
    start: { x: start[0], y: start[1] }, end: { x: end[0], y: end[1] }, cw: false,
  });
}

function dimension(kind: string, spec: any, value: number, label?: unknown): SceneObjectRender {
  return child(`constraint-${kind}`, {
    kind, constraintId: 0, spec, value, ...(label !== undefined ? { label } : {}),
  });
}

function layout(objects: SceneObjectRender[]) {
  const sketch = {
    id: 'sketch-1',
    type: 'sketch',
    uniqueType: 'sketch',
    object: {
      plane: PLANE,
      solvedMode: true,
      solver: {
        entities: [], constraints: [], params: [], outcome: 'solved', dof: 0,
        conflicting: [], redundant: [], underconstrainedEntities: [],
      },
    },
    sceneShapes: [],
    ownShapes: [],
  } as unknown as SceneObjectRender;
  const model = buildSolvedSketchModel(sketch, objects)!;
  return { model, glyphs: layoutConstraintGlyphs(model) as any[] };
}

const WIDTH = { kind: 'distance', a: { entity: 0, point: 'start' }, b: { entity: 0, point: 'end' }, value: 100 };

describe('placed dimensions in the glyph layout', () => {
  it('reads the statement\'s placement off the payload, and only a well-formed one', () => {
    const read = (label: unknown) =>
      layout([line(0, [0, 0], [100, 0]), dimension('distance', WIDTH, 100, label)]).model.constraints[0].label;
    expect(read([4, -12])).toEqual([4, -12]);
    expect(read(undefined)).toBeUndefined();
    for (const bad of [[4], [4, 'x'], [4, Number.NaN], 'left', null, [1, 2, 3]]) {
      expect(read(bad)).toBeUndefined();
    }
  });

  it('draws a placed distance where the statement put it, not lifted by the automatic rule', () => {
    const { glyphs } = layout([line(0, [0, 0], [100, 0]), dimension('distance', WIDTH, 100, [20, -15])]);
    const leader = glyphs.find(g => g.type === 'leader');
    const text = glyphs.find(g => g.type === 'text');
    expect(leader.from).toEqual([0, -15]);
    expect(leader.to).toEqual([100, -15]);
    expect(leader.arrows).toBe('both');
    expect(leader.extensions).toEqual([[[0, 0], [0, -15]], [[100, 0], [100, -15]]]);
    expect(text.placed).toBe(true);
    expect(text.at).toEqual([70, -15]);
    expect(text.label).toBe('100 mm');
    close(text.offsetDir, [0, 1]);
    expect(text.style).toBe('span');
    // Nothing for the declutterer to slide.
    expect(text.slideRange).toBe(0);
    expect(text.leader).toEqual([[0, -15], [100, -15]]);
  });

  it('leaves an unplaced dimension to the automatic layout', () => {
    const { glyphs } = layout([line(0, [0, 0], [100, 0]), dimension('distance', WIDTH, 100)]);
    const text = glyphs.find(g => g.type === 'text');
    expect(text.placed).toBeUndefined();
    expect(text.at).toEqual([50, 12]);
  });

  it('measures an axis-locked distance\'s placement from its axis-aligned span', () => {
    const { glyphs } = layout([
      line(0, [0, 0], [100, 30]),
      dimension('distance', { ...WIDTH, axis: 'x' }, 100, [0, -20]),
    ]);
    const leader = glyphs.find(g => g.type === 'leader');
    expect(leader.from).toEqual([0, -20]);
    expect(leader.to).toEqual([100, -20]);
    // The far witness starts at the REAL point, not the synthetic corner.
    expect(leader.extensions).toEqual([[[0, 0], [0, -20]], [[100, 30], [100, -20]]]);
  });

  it('draws a placed radius through its value, rolled along the leader', () => {
    const { glyphs } = layout([
      circle(0, [10, 10], 20),
      dimension('radius', { kind: 'radius', a: { entity: 0 }, value: 10 }, 10, [0, 25]),
    ]);
    const leader = glyphs.find(g => g.type === 'leader');
    const text = glyphs.find(g => g.type === 'text');
    close(leader.from, [10, 10]);
    close(leader.to, [10, 20]);
    expect(leader.arrows).toBe('end');
    close(leader.tail[1], [10, 35]);
    expect(text.label).toBe('R10 mm');
    expect(text.style).toBe('aligned');
    expect(text.placed).toBe(true);
    close(text.at, [10, 35]);
  });

  it('continues an arc to a radius leader landing off it', () => {
    // A quarter arc, 0°→90°; the value parked at 135°.
    const { glyphs } = layout([
      arc(0, [0, 0], 10, [10, 0], [0, 10]),
      dimension('radius', { kind: 'radius', a: { entity: 0 }, value: 10 }, 10, [-20, 20]),
    ]);
    const leader = glyphs.find(g => g.type === 'leader');
    expect(leader.witnessArcs).toHaveLength(1);
    expect(leader.witnessArcs[0].a0).toBeCloseTo(Math.PI / 2, 9);
    expect(leader.witnessArcs[0].sweep).toBeCloseTo(Math.PI / 4, 9);
  });

  it('draws a placed diameter as a full chord at the value\'s bearing', () => {
    const { glyphs } = layout([
      circle(0, [0, 0], 20),
      dimension('diameter', { kind: 'diameter', a: { entity: 0 }, value: 20 }, 20, [0, -4]),
    ]);
    const leader = glyphs.find(g => g.type === 'leader');
    close(leader.from, [0, 10]);
    close(leader.to, [0, -10]);
    expect(leader.arrows).toBe('both');
    expect(glyphs.find(g => g.type === 'text').label).toBe('⌀20 mm');
  });

  it('draws a placed angle as a world-scale arc with its value riding it', () => {
    const { glyphs } = layout([
      line(0, [0, 0], [100, 0]),
      line(1, [0, 0], [0, 10]),
      dimension('angle', { kind: 'angle', a: { entity: 0 }, b: { entity: 1 }, value: Math.PI / 2 }, 90, [30, 0]),
    ]);
    const arcGlyph = glyphs.find(g => g.type === 'angle-arc');
    const text = glyphs.find(g => g.type === 'text');
    expect(arcGlyph.placed.radius).toBeCloseTo(30, 9);
    expect(arcGlyph.placed.witness).toBeUndefined();
    expect(arcGlyph.tails).toEqual([]);
    // The first line reaches the arc; the second stops at 10 and is carried
    // on, dashed, to just past where the arc lands on its ray.
    expect(arcGlyph.extensions).toHaveLength(1);
    close(arcGlyph.extensions[0][0], [0, 10]);
    close(arcGlyph.extensions[0][1], [0, 33]);
    expect(text.placed).toBe(true);
    expect(text.label).toBe('90°');
    expect(text.style).toBe('span');
    close(text.at, [30 * Math.SQRT1_2, 30 * Math.SQRT1_2]);
  });

  it('falls back to the automatic arc for a placement it cannot draw', () => {
    const { glyphs } = layout([
      line(0, [0, 0], [100, 0]),
      line(1, [0, 0], [0, 80]),
      dimension('angle', { kind: 'angle', a: { entity: 0 }, b: { entity: 1 }, value: Math.PI / 2 }, 90, [0, 0]),
    ]);
    expect(glyphs).toHaveLength(1);
    expect(glyphs[0].type).toBe('angle-arc');
    expect(glyphs[0].placed).toBeUndefined();
  });

  it('gives every dimension kind a frame, and no other constraint one', () => {
    const { model } = layout([
      line(0, [0, 0], [100, 0]),
      line(1, [0, 0], [0, 80]),
      circle(2, [50, 50], 20),
      dimension('distance', WIDTH, 100),
      dimension('angle', { kind: 'angle', a: { entity: 0 }, b: { entity: 1 }, value: Math.PI / 2 }, 90),
      dimension('radius', { kind: 'radius', a: { entity: 2 }, value: 10 }, 10),
      dimension('diameter', { kind: 'diameter', a: { entity: 2 }, value: 20 }, 20),
      child('constraint-horizontal', { kind: 'horizontal', constraintId: 9, spec: { kind: 'horizontal', a: { entity: 0 } } }),
    ]);
    const types = model.constraints.map(c => dimensionFrame(model, c)?.type ?? null);
    expect(types).toEqual(['span', 'angular', 'radial', 'radial', null]);
  });

  it('has no frame for parallel lines — an angle with no corner is not draggable', () => {
    const { model } = layout([
      line(0, [0, 0], [100, 0]),
      line(1, [0, 10], [100, 10]),
      dimension('angle', { kind: 'angle', a: { entity: 0 }, b: { entity: 1 }, value: 0 }, 0),
    ]);
    expect(dimensionFrame(model, model.constraints[0])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Screen space: the box a placed value is drawn as, and the declutterer.
// ---------------------------------------------------------------------------

describe('placed label clearance', () => {
  const LABEL = { halfWidthPx: 24, halfHeightPx: 11, roll: 0 };

  it('reaches by its half height off a horizontal line, half width off a vertical one', () => {
    expect(boxReach(LABEL, { x: 0, y: -1 })).toBeCloseTo(11, 9);
    expect(boxReach(LABEL, { x: 1, y: 0 })).toBeCloseTo(24, 9);
    expect(boxReach(LABEL, { x: Math.SQRT1_2, y: Math.SQRT1_2 })).toBeCloseTo(35 * Math.SQRT1_2, 9);
  });

  it('a label rolled along its line always reaches by its half height across it', () => {
    for (const deg of [0, 30, 90, -45]) {
      const a = (deg * Math.PI) / 180;
      // Line direction on screen (y down) and the roll that follows it.
      const along = { x: Math.cos(a), y: -Math.sin(a) };
      const across = { x: -along.y, y: along.x };
      expect(boxReach({ ...LABEL, roll: a }, across)).toBeCloseTo(11, 9);
      expect(boxReach({ ...LABEL, roll: a }, along)).toBeCloseTo(24, 9);
    }
  });

  it('sits one gap clear of the line', () => {
    expect(placedLabelOffsetPx(LABEL, { x: 0, y: -1 })).toBeCloseTo(11 + PLACED_LABEL_GAP_PX, 9);
  });
});

describe('declutterer: a placed label is not its to move', () => {
  const RIGHT: Pt = { x: 1, y: 0 };
  const DOWN: Pt = { x: 0, y: 1 };

  function item(at: Pt, order: number, overrides: Partial<DimensionItem> = {}): DimensionItem {
    return { anchor: at, slide: RIGHT, push: DOWN, style: 'span', slideRangePx: 60, hw: 16, hh: 8, order, ...overrides };
  }

  function run(dimensions: DimensionItem[]) {
    return declutterAnnotations({
      badges: [], dimensions, obstacles: [], geometry: new GeometryIndex(), pillSize: () => ({ hw: 11, hh: 8 }),
    }).dimensions;
  }

  it('draws it exactly at its offset', () => {
    const [placed] = run([item({ x: 100, y: 100 }, 0, { fixed: { x: 7, y: -31 } })]);
    expect(placed).toEqual({ visible: true, dx: 7, dy: -31 });
  });

  it('routes an automatic label around it, whatever the statement order', () => {
    // Alone, the automatic label takes its first rung: 14 px down.
    const [alone] = run([item({ x: 100, y: 100 }, 0)]);
    expect(alone).toEqual({ visible: true, dx: 0, dy: 14 });
    // A label parked on that very spot — declared AFTER it — keeps the spot.
    const [auto, parked] = run([
      item({ x: 100, y: 100 }, 0),
      item({ x: 100, y: 100 }, 1, { fixed: { x: 0, y: 14 } }),
    ]);
    expect(parked).toEqual({ visible: true, dx: 0, dy: 14 });
    expect(auto.visible).toBe(true);
    expect(auto).not.toEqual(alone);
  });

  it('lets two parked labels overlap rather than move either', () => {
    const [a, b] = run([
      item({ x: 100, y: 100 }, 0, { fixed: { x: 0, y: 14 } }),
      item({ x: 102, y: 100 }, 1, { fixed: { x: 0, y: 14 } }),
    ]);
    expect(a).toEqual({ visible: true, dx: 0, dy: 14 });
    expect(b).toEqual({ visible: true, dx: 0, dy: 14 });
  });
});
