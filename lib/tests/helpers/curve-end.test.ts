import { describe, it, expect } from "vitest";
import { setupOC, render, addToScene } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import select from "../../core/select.js";
import { arc, bezier, circle, line, point } from "../../core/2d/index.js";
import { edge } from "../../filters/index.js";
import { getOC } from "../../oc/init.js";
import { BuildSceneObjectContext, SceneObject } from "../../common/scene-object.js";
import { Shape } from "../../common/shape.js";
import { Edge } from "../../common/edge.js";
import { Vertex } from "../../common/vertex.js";
import { CurveObject } from "../../features/curve-object.js";
import { Extrude } from "../../features/extrude.js";
import { LazyVertex } from "../../features/lazy-vertex.js";
import { LazySelectionSceneObject } from "../../features/lazy-scene-object.js";
import { CurveEnds, type CurveEnd } from "../../helpers/curve-end.js";
import { Point } from "../../math/point.js";
import { Vector3d } from "../../math/vector3d.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { Geometry } from "../../oc/geometry.js";
import { WireOps } from "../../oc/wire-ops.js";
import { testRect } from "../helpers/profiles.js";

const asObject = (value: unknown) => value as SceneObject;
const round = (value: number) => +value.toFixed(6) + 0;
const xyz = (v: Point | Vector3d) => [v.x, v.y, v.z].map(round);

/** An end as plain numbers: its point, tangent and curvature (null where it has none). */
const plain = (end: CurveEnd) => ({
  point: xyz(end.point),
  tangent: end.tangent ? xyz(end.tangent) : null,
  curvature: end.curvature ? xyz(end.curvature) : null,
});

/** The end a value names, its lazy accessors resolved first, as a tool's build resolves them. */
const read = (value: unknown) => {
  LazySelectionSceneObject.resolveReachable(asObject(value));
  return plain(CurveEnds.read(asObject(value)));
};

/** A quarter arc of radius 5 about the origin, from (5, 0, 0) round to (0, 5, 0): its curve starts at (5, 0, 0). */
function quarterArc(): Edge {
  const curve = Geometry.makeArc(new Point(0, 0, 0), 5, new Vector3d(0, 0, 1), new Point(5, 0, 0), new Point(0, 5, 0));
  try {
    return Geometry.makeEdgeFromCurve(curve);
  } finally {
    curve.delete();
  }
}

/** The same edge with its orientation flipped: same curve, its first vertex now at the curve's last parameter. */
function reversed(e: Edge): Edge {
  const oc = getOC();
  const flipped = e.getShape().Reversed();
  try {
    return Edge.fromTopoDSEdge(oc.TopoDS.Edge(flipped));
  } finally {
    flipped.delete();
  }
}

/** A curve tool whose build returns whatever the test hands it. */
class StubCurve extends CurveObject {
  constructor(private readonly make: () => Shape[]) {
    super();
  }

  protected buildCurves(_context: BuildSceneObjectContext): Shape[] {
    return this.make();
  }

  override getType(): string {
    return 'test-chord';
  }

  serialize() {
    return {};
  }
}

/**
 * (−10, 5, 0) → (0, 5, 0) along a line, then round the quarter arc to
 * (5, 0, 0) — clockwise, against the arc's own curve, which runs from
 * (5, 0, 0): the arc is in the wire reversed.
 */
function hook(): Shape[] {
  const straight = EdgeOps.makeLineEdge(new Point(-10, 5, 0), new Point(0, 5, 0));
  const bend = quarterArc();
  const against = reversed(bend);
  try {
    return [WireOps.makeWireFromEdges([straight, against])];
  } finally {
    [straight, bend, against].forEach(piece => piece.dispose());
  }
}

/** A 20 × 10 × 5 block on XY from the origin. */
function block(): Extrude {
  sketch("xy", () => {
    testRect(20, 10);
  });
  return extrude(5).new() as unknown as Extrude;
}

