import { describe, it, expect } from "vitest";
import type { TopoDS_Shape } from "ocjs-fluidcad";
import { setupOC, render } from "../setup.js";
import { getOC } from "../../oc/init.js";
import { Convert } from "../../oc/convert.js";
import { getSceneManager, getCurrentScene } from "../../scene-manager.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import part from "../../core/part.js";
import insert from "../../core/insert.js";
import { DrawingExport } from "../../io/drawing/index.js";
import type { Curve2D, Drawing2D, DrawingLayer, Vec2, ViewBody, ViewStats } from "../../io/drawing/index.js";
import type { StandardPlane } from "../../math/plane.js";
import type { Pose } from "../../math/pose.js";
import { testRect } from "../helpers/profiles.js";
import { DrawingModels as M } from "./drawing/models.js";

const SIX_VIEWS: StandardPlane[] = ['top', 'bottom', 'front', 'back', 'right', 'left'];
const NO_TURN = { x: 0, y: 0, z: 0, w: 1 };

function at(x: number, y: number, z: number): Pose {
  return { position: { x, y, z }, quaternion: NO_TURN };
}

/** A pose turned `degrees` about `axis` (a unit vector), then moved to `position`. */
function turned(axis: [number, number, number], degrees: number, position: [number, number, number] = [0, 0, 0]): Pose {
  const half = (degrees * Math.PI) / 360;
  const s = Math.sin(half);
  return {
    position: { x: position[0], y: position[1], z: position[2] },
    quaternion: { x: axis[0] * s, y: axis[1] * s, z: axis[2] * s, w: Math.cos(half) },
  };
}

function view(bodies: ViewBody[], plane: StandardPlane, options: { hiddenLines?: boolean; tangentEdges?: boolean } = {}): Drawing2D & { stats: ViewStats } {
  let stats!: ViewStats;
  const drawing = DrawingExport.fromBodies(bodies, { unit: 'mm', plane, ...options }, (s) => { stats = s; });
  return Object.assign(drawing, { stats });
}

/** `shape` moved to `pose`, as the flattened assembly holds it. */
function placed(shape: TopoDS_Shape, pose: Pose): TopoDS_Shape {
  const oc = getOC();
  const [trsf, dispose] = Convert.toGpTrsfPose(pose.position, pose.quaternion);
  const location = new oc.TopLoc_Location(trsf);
  const moved = shape.Moved(location, false);
  location.delete();
  dispose();
  return moved;
}

function curvesOf<K extends Curve2D['kind']>(drawing: Drawing2D, kind: K, layer: DrawingLayer = 'visible'): Extract<Curve2D, { kind: K }>[] {
  return drawing.entities
    .filter((e) => e.layer === layer && e.curve.kind === kind)
    .map((e) => e.curve as Extract<Curve2D, { kind: K }>);
}

const near = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y) <= 1e-6;

function hasLine(drawing: Drawing2D, a: [number, number], b: [number, number], layer: DrawingLayer = 'visible'): boolean {
  const [p, q] = [{ x: a[0], y: a[1] }, { x: b[0], y: b[1] }];
  return curvesOf(drawing, 'line', layer).some((l) => (near(l.a, p) && near(l.b, q)) || (near(l.a, q) && near(l.b, p)));
}

/** The drawing's entities as text, rounded past the kernel's noise — what two drawings of one model share. */
function signature(drawing: Drawing2D): string[] {
  const round = (value: unknown): unknown => {
    if (typeof value === 'number') {
      return Math.round(value * 1e6) / 1e6 + 0;
    }
    if (Array.isArray(value)) {
      return value.map(round);
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, round(v)]));
    }
    return value;
  };
  return drawing.entities.map((entity) => JSON.stringify(round(entity))).sort();
}

