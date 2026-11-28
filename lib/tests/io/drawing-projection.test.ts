import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import type { TopAbs_ShapeEnum, TopoDS_Edge, TopoDS_Shape } from "ocjs-fluidcad";
import { setupOC, render } from "../setup.js";
import { getOC } from "../../oc/init.js";
import { Explorer } from "../../oc/explorer.js";
import { getCurrentScene, getSceneManager } from "../../scene-manager.js";
import sketch from "../../core/sketch.js";
import plane from "../../core/plane.js";
import extrude from "../../core/extrude.js";
import loft from "../../core/loft.js";
import fillet from "../../core/fillet.js";
import cut from "../../core/cut.js";
import chamfer from "../../core/chamfer.js";
import select from "../../core/select.js";
import { edge } from "../../filters/index.js";
import { circle } from "../../core/2d/index.js";
import { FileExport } from "../../io/file-export.js";
import { Curves, DrawingCleanup, DrawingExport, DxfWriter, SvgWriter } from "../../io/drawing/index.js";
import type { Curve2D, Drawing2D, DrawingLayer, Vec2 } from "../../io/drawing/index.js";
import { BSplineCurve2D } from "../../io/drawing/bspline.js";
import { EdgeToCurve2D } from "../../oc/projection/edge-to-curve2d.js";
import { HiddenLineProjection } from "../../oc/projection/hidden-line.js";
import { OcclusionProbe } from "../../oc/projection/occlusion-probe.js";
import { Plane, toPlane } from "../../math/plane.js";
import type { StandardPlane } from "../../math/plane.js";
import { withUnit } from "../../units/registry.js";
import { testRect } from "../helpers/profiles.js";
import { box, drawnSolids, exportable, sceneSolids } from "./helpers.js";
import { runFluid } from "../helpers/run-fluid.js";
import type { Extrude } from "../../features/extrude.js";
import type { Solid } from "../../common/solid.js";
import { DrawingModels as M } from "./drawing/models.js";
import { DxfOracle } from "./drawing/dxf-oracle.js";
import { SvgOracle } from "./drawing/svg-oracle.js";

const SIX_VIEWS: StandardPlane[] = ['top', 'bottom', 'front', 'back', 'right', 'left'];
const TWO_PI = 2 * Math.PI;

type ViewOptions = { hiddenLines?: boolean; tangentEdges?: boolean };

function view(shapes: TopoDS_Shape[], on: StandardPlane, options: ViewOptions = {}): Drawing2D {
  return DrawingExport.fromShapes(shapes, { unit: 'mm', plane: on, ...options });
}

