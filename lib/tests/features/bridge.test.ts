import { describe, it, expect } from "vitest";
import type { GeomAbs_Shape, Geom_Curve, TopoDS_Edge } from "ocjs-fluidcad";
import { setupOC, render, addToScene } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import plane from "../../core/plane.js";
import select from "../../core/select.js";
import fillet from "../../core/fillet.js";
import repeat from "../../core/repeat.js";
import sweep from "../../core/sweep.js";
import bridge, { bridgeArgs } from "../../core/bridge.js";
import { arc, circle, line, point, project } from "../../core/2d/index.js";
import { ParamValue } from "../../core/param.js";
import { edge } from "../../filters/index.js";
import { getOC } from "../../oc/init.js";
import { DEFAULT_MESH_CONFIG } from "../../oc/mesh.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { Explorer } from "../../oc/explorer.js";
import { SceneObject } from "../../common/scene-object.js";
import { Edge } from "../../common/edge.js";
import { Wire } from "../../common/wire.js";
import { Bridge } from "../../features/bridge.js";
import { Extrude } from "../../features/extrude.js";
import { Fillet } from "../../features/fillet.js";
import { ProjectedCurve } from "../../features/projected-curve.js";
import { RepeatBase } from "../../features/repeat-base.js";
import { SelectSceneObject } from "../../features/select.js";
import { Sketch } from "../../features/2d/sketch.js";
import { LazyVertex } from "../../features/lazy-vertex.js";
import { PointResolver } from "../../features/point-resolver.js";
import { CurveEnds } from "../../helpers/curve-end.js";
import { anchorEndParameter, anchorFromShape } from "../../features/shape-anchor.js";
import { VertexPointSynthesizer } from "../../selection/vertex-synthesis.js";
import { pickedVertexPoint } from "../../selection/vertex-pick.js";
import { Point } from "../../math/point.js";
import { buildFeatureGhost, type GhostEndRef } from "../../rendering/feature-ghost.js";
import type { Scene } from "../../rendering/scene.js";
import { DefaultNames } from "../../rendering/default-names.js";
import { synthesizeApplyFeature } from "../../selection/explain.js";
import { resolveFeatureSources } from "../../selection/feature-sources.js";
import { getCurrentScene } from "../../scene-manager.js";
import { testRect } from "../helpers/profiles.js";
import { expectOptionsCarried } from "../helpers/option-contract.js";

const FILE = "/tmp/bridge-test.fluid.js";

const asObject = (value: unknown) => value as SceneObject;
const round = (value: number) => +value.toFixed(6) + 0;
const xyz = (point: Point | { x: number; y: number; z: number }) => [point.x, point.y, point.z].map(round);
const at = (vertex: LazyVertex) => xyz(PointResolver.toWorld(vertex));

/** The bridge's wires, as the scene holds them. */
const wiresOf = (br: unknown) => asObject(br).getShapes() as Wire[];
/** The bridge's one edge. */
const edgeOf = (br: unknown) => (asObject(br).getState(Bridge.EDGES_KEY) as Edge[])[0];

/** The degree and poles of the bridge's curve: 1 and its two ends for a straight one. */
function curveOf(br: unknown): { degree: number; poles: number[][] } {
  const oc = getOC();
  const e = edgeOf(br);
  const adaptor = new oc.BRepAdaptor_Curve(e.getShape() as TopoDS_Edge);
  try {
    if (adaptor.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line) {
      return { degree: 1, poles: [xyz(e.getFirstPoint()), xyz(e.getLastPoint())] };
    }
    const bezier = adaptor.Bezier();
    try {
      const poles: number[][] = [];
      for (let i = 1; i <= bezier.NbPoles(); i++) {
        const pole = bezier.Pole(i);
        poles.push(xyz({ x: pole.X(), y: pole.Y(), z: pole.Z() }));
        pole.delete();
      }
      return { degree: bezier.Degree(), poles };
    } finally {
      bezier.delete();
    }
  } finally {
    adaptor.delete();
  }
}