describe("assembly drawing — bodies hide each other", () => {
  setupOC();

  it("draws the part of an edge under another body as a hidden line", () => {
    const block = M.box([20, 20, 10]);
    const drawing = view([{ shape: block, pose: at(0, 0, 0) }, { shape: block, pose: at(10, 10, 30) }], 'top', { hiddenLines: true });

    // The lower block's far side: seen up to the upper block, hidden under it.
    expect(hasLine(drawing, [0, 20], [10, 20])).toBe(true);
    expect(hasLine(drawing, [10, 20], [20, 20], 'hidden')).toBe(true);
    expect(hasLine(drawing, [20, 10], [20, 20], 'hidden')).toBe(true);
    // The upper block is whole.
    expect(hasLine(drawing, [10, 10], [30, 10])).toBe(true);
    expect(hasLine(drawing, [10, 10], [10, 30])).toBe(true);
    expect(drawing.entities.filter((e) => e.layer === 'hidden')).toHaveLength(2);
  });

  it("leaves the covered part out when hidden lines are off", () => {
    const block = M.box([20, 20, 10]);
    const drawing = view([{ shape: block, pose: at(0, 0, 0) }, { shape: block, pose: at(10, 10, 30) }], 'top');
    expect(drawing.entities.every((e) => e.layer === 'visible')).toBe(true);
    expect(hasLine(drawing, [0, 20], [10, 20])).toBe(true);
    // The four sides the lower block still shows — two of them cut short — and the upper block's four.
    expect(curvesOf(drawing, 'line')).toHaveLength(8);
  });

  it("draws one outline for bodies stacked flush", () => {
    // A washer under a bolt head of its own diameter.
    const disc = M.cylinder(10, 5);
    const drawing = view([{ shape: disc, pose: at(0, 0, 0) }, { shape: disc, pose: at(0, 0, 5) }], 'top', { hiddenLines: true });
    expect(drawing.entities).toHaveLength(1);
    expect(curvesOf(drawing, 'circle')).toHaveLength(1);
    expect(curvesOf(drawing, 'circle')[0].radius).toBeCloseTo(10, 9);
  });

  it("does not let a body hide the edges resting on it", () => {
    // A block standing on a plate, seen from the front: its foot lies on the plate's top.
    const drawing = view([
      { shape: M.box([60, 40, 10]), pose: at(0, 0, 0) },
      { shape: M.box([20, 20, 30]), pose: at(20, 10, 10) },
    ], 'front', { hiddenLines: true });
    expect(hasLine(drawing, [0, 10], [60, 10])).toBe(true);
    expect(hasLine(drawing, [20, 10], [20, 40])).toBe(true);
    expect(hasLine(drawing, [20, 40], [40, 40])).toBe(true);
    expect(drawing.entities.filter((e) => e.layer === 'hidden')).toHaveLength(0);
  });

  it("cuts an edge where it runs into another body", () => {
    // A rod through a plate, seen from the front: inside the plate it is hidden.
    const drawing = view([
      { shape: M.box([40, 40, 10]), pose: at(0, 0, 20) },
      { shape: M.box([6, 6, 60]), pose: at(17, 17, 0) },
    ], 'front', { hiddenLines: true });
    expect(hasLine(drawing, [17, 0], [17, 20])).toBe(true);
    expect(hasLine(drawing, [17, 20], [17, 30], 'hidden')).toBe(true);
    expect(hasLine(drawing, [17, 30], [17, 60])).toBe(true);
  });

  it("hides a curved body behind a curved one, cut on the curve itself", () => {
    // A pin behind a disc, both seen along their axes: the pin shows outside the disc only.
    const drawing = view([
      { shape: M.cylinder(10, 5), pose: at(0, 0, 20) },
      { shape: M.cylinder(10, 5), pose: at(12, 0, 0) },
    ], 'top', { hiddenLines: true });
    expect(curvesOf(drawing, 'circle')).toHaveLength(1);
    const seen = curvesOf(drawing, 'arc');
    const behind = curvesOf(drawing, 'arc', 'hidden');
    expect(seen).toHaveLength(1);
    expect(behind).toHaveLength(1);
    // Two circles of radius 10, 12 apart, meet at x = 6: at ±acos(−0.6) around the pin's centre.
    const meet = Math.acos(-0.6);
    expect(seen[0].center.x).toBeCloseTo(12, 9);
    expect(seen[0].end - seen[0].start).toBeCloseTo(2 * meet, 7);
    expect(behind[0].end - behind[0].start).toBeCloseTo(2 * Math.PI - 2 * meet, 7);
  });
});

describe("assembly drawing — the same drawing as the placed shapes", () => {
  setupOC();

  it("draws posed bodies as it draws the shapes moved into place, on every plane", () => {
    const plate = M.plateWithHole();
    const post = M.cylinder(4, 30);
    const bodies: ViewBody[] = [
      { shape: plate, pose: at(0, 0, 0) },
      { shape: post, pose: turned([0, 1, 0], 30, [20, 15, 5]) },
      { shape: plate, pose: turned([0, 0, 1], 90, [60, 0, 12]) },
    ];
    for (const plane of SIX_VIEWS) {
      const posed = view(bodies, plane, { hiddenLines: true, tangentEdges: true });
      const moved = DrawingExport.fromShapes(bodies.map((body) => placed(body.shape, body.pose!)), {
        unit: 'mm', plane, hiddenLines: true, tangentEdges: true,
      });
      expect(signature(posed), plane).toEqual(signature(moved));
    }
  });
});