/** `visible:line` → how many, for the whole drawing. */
function census(drawing: Drawing2D): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entity of drawing.entities) {
    const key = `${entity.layer}:${entity.curve.kind}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function curvesOf<K extends Curve2D['kind']>(drawing: Drawing2D, kind: K, layer: DrawingLayer = 'visible'): Extract<Curve2D, { kind: K }>[] {
  return drawing.entities
    .filter((e) => e.layer === layer && e.curve.kind === kind)
    .map((e) => e.curve as Extract<Curve2D, { kind: K }>);
}

const near = (p: Vec2, q: Vec2, tolerance = 1e-6) => Math.hypot(p.x - q.x, p.y - q.y) <= tolerance;

/** Whether the drawing has a line between the two points, drawn either way. */
function hasLine(drawing: Drawing2D, a: [number, number], b: [number, number], layer: DrawingLayer = 'visible'): boolean {
  const [p, q] = [{ x: a[0], y: a[1] }, { x: b[0], y: b[1] }];
  return curvesOf(drawing, 'line', layer).some((l) => (near(l.a, p) && near(l.b, q)) || (near(l.a, q) && near(l.b, p)));
}

function expectBounds(drawing: Drawing2D, min: [number, number], max: [number, number]): void {
  expect(drawing.bounds).not.toBeNull();
  expect(drawing.bounds!.min.x).toBeCloseTo(min[0], 6);
  expect(drawing.bounds!.min.y).toBeCloseTo(min[1], 6);
  expect(drawing.bounds!.max.x).toBeCloseTo(max[0], 6);
  expect(drawing.bounds!.max.y).toBeCloseTo(max[1], 6);
}

describe("drawing projection — prismatic parts", () => {
  setupOC();

  it("draws a box's top view as four lines closing one loop, at model coordinates", () => {
    const drawing = view([M.box([40, 30, 10])], 'top');
    expect(census(drawing)).toEqual({ 'visible:line': 4 });
    expect(hasLine(drawing, [0, 0], [40, 0])).toBe(true);
    expect(hasLine(drawing, [40, 0], [40, 30])).toBe(true);
    expect(hasLine(drawing, [40, 30], [0, 30])).toBe(true);
    expect(hasLine(drawing, [0, 30], [0, 0])).toBe(true);
    expectBounds(drawing, [0, 0], [40, 30]);
    const chains = DrawingCleanup.chain(drawing.entities, 1e-5);
    expect(chains.map((c) => [c.closed, c.items.length])).toEqual([[true, 4]]);
    expect(drawing.warnings).toEqual([]);
    expect(drawing.plane).toBe('top');
    expect(drawing.unit).toBe('mm');
  });

  it("does not recentre: a box away from the origin stays where it is", () => {
    const drawing = view([M.box([4, 3, 2], [100, -50, 7])], 'top');
    expectBounds(drawing, [100, -50], [104, -47]);
    expectBounds(view([M.box([4, 3, 2], [100, -50, 7])], 'front'), [100, 7], [104, 9]);
  });

  it("draws a through hole as one circle, not two arcs and not once per face", () => {
    const drawing = view([M.plateWithHole()], 'top');
    expect(census(drawing)).toEqual({ 'visible:line': 4, 'visible:circle': 1 });
    expect(curvesOf(drawing, 'circle')[0].radius).toBeCloseTo(5, 9);
    expect(near(curvesOf(drawing, 'circle')[0].center, { x: 20, y: 15 })).toBe(true);
  });

  it("leaves no hidden line under a visible one", () => {
    // The bottom face's outline and the hole's bottom rim are behind the
    // model, exactly under the top face's: nothing of them is left to draw.
    expect(census(view([M.plateWithHole()], 'top', { hiddenLines: true }))).toEqual({ 'visible:line': 4, 'visible:circle': 1 });
  });

  it("draws the hole's edge-on rims as part of the outline and its walls as hidden lines", () => {
    const visibleOnly = view([M.plateWithHole()], 'front');
    expect(census(visibleOnly)).toEqual({ 'visible:line': 4 });
    expectBounds(visibleOnly, [0, 0], [40, 10]);

    const drawing = view([M.plateWithHole()], 'front', { hiddenLines: true });
    expect(census(drawing)).toEqual({ 'visible:line': 4, 'hidden:line': 2 });
    expect(hasLine(drawing, [15, 0], [15, 10], 'hidden')).toBe(true);
    expect(hasLine(drawing, [25, 0], [25, 10], 'hidden')).toBe(true);
  });

  it("lets the nearer of two solids hide the farther", () => {
    // A 20 × 20 block at the front, a 10 × 10 block wholly behind it.
    const nearBlock = M.box([20, 10, 20]);
    const farBlock = M.box([10, 10, 10], [5, 30, 5]);
    const front = view([nearBlock, farBlock], 'front');
    expect(census(front)).toEqual({ 'visible:line': 4 });
    expectBounds(front, [0, 0], [20, 20]);

    const withHidden = view([nearBlock, farBlock], 'front', { hiddenLines: true });
    expect(census(withHidden)).toEqual({ 'visible:line': 4, 'hidden:line': 4 });
    expect(hasLine(withHidden, [5, 5], [15, 5], 'hidden')).toBe(true);
    expect(hasLine(withHidden, [15, 5], [15, 15], 'hidden')).toBe(true);

    // From behind, the small block is the one in front.
    const back = view([nearBlock, farBlock], 'back');
    expect(census(back)).toEqual({ 'visible:line': 8 });
    expect(hasLine(back, [-15, 5], [-5, 5])).toBe(true);
  });

  it("merges the collinear edges of two solids into one line", () => {
    // Side by side on the ground: their bottom edges are one line in front.
    const drawing = view([M.box([10, 10, 10]), M.box([30, 10, 20], [-10, 20, 0])], 'front');
    expect(hasLine(drawing, [-10, 0], [20, 0])).toBe(true);
    expect(curvesOf(drawing, 'line')).toHaveLength(7);
  });
});

describe("drawing projection — the six views", () => {
  setupOC();

  // A 40 × 30 × 10 plate with a post standing 20 high on it, off-centre in
  // both directions (X 5..15, Y 18..26): no view of it has a mirror twin,
  // and no two views show the post in the same place.
  const bracket = () => [M.fuse(M.box([40, 30, 10]), M.box([10, 8, 20], [5, 18, 10]))];

  it("top: X to the right, Y up, seen from +Z", () => {
    const drawing = view(bracket(), 'top');
    expectBounds(drawing, [0, 0], [40, 30]);
    expect(census(drawing)).toEqual({ 'visible:line': 8 });
    expect(hasLine(drawing, [5, 18], [15, 18])).toBe(true);
    expect(hasLine(drawing, [15, 18], [15, 26])).toBe(true);
  });

  it("bottom: the top view mirrored left to right, the post behind the plate", () => {
    const drawing = view(bracket(), 'bottom', { hiddenLines: true });
    expectBounds(drawing, [-40, 0], [0, 30]);
    expect(census(drawing)).toEqual({ 'visible:line': 4, 'hidden:line': 4 });
    expect(hasLine(drawing, [-15, 18], [-5, 18], 'hidden')).toBe(true);
    expect(hasLine(drawing, [-15, 18], [-15, 26], 'hidden')).toBe(true);
  });

  it("front: X to the right, Z up, seen from −Y", () => {
    const drawing = view(bracket(), 'front');
    expectBounds(drawing, [0, 0], [40, 30]);
    expect(hasLine(drawing, [5, 10], [5, 30])).toBe(true);
    expect(hasLine(drawing, [15, 10], [15, 30])).toBe(true);
    // The post's foot lies on the plate's top edge: one line, not two.
    expect(hasLine(drawing, [0, 10], [40, 10])).toBe(true);
    expect(census(drawing)).toEqual({ 'visible:line': 7 });
  });

  it("back: the front view mirrored left to right", () => {
    const drawing = view(bracket(), 'back');
    expectBounds(drawing, [-40, 0], [0, 30]);
    expect(hasLine(drawing, [-15, 10], [-15, 30])).toBe(true);
    expect(hasLine(drawing, [-5, 10], [-5, 30])).toBe(true);
    expect(hasLine(drawing, [-15, 30], [-5, 30])).toBe(true);
  });

  it("right: Y to the right, Z up, seen from +X", () => {
    const drawing = view(bracket(), 'right');
    expectBounds(drawing, [0, 0], [30, 30]);
    expect(hasLine(drawing, [18, 10], [18, 30])).toBe(true);
    expect(hasLine(drawing, [26, 10], [26, 30])).toBe(true);
  });

  it("left: the right view mirrored left to right", () => {
    const drawing = view(bracket(), 'left');
    expectBounds(drawing, [-30, 0], [0, 30]);
    expect(hasLine(drawing, [-26, 10], [-26, 30])).toBe(true);
    expect(hasLine(drawing, [-18, 10], [-18, 30])).toBe(true);
  });

  it("draws the same view under a plane's axis name and its view name", () => {
    const pairs: [StandardPlane, StandardPlane][] = [
      ['xy', 'top'], ['-xy', 'bottom'], ['xz', 'front'], ['-xz', 'back'], ['yz', 'right'], ['-yz', 'left'],
    ];
    for (const [axisName, viewName] of pairs) {
      expect(view(bracket(), axisName).entities).toEqual(view(bracket(), viewName).entities);
    }
  });

  it("refuses a plane that is not a standard one", () => {
    expect(() => view(bracket(), 'iso' as StandardPlane)).toThrow(/plane/);
  });
});

describe("drawing projection — curved parts", () => {
  setupOC();

  it("draws a cylinder's side views as exactly four lines and never its seam", () => {
    // The seam runs up the cylinder at (5, 0): on the outline in the front
    // and back views, down the middle of the right and left ones.
    for (const on of ['front', 'back', 'right', 'left'] as const) {
      const drawing = view([M.cylinder(5, 20)], on, { hiddenLines: true, tangentEdges: true });
      expect(census(drawing)).toEqual({ 'visible:line': 4 });
      expectBounds(drawing, [-5, 0], [5, 20]);
      expect(hasLine(drawing, [-5, 0], [5, 0])).toBe(true);
      expect(hasLine(drawing, [5, 0], [5, 20])).toBe(true);
      expect(hasLine(drawing, [-5, 20], [5, 20])).toBe(true);
      expect(hasLine(drawing, [-5, 0], [-5, 20])).toBe(true);
    }
  });

  it("draws a cylinder's end views as one circle", () => {
    for (const on of ['top', 'bottom'] as const) {
      const drawing = view([M.cylinder(5, 20)], on, { hiddenLines: true, tangentEdges: true });
      expect(census(drawing)).toEqual({ 'visible:circle': 1 });
      expect(curvesOf(drawing, 'circle')[0]).toEqual({ kind: 'circle', center: { x: 0, y: 0 }, radius: 5 });
    }
  });

  it("draws a sphere as one circle of its radius in every view", () => {
    for (const on of SIX_VIEWS) {
      const drawing = view([M.sphere(7, [1, 2, 3])], on, { hiddenLines: true, tangentEdges: true });
      expect(census(drawing)).toEqual({ 'visible:circle': 1 });
      expect(curvesOf(drawing, 'circle')[0].radius).toBeCloseTo(7, 6);
    }
    expect(near(curvesOf(view([M.sphere(7, [1, 2, 3])], 'top'), 'circle')[0].center, { x: 1, y: 2 })).toBe(true);
    expect(near(curvesOf(view([M.sphere(7, [1, 2, 3])], 'front'), 'circle')[0].center, { x: 1, y: 3 })).toBe(true);
    expect(near(curvesOf(view([M.sphere(7, [1, 2, 3])], 'left'), 'circle')[0].center, { x: -2, y: 3 })).toBe(true);
  });

  it("draws a tilted circle as the ellipse of its closed form", () => {
    // A boss of radius 3 along (0.3, 0.2, 0.93), 15 long, from (8, 8, 5).
    const axis = [0.3, 0.2, 0.93];
    const length = Math.hypot(...axis);
    const [nx, ny, nz] = axis.map((v) => v / length);
    const boss = M.fuse(M.box([40, 30, 10]), M.cylinder(3, 15, [8, 8, 5], [0.3, 0.2, 0.93]));
    const drawing = view([boss], 'top');
    expect(census(drawing)).toEqual({ 'visible:line': 6, 'visible:ellipse': 2 });

    // The boss's end cap: a full ellipse, major axis square to the tilt.
    const cap = curvesOf(drawing, 'ellipse').find((e) => e.end - e.start > TWO_PI - 1e-9)!;
    expect(cap).toBeDefined();
    expect(cap.center.x).toBeCloseTo(8 + 15 * nx, 6);
    expect(cap.center.y).toBeCloseTo(8 + 15 * ny, 6);
    expect(Math.hypot(cap.major.x, cap.major.y)).toBeCloseTo(3, 9);
    expect(cap.ratio).toBeCloseTo(nz, 9);
    expect(Math.abs(cap.major.x * nx + cap.major.y * ny)).toBeLessThan(1e-9);

    // Where the boss meets the plate's top: half of that ellipse shows, the
    // boss itself covers the rest.
    const foot = curvesOf(drawing, 'ellipse').find((e) => e !== cap)!;
    expect(foot.end - foot.start).toBeCloseTo(Math.PI, 6);
    expect(foot.ratio).toBeCloseTo(nz, 9);
  });

  it("puts the covered half of a tilted rim on the hidden layer, with no dash under the solid half", () => {
    const boss = M.fuse(M.box([40, 30, 10]), M.cylinder(3, 15, [8, 8, 5], [0.3, 0.2, 0.93]));
    const drawing = view([boss], 'front', { hiddenLines: true });
    const visible = curvesOf(drawing, 'ellipse');
    const hidden = curvesOf(drawing, 'ellipse', 'hidden');
    expect(visible).toHaveLength(1);
    expect(hidden).toHaveLength(1);
    expect(near(visible[0].center, hidden[0].center)).toBe(true);
    expect((visible[0].end - visible[0].start) + (hidden[0].end - hidden[0].start)).toBeCloseTo(TWO_PI, 6);
  });
});

describe("drawing projection — feature-built parts", () => {
  setupOC();

  const shapes = () => [sceneSolids().at(-1)!.getShape()];

  function filletedPlate(): void {
    sketch("xy", () => {
      testRect(40, 30);
    });
    extrude(10);
    select(edge().verticalTo("xy"));
    fillet(4);
    render();
  }

  it("draws a filleted outline as lines and arcs in one closed loop", () => {
    filletedPlate();
    const drawing = view(shapes(), 'top', { tangentEdges: true });
    expect(census(drawing)).toEqual({ 'visible:line': 4, 'visible:arc': 4 });
    for (const arc of curvesOf(drawing, 'arc')) {
      expect(arc.radius).toBeCloseTo(4, 9);
      expect(arc.end - arc.start).toBeCloseTo(Math.PI / 2, 9);
    }
    const chains = DrawingCleanup.chain(drawing.entities, 1e-5);
    expect(chains.map((c) => [c.closed, c.items.length])).toEqual([[true, 8]]);
  });

  it("draws tangent edges only when asked, on their own layer", () => {
    filletedPlate();
    expect(census(view(shapes(), 'front'))).toEqual({ 'visible:line': 4 });
    const drawing = view(shapes(), 'front', { tangentEdges: true, hiddenLines: true });
    // The fillets' borders at the front; those at the back are not drawn.
    expect(census(drawing)).toEqual({ 'visible:line': 4, 'tangent:line': 2 });
    expect(hasLine(drawing, [4, 0], [4, 10], 'tangent')).toBe(true);
    expect(hasLine(drawing, [36, 0], [36, 10], 'tangent')).toBe(true);
  });

  it("recovers the arcs a loft's spline edges stand for and keeps their outline closed", () => {
    const base = sketch(plane("xy", 0), () => {
      testRect(40, 40, { at: [-20, -20] });
    });
    const top = sketch(plane("xy", 50), () => {
      circle([0, 0], 30);
    });
    loft(base, top);
    render();
    const drawing = view(shapes(), 'top');
    // No spline is left in the drawing: the square, the round top as arcs,
    // and the walls' edges as lines.
    expect(curvesOf(drawing, 'bspline')).toHaveLength(0);
    expect(drawing.warnings).toEqual([]);
    const arcs = curvesOf(drawing, 'arc');
    expect(arcs).toHaveLength(4);
    for (const arc of arcs) {
      // The kernel's own recovery is good to a micron, no better.
      expect(arc.radius).toBeCloseTo(15, 2);
    }
    // The four arcs meet end to end: the recovered circles are drawn through
    // the edges' own end points.
    const round = DrawingCleanup.chain(arcs.map((curve) => ({ layer: 'visible' as const, curve })), 1e-5);
    expect(round.map((c) => [c.closed, c.items.length])).toEqual([[true, 4]]);
    expect(hasLine(drawing, [-20, -20], [20, -20])).toBe(true);
  });
});

describe("drawing projection — creases, smooth joins and seams", () => {
  setupOC();

  // A boolean records no continuity on the edges it leaves, and the
  // hidden-line algorithm takes an edge with no record for a crease. The
  // view encodes it from the geometry first — on a copy.

  /** A 40 × 20 × 10 block with a half-round end: the round's borders are tangent to the block's sides. */
  const slot = () => M.fuse(M.box([40, 20, 10]), M.cylinder(10, 10, [40, 10, 0]));
  /** Two 20 × 20 × 10 blocks side by side: their faces are coplanar across x = 20. */
  const twoBlocks = () => M.fuse(M.box([20, 20, 10]), M.box([20, 20, 10], [20, 0, 0]));

  it("draws the tangent border a boolean left as a tangent edge, not as a crease", () => {
    const front = view([slot()], 'front');
    // The outline and nothing else: no line where the flat side runs into the round.
    expect(census(front)).toEqual({ 'visible:line': 4 });
    expect(hasLine(front, [0, 0], [50, 0])).toBe(true);
    expect(hasLine(front, [50, 0], [50, 10])).toBe(true);

    const withTangent = view([slot()], 'front', { tangentEdges: true });
    expect(census(withTangent)).toEqual({ 'visible:line': 4, 'tangent:line': 1 });
    expect(hasLine(withTangent, [40, 0], [40, 10], 'tangent')).toBe(true);
  });

  it("takes the join of two coplanar faces for a smooth one", () => {
    expect(census(view([twoBlocks()], 'top'))).toEqual({ 'visible:line': 4 });
    const withTangent = view([twoBlocks()], 'top', { tangentEdges: true });
    expect(census(withTangent)).toEqual({ 'visible:line': 4, 'tangent:line': 1 });
    expect(hasLine(withTangent, [20, 0], [20, 20], 'tangent')).toBe(true);
  });

  it("does not write to the shape it draws: the scene's edges keep the records they had", () => {
    const oc = getOC();
    const shape = slot();
    /** How many edges of the shape have a continuity recorded between their two faces. */
    const recorded = () => {
      const edges = Explorer.findShapes<TopoDS_Edge>(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum);
      const count = edges.filter((raw) => {
        const e = oc.TopoDS.Edge(raw);
        const has = oc.BRep_Tool.HasContinuity(e);
        e.delete();
        return has;
      }).length;
      Explorer.deleteAll(edges);
      return count;
    };
    const before = recorded();
    view([shape], 'front', { tangentEdges: true, hiddenLines: true });
    expect(recorded()).toBe(before);
  });

  it("leaves out a recorded render seam on every layer", () => {
    const oc = getOC();
    const shape = twoBlocks();
    // The joins across x = 20, as a wrapper would have recorded them.
    const edges = Explorer.findShapes<TopoDS_Edge>(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum);
    const joins = edges.filter((raw) => {
      const e = oc.TopoDS.Edge(raw);
      const adaptor = new oc.BRepAdaptor_Curve(e);
      const a = adaptor.Value(adaptor.FirstParameter());
      const b = adaptor.Value(adaptor.LastParameter());
      const onJoin = Math.abs(a.X() - 20) < 1e-9 && Math.abs(b.X() - 20) < 1e-9;
      a.delete();
      b.delete();
      adaptor.delete();
      e.delete();
      return onJoin;
    });
    expect(joins.length).toBeGreaterThan(0);

    const drawing = DrawingExport.fromShapes([{ shape, renderSeams: joins }], { unit: 'mm', plane: 'top', tangentEdges: true, hiddenLines: true });
    expect(census(drawing)).toEqual({ 'visible:line': 4 });
    const front = DrawingExport.fromShapes([{ shape, renderSeams: joins }], { unit: 'mm', plane: 'front', tangentEdges: true });
    expect(census(front)).toEqual({ 'visible:line': 4 });
  });

  it("never draws a cylinder's seam, on any layer, in any view", () => {
    // Along X, so the seam is a generatrix that the top or the front view looks straight at.
    const shape = M.cylinder(10, 40, [0, 0, 0], [1, 0, 0]);
    for (const on of SIX_VIEWS) {
      const drawing = view([shape], on, { tangentEdges: true, hiddenLines: true });
      const layers = new Set(drawing.entities.map((e) => e.layer));
      expect(layers.has('tangent'), on).toBe(false);
      const endOn = on === 'right' || on === 'left';
      expect(census(drawing), on).toEqual(endOn ? { 'visible:circle': 1 } : { 'visible:line': 4 });
    }
  });

  it("still draws one solid's crease that lies along another solid's seam", () => {
    // The cylinder's seam is its top generatrix (y = 0, z = 10); the bar's
    // upper front edge runs exactly along it.
    const cylinder = M.cylinder(10, 40, [0, 0, 0], [1, 0, 0]);
    const bar = M.box([40, 5, 3], [0, 0, 7]);
    const top = view([cylinder, bar], 'top');
    expect(hasLine(top, [0, 0], [40, 0])).toBe(true);
    // Alone, the cylinder has no line there.
    expect(hasLine(view([cylinder], 'top'), [0, 0], [40, 0])).toBe(false);
  });

  describe("a pipe built by features", () => {
    const R = 20;
    const AXIS_Z = 50;

    /**
     * The tutorial's pipe in small: a wall whose top is at the axis height,
     * a circle extruded from an offset 'right' plane (its seam is the top
     * generatrix), a bore cut through it, the bore's rims chamfered.
     */
    function pipeOnWall(): Solid[] {
      sketch("xy", () => {
        testRect(60, 15, { at: [20, -7.5] });
      });
      extrude(AXIS_Z);
      sketch(plane("right", 110), () => {
        circle([0, AXIS_Z], 2 * R);
      });
      const body = extrude(-120) as Extrude;
      sketch(body.startFaces(), () => {
        circle([0, AXIS_Z], R);
      });
      const bore = cut() as Extrude;
      chamfer(2, bore.startEdges(), bore.endEdges());
      return drawnSolids(render());
    }

    const viewOf = (solids: Solid[], on: StandardPlane, options: ViewOptions = {}) =>
      DrawingExport.fromShapes(solids.map((s) => ({ shape: s.getShape(), renderSeams: s.getRenderSeams() })), { unit: 'mm', plane: on, ...options });

    it("has its seam along the top, where the top view looks straight at it", () => {
      const [solid] = pipeOnWall();
      const oc = getOC();
      const edges = Explorer.findShapes<TopoDS_Edge>(solid.getShape(), oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum);
      const seamOnTop = edges.some((raw) => {
        if (!solid.isHiddenEdge(raw)) {
          return false;
        }
        const e = oc.TopoDS.Edge(raw);
        const adaptor = new oc.BRepAdaptor_Curve(e);
        const a = adaptor.Value(adaptor.FirstParameter());
        const b = adaptor.Value(adaptor.LastParameter());
        const onTop = [a, b].every((p) => Math.abs(p.Z() - (AXIS_Z + R)) < 1e-9 && Math.abs(p.Y()) < 1e-9) && Math.abs(a.X() - b.X()) > 100;
        a.delete();
        b.delete();
        adaptor.delete();
        e.delete();
        return onTop;
      });
      expect(seamOnTop).toBe(true);
    });

    it("draws the top view as the pipe's outline: no line down its middle, on any layer", () => {
      const solids = pipeOnWall();
      expect(solids).toHaveLength(1);
      const drawing = viewOf(solids, 'top', { tangentEdges: true });
      // The pipe covers the wall: its two silhouettes and its two ends.
      expect(census(drawing)).toEqual({ 'visible:line': 4 });
      expect(hasLine(drawing, [-10, -R], [110, -R])).toBe(true);
      expect(hasLine(drawing, [-10, R], [110, R])).toBe(true);
      for (const line of drawing.entities.map((e) => e.curve).filter((c) => c.kind === 'line')) {
        expect(Math.abs(line.a.y) < 1e-6 && Math.abs(line.b.y) < 1e-6).toBe(false);
      }
    });

    it("keeps the outline in the view the seam lies on it", () => {
      const front = viewOf(pipeOnWall(), 'front');
      // From the front the seam is the pipe's top silhouette: the silhouette is real.
      expect(hasLine(front, [-10, AXIS_Z + R], [110, AXIS_Z + R])).toBe(true);
      expect(hasLine(front, [-10, AXIS_Z - R], [20, AXIS_Z - R])).toBe(true);
    });

    it("draws no tick for the seams of the bore and its chamfers", () => {
      const solids = pipeOnWall();
      // End-on, the chamfer cones' seams are short radial lines and the bore's a point.
      for (const on of ['right', 'left'] as const) {
        const drawing = viewOf(solids, on, { tangentEdges: true, hiddenLines: true });
        const radial = drawing.entities.filter((e) => e.curve.kind === 'line' && Math.abs(e.curve.a.x) < 1e-6 && Math.abs(e.curve.b.x) < 1e-6
          && Math.min(e.curve.a.y, e.curve.b.y) > AXIS_Z);
        expect(radial, on).toEqual([]);
      }
    });
  });
});

describe("drawing projection — an edge under its own wall's junction", () => {
  setupOC();

  // The hidden-line algorithm does not hide an edge by a face while the
  // edge's projection runs along one of that face's border edges. A round
  // post under a pipe puts the post's foot circle exactly under the curve
  // where the post's wall runs into the pipe — a border of the pipe's face —
  // and the foot came out visible under the pipe. A sight line says no.

  const PLATE_T = 10;
  const POST_R = 30;
  const PIPE_R = 25;
  const AXIS_Z = 60;

  /** A round plate, a round post on it, and a pipe along Y lying on the post (the post's top at `postTop`). */
  function postUnderPipe(postTop = AXIS_Z): Solid[] {
    sketch("xy", () => {
      circle([0, 0], 160);
    });
    extrude(PLATE_T);
    sketch("xy", () => {
      circle([0, 0], 2 * POST_R);
    });
    extrude(postTop);
    sketch(plane("front", 60), () => {
      circle([0, AXIS_Z], 2 * PIPE_R);
    });
    extrude(-120);
    return drawnSolids(render());
  }

  const viewOf = (solids: Solid[], on: StandardPlane, options: ViewOptions = {}) =>
    DrawingExport.fromShapes(solids.map((s) => ({ shape: s.getShape(), renderSeams: s.getRenderSeams() })), { unit: 'mm', plane: on, ...options });

  /** The arcs of `drawing` on the post's foot circle, each with the |x| nearest the pipe's axis it reaches. */
  const footArcs = (drawing: Drawing2D, layer: DrawingLayer) => curvesOf(drawing, 'arc', layer)
    .filter((arc) => near(arc.center, { x: 0, y: 0 }) && Math.abs(arc.radius - POST_R) < 1e-6)
    .map((arc) => Math.min(...Curves.sample(arc, 64).map((p) => Math.abs(p.x))));

  for (const postTop of [AXIS_Z, AXIS_Z - 10]) {
    it(`draws the post's foot only beside the pipe, not under it (post top at z = ${postTop})`, () => {
      const solids = postUnderPipe(postTop);
      expect(solids).toHaveLength(1);
      const top = viewOf(solids, 'top', { hiddenLines: true });
      // Seen: the two stretches of the foot circle clear of the pipe's outline x = ±25.
      const seen = footArcs(top, 'visible');
      expect(seen).toHaveLength(2);
      for (const nearest of seen) {
        expect(nearest).toBeGreaterThan(PIPE_R - 1e-6);
      }
      // Under the pipe the foot is a hidden line, as far in as x = 0.
      const hidden = footArcs(top, 'hidden');
      expect(hidden.length).toBeGreaterThan(0);
      expect(Math.min(...hidden)).toBeLessThan(1);
      // Without hidden lines the stretch is not drawn at all.
      expect(footArcs(viewOf(solids, 'top'), 'visible').every((nearest) => nearest > PIPE_R - 1e-6)).toBe(true);
    });
  }

  it("is what the algorithm itself gets wrong: its visible pieces include the covered stretch", () => {
    const [solid] = postUnderPipe();
    // The sight-line check finds it among the pieces as the algorithm returns them…
    const oc = getOC();
    const frame = new oc.gp_Ax2(new oc.gp_Pnt(0, 0, 0), new oc.gp_Dir(0, 0, 1), new oc.gp_Dir(1, 0, 0));
    const probe = new OcclusionProbe([solid.getShape()], toPlane('top').normal);
    const covered = HiddenLineProjection.withAlgo([solid.getShape()], frame, true, (toShape) => {
      const compound = toShape.CompoundOfEdges(oc.HLRBRep_TypeOfResultingEdge.HLRBRep_Sharp, true, true);
      return Explorer.findShapes<TopoDS_Edge>(compound, oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum)
        .map((raw) => oc.TopoDS.Edge(raw))
        .filter((piece) => probe.sightOf(piece) === 'covered');
    });
    expect(covered.length).toBeGreaterThan(0);
    for (const piece of covered) {
      const adaptor = new oc.BRepAdaptor_Curve(piece);
      const middle = adaptor.Value((adaptor.FirstParameter() + adaptor.LastParameter()) / 2);
      // …at the post's foot, under the pipe.
      expect(middle.Z()).toBeCloseTo(PLATE_T, 9);
      expect(Math.hypot(middle.X(), middle.Y())).toBeCloseTo(POST_R, 6);
      expect(Math.abs(middle.X())).toBeLessThan(PIPE_R);
    }
    // …and none is left in what the projection hands on.
    const edges = HiddenLineProjection.project([solid.getShape()], toPlane('top'), { hidden: true, tangent: true });
    expect([...edges.visible, ...edges.tangent].map((piece) => probe.sightOf(piece))).not.toContain('covered');
    edges.dispose();
    probe.dispose();
  });
});