/** The point of `edge`'s curve, its first derivative, at one of its ends in the edge's own sense, and the curve itself. */
function kernelEnd(e: Edge, end: "start" | "end") {
  const oc = getOC();
  const adaptor = new oc.BRepAdaptor_Curve(e.getShape() as TopoDS_Edge);
  try {
    return anchorEndParameter(adaptor, end).parameter;
  } finally {
    adaptor.delete();
  }
}

/**
 * Checks each end of a built bridge against the curve it continues, where
 * the end offers a tangent and the continuity asks for `order` derivatives:
 * the kernel finds the joint G1 (G2 at order 2), the bridge runs on the
 * same way — its tangent out of itself the opposite of the curve's, which
 * the kernel's angle between lines cannot tell — and at order 2 it has the
 * curve's own curvature there.
 */
let kernelG2 = 0;
function expectJoins(br: unknown, ends: [unknown, unknown], order: number): void {
  const oc = getOC();
  const bridgeEdge = edgeOf(br);
  ends.forEach((end, i) => {
    const at = CurveEnds.edgeEndOf(asObject(end));
    if (!at || order === 0) {
      return;
    }
    const own = i === 0 ? "start" : "end";
    const source = CurveEnds.ofEdge(at.edge, at.end);
    const joint = CurveEnds.ofEdge(bridgeEdge, own);
    expect(xyz(joint.point)).toEqual(xyz(source.point));
    expect(xyz(joint.tangent!)).toEqual(xyz(source.tangent!.negate()));
    if (order === 2) {
      expect(xyz(joint.curvature!)).toEqual(xyz(source.curvature!));
    }
    // The kernel has no normal to compare at a straight end: there the zero
    // curvature is checked above, and the kernel checks the tangent.
    const curved = order === 2 && source.curvature!.length() > 1e-9;
    const a = oc.BRep_Tool.Curve(at.edge.getShape() as TopoDS_Edge, 0, 1);
    const b = oc.BRep_Tool.Curve(bridgeEdge.getShape() as TopoDS_Edge, 0, 1);
    const shape = (curved ? oc.GeomAbs_Shape.GeomAbs_G2 : oc.GeomAbs_Shape.GeomAbs_G1) as GeomAbs_Shape;
    const analysis = new oc.LocalAnalysis_CurveContinuity(
      a.returnValue as Geom_Curve, kernelEnd(at.edge, at.end), b.returnValue as Geom_Curve, kernelEnd(bridgeEdge, own), shape,
    );
    try {
      expect(analysis.IsDone()).toBe(true);
      expect(analysis.IsG1()).toBe(true);
      if (curved) {
        expect(analysis.IsG2()).toBe(true);
        kernelG2 += 1;
      }
    } finally {
      analysis.delete();
      a[Symbol.dispose]();
      b[Symbol.dispose]();
    }
  });
}

function located<T>(value: T, line: number): T {
  asObject(value).setSourceLocation({ filePath: FILE, line, column: 0 });
  return value;
}

/** A `width` × 20 × 5 block on XY from the origin. */
function block(width = 40): Extrude {
  sketch("xy", () => {
    testRect(width, 20);
  });
  return extrude(5).new() as unknown as Extrude;
}

/** A sketch on XY lifted to `height`, drawing what `draw` draws. */
function above(height: number, draw: () => void): Sketch {
  return sketch(plane("xy", height), draw) as unknown as Sketch;
}

/**
 * Two rails on the block's top: A along +X from (5, 5, 5) to (15, 5, 5),
 * B along +X from (25, 15, 5) to (35, 15, 5), each a curve projected from
 * a sketch line above.
 */
function rails(box: Extrude): { a: ProjectedCurve; b: ProjectedCurve } {
  const a = project(above(20, () => {
    line([5, 5], [15, 5]);
  }), box.endFaces()) as unknown as ProjectedCurve;
  const b = project(above(20, () => {
    line([25, 15], [35, 15]);
  }), box.endFaces()) as unknown as ProjectedCurve;
  return { a, b };
}

