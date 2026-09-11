import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import { Extrude } from "../../features/extrude.js";
import select from "../../core/select.js";
import cut from "../../core/cut.js";
import { circle } from "../../core/2d/index.js";
import { Face } from "../../common/face.js";
import { Edge } from "../../common/edge.js";
import { Point } from "../../math/point.js";
import { Vector3d } from "../../math/vector3d.js";
import { Matrix4 } from "../../math/matrix4.js";
import { face, edge } from "../../filters/index.js";
import { SelectSceneObject } from "../../features/select.js";
import { LazySelectionSceneObject } from "../../features/lazy-scene-object.js";
import { ExtremalFilter, groupLayers } from "../../filters/rank/extremal.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { ShapeMeasure } from "../../oc/shape-measure.js";
import { testRect } from "../helpers/profiles.js";

/** 100 × 50 × 30 box with its corner at the origin. */
function box() {
  sketch("xy", () => {
      testRect(100, 50);
    });
  return extrude(30) as Extrude;
}

/** The box plus a Ø10 boss fused through it, reaching z = 40. */
function boxWithBoss() {
  const e = box();
  sketch("xy", () => {
      circle([50, 25], 10);
    });
  extrude(40);
  return e;
}

function midZ(e: Edge): number {
  return EdgeOps.getEdgeMidPoint(e).z;
}

describe("rank filters: farthest / nearest / nth", () => {
  setupOC();

  it("farthest('z') keeps the whole top layer of a box, not the vertical edges touching it", () => {
    box();
    const top = select(edge().farthest("z")) as SelectSceneObject;
    const bottom = select(edge().nearest("z")) as SelectSceneObject;
    const topFace = select(face().farthest("z")) as SelectSceneObject;
    render();

    const topEdges = top.getShapes() as Edge[];
    expect(topEdges).toHaveLength(4);
    for (const e of topEdges) {
      expect(midZ(e)).toBeCloseTo(30, 6);
    }
    const bottomEdges = bottom.getShapes() as Edge[];
    expect(bottomEdges).toHaveLength(4);
    for (const e of bottomEdges) {
      expect(midZ(e)).toBeCloseTo(0, 6);
    }
    expect(topFace.getShapes()).toHaveLength(1);
    expect((topFace.getShapes()[0] as Face).center().z).toBeCloseTo(30, 6);
  });

  it("negative axes and vectors point the other way", () => {
    box();
    const viaNegative = select(face().nearest("-z")) as SelectSceneObject;
    const viaVector = select(face().farthest([0, 0, 1])) as SelectSceneObject;
    const leftmost = select(edge().nearest("x")) as SelectSceneObject;
    render();

    expect((viaNegative.getShapes()[0] as Face).center().z).toBeCloseTo(30, 6);
    expect((viaVector.getShapes()[0] as Face).center().z).toBeCloseTo(30, 6);
    const leftEdges = leftmost.getShapes() as Edge[];
    expect(leftEdges).toHaveLength(4);
    for (const e of leftEdges) {
      expect(EdgeOps.getEdgeMidPoint(e).x).toBeCloseTo(0, 6);
    }
  });

  it("nth() addresses interior layers from either end", () => {
    box();
    const middle = select(edge().nth("z", 1)) as SelectSceneObject;
    const fromTop = select(edge().nth("z", -1)) as SelectSceneObject;
    const outOfRange = select(edge().nth("z", 3)) as SelectSceneObject;
    render();

    const vertical = middle.getShapes() as Edge[];
    expect(vertical).toHaveLength(4);
    for (const e of vertical) {
      expect(midZ(e)).toBeCloseTo(15, 6);
    }
    expect(fromTop.getShapes()).toHaveLength(4);
    expect(midZ(fromTop.getShapes()[0] as Edge)).toBeCloseTo(30, 6);
    expect(outOfRange.getShapes()).toHaveLength(0);
  });

  it("notFarthest() keeps everything but the top layer", () => {
    box();
    const rest = select(edge().notFarthest("z")) as SelectSceneObject;
    render();
    const edges = rest.getShapes() as Edge[];
    expect(edges).toHaveLength(8);
    expect(edges.every(e => midZ(e) < 30 - 1e-6)).toBe(true);
  });

  it("chain order is evaluation order: a class filter before farthest() ranks only that class", () => {
    boxWithBoss();
    const bossRim = select(edge().farthest("z")) as SelectSceneObject;
    const seam = select(edge().line().farthest("z")) as SelectSceneObject;
    const boxRim = select(edge().line().parallelTo("xy").farthest("z")) as SelectSceneObject;
    const circleFirst = select(edge().farthest("z").line()) as SelectSceneObject;
    render();

    const rim = bossRim.getShapes() as Edge[];
    expect(rim).toHaveLength(1);
    expect(midZ(rim[0])).toBeCloseTo(40, 6);

    // Among lines, the topmost center is the boss seam above the box (z 30..40).
    const seamEdges = seam.getShapes() as Edge[];
    expect(seamEdges).toHaveLength(1);
    expect(midZ(seamEdges[0])).toBeCloseTo(35, 6);

    const lines = boxRim.getShapes() as Edge[];
    expect(lines).toHaveLength(4);
    for (const e of lines) {
      expect(midZ(e)).toBeCloseTo(30, 6);
    }

    // The top layer is the boss rim (a circle); asking for lines within it finds none.
    expect(circleFirst.getShapes()).toHaveLength(0);
  });

  it("works inside bucket accessors and composes with positional selectors", () => {
    const e = box();
    const rightSide = e.sideEdges(edge().farthest("x")) as unknown as LazySelectionSceneObject;
    const oneOfThem = select(edge().farthest("z").first()) as SelectSceneObject;
    render();

    // Accessor selections are lazy; resolve this one by hand against the built feature.
    rightSide.build();
    const right = rightSide.getShapes() as Edge[];
    expect(right).toHaveLength(2);
    for (const r of right) {
      expect(EdgeOps.getEdgeMidPoint(r).x).toBeCloseTo(100, 6);
    }
    expect(oneOfThem.getShapes()).toHaveLength(1);
  });

  it("a mirroring transform flips the direction", () => {
    const filter = new ExtremalFilter<Edge>("z", { kind: "farthest" });
    const mirrored = filter.transform(Matrix4.mirrorPlane(new Vector3d(0, 0, 1), new Point(0, 0, 0)));
    const flipped = new ExtremalFilter<Edge>("-z", { kind: "farthest" });
    expect(mirrored.compareTo(flipped)).toBe(true);
    expect(mirrored.compareTo(filter)).toBe(false);
  });

  it("groups near-equal measures into one layer", () => {
    expect(groupLayers([0, 10, 10 + 1e-9, 20], 1e-6)).toEqual([0, 1, 1, 2]);
    expect(groupLayers([5, 5, 5], 1e-6)).toEqual([0, 0, 0]);
    expect(groupLayers([], 1e-6)).toEqual([]);
  });
});