describe("OcclusionProbe", () => {
  setupOC();

  const up = toPlane('top').normal;

  it("tells a point under the model from one on top of it or beside it", () => {
    // A 40 × 30 × 10 plate standing 20 above the floor of the scene.
    const probe = new OcclusionProbe([M.box([40, 30, 10], [0, 0, 20])], up);
    expect(probe.isCovered([20, 15, 0])).toBe(true);
    expect(probe.isCovered([20, 15, 30])).toBe(false);
    expect(probe.isCovered([20, 15, 40])).toBe(false);
    expect(probe.isCovered([60, 15, 0])).toBe(false);
    probe.dispose();
  });

  it("does not take a face the sight line runs in, or its border, for cover", () => {
    // A step: from the foot of the riser the sight line runs up the riser and through its top edge.
    const step = M.fuse(M.box([40, 20, 10]), M.box([20, 20, 30]));
    const probe = new OcclusionProbe([step], up);
    expect(probe.isCovered([20, 10, 10])).toBe(false);
    // A point of the lower block's side wall under nothing but that wall.
    expect(probe.isCovered([40, 10, 0])).toBe(false);
    // Inside the riser's footprint the block above does cover.
    expect(probe.isCovered([10, 10, 0])).toBe(true);
    probe.dispose();
  });

  it("does not take a silhouette's own surface for cover", () => {
    const probe = new OcclusionProbe([M.sphere(10)], up);
    // On the equator the sight line is tangent to the sphere.
    expect(probe.isCovered([10, 0, 0])).toBe(false);
    // A hair inside the surface, as the kernel's approximate outlines can sit.
    expect(probe.isCovered([9.995, 0, 0])).toBe(false);
    // On the lower half, well under the upper half of the same face (off the
    // sphere's seam in the XZ plane: a crossing on a face's border never counts).
    expect(probe.isCovered([3, 4, -Math.sqrt(75)])).toBe(true);
    expect(probe.isCovered([5, 0, -Math.sqrt(75)])).toBe(false);
    probe.dispose();
  });

  it("leaves a sight line through the border of a face in front undecided: it is not cover, and not a clear view", () => {
    const oc = getOC();
    const probe = new OcclusionProbe([M.sphere(10)], up);
    const segment = (a: [number, number, number], b: [number, number, number]) => new oc.BRepBuilderAPI_MakeEdge(new oc.gp_Pnt(...a), new oc.gp_Pnt(...b)).Edge();
    // Under the sphere, in the plane of its seam: every sight line leaves through the seam.
    const underSeam = segment([1, 0, -20], [8, 0, -20]);
    expect(probe.isCoveredThroughout(underSeam)).toBe(false);
    // A millimetre aside the lines cross the face itself, twice.
    expect(probe.isCoveredThroughout(segment([1, 1, -20], [8, 1, -20]))).toBe(true);
    // Crossing under the seam: one line undecided, the others covered — covered.
    expect(probe.sightOf(segment([4, -3, -20], [4, 3.383, -20]))).toBe('covered');
    probe.dispose();
  });

  it("reads a piece as clear, covered or mixed from its interior points", () => {
    const oc = getOC();
    const probe = new OcclusionProbe([M.box([40, 30, 10], [0, 0, 20])], up);
    const segment = (a: [number, number, number], b: [number, number, number]) => {
      const maker = new oc.BRepBuilderAPI_MakeEdge(new oc.gp_Pnt(...a), new oc.gp_Pnt(...b));
      return maker.Edge();
    };
    expect(probe.sightOf(segment([5, 15, 0], [35, 15, 0]))).toBe('covered');
    expect(probe.isCoveredThroughout(segment([5, 15, 0], [35, 15, 0]))).toBe(true);
    expect(probe.sightOf(segment([50, 15, 0], [80, 15, 0]))).toBe('clear');
    expect(probe.sightOf(segment([20, 15, 0], [80, 15, 0]))).toBe('mixed');
    // Only cover along the whole piece overrules the hidden-line algorithm.
    expect(probe.isCoveredThroughout(segment([20, 15, 0], [80, 15, 0]))).toBe(false);
    probe.dispose();
  });
});