describe("CurveEnds", () => {
  setupOC();

  describe("the end of an edge", () => {
    it("at the end of a line: along the line, no curvature; at its start, the other way", () => {
      const e = EdgeOps.makeLineEdge(new Point(0, 0, 0), new Point(10, 0, 0));
      try {
        expect(plain(CurveEnds.ofEdge(e, "end"))).toEqual({ point: [10, 0, 0], tangent: [1, 0, 0], curvature: [0, 0, 0] });
        expect(plain(CurveEnds.ofEdge(e, "start"))).toEqual({ point: [0, 0, 0], tangent: [-1, 0, 0], curvature: [0, 0, 0] });
      } finally {
        e.dispose();
      }
    });

    it("reads a line drawn towards −X by its canonical ends, each pointing out of it", () => {
      const e = EdgeOps.makeLineEdge(new Point(10, 0, 0), new Point(0, 0, 0));
      try {
        // start() and end() of a straight edge lean towards +X, whichever way its curve runs.
        expect(plain(CurveEnds.ofEdge(e, "end"))).toEqual({ point: [10, 0, 0], tangent: [1, 0, 0], curvature: [0, 0, 0] });
        expect(plain(CurveEnds.ofEdge(e, "start"))).toEqual({ point: [0, 0, 0], tangent: [-1, 0, 0], curvature: [0, 0, 0] });
      } finally {
        e.dispose();
      }
    });

    it("at either end of an arc of radius 5: curvature 0.2 towards the centre, the tangent out of the arc", () => {
      const e = quarterArc();
      try {
        expect(plain(CurveEnds.ofEdge(e, "end"))).toEqual({ point: [0, 5, 0], tangent: [-1, 0, 0], curvature: [0, -0.2, 0] });
        expect(plain(CurveEnds.ofEdge(e, "start"))).toEqual({ point: [5, 0, 0], tangent: [0, -1, 0], curvature: [-0.2, 0, 0] });
      } finally {
        e.dispose();
      }
    });

    it("reads a reversed edge as its curve: each end's tangent still points out of the edge", () => {
      const forward = quarterArc();
      const back = reversed(forward);
      try {
        // The reversed edge's first vertex is its curve's last point...
        expect(xyz(back.getFirstPoint())).toEqual([0, 5, 0]);
        // ...and its ends read the same as the forward edge's: out of the arc at (0, 5, 0) is −X.
        expect(plain(CurveEnds.ofEdge(back, "end"))).toEqual(plain(CurveEnds.ofEdge(forward, "end")));
        expect(plain(CurveEnds.ofEdge(back, "start"))).toEqual(plain(CurveEnds.ofEdge(forward, "start")));
        expect(plain(CurveEnds.ofEdge(back, "end")).tangent).toEqual([-1, 0, 0]);
      } finally {
        back.dispose();
        forward.dispose();
      }
    });
  });

  describe("what names an end", () => {
    it("reads .end() of an edge selection along the edge, out of it", () => {
      const box = block();
      const side = box.sideEdges(2);
      const end = side.end();
      const start = side.start();
      addToScene(asObject(side));
      render();

      const [picked] = asObject(side).getShapes() as Edge[];
      expect(read(end)).toEqual(plain(CurveEnds.ofEdge(picked, "end")));
      expect(read(start)).toEqual(plain(CurveEnds.ofEdge(picked, "start")));
      // A side edge of the block is upright: its end at the top, leaving upwards.
      expect(read(end)).toMatchObject({ tangent: [0, 0, 1], curvature: [0, 0, 0] });
      expect(read(end).point[2]).toBe(5);
      expect(read(start)).toMatchObject({ tangent: [0, 0, -1] });
    });

    it("reads .start() of a select(…) of edges on the selection's first edge", () => {
      block();
      const along = select(edge().parallelTo("xz").onPlane("xy", 0));
      const start = along.start();
      render();

      const [first] = asObject(along).getShapes() as Edge[];
      expect(read(start)).toEqual(plain(CurveEnds.ofEdge(first, "start")));
      // An edge along X on the floor: its start() at x = 0, leaving towards −X.
      expect(read(start)).toMatchObject({ tangent: [-1, 0, 0], curvature: [0, 0, 0] });
      expect(read(start).point[0]).toBe(0);
    });

    it("reads a curve object's start() and end() where its walk starts and ends, out of the curve", () => {
      const c = new StubCurve(hook);
      addToScene(c);
      const start = c.start();
      const end = c.end();
      render();

      expect(read(start)).toEqual({ point: [-10, 5, 0], tangent: [-1, 0, 0], curvature: [0, 0, 0] });
      // The walk arrives at (5, 0, 0) going clockwise round the arc, though the
      // arc's own curve leaves (5, 0, 0) anticlockwise: out of the curve is −Y.
      expect(read(end)).toEqual({ point: [5, 0, 0], tangent: [0, -1, 0], curvature: [-0.2, 0, 0] });
    });

    it("reads a curve of several wires by its first one, and c.edges(i).start() by that edge's own ends", () => {
      const c = new StubCurve(() => [
        ...hook(),
        WireOps.makeWireFromEdges([EdgeOps.makeLineEdge(new Point(0, 20, 0), new Point(0, 30, 0))]),
      ]);
      addToScene(c);
      const end = c.end();
      const bendStart = c.edges(1).start();
      const bendEnd = c.edges(1).end();
      const far = c.edges(2).end();
      addToScene(asObject(c.edges(1)));
      addToScene(asObject(c.edges(2)));
      render();

      expect(read(end)).toMatchObject({ point: [5, 0, 0], tangent: [0, -1, 0] });
      // The arc's own start() is where its curve starts, (5, 0, 0), whatever way the wire walks it.
      expect(read(bendStart)).toEqual({ point: [5, 0, 0], tangent: [0, -1, 0], curvature: [-0.2, 0, 0] });
      expect(read(bendEnd)).toEqual({ point: [0, 5, 0], tangent: [-1, 0, 0], curvature: [0, -0.2, 0] });
      expect(read(far)).toEqual({ point: [0, 30, 0], tangent: [0, 1, 0], curvature: [0, 0, 0] });
    });

    it("reads a sketch line's start() and end() as the line's ends, an arc's with its curvature", () => {
      const sk = sketch("xy", () => {
        const l = line([0, 0], [10, 0]);
        const a = arc([25, 0], [20, 5], [20, 0]);
        return { l, a };
      });
      render();

      expect(read(sk.geometries.l.start())).toEqual({ point: [0, 0, 0], tangent: [-1, 0, 0], curvature: [0, 0, 0] });
      expect(read(sk.geometries.l.end())).toEqual({ point: [10, 0, 0], tangent: [1, 0, 0], curvature: [0, 0, 0] });
      // A quarter arc of radius 5 about (20, 0), anticlockwise from (25, 0) to (20, 5).
      expect(read(sk.geometries.a.end())).toEqual({ point: [20, 5, 0], tangent: [-1, 0, 0], curvature: [0, -0.2, 0] });
      expect(read(sk.geometries.a.start())).toEqual({ point: [25, 0, 0], tangent: [0, -1, 0], curvature: [-0.2, 0, 0] });
    });

    it("reads a bezier's first point as the curve's start, leaving against its first leg", () => {
      const sk = sketch("xy", () => ({ b: bezier([0, 0], [5, 10], [10, 0]) }));
      render();

      const start = read(sk.geometries.b.start());
      expect(start.point).toEqual([0, 0, 0]);
      expect(start.tangent).toEqual(xyz(new Vector3d(-1, -2, 0).normalize()));
      expect(read(sk.geometries.b.point(1)).tangent).toBeNull();
    });

    it("reads a sketch point, a line's mid(), a circle's centre and a plain vertex as bare points", () => {
      const sk = sketch("xy", () => {
        const p = point([3, 4]);
        const l = line([0, 0], [10, 0]);
        const c = circle([20, 0], 2);
        return { p, l, c };
      });
      render();

      const bare = (at: number[]) => ({ point: at, tangent: null, curvature: null });
      expect(read(sk.geometries.p)).toEqual(bare([3, 4, 0]));
      expect(read(sk.geometries.p.start())).toEqual(bare([3, 4, 0]));
      expect(read(sk.geometries.l.mid())).toEqual(bare([5, 0, 0]));
      expect(read(sk.geometries.c.center())).toEqual(bare([20, 0, 0]));
      expect(read(LazyVertex.fromVertex(Vertex.fromPoint(new Point(1, 2, 3))))).toEqual(bare([1, 2, 3]));
    });

    it("refuses .center(), .offset(…) and an anchor on a face", () => {
      const box = block();
      const side = box.sideEdges(2);
      const top = box.endFaces();
      addToScene(asObject(side));
      addToScene(asObject(top));
      const anchors = [side.center(), side.offset("relative", 0.5), top.start()];
      render();

      for (const anchor of anchors) {
        LazySelectionSceneObject.resolveReachable(asObject(anchor));
        expect(() => CurveEnds.read(asObject(anchor))).toThrow(/^bridge: an end is the start or the end of an edge, or a point\./);
      }
    });

    it("refuses a scene object that is no point", () => {
      const box = block();
      render();
      expect(() => CurveEnds.read(asObject(box))).toThrow(/^bridge: an end is the start or the end of an edge, or a point\./);
    });
  });
});
