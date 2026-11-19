// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { OrthographicCamera, PerspectiveCamera, Scene } from 'three';
import { DimensionLabelPlacer } from '../src/interactive/dimension-label-placer';
import { SketchHoverSelectHandler } from '../src/interactive/sketch-hover-select-handler';
import { ExpressionInput } from '../src/ui/expression-input';
import { labelCoordsOf, placedDimension } from '../src/sketch-solver-client';
import type {
  AngularFrame, DimensionFrame, RadialFrame, SpanFrame,
} from '../src/sketch-solver-client';
import type { SolvedEntityView, SolvedSketchModel } from '../src/sketch-solver-client/model';

// ---------------------------------------------------------------------------
// Placing a dimension as it is drawn: the pieces around the pure frame math
// (dimension-label.test.ts) that need a camera or the DOM — the cursor ↔
// placement conversion the drag and the constraint bar share, the pick a
// click would add while a dimension is under the cursor, and the value input
// opening centered on the placed value.
// ---------------------------------------------------------------------------

type V2 = [number, number];

const PLANE = {
  origin: { x: 0, y: 0, z: 0 },
  center: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  xDirection: { x: 1, y: 0, z: 0 },
  yDirection: { x: 0, y: 1, z: 0 },
} as any;

/** A canvas of `width` × `height` px looking straight down at the sketch,
 * `zoom` px per sketch unit. */
function topDownContext(zoom: number, width = 800, height = 600) {
  const camera = new OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2, 0.1, 1000);
  camera.zoom = zoom;
  camera.position.set(0, 0, 100);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () => ({
    left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0, toJSON: () => ({}),
  });
  return { camera, renderer: { domElement: canvas } } as any;
}

const BOX = { halfWidthPx: 30, halfHeightPx: 11 };

const HORIZONTAL: SpanFrame = {
  type: 'span', from: [0, 0], to: [100, 0], toAnchor: [100, 0], arrows: 'both',
};
const SLANTED: SpanFrame = { ...HORIZONTAL, to: [60, 80], toAnchor: [60, 80] };
const CIRCLE: RadialFrame = { type: 'radial', center: [10, 20], radius: 40, diameter: true };
const CORNER: AngularFrame = { type: 'angular', at: [5, 5], startAngle: 0, sweep: Math.PI / 3 };

describe('DimensionLabelPlacer', () => {
  const cases: [string, DimensionFrame, V2][] = [
    ['a horizontal span, value above it', HORIZONTAL, [30, 40]],
    ['a horizontal span, value below and past its end', HORIZONTAL, [140, -25]],
    ['a slanted span', SLANTED, [-20, 60]],
    ['a circle, value outside the rim', CIRCLE, [70, 80]],
    ['a circle, value inside it', CIRCLE, [30, 35]],
    ['an angle, value inside its sector', CORNER, [60, 30]],
    ['an angle, value outside its sector', CORNER, [-30, 40]],
  ];

  for (const zoom of [1, 2, 4]) {
    for (const [name, frame, center] of cases) {
      it(`draws the text centered on the cursor — ${name}, ${zoom} px per unit`, () => {
        const placer = new DimensionLabelPlacer(topDownContext(zoom));
        const coords = placer.coordsFor(PLANE, frame, center, BOX);
        // The placement is drawable, and its text lands back under the cursor:
        // what the value input centers on is where the click was.
        expect(placedDimension(frame, coords)).not.toBeNull();
        const drawn = placer.centerOf(PLANE, frame, coords, BOX)!;
        expect(drawn[0]).toBeCloseTo(center[0], 6);
        expect(drawn[1]).toBeCloseTo(center[1], 6);
      });
    }
  }

  it('keeps the dimension line one clearance off the text, whatever the zoom', () => {
    // A value above a horizontal line is pushed straight up: half its
    // height plus the gap, in pixels — more sketch units when zoomed out.
    for (const zoom of [1, 4]) {
      const placer = new DimensionLabelPlacer(topDownContext(zoom));
      const [, v] = placer.coordsFor(PLANE, HORIZONTAL, [50, 40], BOX);
      expect(40 - v).toBeCloseTo((BOX.halfHeightPx + 3) / zoom, 6);
    }
  });

  it('a slanted distance keeps that same clearance: its value lies along the line', () => {
    // Rolled to its line, the text always turns its short side to it — the
    // line stays half a text height plus the gap away at any slope, where
    // an upright box would need its diagonal reach.
    const placer = new DimensionLabelPlacer(topDownContext(1));
    const center: V2 = [-20, 60];
    const [, v] = placer.coordsFor(PLANE, SLANTED, center, BOX);
    expect(Math.abs(labelCoordsOf(SLANTED, center)[1] - v)).toBeCloseTo(BOX.halfHeightPx + 3, 6);
  });

  it('settles for the nearest drawable placement when the text cannot reach the cursor', () => {
    // Zoomed far out, the text's clearance is many sketch units: a cursor
    // nearer the corner than that cannot have the text centered on it. The
    // arc stops at its minimum radius instead of collapsing onto the corner.
    const zoom = 0.25;
    const placer = new DimensionLabelPlacer(topDownContext(zoom));
    const coords = placer.coordsFor(PLANE, CORNER, [8, 6], BOX);
    const placed = placedDimension(CORNER, coords)!;
    expect(placed.arc!.radius).toBeCloseTo(12 / zoom, 6);
  });

  it('has no center for a placement that cannot be drawn', () => {
    const placer = new DimensionLabelPlacer(topDownContext(1));
    // An angle's value sitting exactly on its corner has no arc to ride.
    expect(placer.centerOf(PLANE, CORNER, [0, 0], BOX)).toBeNull();
  });
});