describe("drawing projection — the CSWP tutorial part", () => {
  setupOC();

  // The whole tutorial model, as the docs build it: the part the seam down
  // a pipe's middle and the missing wall/pipe curve were found on.
  const TUTORIAL = fileURLToPath(new URL("../../../website/docs/tutorials/_examples/cswp-sample-exam-final.js", import.meta.url));
  // The file's own parameters.
  const B = 200;
  const C = 170;
  const PIPE2_Y = C - 7.5;
  const PIPE2_R = (B / 3 + 10) / 2;
  const AXIS_Z = 95;

  function tutorialPart(): Solid[] {
    const code = readFileSync(TUTORIAL, "utf8").replace(/^\s*import\s[\s\S]*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, "");
    runFluid(code);
    return drawnSolids(render());
  }

  const viewOf = (solids: Solid[], on: StandardPlane, options: ViewOptions = {}) =>
    DrawingExport.fromShapes(solids.map((s) => ({ shape: s.getShape(), renderSeams: s.getRenderSeams() })), { unit: 'mm', plane: on, ...options });

  it("draws the top view without a line down the middle of the second pipe", () => {
    const solids = tutorialPart();
    expect(solids).toHaveLength(1);
    const top = viewOf(solids, 'top', { hiddenLines: true, tangentEdges: true });
    // The pipe's seam is its top generatrix; a later fuse dropped the
    // continuity recorded on it and the kernel then filed it under creases.
    for (const entity of top.entities) {
      if (entity.curve.kind === 'line') {
        const along = Math.abs(entity.curve.a.y - PIPE2_Y) < 1e-6 && Math.abs(entity.curve.b.y - PIPE2_Y) < 1e-6;
        expect(along && Math.abs(entity.curve.a.x - entity.curve.b.x) > 100, `${entity.layer} line along the pipe`).toBe(false);
      }
    }
    // Its outline is there.
    expect(hasLine(top, [80, PIPE2_Y + PIPE2_R], [210, PIPE2_Y + PIPE2_R])).toBe(true);
    expect(census(viewOf(solids, 'top'))).toEqual({ 'visible:line': 19, 'visible:arc': 11, 'visible:circle': 2 });
  });

  it("draws the curve where the support wall meets the second pipe, as a spline readers draw", () => {
    const solids = tutorialPart();
    const front = viewOf(solids, 'front');
    const meets = curvesOf(front, 'bspline').filter((curve) => {
      const [a, b] = Curves.endpoints(curve)!;
      const fromWallTop = (p: Vec2) => Math.abs(p.y - AXIS_Z) < 1e-6 && Math.abs(p.x - 107.46) < 0.01;
      const toPipeBottom = (p: Vec2) => Math.abs(p.y - (AXIS_Z - PIPE2_R)) < 1e-6 && Math.abs(p.x - 119.69) < 0.01;
      return (fromWallTop(a) && toPipeBottom(b)) || (fromWallTop(b) && toPipeBottom(a));
    });
    expect(meets).toHaveLength(1);
    // The kernel's intersection curve is of degree six…
    expect(meets[0].degree).toBeGreaterThan(3);

    // …and the file has no spline above a cubic, the one for this curve on it.
    const file = DxfOracle.parse(DxfWriter.write(front));
    const splines = DxfOracle.section(file, 'ENTITIES').objects.filter((o) => o.type === 'SPLINE');
    expect(splines).toHaveLength(curvesOf(front, 'bspline').length);
    expect(splines.every((s) => DxfOracle.number(s, 71) <= 3)).toBe(true);
    const index = front.entities.filter((e) => e.curve.kind === 'bspline').findIndex((e) => e.curve === meets[0]);
    const expected = BSplineCurve2D.sample(meets[0], 200);
    const actual = DxfOracle.sample(splines[index], 200);
    expect(Math.max(...expected.map((p, i) => Math.hypot(p.x - actual[i].x, p.y - actual[i].y)))).toBeLessThan(2e-5);
  });

  it("keeps the front view's outline where a seam lies on it, and draws no seam tick", () => {
    const solids = tutorialPart();
    const front = viewOf(solids, 'front', { hiddenLines: true });
    // The second pipe's seam is its top silhouette from the front.
    expect(hasLine(front, [80, AXIS_Z + PIPE2_R], [210, AXIS_Z + PIPE2_R])).toBe(true);
    // The first pipe is seen end-on at x = 37.5: its bore chamfer's seam was a tick below the bore.
    const ticks = front.entities.filter((e) => e.curve.kind === 'line'
      && Math.abs(e.curve.a.x - 37.5) < 1e-6 && Math.abs(e.curve.b.x - 37.5) < 1e-6
      && Math.hypot(e.curve.a.y - e.curve.b.y) < 5);
    expect(ticks).toEqual([]);
  });

  it("draws the plate's rounded corners' borders only as tangent edges", () => {
    const solids = tutorialPart();
    // x = 10: where the plate's front side runs into its corner fillet.
    expect(hasLine(viewOf(solids, 'front'), [10, 0], [10, 25])).toBe(false);
    const withTangent = viewOf(solids, 'front', { tangentEdges: true });
    expect(hasLine(withTangent, [10, 0], [10, 25], 'tangent')).toBe(true);
    expect(hasLine(withTangent, [10, 0], [10, 25], 'visible')).toBe(false);
  });

  it("stops the support wall's foot at the first pipe's outline, not at its bore's", () => {
    const solids = tutorialPart();
    // The wall is the band between r = 75 and r = 90 about (30, 170); its
    // foot on the base lies exactly under the curves where the wall runs into
    // pipe 1 (axis x = 37.5, outer radius 35.5: outline at x = 73, bore's at
    // x = 58). The algorithm called the foot visible from x = 73 in to x = 58.
    const PIPE1_OUTLINE_X = 73;
    const onWall = (arc: Extract<Curve2D, { kind: 'arc' }>) => near(arc.center, { x: 30, y: 170 }) && (Math.abs(arc.radius - 90) < 1e-6 || Math.abs(arc.radius - 75) < 1e-6);
    const leftmost = (arc: Extract<Curve2D, { kind: 'arc' }>) => Math.min(...Curves.sample(arc, 64).map((p) => p.x));

    const top = viewOf(solids, 'top', { hiddenLines: true });
    const seen = curvesOf(top, 'arc').filter(onWall);
    expect(seen).toHaveLength(2);
    for (const arc of seen) {
      expect(leftmost(arc)).toBeCloseTo(PIPE1_OUTLINE_X, 6);
    }
    // The covered stretch is a hidden line now, joined to the one the bore already hid.
    const behind = curvesOf(top, 'arc', 'hidden').filter(onWall).filter((arc) => leftmost(arc) < PIPE1_OUTLINE_X - 1);
    expect(behind).toHaveLength(2);
    for (const arc of behind) {
      expect(Math.max(...Curves.sample(arc, 64).map((p) => p.x))).toBeCloseTo(PIPE1_OUTLINE_X, 6);
    }
    // The pocket outline (r = 99, lower down) always stopped there.
    const pocket = curvesOf(top, 'arc').filter((arc) => near(arc.center, { x: 30, y: 170 }) && Math.abs(arc.radius - 99) < 1e-6);
    expect(pocket.map(leftmost)[0]).toBeCloseTo(PIPE1_OUTLINE_X, 6);
  });

  it("leaves no visible piece with the model in front of it, in any of the six views", () => {
    const solids = tutorialPart();
    const shapes = solids.map((s) => s.getShape());
    for (const on of SIX_VIEWS) {
      const viewPlane = toPlane(on);
      const probe = new OcclusionProbe(shapes, viewPlane.normal);
      const edges = HiddenLineProjection.project(
        solids.map((s) => ({ shape: s.getShape(), renderSeams: s.getRenderSeams() })),
        viewPlane,
        { hidden: true, tangent: true },
      );
      const sights = [...edges.visible, ...edges.tangent].map((piece) => probe.sightOf(piece));
      expect(sights.length, on).toBeGreaterThan(10);
      // Neither covered along its length nor covered in part: the pieces are cut where visibility changes.
      expect(sights.filter((sight) => sight !== 'clear'), on).toEqual([]);
      edges.dispose();
      probe.dispose();
    }
  });

  it("draws all six views without a warning", () => {
    const solids = tutorialPart();
    for (const on of SIX_VIEWS) {
      const drawing = viewOf(solids, on, { hiddenLines: true, tangentEdges: true });
      expect(drawing.warnings, on).toEqual([]);
      expect(drawing.entities.length, on).toBeGreaterThan(20);
      expect(drawing.entities.length, on).toBeLessThan(300);
      expect(() => DxfWriter.write(drawing)).not.toThrow();
    }
  });

  it("writes all six views as SVG: the same drawing as the DXF, on a page of its bounds", () => {
    const solids = tutorialPart();
    for (const on of SIX_VIEWS) {
      const drawing = viewOf(solids, on, { hiddenLines: true, tangentEdges: true });
      const svg = SvgOracle.parse(SvgWriter.write(drawing, { margin: 0 }));
      const dxf = DxfOracle.parse(DxfWriter.write(drawing));

      // The page is the extents the DXF declares, in the same numbers.
      const [minX, minY] = DxfOracle.headerVariable(dxf, '$EXTMIN').map((p) => Number(p.value));
      const [maxX, maxY] = DxfOracle.headerVariable(dxf, '$EXTMAX').map((p) => Number(p.value));
      // (An SVG millimetre is written to seven decimals, a DXF real to nine.)
      expect(svg.viewBox.x, on).toBeCloseTo(minX, 6);
      expect(svg.viewBox.y, on).toBe(0);
      expect(svg.viewBox.width, on).toBeCloseTo(maxX - minX, 6);
      expect(svg.viewBox.height, on).toBeCloseTo(maxY - minY, 6);
      expect(svg.attributes.width, on).toBe(`${SvgWriter.number(maxX - minX, 7)}mm`);

      // Every layer is there, and every path reads by the format's grammar and stays on the page.
      const inUse = (['hidden', 'tangent', 'visible'] as const).filter((layer) => drawing.entities.some((e) => e.layer === layer));
      expect(inUse, on).toContain('visible');
      expect(inUse, on).toContain('hidden');
      expect(svg.groups.map((g) => g.id), on).toEqual(inUse);
      let drawn = 0;
      for (const group of svg.groups) {
        for (const element of group.elements) {
          if (element.tag === 'circle') {
            drawn++;
            continue;
          }
          expect(element.tag, on).toBe('path');
          for (const segment of SvgOracle.segments(element.attributes.d)) {
            drawn++;
            for (const p of SvgOracle.sample(segment, 6)) {
              expect(p.x, on).toBeGreaterThan(minX - 1e-6);
              expect(p.x, on).toBeLessThan(maxX + 1e-6);
              expect(p.y, on).toBeGreaterThan(-1e-6);
              expect(p.y, on).toBeLessThan(maxY - minY + 1e-6);
            }
          }
        }
      }
      // At least one drawn piece per entity: nothing the DXF has is left out.
      expect(drawn, on).toBeGreaterThanOrEqual(drawing.entities.length);
    }
  });

  it("puts the top view the right way up in SVG: the far side of the plate at the top of the page", () => {
    const solids = tutorialPart();
    const drawing = viewOf(solids, 'top');
    const svg = SvgOracle.parse(SvgWriter.write(drawing, { margin: 0 }));
    // The counterbored hole sits near the plate's front-right corner, (170, 30): low on the page, to the right.
    const circles = SvgOracle.group(svg, 'visible').elements.filter((e) => e.tag === 'circle');
    expect(circles.map((c) => [Number(c.attributes.cx), Number(c.attributes.cy), Number(c.attributes.r)]).sort((p, q) => p[2] - q[2]))
      .toEqual([[170, drawing.bounds!.max.y - 30, 7.5], [170, drawing.bounds!.max.y - 30, 15]]);
    expect(drawing.bounds!.max.y - 30).toBeGreaterThan(svg.viewBox.height / 2);
  });
});

