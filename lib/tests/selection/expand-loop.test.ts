import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import { SceneObject } from "../../common/scene-object.js";
import { Shape } from "../../common/shape.js";
import { Explorer } from "../../oc/explorer.js";
import { EdgeOps } from "../../oc/edge-ops.js";
import { expandBucket, expandLoop, expandTangentChain } from "../../selection/expand.js";
import type { PickRef } from "../../selection/types.js";
import { surface, TopologySheets } from "../helpers/topology-surfaces.js";
import { TestSheets } from "../helpers/sheets.js";
import { testRect } from "../helpers/profiles.js";
import { useLoadedBodies, loadShapes } from "../helpers/loaded-bodies.js";
import { edgeRefsWhere, faceRefsWhere, findSolid } from "./pick-helpers.js";

const mid = (shape: Shape, ref: PickRef) => EdgeOps.getEdgeMidPoint(Explorer.findEdgesWrapped(shape)[ref.sub.index]);

/** Which of a 30-wide plate's two square loops an edge lies on, read from its middle. */
const squareOf = (shape: Shape, ref: PickRef) => {
  const m = mid(shape, ref);
  return Math.max(Math.abs(m.x), Math.abs(m.y)) > 10 ? "outer" : "inner";
};

describe("expandLoop (the double-click on an edge)", () => {
  setupOC();
  useLoadedBodies();

  it("takes the rim loop a surface's rim edge belongs to, of the two the surface has", () => {
    const s = surface(() => [TopologySheets.plateWithSquareHole(30, 10)]) as unknown as SceneObject;
    const scene = render();
    const sheet = s.getShapes()[0];

    for (const seed of edgeRefsWhere(sheet, () => true)) {
      const result = expandLoop(scene, seed);
      expect(result.ok).toBe(true);
      if (result.ok === false) {
        continue;
      }
      expect(result.rim).toBe(true);
      expect(result.members).toHaveLength(4);
      expect(result.members).toContainEqual(seed);
      expect(result.members.every(m => squareOf(sheet, m) === squareOf(sheet, seed))).toBe(true);
      // In mesh order.
      const indices = result.members.map(m => m.sub.index);
      expect(indices).toEqual([...indices].sort((a, b) => a - b));
    }
  });

  it("takes a loaded surface's rim loop, which no bucket names", () => {
    const l = loadShapes([TopologySheets.squareTube(10, 10, 20)]) as unknown as SceneObject;
    const scene = render();
    const tube = l.getShapes()[0];
    const [top] = edgeRefsWhere(tube, m => Math.abs(m.z - 20) < 1e-6);

    expect(expandBucket(scene, top).ok).toBe(false);
    const result = expandLoop(scene, top);
    expect(result.ok && result.rim).toBe(true);
    expect(result.ok && result.members.map(m => Math.round(mid(tube, m).z))).toEqual([20, 20, 20, 20]);
  });

  it("calls no other pick a rim edge: a solid's edge, a surface's interior edge, a face", () => {
    const s = surface(() => [TestSheets.openBox(10, 10, 10)]) as unknown as SceneObject;
    sketch("xy", () => {
      testRect(20, 20, { at: [100, 0] });
    });
    extrude(10);
    const scene = render();
    const box = s.getShapes()[0];
    const solid = findSolid(scene);

    const [fold] = edgeRefsWhere(box, m => Math.abs(m.z) < 1e-6 && Math.abs(m.y) < 1e-6);
    const [solidEdge] = edgeRefsWhere(solid, () => true);
    const [floor] = faceRefsWhere(box, m => Math.abs(m.z) < 1e-6);
    for (const pick of [fold, solidEdge, floor]) {
      expect(expandLoop(scene, pick)).toEqual({ ok: true, rim: false, members: [] });
    }
    // The open box's rim is one loop of four.
    const [rimEdge] = edgeRefsWhere(box, m => Math.abs(m.z - 10) < 1e-6);
    const rim = expandLoop(scene, rimEdge);
    expect(rim.ok && rim.rim && rim.members.length).toBe(4);
  });

  it("refuses a pick that names nothing in the scene", () => {
    surface(() => [TestSheets.plate(10, 10)]);
    const scene = render();
    const result = expandLoop(scene, { shapeId: "nope", sub: { type: "edge", index: 0 } });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toContain("does not resolve");
    }
  });
});

describe("expansions over a pick on a surface", () => {
  setupOC();

  it("expands a surface's rim edge to its bucket, its face to the faces bucket", () => {
    const s = surface(() => [TopologySheets.plateWithSquareHole(30, 10)]) as unknown as SceneObject;
    const scene = render();
    const sheet = s.getShapes()[0];
    const [edge] = edgeRefsWhere(sheet, () => true);

    const rim = expandBucket(scene, edge);
    expect(rim.ok).toBe(true);
    if (rim.ok) {
      expect(rim.accessor).toBe("boundaryEdges");
      expect(rim.members).toHaveLength(8);
    }
    const faces = expandBucket(scene, { shapeId: sheet.id, sub: { type: "face", index: 0 } });
    expect(faces.ok && faces.accessor).toBe("faces");
  });

  it("expands a surface's face and rim edge along tangent neighbours", () => {
    // A straight run into a quarter turn: two faces meeting tangentially.
    const s = surface(() => [TestSheets.tangentStrip(5)]) as unknown as SceneObject;
    const scene = render();
    const strip = s.getShapes()[0];

    const faces = expandTangentChain(scene, { shapeId: strip.id, sub: { type: "face", index: 0 } });
    expect(faces.ok && faces.members).toHaveLength(2);
    // The bottom rim: the line runs smoothly into the arc.
    const [bottom] = edgeRefsWhere(strip, m => Math.abs(m.z) < 1e-6);
    const edges = expandTangentChain(scene, bottom);
    expect(edges.ok && edges.members.map(m => Math.round(mid(strip, m).z))).toEqual([0, 0]);
  });
});