describe("rank filters: largest / smallest", () => {
  setupOC();

  it("keeps every tie with the extreme size", () => {
    box();
    const longest = select(edge().largest()) as SelectSceneObject;
    const shortest = select(edge().smallest()) as SelectSceneObject;
    const bigFaces = select(face().largest()) as SelectSceneObject;
    const smallFaces = select(face().smallest()) as SelectSceneObject;
    const notBig = select(face().notLargest()) as SelectSceneObject;
    render();

    const long = longest.getShapes() as Edge[];
    expect(long).toHaveLength(4);
    for (const e of long) {
      expect(ShapeMeasure.size(e)).toBeCloseTo(100, 6);
    }
    const short = shortest.getShapes() as Edge[];
    expect(short).toHaveLength(4);
    for (const e of short) {
      expect(ShapeMeasure.size(e)).toBeCloseTo(30, 6);
    }
    expect(bigFaces.getShapes()).toHaveLength(2);
    expect(ShapeMeasure.size(bigFaces.getShapes()[0])).toBeCloseTo(5000, 4);
    expect(smallFaces.getShapes()).toHaveLength(2);
    expect(ShapeMeasure.size(smallFaces.getShapes()[0])).toBeCloseTo(1500, 4);
    expect(notBig.getShapes()).toHaveLength(4);
  });

  it("ranks by radius on request and ignores shapes without one", () => {
    const e = box();
    sketch(e.endFaces(), () => {
        circle([25, 25], 5);
        circle([75, 25], 8);
      });
    cut(30);
    const bigger = select(face().cylinder().largest("radius")) as SelectSceneObject;
    const smallerRim = select(edge().circle().smallest("radius")) as SelectSceneObject;
    const radiusOverEverything = select(edge().largest("radius")) as SelectSceneObject;
    render();

    expect(bigger.getShapes()).toHaveLength(1);
    expect(ShapeMeasure.radius(bigger.getShapes()[0])).toBeCloseTo(4, 6);
    // The Ø5 hole has a rim on each face of the plate.
    const rims = smallerRim.getShapes() as Edge[];
    expect(rims).toHaveLength(2);
    for (const rim of rims) {
      expect(ShapeMeasure.radius(rim)).toBeCloseTo(2.5, 6);
    }
    // Lines have no radius: only the Ø8 rims qualify.
    const largestRadius = radiusOverEverything.getShapes() as Edge[];
    expect(largestRadius).toHaveLength(2);
    expect(ShapeMeasure.radius(largestRadius[0])).toBeCloseTo(4, 6);
  });
});