describe("EdgeToCurve2D", () => {
  setupOC();

  const TOL = 1e-5;

  /** A cubic B-spline edge through `points`, optionally only the stretch between two fractions of its range. */
  function splineEdge(points: [number, number, number][], from = 0, to = 1): TopoDS_Edge {
    const oc = getOC();
    const array = new oc.NCollection_Array1_gp_Pnt(1, points.length);
    points.forEach((p, i) => {
      const point = new oc.gp_Pnt(p[0], p[1], p[2]);
      array.SetValue(i + 1, point);
      point.delete();
    });
    const fit = new oc.GeomAPI_PointsToBSpline(array);
    const curve = fit.Curve();
    const [u0, u1] = [curve.FirstParameter(), curve.LastParameter()];
    const maker = new oc.BRepBuilderAPI_MakeEdge(curve, u0 + (u1 - u0) * from, u0 + (u1 - u0) * to);
    const result = maker.Edge();
    maker.delete();
    fit.delete();
    array.delete();
    return result;
  }

  /** The edge's own points, projected: what the converted curve must pass through. */
  function projectedSamples(e: TopoDS_Edge, on: Plane, count: number): Vec2[] {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Curve(e);
    const [first, last] = [adaptor.FirstParameter(), adaptor.LastParameter()];
    const points: Vec2[] = [];
    for (let i = 0; i <= count; i++) {
      const p = adaptor.Value(first + ((last - first) * i) / count);
      const local = on.worldToLocal({ x: p.X(), y: p.Y(), z: p.Z() } as never);
      points.push({ x: local.x, y: local.y });
      p.delete();
    }
    adaptor.delete();
    return points;
  }

  const wavy: [number, number, number][] = [[0, 0, 0], [5, 8, 2], [12, 3, 5], [18, 9, 1], [25, 4, 6], [31, 10, 3]];

  it("carries a spline over as a spline: same degree and knots, poles projected", () => {
    const e = splineEdge(wavy);
    for (const on of ['top', 'front', 'left'] as const) {
      const target = toPlane(on);
      const { curve, approximated } = EdgeToCurve2D.convert(e, target, TOL);
      expect(approximated).toBe(false);
      expect(curve!.kind).toBe('bspline');
      if (curve!.kind !== 'bspline') {
        continue;
      }
      expect(BSplineCurve2D.invalidReason(curve)).toBeNull();
      // An affine map keeps the parametrisation: point for point the same curve.
      const expected = projectedSamples(e, target, 40);
      const actual = BSplineCurve2D.sample(curve, 40);
      const deviation = Math.max(...expected.map((p, i) => Math.hypot(p.x - actual[i].x, p.y - actual[i].y)));
      expect(deviation).toBeLessThan(1e-9);
    }
  });

  it("cuts the spline to the edge: an edge on part of its curve draws only that part", () => {
    const e = splineEdge(wavy, 0.25, 0.6);
    const target = toPlane('top');
    const { curve } = EdgeToCurve2D.convert(e, target, TOL);
    expect(curve!.kind).toBe('bspline');
    if (curve!.kind !== 'bspline') {
      return;
    }
    const expected = projectedSamples(e, target, 40);
    const actual = BSplineCurve2D.sample(curve, 40);
    // Starts and ends where the edge does — not at the curve's own ends…
    expect(Math.hypot(actual[0].x - expected[0].x, actual[0].y - expected[0].y)).toBeLessThan(1e-9);
    expect(Math.hypot(actual[40].x - expected[40].x, actual[40].y - expected[40].y)).toBeLessThan(1e-9);
    expect(Math.hypot(actual[0].x, actual[0].y)).toBeGreaterThan(1);
    // …and follows it in between.
    const deviation = Math.max(...expected.map((p, i) => Math.hypot(p.x - actual[i].x, p.y - actual[i].y)));
    expect(deviation).toBeLessThan(1e-9);
  });

  it("draws a planar spline seen edge-on as a line", () => {
    // Every point at y = 3: seen from the top it is a stretch of that line.
    const e = splineEdge([[0, 3, 0], [5, 3, 8], [12, 3, 2], [18, 3, 9]]);
    const { curve } = EdgeToCurve2D.convert(e, toPlane('top'), TOL);
    expect(curve!.kind).toBe('line');
    if (curve!.kind === 'line') {
      const xs = [curve.a.x, curve.b.x].sort((p, q) => p - q);
      expect(xs[0]).toBeCloseTo(0, 6);
      expect(xs[1]).toBeCloseTo(18, 6);
      expect(curve.a.y).toBeCloseTo(3, 9);
    }
  });

  it("draws nothing for a line along the view direction", () => {
    const oc = getOC();
    const [a, b] = [new oc.gp_Pnt(3, 4, 0), new oc.gp_Pnt(3, 4, 10)];
    const maker = new oc.BRepBuilderAPI_MakeEdge(a, b);
    expect(EdgeToCurve2D.convert(maker.Edge(), toPlane('top'), TOL)).toEqual({ curve: null, approximated: false });
    const front = EdgeToCurve2D.convert(maker.Edge(), toPlane('front'), TOL).curve!;
    expect(front).toEqual({ kind: 'line', a: { x: 3, y: 0 }, b: { x: 3, y: 10 } });
    maker.delete();
    a.delete();
    b.delete();
  });

  it("carries a parabola over as an exact spline, not a polyline", () => {
    const oc = getOC();
    const origin = new oc.gp_Pnt(0, 0, 0);
    const normal = new oc.gp_Dir(0, 0, 1);
    const frame = new oc.gp_Ax2(origin, normal);
    const parabola = new oc.gp_Parab(frame, 2);
    const maker = new oc.BRepBuilderAPI_MakeEdge(parabola, -3, 4);
    const e = maker.Edge();
    const target = toPlane('top');
    const { curve, approximated } = EdgeToCurve2D.convert(e, target, TOL);
    expect(approximated).toBe(false);
    expect(curve!.kind).toBe('bspline');
    if (curve!.kind === 'bspline') {
      // Every sampled point of the spline satisfies the parabola's equation y² = 4·f·x.
      for (const p of BSplineCurve2D.sample(curve, 30)) {
        expect(p.y * p.y - 8 * p.x).toBeCloseTo(0, 8);
      }
      const ends = BSplineCurve2D.sample(curve, 1);
      const expected = projectedSamples(e, target, 1);
      expect(near(ends[0], expected[0], 1e-9)).toBe(true);
      expect(near(ends[1], expected[1], 1e-9)).toBe(true);
    }
    maker.delete();
    parabola.delete();
    frame.delete();
    normal.delete();
    origin.delete();
  });
});