/** The scoped read of a render: what still shows on screen. */
const onScreen = (scene: Scene, obj: unknown) => asObject(obj).getShapes(undefined, undefined, new Set(scene.getAllSceneObjects()));

describe("bridge(from, to)", () => {
  setupOC();

  describe("between ends", () => {
    it("joins the end of one curve to the start of another: one wire of one edge, leaving and arriving along them", () => {
      const box = block();
      const { a, b } = rails(box);
      const br = bridge(a.end(), b.start()) as unknown as Bridge;
      const scene = render();

      expect(br.getError()).toBeNull();
      const wires = wiresOf(br);
      expect(wires).toHaveLength(1);
      expect(wires[0].getEdges()).toHaveLength(1);
      expect(xyz(wires[0].getFirstPoint()!)).toEqual([15, 5, 5]);
      expect(xyz(wires[0].getLastPoint()!)).toEqual([25, 15, 5]);
      expect(curveOf(br).degree).toBe(3);
      // Out of the bridge at its start is back along A; at its end, on along B.
      expect(xyz(CurveEnds.ofEdge(edgeOf(br), "start").tangent!)).toEqual([-1, 0, 0]);
      expect(xyz(CurveEnds.ofEdge(edgeOf(br), "end").tangent!)).toEqual([1, 0, 0]);

      // The rails are read, not used up: both stay on screen, and the block.
      expect(onScreen(scene, a)).toHaveLength(1);
      expect(onScreen(scene, b)).toHaveLength(1);
      expect(onScreen(scene, box)).toHaveLength(1);
    });

    it("swapping the ends reverses the curve: the same points, run the other way", () => {
      const box = block();
      const { a, b } = rails(box);
      const there = bridge(a.end(), b.start()) as unknown as Bridge;
      const back = bridge(b.start(), a.end()) as unknown as Bridge;
      render();

      expect(curveOf(back).poles).toEqual([...curveOf(there).poles].reverse());
    });

    it("joins two edges of a solid, the solid untouched", () => {
      const box = block();
      const near = box.sideEdges(0);
      const far = box.sideEdges(2);
      const br = bridge(near.end(), far.end()) as unknown as Bridge;
      const scene = render();

      expect(br.getError()).toBeNull();
      expect(curveOf(br).degree).toBe(3);
      // Both upright edges end at the top, heading up: the bridge rises out of one and drops into the other.
      expect(xyz(CurveEnds.ofEdge(edgeOf(br), "start").tangent!)).toEqual([0, 0, -1]);
      expect(xyz(CurveEnds.ofEdge(edgeOf(br), "end").tangent!)).toEqual([0, 0, -1]);
      expect(Math.max(...curveOf(br).poles.map(pole => pole[2]))).toBeGreaterThan(5);
      expect(box.getShapes()).toHaveLength(1);
      expect(box.getShapes()[0].isSolid()).toBe(true);
      expect(onScreen(scene, box)).toHaveLength(1);
    });

    it("runs to a sketch point matching only its position there", () => {
      const box = block();
      const { a } = rails(box);
      const target = sketch(plane("xy", 20), () => ({ p: point([30, 2]) }));
      const br = bridge(a.end(), target.geometries.p) as unknown as Bridge;
      const tangentAtPoint = bridge(target.geometries.p.start(), a.end()).continuity("g2") as unknown as Bridge;
      render();

      expect(br.getError()).toBeNull();
      expect(curveOf(br).degree).toBe(2);
      expect(curveOf(br).poles[2]).toEqual([30, 2, 20]);
      expect(tangentAtPoint.getError()).toBeNull();
      expect(curveOf(tangentAtPoint).degree).toBe(3);
    });

    it("leaves a sketch line's end along the line", () => {
      const lines = sketch(plane("xy", 20), () => ({
        l: line([0, 0], [10, 0]),
        m: line([20, 10], [20, 20]),
      }));
      const br = bridge(lines.geometries.l.end(), lines.geometries.m.start()) as unknown as Bridge;
      render();

      expect(br.getError()).toBeNull();
      expect(curveOf(br).degree).toBe(3);
      expect(xyz(CurveEnds.ofEdge(edgeOf(br), "start").tangent!)).toEqual([-1, 0, 0]);
      expect(xyz(CurveEnds.ofEdge(edgeOf(br), "end").tangent!)).toEqual([0, 1, 0]);
    });

    it("builds for every pair of end kinds at every continuity, the joints G1 or G2 by the kernel", () => {
      const box = block();
      const { a, b } = rails(box);
      const marks = sketch(plane("xy", 20), () => ({
        l: line([0, 30], [10, 30]),
        c: arc([40, 30], [35, 35], [35, 30]),
        p: point([30, 2]),
      }));
      const ends = [
        a.end(),                     // a curve's end
        b.edges(0).start(),          // an edge of a curve, by its own start
        box.sideEdges(1).end(),      // an edge of a solid
        marks.geometries.l.end(),    // a sketch line's end
        marks.geometries.c.start(),  // a sketch arc's end, curved
        marks.geometries.p,          // a sketch point
      ];
      const offers = ends.map((_, i) => i < 5);
      const continuities = ["g0", "g1", "g2"] as const;
      const built: { br: Bridge; from: number; to: number; order: number }[] = [];
      ends.forEach((from, i) => ends.forEach((to, j) => {
        if (i !== j) {
          continuities.forEach((continuity, order) => {
            built.push({ br: bridge(from, to).continuity(continuity) as unknown as Bridge, from: i, to: j, order });
          });
        }
      }));
      render();

      expect(built).toHaveLength(90);
      kernelG2 = 0;
      for (const { br, from, to, order } of built) {
        expect(br.getError(), `${from} → ${to} at g${order}`).toBeNull();
        const degree = (offers[from] ? order : 0) + (offers[to] ? order : 0) + 1;
        expect(curveOf(br).degree, `${from} → ${to} at g${order}`).toBe(degree);
        expectJoins(br, [ends[from], ends[to]], order);
      }
      // Every g2 bridge into or out of the arc: the kernel saw each of those joints G2.
      expect(kernelG2).toBe(10);
    });

    it("refuses a .center() anchor, and two ends at one point, in the build's words", () => {
      const box = block();
      const { a } = rails(box);
      const centred = bridge(box.sideEdges(0).center(), a.end()) as unknown as Bridge;
      const onePoint = bridge(a.end(), a.end()) as unknown as Bridge;
      render();

      expect(centred.getError()).toMatch(/^bridge: an end is the start or the end of an edge, or a point\./);
      expect(onePoint.getError()).toMatch(/^bridge: the two ends are at the same point\./);
      expect(centred.getShapes()).toEqual([]);
    });
  });

  describe("the chained options", () => {
    it("matches position, tangent or curvature: a line, a cubic, a quintic", () => {
      const box = block();
      const { a, b } = rails(box);
      const position = bridge(a.end(), b.start()).continuity("g0");
      const tangent = bridge(a.end(), b.start()).continuity("g1");
      const curvature = bridge(a.end(), b.start()).continuity("g2");
      render();

      expect(curveOf(position)).toEqual({ degree: 1, poles: [[15, 5, 5], [25, 15, 5]] });
      expect(curveOf(tangent).degree).toBe(3);
      expect(curveOf(curvature).degree).toBe(5);
    });

    it("sets how far the bridge runs straight at each end, numbers or parameters", () => {
      const box = block();
      const { a, b } = rails(box);
      const plain = bridge(a.end(), b.start());
      const fuller = bridge(a.end(), b.start()).startMagnitude(2);
      const tighter = bridge(a.end(), b.start()).endMagnitude(new ParamValue("Tight", 0.5));
      render();

      const gap = new Point(15, 5, 5).distanceTo(new Point(25, 15, 5));
      expect(curveOf(plain).poles[1][0]).toBeCloseTo(15 + gap / 3, 5);
      expect(curveOf(fuller).poles[1][0]).toBeCloseTo(15 + 2 * gap / 3, 5);
      expect(curveOf(fuller).poles[2]).toEqual(curveOf(plain).poles[2]);
      expect(curveOf(tighter).poles[2][0]).toBeCloseTo(25 - 0.5 * gap / 3, 5);
      expect(asObject(tighter).serialize()).toMatchObject({ endMagnitude: 0.5 });
    });

    it("refuses a magnitude not above zero when the curve builds, naming it", () => {
      const box = block();
      const { a, b } = rails(box);
      const zero = bridge(a.end(), b.start()).startMagnitude(0) as unknown as Bridge;
      const negative = bridge(a.end(), b.start()).endMagnitude(-1) as unknown as Bridge;
      render();

      for (const br of [zero, negative]) {
        expect(br.getError()).toMatch(/^bridge: a magnitude must be greater than zero\.\nHint: 1 is the default/);
        expect(br.getShapes()).toEqual([]);
      }
    });

    it("refuses a continuity outside its set, and a magnitude that is no number, where the statement is written", () => {
      const box = block();
      const { a, b } = rails(box);
      const br = bridge(a.end(), b.start());
      expect(() => br.continuity("g3" as never)).toThrow("bridge: .continuity() takes 'g0', 'g1' or 'g2'.");
      expect(() => br.startMagnitude("big" as never)).toThrow("bridge: .startMagnitude() takes a number.");
      expect(() => br.endMagnitude(undefined as never)).toThrow("bridge: .endMagnitude() takes a number.");
    });

    it("builds the same curve whatever order the chain is written in", () => {
      const box = block();
      const { a, b } = rails(box);
      const one = bridge(a.end(), b.start()).continuity("g2").startMagnitude(1.5).endMagnitude(0.8);
      const other = bridge(a.end(), b.start()).endMagnitude(0.8).startMagnitude(1.5).continuity("g2");
      render();

      expect(curveOf(one)).toEqual(curveOf(other));
      expect(asObject(one).serialize()).toEqual(asObject(other).serialize());
    });

    it("carries the ends, continuity and magnitudes through createCopy, compareTo, getDependencies and serialize", () => {
      const points = sketch("xy", () => ({ p: point([0, 0]), q: point([10, 5]), r: point([20, 0]) }));
      const p = points.geometries.p.start();
      const q = points.geometries.q.start();
      const r = points.geometries.r.start();
      const make = () => bridge(p, q) as unknown as Bridge;
      expectOptionsCarried<Bridge>(make, {
        continuity: tool => tool.continuity("g2"),
        startMagnitude: tool => tool.startMagnitude(2),
        endMagnitude: tool => tool.endMagnitude(0.5),
        to: tool => { tool["to"] = asObject(r); },
      });
      expect(make().getDependencies()).toEqual([p, q]);
      expect(make().getType()).toBe("bridge");
      expect(make().serialize()).toMatchObject({ continuity: "g1", startMagnitude: 1, endMagnitude: 1 });
    });
  });

  describe("its arguments", () => {
    it("takes exactly two ends, each a vertex or a sketch point", () => {
      const box = block();
      const end = box.sideEdges(0).end();
      expect(() => bridgeArgs([end])).toThrow(
        "bridge: give the two ends to join: bridge(from, to), each the start() or end() of an edge or a curve, or a point.",
      );
      expect(() => bridgeArgs([end, end, end])).toThrow("bridge: takes two arguments, the two ends, got 3.");
      expect(() => bridgeArgs([[1, 2, 3], end])).toThrow(
        "bridge: the from argument must be a curve end, the start() or end() of an edge or a curve, or a point; got a nested list.",
      );
      expect(() => bridgeArgs([end, box])).toThrow(
        "bridge: the to argument must be a curve end, the start() or end() of an edge or a curve, or a point; got an extrude.",
      );
      expect(() => bridgeArgs([end, "xy"])).toThrow(/the to argument must be a curve end.*got 'xy'\./);
    });

    it("is written outside a sketch", () => {
      const box = block();
      const end = box.sideEdges(0).end();
      expect(() => sketch("xy", () => {
        bridge(end, end);
      })).toThrow("bridge: is written outside a sketch; inside one, draw the curve with bezier().");
    });

    it("claims a select() an end is taken on, so a later bare fillet(2) does not take it, and takes its highlight off the display", () => {
      const box = block();
      const { a } = rails(box);
      const upright = select(edge().verticalTo("xy").nearest("x").nearest("y")) as unknown as SelectSceneObject;
      expect(getCurrentScene().getLastSelection()).toBe(upright);

      const br = bridge(upright.end(), a.start()) as unknown as Bridge;
      const rounded = fillet(2) as unknown as Fillet;
      expect(upright.isClaimed()).toBe(true);
      expect(rounded.targetEdges).not.toContain(upright);
      const scene = render();

      expect(br.getError()).toBeNull();
      expect(onScreen(scene, upright)).toEqual([]);
      expect(upright.getShapes()).toHaveLength(1);
    });
  });

  describe("the result", () => {
    it("answers edges(0), start() and end()", () => {
      const box = block();
      const { a, b } = rails(box);
      const br = bridge(a.end(), b.start()) as unknown as Bridge;
      const first = asObject(br.edges(0));
      addToScene(first);
      const start = br.start();
      const end = br.end();
      render();

      expect(first.getShapes()).toEqual([edgeOf(br)]);
      expect(at(start)).toEqual([15, 5, 5]);
      expect(at(end)).toEqual([25, 15, 5]);
    });

    it("reads as Bridge 1 in an unnamed row", () => {
      const box = block();
      const { a, b } = rails(box);
      const br = bridge(a.end(), b.start()) as unknown as Bridge;
      render();

      const labels = DefaultNames.labelsFor(getCurrentScene().getTimelineObjects());
      expect(DefaultNames.labelFor(br, labels)).toBe("Bridge 1");
    });

    it("serves alone as a sweep path", () => {
      const box = block();
      const { a, b } = rails(box);
      const br = bridge(a.end(), b.start()) as unknown as Bridge;
      const swept = asObject(sweep(br, sketch(plane("yz", 15), () => {
        circle([5, 5], 0.5);
      })));
      render();

      expect(br.getError()).toBeNull();
      expect(swept.getError()).toBeNull();
      expect(swept.getShapes().some(shape => shape.isSolid())).toBe(true);
    });

    it("repeats with its edges bucket", () => {
      const box = block();
      const { a, b } = rails(box);
      const br = bridge(a.end(), b.start()) as unknown as Bridge;
      const r = repeat("linear", "y", { count: 2, offset: 50 }, br) as unknown as RepeatBase;
      const copied = asObject(r.instance(1).edges(0));
      addToScene(copied);
      render();

      const [copy] = r.getInstanceRoots(1);
      expect(copy).toBeInstanceOf(Bridge);
      expect(copy.getError()).toBeNull();
      const bucket = copy.getState(Bridge.EDGES_KEY) as Edge[];
      expect(xyz(bucket[0].getFirstPoint())).toEqual([15, 55, 5]);
      expect(copied.getShapes()).toEqual([bucket[0]]);
    });
  });

  describe("the preview", () => {
    /** The index of the block's upright edge at (x, y), and the block's solid id. */
    function upright(box: Extrude, x: number, y: number): { shapeId: string; index: number } {
      const solid = asObject(box).getShapes()[0];
      const edges = Explorer.findEdgesWrapped(solid);
      const index = edges.findIndex(e => {
        const [p, q] = EdgeOps.endPoints(e);
        return Math.abs(p.x - x) < 1e-9 && Math.abs(q.x - x) < 1e-9 && Math.abs(p.y - y) < 1e-9 && Math.abs(q.y - y) < 1e-9;
      });
      edges.forEach(e => e.dispose());
      return { shapeId: solid.id, index };
    }

    it("draws the bridge as a wire between two picked edge ends", () => {
      const box = block();
      const scene = render() as Scene;
      const result = buildFeatureGhost(scene, {
        feature: "bridge",
        from: { kind: "edge-end", ...upright(box, 0, 0), end: "end" },
        to: { kind: "edge-end", ...upright(box, 40, 20), end: "end" },
        continuity: "g1", startMagnitude: 1, endMagnitude: 1,
      }, DEFAULT_MESH_CONFIG);
      expect(result).toMatchObject({ ok: true, solids: [{ kind: "wire" }] });
    });

    it("takes a curve's end by its statement, and a vertex as the point synthesis writes it", () => {
      const box = located(block(), 2);
      const { a } = rails(box);
      located(a, 5);
      const target = located(sketch(plane("xy", 20), () => ({ p: located(point([30, 2]), 7) })), 6);
      const scene = render() as Scene;
      const curveEnd: GhostEndRef = { kind: "curve-end", filePath: FILE, line: 5, end: "end" };
      const solid = asObject(box).getShapes()[0];
      const pointVertex = asObject(target.geometries.p).getAddedShapes()[0];

      for (const to of [
        { kind: "vertex" as const, shapeId: solid.id, index: 0 },
        { kind: "vertex" as const, shapeId: pointVertex.id, index: 0 },
      ]) {
        const result = buildFeatureGhost(scene, {
          feature: "bridge", from: curveEnd, to, continuity: "g1", startMagnitude: 1, endMagnitude: 1,
        }, DEFAULT_MESH_CONFIG);
        expect(result, JSON.stringify(to)).toMatchObject({ ok: true, solids: [{ kind: "wire" }] });
      }
    });

    it("reads a solid's vertex as the end of the edge whose selector names it, a sketch point as that point", () => {
      const box = located(block(), 2);
      const target = located(sketch(plane("xy", 20), () => ({ p: located(point([30, 2]), 7) })), 6);
      const scene = render() as Scene;
      const solid = asObject(box).getShapes()[0];
      const corner = pickedVertexPoint(solid, 0)!;

      const onSolid = VertexPointSynthesizer.writtenPoint(scene, { shapeId: solid.id, sub: { type: "vertex", index: 0 } });
      expect(onSolid?.kind).toBe("edge");
      if (onSolid?.kind === "edge") {
        expect(anchorFromShape(onSolid.edge, { kind: onSolid.role }).origin.distanceTo(corner)).toBeLessThan(1e-9);
        onSolid.edge.dispose();
      }
      const pointVertex = asObject(target.geometries.p).getAddedShapes()[0];
      const onSketch = VertexPointSynthesizer.writtenPoint(scene, { shapeId: pointVertex.id, sub: { type: "vertex", index: 0 } });
      expect(onSketch?.kind).toBe("sketch");
      if (onSketch?.kind === "sketch") {
        expect(at(onSketch.point)).toEqual([30, 2, 20]);
        expect(CurveEnds.edgeEndOf(onSketch.point)).toBeNull();
      }
    });

    it("says why it cannot build: a magnitude not above zero, two ends at one point; nothing for a stale pick", () => {
      const box = block();
      const scene = render() as Scene;
      const end: GhostEndRef = { kind: "edge-end", ...upright(box, 0, 0), end: "end" };
      const other: GhostEndRef = { kind: "edge-end", ...upright(box, 40, 20), end: "end" };

      const zero = buildFeatureGhost(scene, {
        feature: "bridge", from: end, to: other, continuity: "g1", startMagnitude: 0, endMagnitude: 1,
      }, DEFAULT_MESH_CONFIG);
      expect(zero).toMatchObject({ ok: false, surface: true, reason: "bridge: a magnitude must be greater than zero." });

      const onePoint = buildFeatureGhost(scene, {
        feature: "bridge", from: end, to: end, continuity: "g1", startMagnitude: 1, endMagnitude: 1,
      }, DEFAULT_MESH_CONFIG);
      expect(onePoint).toMatchObject({ ok: false, surface: true, reason: "bridge: the two ends are at the same point." });

      const stale = buildFeatureGhost(scene, {
        feature: "bridge", from: { kind: "edge-end", shapeId: "gone", index: 0, end: "end" }, to: other,
        continuity: "g1", startMagnitude: 1, endMagnitude: 1,
      }, DEFAULT_MESH_CONFIG);
      expect(stale.ok).toBe(false);
    });
  });

  describe("its edit dialog's sources", () => {
    it("resolves a curve's end by its statement, an edge's end as the edge with its end, a point as opaque", () => {
      const box = located(block(), 2);
      const { a, b } = rails(box);
      located(a, 5);
      located(b, 6);
      const target = located(sketch(plane("xy", 20), () => ({ p: located(point([30, 2]), 8) })), 7);
      const first = located(bridge(a.end(), box.sideEdges(2).end()), 10);
      const second = located(bridge(b.edges(0).start(), target.geometries.p), 11);
      const scene = render();
      expect(asObject(first).getError()).toBeNull();
      expect(asObject(second).getError()).toBeNull();

      const sourcesOf = (br: unknown, line: number) => resolveFeatureSources(scene, {
        index: scene.getAllSceneObjects().indexOf(asObject(br)), type: "bridge", line, column: 0,
      });
      const one = sourcesOf(first, 10);
      expect(one.ok).toBe(true);
      if (one.ok && one.feature === "bridge") {
        expect(one.from).toEqual({ kind: "curve-end", filePath: FILE, line: 5, column: 0, end: "end" });
        expect(one.to).toMatchObject({ kind: "edge-end", end: "end", entity: { shapeId: asObject(box).getShapes()[0].id, sub: { type: "edge" } } });
      }
      const two = sourcesOf(second, 11);
      expect(two.ok).toBe(true);
      if (two.ok && two.feature === "bridge") {
        expect(two.from).toMatchObject({ kind: "edge-end", end: "start", entity: { shapeId: wiresOf(b)[0].id, sub: { type: "edge", index: 0 } } });
        expect(two.to).toEqual({ kind: "opaque" });
      }
    });
  });

  describe("picks", () => {
    it("synthesizes one edge with the end taken as bridge(...) arguments, and refuses a vertex or two edges", () => {
      const box = located(block(), 2);
      const scene = render();
      const solid = asObject(box).getShapes()[0];

      const end = synthesizeApplyFeature(scene, [{ shapeId: solid.id, sub: { type: "edge", index: 0 } }], "bridge", undefined, [], {
        connector: { anchor: { kind: "end" } },
      });
      expect(end.ok).toBe(true);
      if (end.ok) {
        expect(end.args).toMatch(/\.end\(\)$/);
        expect(end.preview).toBe(`bridge(${end.args})`);
        expect(end.spec.feature).toBe("bridge");
        expect(end.spec.value).toBeUndefined();
      }

      expect(synthesizeApplyFeature(scene, [{ shapeId: solid.id, sub: { type: "vertex", index: 0 } }], "bridge")).toMatchObject({
        ok: false, reason: "a bridge end is the start or the end of one edge — pick exactly one edge",
      });
      expect(synthesizeApplyFeature(scene, [
        { shapeId: solid.id, sub: { type: "edge", index: 0 } },
        { shapeId: solid.id, sub: { type: "edge", index: 1 } },
      ], "bridge")).toMatchObject({ ok: false });
      expect(synthesizeApplyFeature(scene, [{ shapeId: solid.id, sub: { type: "edge", index: 0 } }], "bridge", undefined, [], {
        connector: { anchor: { kind: "center" } },
      })).toMatchObject({ ok: false, reason: "a bridge end is the start or the end of an edge, not a point along it" });
    });

    it("names a pick on the bridge through its own variable, br", () => {
      const box = block();
      const { a, b } = rails(box);
      const br = located(bridge(a.end(), b.start()), 8);
      const scene = render();
      const wire = asObject(br).getShapes()[0];

      const result = synthesizeApplyFeature(scene, [{ shapeId: wire.id, sub: { type: "edge", index: 0 } }], "sweep");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.spec.producers.map(producer => producer.nameHint)).toEqual(["br"]);
        expect(result.args).toMatch(/^br\.edges\(/);
      }
    });
  });
});