describe("assembly drawing — copies of a part share their outlines", () => {
  setupOC();

  it("computes a shape's curves once for copies turned alike or about the view direction", () => {
    const post = M.cylinder(4, 30, [0, 0, 0], [1, 0, 0]);
    const drawing = view([
      { shape: post, pose: at(0, 0, 0) },
      { shape: post, pose: at(0, 20, 0) },
      { shape: post, pose: at(50, 40, 7) },
      { shape: post, pose: turned([0, 0, 1], 37, [0, 80, 0]) },
    ], 'top');
    expect(drawing.stats.bodies).toBe(4);
    expect(drawing.stats.views).toBe(1);
    // Each lying post is a rectangle.
    expect(curvesOf(drawing, 'line')).toHaveLength(16);
  });

  it("computes them again for a copy seen from another side", () => {
    const post = M.cylinder(4, 30, [0, 0, 0], [1, 0, 0]);
    const drawing = view([
      { shape: post, pose: at(0, 0, 0) },
      { shape: post, pose: turned([0, 1, 0], 90, [60, 0, 0]) },
    ], 'top');
    expect(drawing.stats.views).toBe(2);
    expect(curvesOf(drawing, 'circle')).toHaveLength(1);
  });

  it("tells two shapes apart", () => {
    const drawing = view([{ shape: M.box([10, 10, 10]), pose: at(0, 0, 0) }, { shape: M.box([10, 10, 10]), pose: at(30, 0, 0) }], 'top');
    expect(drawing.stats.views).toBe(2);
  });
});

describe("assembly drawing — edges that land on each other", () => {
  setupOC();

  /** A piston: ring grooves and a cross bore, every circle of it a line over the others seen from the side. */
  function piston(): TopoDS_Shape {
    let body = M.cylinder(42.5, 90);
    for (const z of [60, 70, 80]) {
      body = M.cut(body, M.cut(M.cylinder(44, 4, [0, 0, z]), M.cylinder(39.5, 4, [0, 0, z])));
    }
    body = M.cut(body, M.cylinder(38, 75));
    return M.cut(body, M.cylinder(16.9, 100, [0, -50, 27], [0, 1, 0]));
  }

  it("draws four pistons one behind the other in seconds", () => {
    const shape = piston();
    const bodies = [0, 114, 228, 342].map((y) => ({ shape, pose: at(0, y, 0) }));
    const started = performance.now();
    const drawing = view(bodies, 'front', { hiddenLines: true });
    // The kernel's own hiding pass takes over ten seconds for one of them.
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(drawing.stats.views).toBe(1);
    // The crown and the skirt's foot, and the bore's mouth in the skirt: two curves round it.
    expect(hasLine(drawing, [-42.5, 90], [42.5, 90])).toBe(true);
    expect(hasLine(drawing, [-42.5, 0], [42.5, 0])).toBe(true);
    expect(curvesOf(drawing, 'bspline')).toHaveLength(2);
    // The hollow inside, behind the skirt.
    expect(hasLine(drawing, [-38, 0], [-38, 75], 'hidden')).toBe(true);
    expect(hasLine(drawing, [-38, 75], [38, 75], 'hidden')).toBe(true);
    // A groove's floor shows between its lips: three grooves, two sides.
    const floors = curvesOf(drawing, 'line').filter((l) => Math.abs(Math.abs(l.a.x) - 39.5) < 1e-6 && Math.abs(l.a.x - l.b.x) < 1e-6);
    expect(floors).toHaveLength(6);
  });
});

describe("assembly drawing — export", () => {
  setupOC();

  function blockDefinition() {
    return part("block", () => {
      sketch("xy", () => { testRect(20, 20); });
      extrude(10);
    });
  }

  function exportCurrent(options: { format: 'dxf' | 'svg'; plane: StandardPlane; hiddenLines?: boolean }) {
    const outcome = getSceneManager().exportAssembly(getCurrentScene(), { name: "rig", ...options });
    if ('reason' in outcome) {
      throw new Error(outcome.reason);
    }
    return outcome;
  }

  it("writes the assembly's view as an SVG named after the assembly and the view", () => {
    getSceneManager().startScene();
    getSceneManager().startAssemblyScene();
    const block = blockDefinition();
    insert(block);
    insert(block).translate(10, 10, 30);
    render();

    const outcome = exportCurrent({ format: 'svg', plane: 'xy', hiddenLines: true });
    expect(outcome.fileName).toBe("rig-top.svg");
    const svg = outcome.data as string;
    expect(svg).toContain('<g id="hidden"');
    expect(svg).toContain('<g id="visible"');
    // 30 wide and 30 deep, on a 5 mm margin.
    expect(svg).toMatch(/viewBox="-5 -5 40 40"/);
  });

  it("writes it as a DXF with the hidden edges on their layer", () => {
    getSceneManager().startScene();
    getSceneManager().startAssemblyScene();
    const block = blockDefinition();
    insert(block);
    insert(block).translate(10, 10, 30);
    render();

    const outcome = exportCurrent({ format: 'dxf', plane: 'top', hiddenLines: true });
    expect(outcome.fileName).toBe("rig-top.dxf");
    const dxf = outcome.data as string;
    expect(dxf).toContain("HIDDEN");
    // Eight seen sides and the lower block's two stretches under the upper one.
    expect(dxf.split("\r\nLINE\r\n").length - 1).toBe(10);
  });
});