describe("EdgeToCurve2D.sample — the polyline fallback", () => {
  setupOC();

  it("stays within its chord tolerance of the curve and ends on the edge's ends", () => {
    const oc = getOC();
    const origin = new oc.gp_Pnt(2, 3, 0);
    const normal = new oc.gp_Dir(0, 0, 1);
    const frame = new oc.gp_Ax2(origin, normal);
    const circ = new oc.gp_Circ(frame, 10);
    const maker = new oc.BRepBuilderAPI_MakeEdge(circ, 0.5, 2.5);
    const tolerance = 1e-5;
    const curve = EdgeToCurve2D.sample(maker.Edge(), toPlane('top'), tolerance)!;
    expect(curve.kind).toBe('polyline');
    if (curve.kind === 'polyline') {
      expect(curve.closed).toBe(false);
      expect(near(curve.points[0], { x: 2 + 10 * Math.cos(0.5), y: 3 + 10 * Math.sin(0.5) }, 1e-9)).toBe(true);
      expect(near(curve.points.at(-1)!, { x: 2 + 10 * Math.cos(2.5), y: 3 + 10 * Math.sin(2.5) }, 1e-9)).toBe(true);
      // Every vertex on the circle, every chord's middle within reach of it.
      const reach = tolerance * EdgeToCurve2D.SAMPLE_CHORD_FACTOR;
      for (let i = 0; i + 1 < curve.points.length; i++) {
        const [p, q] = [curve.points[i], curve.points[i + 1]];
        expect(Math.hypot(p.x - 2, p.y - 3)).toBeCloseTo(10, 9);
        const sag = 10 - Math.hypot((p.x + q.x) / 2 - 2, (p.y + q.y) / 2 - 3);
        expect(sag).toBeLessThanOrEqual(reach * 1.01);
      }
    }
    maker.delete();
    circ.delete();
    frame.delete();
    normal.delete();
    origin.delete();
  });

  it("closes a sampled loop", () => {
    const oc = getOC();
    const origin = new oc.gp_Pnt(0, 0, 0);
    const normal = new oc.gp_Dir(0, 0, 1);
    const frame = new oc.gp_Ax2(origin, normal);
    const circ = new oc.gp_Circ(frame, 4);
    const maker = new oc.BRepBuilderAPI_MakeEdge(circ);
    const curve = EdgeToCurve2D.sample(maker.Edge(), toPlane('top'), 1e-5)!;
    expect(curve.kind === 'polyline' && curve.closed).toBe(true);
    maker.delete();
    circ.delete();
    frame.delete();
    normal.delete();
    origin.delete();
  });
});

