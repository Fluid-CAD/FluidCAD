import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import { bezier, circle, line, rect } from "../core/2d/index.js";
import { getSceneManager, getCurrentScene } from "../scene-manager.js";
import { Explorer } from "../oc/explorer.js";
import { classifyEdge, classifyFace } from "../oc/measure/classify.js";
import type { ClassifiedEntity } from "../oc/measure/classify.js";
import type { MeasureEntityRef, MeasureResult, MeasureVec } from "../oc/measure/measure-types.js";

type FoundEntity = { ref: MeasureEntityRef; info: ClassifiedEntity };

function findEntities(kind: 'face' | 'edge', predicate: (c: ClassifiedEntity) => boolean): FoundEntity[] {
  const found: FoundEntity[] = [];
  for (const obj of getCurrentScene().getAllSceneObjects()) {
    for (const shape of obj.getAddedShapes()) {
      if (shape.isMetaShapeFlag || shape.isGuideFlag || shape.getType() !== 'solid') {
        continue;
      }
      const subs = kind === 'face' ? Explorer.findFacesWrapped(shape) : Explorer.findEdgesWrapped(shape);
      subs.forEach((sub, index) => {
        const info = kind === 'face' ? classifyFace(sub.getShape()) : classifyEdge(sub.getShape());
        if (predicate(info)) {
          found.push({ ref: { shapeId: shape.id, kind, index }, info });
        }
      });
    }
  }
  return found;
}

function measureRefs(refs: MeasureEntityRef[]): MeasureResult {
  const result = getSceneManager().measure(getCurrentScene(), refs);
  expect(result).not.toBeNull();
  return result;
}

function dirAlong(c: ClassifiedEntity, x: number, y: number, z: number): boolean {
  if (!c.dir) {
    return false;
  }
  return Math.abs(c.dir.x * x + c.dir.y * y + c.dir.z * z) > 0.9999;
}

function delta(d: { from: MeasureVec; to: MeasureVec }): MeasureVec {
  return { x: d.to.x - d.from.x, y: d.to.y - d.from.y, z: d.to.z - d.from.z };
}

function makeBox(width = 100, depth = 50, height = 30): void {
  sketch("xy", () => {
    rect(width, depth);
  });
  extrude(height);
  render();
}

// Right triangle in the XZ plane: legs 40 (x) and 30 (z), hypotenuse face at
// atan(30/40) = 36.8699° to the bottom face.
function makeWedge(): void {
  sketch("xz", () => {
    line([0, 0], [40, 0]);
    line([40, 0], [0, 30]);
    line([0, 30], [0, 0]);
  });
  extrude(10);
  render();
}

// Same wedge footprint, but the bottom edge is a straight quadratic bezier:
// its edge and extruded side face sit on fitted (non-canonical) geometry, so
// classification must recover the line/plane carriers numerically.
function makeBezierWedge(): void {
  sketch("xy", () => {
    bezier([0, 0], [20, 0], [40, 0]);
    line([40, 0], [40, 30]);
    line([40, 30], [0, 0]);
  });
  extrude(10);
  render();
}

// Two non-touching Ø20 cylinders whose axes are 40 apart.
function makeTwoCylinders(): void {
  sketch("xy", () => {
    circle([0, 0], 20);
    circle([40, 0], 20);
  });
  extrude(10);
  render();
}