function entity(entityId: number, fields: Partial<SolvedEntityView> & { kind: SolvedEntityView['kind'] }): SolvedEntityView {
  return {
    entityId,
    obj: { id: `obj-${entityId}`, sourceLocation: { filePath: '/m.fluid.js', line: 5 + entityId, column: 3 } } as any,
    ...fields,
  };
}

function hoverHarness() {
  const ctx = {
    scene: new Scene(),
    camera: new PerspectiveCamera(),
    renderer: { domElement: document.createElement('canvas') },
    requestRender: () => {},
  } as any;
  const handler = new SketchHoverSelectHandler(ctx, PLANE, () => false);
  const h = handler as any;
  h.solvedModel = {
    entities: new Map([
      [0, entity(0, { kind: 'line', start: [0, 0], end: [10, 0] })],
      [2, entity(2, { kind: 'circle', center: [30, 0], radius: 5 })],
    ]),
    hasDatums: true,
  } as unknown as SolvedSketchModel;
  h.entityShapeIds = new Map([[0, ['edge-line']], [2, ['edge-circle']]]);
  return { handler, h };
}

describe('SketchHoverSelectHandler.hoverPick', () => {
  it('is null over empty space', () => {
    expect(hoverHarness().handler.hoverPick()).toBeNull();
  });

  it('a hovered edge is the whole entity, with no touch point yet', () => {
    const { handler, h } = hoverHarness();
    h.hoveredShapeId = 'edge-circle';
    expect(handler.hoverPick()).toEqual({
      entityId: 2,
      kind: 'circle',
      sourceLocation: { filePath: '/m.fluid.js', line: 7, column: 3 },
      shapeId: 'edge-circle',
    });
  });

  it('a hovered vertex is that named point', () => {
    const { handler, h } = hoverHarness();
    h.hoveredVertex = { key: '0:end', entityId: 0, role: 'end', at: [10, 0] };
    expect(handler.hoverPick()).toMatchObject({ entityId: 0, kind: 'line', role: 'end' });
  });

  it('a hovered datum is its reserved pick', () => {
    const { handler, h } = hoverHarness();
    h.hoveredDatum = { datum: 'x-axis' };
    expect(handler.hoverPick()).toEqual({ entityId: -2, kind: 'line', datum: 'x-axis' });
  });

  it('a hovered constraint glyph is not geometry: the click picks the statement', () => {
    const { handler, h } = hoverHarness();
    h.hoveredShapeId = 'edge-line';
    h.hoveredBadge = { objId: 'c1' };
    expect(handler.hoverPick()).toBeNull();
  });

  it('an edge no solver entity owns is no pick', () => {
    const { handler, h } = hoverHarness();
    h.hoveredShapeId = 'edge-of-something-else';
    expect(handler.hoverPick()).toBeNull();
  });

  it('matches what the click then records', () => {
    const { handler, h } = hoverHarness();
    h.hoveredShapeId = 'edge-line';
    const hovered = handler.hoverPick();
    h.selectedShapeIds.add('edge-line');
    h.pickSequence.push('e:edge-line');
    expect(handler.getSolvedPicks()).toEqual([hovered]);
  });
});

describe('ExpressionInput placement', () => {
  function open(centered: boolean | undefined) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const input = new ExpressionInput(container);
    input.show({
      label: 'D', value: '25', clientX: 300, clientY: 200, variables: [],
      onCommit: () => {},
      ...(centered !== undefined ? { centered } : {}),
    });
    const el = container.firstElementChild as HTMLElement;
    const wrapper = el.querySelector('.expression-wrapper') as HTMLElement;
    return { input, el, wrapper };
  }

  it('floats up and right of its point by default, clear of the cursor', () => {
    const { el } = open(undefined);
    expect(el.style.left).toBe('316px');
    expect(el.style.top).toBe('164px');
  });

  it('centers its field on the point when asked — a placed value opens where it was dropped', () => {
    const { input, el, wrapper } = open(true);
    // jsdom lays nothing out: give the field the size a browser would.
    Object.defineProperty(wrapper, 'offsetWidth', { value: 130 });
    Object.defineProperty(wrapper, 'offsetHeight', { value: 30 });
    input.updatePosition(300, 200);
    expect(el.style.left).toBe('235px');
    expect(el.style.top).toBe('185px');
  });

  it('forgets the centering when it reopens without it', () => {
    const { input, el } = open(true);
    input.show({ label: 'D', value: '25', clientX: 300, clientY: 200, variables: [], onCommit: () => {} });
    expect(el.style.left).toBe('316px');
  });
});