describe("HiddenLineProjection", () => {
  setupOC();

  it("returns nothing on the layers that were not asked for and frees what it returned", () => {
    const shape = M.plateWithHole();
    const plain = HiddenLineProjection.project([shape], toPlane('front'));
    expect(plain.visible.length).toBeGreaterThan(0);
    expect(plain.hidden).toHaveLength(0);
    expect(plain.tangent).toHaveLength(0);
    plain.dispose();
    expect(plain.visible).toHaveLength(0);

    const all = HiddenLineProjection.project([shape], toPlane('front'), { hidden: true, tangent: true });
    expect(all.hidden.length).toBeGreaterThan(0);
    all.dispose();
  });
});

describe("FileExport — DXF", () => {
  setupOC();

  const entities = (text: string) => DxfOracle.section(DxfOracle.parse(text), 'ENTITIES').objects;

  it("writes the solids' view as a DXF named after the view", () => {
    const solids = exportable(box(10));
    const top = FileExport.exportShapes(solids, { format: 'dxf', plane: 'top' });
    expect(top.fileName).toBe('export-top.dxf');
    expect(typeof top.data).toBe('string');
    expect(entities(top.data as string).map((e) => e.type)).toEqual(['LINE', 'LINE', 'LINE', 'LINE']);

    // An axis name is written under its view's name.
    expect(FileExport.exportShapes(solids, { format: 'dxf', plane: '-xz' }).fileName).toBe('export-back.dxf');
    expect(FileExport.exportShapes(solids, { format: 'dxf', plane: 'yz' }).fileName).toBe('export-right.dxf');
  });

  it("keeps an inch document's numbers and declares inches", () => {
    const solids = exportable(box(2));
    const text = withUnit('in', () => FileExport.exportShapes(solids, { format: 'dxf', plane: 'front', unit: 'in' }).data as string);
    const file = DxfOracle.parse(text);
    expect(DxfOracle.headerVariable(file, '$INSUNITS')).toEqual([{ code: 70, value: '1' }]);
    expect(DxfOracle.headerVariable(file, '$MEASUREMENT')).toEqual([{ code: 70, value: '0' }]);
    expect(DxfOracle.headerVariable(file, '$EXTMAX').map((p) => Number(p.value))).toEqual([2, 2, 0]);
  });

  it("still refuses an export with no solids, and leaves STEP and STL as they were", () => {
    expect(() => FileExport.exportShapes([], { format: 'dxf', plane: 'top' })).toThrow(/No solids/);
    const solids = exportable(box(10));
    expect(FileExport.exportShapes(solids, { format: 'step' }).fileName).toBe('export.step');
    expect(FileExport.exportShapes(solids, { format: 'stl' }).fileName).toBe('export.stl');
  });

  it("goes through the scene manager with the scene's unit", () => {
    box(10);
    const scene = getCurrentScene();
    const ids = sceneSolids().map((s) => s.id);
    const result = getSceneManager().exportShapes(scene, ids, { format: 'dxf', plane: 'right', hiddenLines: true });
    expect(result.fileName).toBe('export-right.dxf');
    const file = DxfOracle.parse(result.data as string);
    expect(DxfOracle.headerVariable(file, '$INSUNITS')).toEqual([{ code: 70, value: '4' }]);
    expect(entities(result.data as string)).toHaveLength(4);
  });
});

