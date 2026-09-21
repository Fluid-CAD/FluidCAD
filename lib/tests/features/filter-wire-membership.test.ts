import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import plane from "../../core/plane.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import loft from "../../core/loft.js";
import fillet from "../../core/fillet.js";
import select from "../../core/select.js";
import { circle } from "../../core/2d/index.js";
import { edge, face } from "../../filters/index.js";
import { Edge } from "../../common/edge.js";
import { Extrude } from "../../features/extrude.js";
import { Loft } from "../../features/loft.js";
import { SelectSceneObject } from "../../features/select.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { EdgeProps } from "../../oc/edge-props.js";
import { Matrix4 } from "../../math/matrix4.js";
import { WireMembershipFilter } from "../../filters/edge/wire-membership.js";
import { testRect } from "../helpers/profiles.js";

function edgesOf(sel: unknown): Edge[] {
  return (sel as SelectSceneObject).getShapes() as Edge[];
}

function mids(edges: Edge[]) {
  return edges.map(e => EdgeOps.getEdgeMidPoint(e));
}

/** A 60 × 40 × 10 plate with a Ø24 bore through it. */
function plateWithBore() {
  sketch("xy", () => {
    testRect(60, 40);
  });
  const plate = extrude(10) as Extrude;
  sketch(plate.endFaces(), () => {
    circle([30, 20], 24);
  });
  const bore = cut() as Extrude;
  return { plate, bore };
}

/** A 90°-twisted thin loft, both corner families filleted: 8 outer + 8 inner rim edges on top. */
function twistedVase() {
  const s = sketch("xy", () => testRect(50, 50, { at: [-25, -25] }));
  const s2 = sketch(plane("xy", { offset: 80 }), () => testRect(30, 30, { at: [-15, -15] }));
  const lf = loft(s, s2).connect(s.geometries.b.end(), s2.geometries.b.start())
    .startCondition("normal").endCondition("normal").thin(-4) as Loft;
  fillet(6, lf.sideEdges(edge().convex()));
  fillet(4, lf.sideEdges(edge().concave()));
  return lf;
}

describe("edge().outerOf() / edge().holeOf()", () => {
  setupOC();

  it("a box face has an outer loop and no hole loop", () => {
    sketch("xy", () => {
      testRect(40, 30);
    });
    extrude(10);
    const outer = select(edge().outerOf(face().onPlane("xy", 10)));
    const hole = select(edge().holeOf(face().onPlane("xy", 10)));
    const notOuter = select(edge().notOuterOf(face().onPlane("xy", 10)));
    const notHole = select(edge().notHoleOf(face().onPlane("xy", 10)));
    render();

    expect(edgesOf(outer)).toHaveLength(4);
    expect(mids(edgesOf(outer)).every(m => Math.abs(m.z - 10) < 1e-6)).toBe(true);
    expect(edgesOf(hole)).toHaveLength(0);
    // Edges bounding no matching face survive the negations.
    expect(edgesOf(notOuter)).toHaveLength(8);
    expect(edgesOf(notHole)).toHaveLength(12);
  });

  it("separates a plate's rim from its bore by face filters", () => {
    plateWithBore();
    const rim = select(edge().outerOf(face().onPlane("xy", 10)));
    const bore = select(edge().holeOf(face().onPlane("xy", 10)));
    render();

    const rimEdges = edgesOf(rim);
    expect(rimEdges).toHaveLength(4);
    expect(rimEdges.every(e => EdgeProps.getProperties(e.getShape()).curveType === "line")).toBe(true);
    const boreEdges = edgesOf(bore);
    expect(boreEdges).toHaveLength(1);
    expect(EdgeProps.getProperties(boreEdges[0].getShape()).curveType).toBe("circle");
  });

  it("reads a face reference by its surface, so the reshaped face's loops resolve", () => {
    const { plate } = plateWithBore();
    // The as-built end face predates the bore: identity would never see the
    // bore rim. The reference names the plane; the loop comes from the top
    // face as it is now.
    const rim = select(edge().outerOf(plate.endFaces()));
    const boreRim = select(edge().holeOf(plate.endFaces()));
    // The same circle is on the outer loop of the bore's wall (its single
    // seam-bounded wire) — loop membership is relative to the face.
    const wallRims = select(edge().outerOf(face().cylinder(24)));
    const wallHoles = select(edge().holeOf(face().cylinder(24)));
    render();

    expect(edgesOf(rim)).toHaveLength(4);
    expect(edgesOf(boreRim)).toHaveLength(1);
    expect(edgesOf(wallRims)).toHaveLength(2);
    expect(mids(edgesOf(wallRims)).map(m => m.z).sort()).toEqual([0, 10]);
    expect(edgesOf(wallHoles)).toHaveLength(0);
  });

  it("classifies a cross-hole in a cylinder wall as the wall's hole loops", () => {
    sketch("xy", () => {
      circle([0, 0], 80);
    });
    extrude(50);
    sketch("xz", () => {
      circle([0, 25], 20);
    });
    cut().symmetric();
    const outer = select(edge().outerOf(face().cylinder(80)));
    const holes = select(edge().holeOf(face().cylinder(80)));
    render();

    // The outer loop is the seam-bounded rectangle: the two end circles (the
    // seam itself is hidden from the model edges).
    const outerZ = mids(edgesOf(outer)).map(m => m.z).sort((a, b) => a - b);
    expect(outerZ).toEqual([0, 50]);
    // The drilled loops — one per wall the hole pierces — sit in the z band
    // of the hole and on the wall's radius.
    const holeEdges = edgesOf(holes);
    expect(holeEdges.length).toBeGreaterThanOrEqual(2);
    for (const m of mids(holeEdges)) {
      expect(m.z).toBeGreaterThan(10);
      expect(m.z).toBeLessThan(40);
      expect(Math.hypot(m.x, m.y)).toBeCloseTo(40, 3);
    }
  });

  it("splits a filleted thin loft's top rim into its outer and inner loops", () => {
    const lf = twistedVase();
    const outer = select(edge().outerOf(lf.endFaces()));
    const inner = select(edge().holeOf(lf.endFaces()));
    const notOuter = select(edge().notOuterOf(lf.endFaces()).onPlane(lf.endFaces()));
    render();

    const outerEdges = edgesOf(outer);
    const innerEdges = edgesOf(inner);
    expect(outerEdges).toHaveLength(8);
    expect(innerEdges).toHaveLength(8);
    const ring = (e: Edge) => {
      const m = EdgeOps.getEdgeMidPoint(e);
      return Math.max(Math.abs(m.x), Math.abs(m.y));
    };
    expect(outerEdges.every(e => ring(e) > 12.5)).toBe(true);
    expect(innerEdges.every(e => ring(e) < 12.5)).toBe(true);
    // The negation on the same plane is exactly the inner loop.
    expect(edgesOf(notOuter)).toHaveLength(8);
  });

  it("transforms with its face filters and keeps its role", () => {
    const outer = new WireMembershipFilter([face().onPlane("xy", 10)], "outer", false);
    const lifted = outer.transform(Matrix4.fromTranslation(0, 0, 5));
    expect(lifted).toBeInstanceOf(WireMembershipFilter);
    expect(lifted.compareTo(new WireMembershipFilter([face().onPlane("xy", 15)], "outer", false))).toBe(true);
    expect(lifted.compareTo(new WireMembershipFilter([face().onPlane("xy", 15)], "hole", false))).toBe(false);
    expect(lifted.compareTo(new WireMembershipFilter([face().onPlane("xy", 15)], "outer", true))).toBe(false);
  });
});