describe("measure", () => {
  setupOC();

  describe("plane-plane", () => {
    it("measures parallel distance between opposite box faces", () => {
      makeBox();
      const faces = findEntities('face', (c) => c.form === 'plane' && dirAlong(c, 1, 0, 0));
      expect(faces).toHaveLength(2);

      const result = measureRefs(faces.map((f) => f.ref));
      expect(result.primary).toBe('parallelDist');
      expect(result.primaryLabel).toBe('Parallel dist');
      expect(result.parallelDist!.value).toBeCloseTo(100, 4);

      const d = delta(result.parallelDist!);
      expect(Math.abs(d.x)).toBeCloseTo(100, 4);
      expect(d.y).toBeCloseTo(0, 4);
      expect(d.z).toBeCloseTo(0, 4);

      expect(result.minDist!.value).toBeCloseTo(100, 4);
      expect(result.angleDeg).toBeUndefined();
      expect(result.totalArea).toBeCloseTo(2 * 50 * 30, 2);
    });

    it("measures max distance as the diagonal between opposite faces", () => {
      makeBox();
      const faces = findEntities('face', (c) => c.form === 'plane' && dirAlong(c, 1, 0, 0));
      const result = measureRefs(faces.map((f) => f.ref));

      const expected = Math.sqrt(100 * 100 + 50 * 50 + 30 * 30);
      expect(result.maxDist!.value).toBeCloseTo(expected, 3);
      const d = delta(result.maxDist!);
      expect(Math.abs(d.x)).toBeCloseTo(100, 3);
      expect(Math.abs(d.y)).toBeCloseTo(50, 3);
      expect(Math.abs(d.z)).toBeCloseTo(30, 3);
    });

    it("reports 90° for perpendicular box faces", () => {
      makeBox();
      const xFace = findEntities('face', (c) => c.form === 'plane' && dirAlong(c, 1, 0, 0))[0];
      const zFace = findEntities('face', (c) => c.form === 'plane' && dirAlong(c, 0, 0, 1))[0];

      const result = measureRefs([xFace.ref, zFace.ref]);
      expect(result.primary).toBe('angle');
      expect(result.primaryLabel).toBe('Perp planes angle');
      expect(result.angleDeg).toBeCloseTo(90, 5);
      expect(result.minDist!.value).toBeCloseTo(0, 5);
    });

    it("reports the slope angle of a wedge face", () => {
      makeWedge();
      const bottom = findEntities('face', (c) => c.form === 'plane' && dirAlong(c, 0, 0, 1));
      const slanted = findEntities('face', (c) => c.form === 'plane' && dirAlong(c, 0.6, 0, 0.8));
      expect(bottom).toHaveLength(1);
      expect(slanted).toHaveLength(1);

      const result = measureRefs([bottom[0].ref, slanted[0].ref]);
      expect(result.primary).toBe('angle');
      expect(result.primaryLabel).toBe('Planes angle');
      expect(result.angleDeg).toBeCloseTo(36.8699, 3);
    });
  });

  describe("fitted geometry fallbacks", () => {
    it("measures the angle between a bezier-carried planar face and a true plane", () => {
      makeBezierWedge();
      const bezierFace = findEntities('face', (c) =>
        c.form === 'plane' && dirAlong(c, 0, 1, 0) && Math.abs(c.anchor.y) < 1e-4);
      const slanted = findEntities('face', (c) => c.form === 'plane' && dirAlong(c, 0.6, -0.8, 0));
      expect(bezierFace).toHaveLength(1);
      expect(slanted).toHaveLength(1);

      const result = measureRefs([bezierFace[0].ref, slanted[0].ref]);
      expect(result.entities[0].geomType).toBe('plane');
      expect(result.primary).toBe('angle');
      expect(result.primaryLabel).toBe('Planes angle');
      expect(result.angleDeg).toBeCloseTo(36.8699, 3);
    });

    it("measures angle and parallel distance between bezier-carried straight edges", () => {
      makeBezierWedge();
      const bezierEdges = findEntities('edge', (c) =>
        c.form === 'line' && dirAlong(c, 1, 0, 0) && Math.abs(c.anchor.y) < 1e-4);
      expect(bezierEdges).toHaveLength(2);

      const parallel = measureRefs(bezierEdges.map((e) => e.ref));
      expect(parallel.primary).toBe('parallelDist');
      expect(parallel.parallelDist!.value).toBeCloseTo(10, 4);

      const hypotenuse = findEntities('edge', (c) => c.form === 'line' && dirAlong(c, 0.8, 0.6, 0));
      expect(hypotenuse.length).toBeGreaterThan(0);
      const result = measureRefs([bezierEdges[0].ref, hypotenuse[0].ref]);
      expect(result.primary).toBe('angle');
      expect(result.primaryLabel).toBe('Lines angle');
      expect(result.angleDeg).toBeCloseTo(36.8699, 3);
    });
  });

  describe("edge-edge", () => {
    it("measures parallel distance between parallel edges", () => {
      makeBox();
      const topXEdges = findEntities('edge', (c) =>
        c.form === 'line' && dirAlong(c, 1, 0, 0) && Math.abs(c.anchor.z - 30) < 1e-6);
      expect(topXEdges).toHaveLength(2);

      const result = measureRefs(topXEdges.map((e) => e.ref));
      expect(result.primary).toBe('parallelDist');
      expect(result.parallelDist!.value).toBeCloseTo(50, 4);
      expect(result.totalLength).toBeCloseTo(200, 4);
    });

    it("measures angle and min distance between skew edges", () => {
      makeBox();
      const topXEdges = findEntities('edge', (c) =>
        c.form === 'line' && dirAlong(c, 1, 0, 0) && Math.abs(c.anchor.z - 30) < 1e-6);
      const vertical = findEntities('edge', (c) => c.form === 'line' && dirAlong(c, 0, 0, 1));
      expect(vertical.length).toBeGreaterThan(0);

      // Pick a vertical edge on the opposite Y side so the pair doesn't touch.
      const topEdge = topXEdges[0];
      const skew = vertical.find((e) => Math.abs(e.info.anchor.y - topEdge.info.anchor.y) > 1);
      expect(skew).toBeDefined();

      const result = measureRefs([topEdge.ref, skew!.ref]);
      expect(result.primary).toBe('angle');
      expect(result.primaryLabel).toBe('Lines angle');
      expect(result.angleDeg).toBeCloseTo(90, 5);
      expect(result.minDist!.value).toBeCloseTo(50, 4);
    });

    it("measures center distance between circle edges", () => {
      makeTwoCylinders();
      const topRims = findEntities('edge', (c) => c.form === 'circle' && Math.abs(c.center!.z - 10) < 1e-6);
      expect(topRims).toHaveLength(2);

      const result = measureRefs(topRims.map((e) => e.ref));
      expect(result.primary).toBe('centerDist');
      expect(result.primaryLabel).toBe('Center dist');
      expect(result.centerDist!.value).toBeCloseTo(40, 4);
      expect(result.minDist!.value).toBeCloseTo(20, 4);
      expect(result.angleDeg).toBeUndefined();
      expect(result.entities[0].radius).toBeCloseTo(10, 4);
    });
  });

  describe("face-edge", () => {
    it("measures parallel distance between a face and a parallel edge", () => {
      makeBox();
      const topFace = findEntities('face', (c) =>
        c.form === 'plane' && dirAlong(c, 0, 0, 1) && Math.abs(c.anchor.z - 30) < 1e-6);
      const bottomXEdge = findEntities('edge', (c) =>
        c.form === 'line' && dirAlong(c, 1, 0, 0) && Math.abs(c.anchor.z) < 1e-6);
      expect(topFace).toHaveLength(1);
      expect(bottomXEdge.length).toBeGreaterThan(0);

      const result = measureRefs([topFace[0].ref, bottomXEdge[0].ref]);
      expect(result.primary).toBe('parallelDist');
      expect(result.parallelDist!.value).toBeCloseTo(30, 4);
      const d = delta(result.parallelDist!);
      expect(Math.abs(d.z)).toBeCloseTo(30, 4);
    });

    it("measures the angle between a slanted edge and a face", () => {
      makeWedge();
      const bottom = findEntities('face', (c) => c.form === 'plane' && dirAlong(c, 0, 0, 1))[0];
      const slantedEdges = findEntities('edge', (c) => c.form === 'line' && dirAlong(c, -0.8, 0, 0.6));
      expect(slantedEdges.length).toBeGreaterThan(0);

      const result = measureRefs([bottom.ref, slantedEdges[0].ref]);
      expect(result.primary).toBe('angle');
      expect(result.primaryLabel).toBe('Line-plane angle');
      expect(result.angleDeg).toBeCloseTo(36.8699, 3);
    });
  });

  describe("cylinders", () => {
    it("measures axis distance between parallel cylinders", () => {
      makeTwoCylinders();
      const cylinders = findEntities('face', (c) => c.form === 'cylinder');
      expect(cylinders).toHaveLength(2);

      const result = measureRefs(cylinders.map((f) => f.ref));
      expect(result.primary).toBe('axisDist');
      expect(result.primaryLabel).toBe('Axis dist');
      expect(result.axisDist!.value).toBeCloseTo(40, 4);
      expect(result.minDist!.value).toBeCloseTo(20, 4);
      expect(result.maxDist!.value).toBeGreaterThan(60);
      expect(result.maxDist!.value).toBeLessThan(61.5);
      expect(result.entities[0].geomType).toBe('cylinder');
      expect(result.entities[0].radius).toBeCloseTo(10, 4);
    });

    it("reports the axis-plane angle between a cylinder and its base plane", () => {
      makeTwoCylinders();
      const cylinder = findEntities('face', (c) => c.form === 'cylinder')[0];
      const base = findEntities('face', (c) => c.form === 'plane' && dirAlong(c, 0, 0, 1))[0];

      const result = measureRefs([cylinder.ref, base.ref]);
      expect(result.primary).toBe('minDist');
      expect(result.angleDeg).toBeCloseTo(90, 4);
      expect(result.angleLabel).toBe('Axis-plane angle');
    });
  });

  describe("single entity and aggregates", () => {
    it("returns area for a single face", () => {
      makeWedge();
      const cap = findEntities('face', (c) => c.form === 'plane' && dirAlong(c, 0, 1, 0))[0];

      const result = measureRefs([cap.ref]);
      expect(result.primary).toBe('totalArea');
      expect(result.primaryLabel).toBe('Area');
      expect(result.totalArea).toBeCloseTo((40 * 30) / 2, 3);
      expect(result.minDist).toBeUndefined();
    });

    it("returns length for a single edge", () => {
      makeBox();
      const edge = findEntities('edge', (c) =>
        c.form === 'line' && dirAlong(c, 1, 0, 0) && Math.abs(c.anchor.z - 30) < 1e-6)[0];

      const result = measureRefs([edge.ref]);
      expect(result.primary).toBe('totalLength');
      expect(result.primaryLabel).toBe('Length');
      expect(result.totalLength).toBeCloseTo(100, 4);
    });

    it("sums areas across 3+ selected faces", () => {
      makeBox();
      const faces = [
        ...findEntities('face', (c) => c.form === 'plane' && dirAlong(c, 1, 0, 0)),
        ...findEntities('face', (c) => c.form === 'plane' && dirAlong(c, 0, 1, 0)),
      ];
      expect(faces).toHaveLength(4);

      const result = measureRefs(faces.map((f) => f.ref));
      expect(result.primary).toBe('totalArea');
      expect(result.totalArea).toBeCloseTo(2 * 50 * 30 + 2 * 100 * 30, 2);
      expect(result.minDist).toBeUndefined();
    });

    it("returns null for an unknown shape or out-of-range index", () => {
      makeBox();
      expect(getSceneManager().measure(getCurrentScene(), [
        { shapeId: 'nope', kind: 'face', index: 0 },
      ])).toBeNull();

      const face = findEntities('face', (c) => c.form === 'plane')[0];
      expect(getSceneManager().measure(getCurrentScene(), [
        { shapeId: face.ref.shapeId, kind: 'face', index: 999 },
      ])).toBeNull();
    });
  });
});