describe("FileExport — SVG", () => {
  setupOC();

  it("writes the solids' view as an SVG named and titled after the view", () => {
    const solids = exportable(box(10));
    const top = FileExport.exportShapes(solids, { format: 'svg', plane: 'top' });
    expect(top.fileName).toBe('export-top.svg');
    expect(typeof top.data).toBe('string');
    const file = SvgOracle.parse(top.data as string);
    expect(file.title).toBe('Top view');
    expect(file.viewBox).toEqual({ x: -5, y: -5, width: 20, height: 20 });
    expect(file.attributes.width).toBe('20mm');
    // The square is one closed path.
    expect(file.groups.map((g) => g.id)).toEqual(['visible']);
    expect(file.groups[0].elements.map((e) => e.attributes.d)).toEqual(['M 0 10 L 10 10 L 10 0 L 0 0 Z']);

    // An axis name is written under its view's name.
    const back = FileExport.exportShapes(solids, { format: 'svg', plane: '-xz' });
    expect(back.fileName).toBe('export-back.svg');
    expect(SvgOracle.parse(back.data as string).title).toBe('Back view');
  });

  it("takes the stroke width and margin of the page, and the drawing's options", () => {
    const solids = exportable(box(10));
    const result = FileExport.exportShapes(solids, {
      format: 'svg', plane: 'front', hiddenLines: true, svg: { strokeWidth: 0.5, margin: 2 },
    });
    const file = SvgOracle.parse(result.data as string);
    expect(file.viewBox).toEqual({ x: -2, y: -2, width: 14, height: 14 });
    expect(SvgOracle.group(file, 'visible').attributes['stroke-width']).toBe('0.5');
    expect(() => FileExport.exportShapes(solids, { format: 'svg', plane: 'front', svg: { strokeWidth: 0 } })).toThrow(/stroke width/);
  });

  it("keeps an inch document's numbers and sizes the page in inches", () => {
    const solids = exportable(box(2));
    const text = withUnit('in', () => FileExport.exportShapes(solids, { format: 'svg', plane: 'front', unit: 'in', svg: { margin: 0 } }).data as string);
    const file = SvgOracle.parse(text);
    expect(file.viewBox).toEqual({ x: 0, y: 0, width: 2, height: 2 });
    expect(file.attributes.width).toBe('2in');
    expect(file.attributes.height).toBe('2in');
  });

  it("goes through the scene manager with the scene's unit, and is a drawing like DXF", () => {
    box(10);
    const scene = getCurrentScene();
    const ids = sceneSolids().map((s) => s.id);
    const result = getSceneManager().exportShapes(scene, ids, { format: 'svg', plane: 'right', hiddenLines: true });
    expect(result.fileName).toBe('export-right.svg');
    expect(SvgOracle.parse(result.data as string).attributes.width).toBe('20mm');
    expect(FileExport.isDrawing({ format: 'svg', plane: 'top' })).toBe(true);
    expect(FileExport.isDrawing({ format: 'dxf', plane: 'top' })).toBe(true);
    expect(FileExport.isDrawing({ format: 'step' })).toBe(false);
    expect(() => FileExport.exportShapes([], { format: 'svg', plane: 'top' })).toThrow(/No solids/);
  });
});

describe("SVG golden files — from the kernel", () => {
  setupOC();

  it("the plate with a hole, top", async () => {
    await expect(SvgWriter.write(view([M.plateWithHole()], 'top'), { title: 'Top view' }))
      .toMatchFileSnapshot('./drawing/golden/plate-top.svg');
  });

  it("the plate with a hole, front, hidden lines on", async () => {
    await expect(SvgWriter.write(view([M.plateWithHole()], 'front', { hiddenLines: true }), { title: 'Front view' }))
      .toMatchFileSnapshot('./drawing/golden/plate-front-hidden.svg');
  });
});

describe("DXF golden files — from the kernel", () => {
  setupOC();

  const golden = (drawing: Drawing2D) => DxfWriter.write(drawing).replace(/\r\n/g, '\n');

  it("the plate with a hole, top", async () => {
    await expect(golden(view([M.plateWithHole()], 'top'))).toMatchFileSnapshot('./drawing/golden/plate-top.dxf');
  });

  it("the plate with a hole, front, hidden lines on", async () => {
    await expect(golden(view([M.plateWithHole()], 'front', { hiddenLines: true })))
      .toMatchFileSnapshot('./drawing/golden/plate-front-hidden.dxf');
  });
});
