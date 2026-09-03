import { describe, it, expect } from "vitest";
import { setupOC, render } from "./setup.js";
import sketch from "../core/sketch.js";
import extrude from "../core/extrude.js";
import { bezier, circle, line } from "../core/2d/index.js";
import { getSceneManager, getCurrentScene } from "../scene-manager.js";
import { Explorer } from "../oc/explorer.js";
import { classifyEdge, classifyFace } from "../oc/measure/classify.js";
import type { ClassifiedEntity } from "../oc/measure/classify.js";
import type { MeasureEntityRef, MeasureResult, MeasureVec } from "../oc/measure/measure-types.js";
import { testRect } from "./helpers/profiles.js";

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
      testRect(width, depth);
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
// A lone r=10 cylinder, 10 tall, on the origin.
function makeCylinder(): void {
  sketch("xy", () => {
    circle([0, 0], 20);
  });
  extrude(10);
  render();
}

// Two r=10 cylinders 15 apart fuse into one solid whose end faces are bounded
// by two arcs of different centers: planar, but no single rim.
function makeFusedCylinders(): void {
  sketch("xy", () => {
    circle([0, 0], 20);
    circle([15, 0], 20);
  });
  extrude(10);
  render();
}

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

    it("reports the axis-plane angle between a cylinder and a non-circular plane", () => {
      makeFusedCylinders();
      const cylinder = findEntities('face', (c) => c.form === 'cylinder')[0];
      const top = findEntities('face', (c) => c.form === 'plane' && dirAlong(c, 0, 0, 1) && Math.abs(c.anchor.z - 10) < 1e-6);
      expect(top).toHaveLength(1);
      expect(top[0].info.center).toBeNull();

      const result = measureRefs([cylinder.ref, top[0].ref]);
      expect(result.primary).toBe('minDist');
      expect(result.centerDist).toBeUndefined();
      expect(result.angleDeg).toBeCloseTo(90, 4);
      expect(result.angleLabel).toBe('Axis-plane angle');
    });

    it("a cylinder's center sits on its axis at mid-height, a disc's at its rim center", () => {
      makeCylinder();
      const barrel = findEntities('face', (c) => c.form === 'cylinder')[0].info;
      expect(barrel.center).toEqual({ x: expect.closeTo(0, 6), y: expect.closeTo(0, 6), z: expect.closeTo(5, 6) });
      const top = findEntities('face', (c) => c.form === 'plane' && Math.abs(c.anchor.z - 10) < 1e-6)[0].info;
      expect(top.center).toEqual({ x: expect.closeTo(0, 6), y: expect.closeTo(0, 6), z: expect.closeTo(10, 6) });
      expect(top.radius).toBeCloseTo(10, 6);
    });

    it("measures a cylinder to a circular face center to center, not rim to rim", () => {
      makeCylinder();
      const barrel = findEntities('face', (c) => c.form === 'cylinder')[0];
      const top = findEntities('face', (c) => c.form === 'plane' && Math.abs(c.anchor.z - 10) < 1e-6)[0];

      const result = measureRefs([barrel.ref, top.ref]);
      expect(result.primary).toBe('centerDist');
      expect(result.primaryLabel).toBe('Center dist');
      expect(result.centerDist!.value).toBeCloseTo(5, 4);
      expect(result.centerDist!.from).toEqual({ x: expect.closeTo(0, 6), y: expect.closeTo(0, 6), z: expect.closeTo(5, 6) });
      expect(result.centerDist!.to).toEqual({ x: expect.closeTo(0, 6), y: expect.closeTo(0, 6), z: expect.closeTo(10, 6) });
      expect(result.minDist!.value).toBeCloseTo(0, 4);
      expect(result.angleDeg).toBeCloseTo(90, 4);
    });

    it("measures two circular faces center to center", () => {
      makeTwoCylinders();
      const tops = findEntities('face', (c) => c.form === 'plane' && Math.abs(c.anchor.z - 10) < 1e-6);
      expect(tops).toHaveLength(2);

      const result = measureRefs(tops.map((f) => f.ref));
      expect(result.primary).toBe('centerDist');
      expect(result.centerDist!.value).toBeCloseTo(40, 4);
      expect(result.parallelDist!.value).toBeCloseTo(0, 4);
    });

    it("keeps axis distance primary for parallel cylinders and adds their center distance", () => {
      makeTwoCylinders();
      const cylinders = findEntities('face', (c) => c.form === 'cylinder');
      expect(cylinders).toHaveLength(2);

      const result = measureRefs(cylinders.map((f) => f.ref));
      expect(result.primary).toBe('axisDist');
      expect(result.axisDist!.value).toBeCloseTo(40, 4);
      expect(result.centerDist!.value).toBeCloseTo(40, 4);
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

// ---------------------------------------------------------------------------
// Assembly context: entities carry an instanceId (+ optional live pose) and
// are measured where the instance sits, not in the part template's frame.
// ---------------------------------------------------------------------------

import part from "../core/part.js";
import assembly from "../core/assembly.js";
import insert from "../core/insert.js";
import type { MeasurePose } from "../oc/measure/measure-types.js";

type AsmFace = { shapeId: string; index: number };

/** A 20×20×10 box definition, inserted twice — the second instance posed by `poseSecond`. */
function makeAssemblyPair(poseSecond: (inst: ReturnType<typeof insert>) => void): { xMin: AsmFace; xMax: AsmFace; ids: string[] } {
  const scene = getSceneManager().startAssemblyScene();
  const def = part("box", () => {
    sketch("xy", () => {
      testRect(20, 20);
    });
    extrude(10);
  });
  insert(def);
  poseSecond(insert(def));
  render();
  const ids = scene.getSerializedInstances().map((i) => i.instanceId);
  const xFaces = findEntities('face', (c) => c.form === 'plane' && dirAlong(c, 1, 0, 0));
  expect(xFaces).toHaveLength(2);
  const byX = [...xFaces].sort((a, b) => a.info.point!.x - b.info.point!.x);
  return {
    xMin: { shapeId: byX[0].ref.shapeId, index: byX[0].ref.index },
    xMax: { shapeId: byX[1].ref.shapeId, index: byX[1].ref.index },
    ids,
  };
}

function faceRef(face: AsmFace, instanceId?: string, pose?: MeasurePose): MeasureEntityRef {
  return { shapeId: face.shapeId, kind: 'face', index: face.index, ...(instanceId ? { instanceId } : {}), ...(pose ? { pose } : {}) };
}

describe("measure — assembly context", () => {
  setupOC();

  it("an instance at the identity pose measures like the template", () => {
    const { xMin, xMax, ids } = makeAssemblyPair(() => {});
    const template = measureRefs([faceRef(xMin), faceRef(xMax)]);
    const posed = measureRefs([faceRef(xMin, ids[0]), faceRef(xMax, ids[0])]);
    expect(posed.primary).toBe('parallelDist');
    expect(posed.parallelDist!.value).toBeCloseTo(template.parallelDist!.value, 6);
    expect(posed.totalArea).toBeCloseTo(template.totalArea!, 6);
    expect(posed.entities[0].ref.instanceId).toBe(ids[0]);
  });

  it("two instances of one part share a shapeId but measure at their own statement poses", () => {
    const { xMin, xMax, ids } = makeAssemblyPair((inst) => inst.translate(30, 0, 0));
    // Same face index on both instances: exactly the translation apart.
    const same = measureRefs([faceRef(xMax, ids[0]), faceRef(xMax, ids[1])]);
    expect(same.primary).toBe('parallelDist');
    expect(same.parallelDist!.value).toBeCloseTo(30, 4);
    // A's far face (x=20) to B's near face (x=30): the 10 gap, in world coordinates.
    const gap = measureRefs([faceRef(xMax, ids[0]), faceRef(xMin, ids[1])]);
    expect(gap.parallelDist!.value).toBeCloseTo(10, 4);
    const xs = [gap.parallelDist!.from.x, gap.parallelDist!.to.x].sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(20, 4);
    expect(xs[1]).toBeCloseTo(30, 4);
    expect(gap.minDist!.value).toBeCloseTo(10, 4);
  });

  it("a caller-supplied pose overrides the statement pose", () => {
    const { xMax, ids } = makeAssemblyPair((inst) => inst.translate(30, 0, 0));
    const live: MeasurePose = { position: { x: 50, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } };
    const result = measureRefs([faceRef(xMax, ids[0]), faceRef(xMax, ids[1], live)]);
    expect(result.parallelDist!.value).toBeCloseTo(50, 4);
  });

  it("a rotated instance turns a parallel pair into an angle", () => {
    const { xMax, ids } = makeAssemblyPair((inst) => inst.rotate("z", 90).translate(60, 0, 0));
    const result = measureRefs([faceRef(xMax, ids[0]), faceRef(xMax, ids[1])]);
    expect(result.primary).toBe('angle');
    expect(result.angleDeg).toBeCloseTo(90, 4);
  });

  it("an un-normalized live quaternion is treated as a pure rotation", () => {
    const { xMax, ids } = makeAssemblyPair(() => {});
    const s = Math.SQRT1_2 * 3; // 90° about Z, scaled ×3
    const live: MeasurePose = { position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: s, w: s } };
    const result = measureRefs([faceRef(xMax, ids[0]), faceRef(xMax, ids[1], live)]);
    expect(result.angleDeg).toBeCloseTo(90, 4);
    expect(result.entities[1].area).toBeCloseTo(result.entities[0].area!, 6);
  });

  it("an occurrence-owned instance measures at its composed world pose", () => {
    const scene = getSceneManager().startAssemblyScene();
    const def = part("box", () => {
      sketch("xy", () => {
        testRect(20, 20);
      });
      extrude(10);
    });
    const sub = assembly("sub", () => ({ b: insert(def).translate(5, 0, 0) }));
    insert(def);
    insert(sub).translate(40, 0, 0);
    render();
    const ids = scene.getSerializedInstances().map((i) => i.instanceId);
    expect(ids).toHaveLength(2);
    const owned = scene.getSerializedInstances().find((i) => i.owner !== "")!;
    expect(owned.position.x).toBeCloseTo(45, 6);
    const xFaces = findEntities('face', (c) => c.form === 'plane' && dirAlong(c, 1, 0, 0));
    const xMax = [...xFaces].sort((a, b) => a.info.point!.x - b.info.point!.x)[1].ref;
    const root = scene.getSerializedInstances().find((i) => i.owner === "")!;
    const result = measureRefs([
      { ...xMax, instanceId: root.instanceId },
      { ...xMax, instanceId: owned.instanceId },
    ]);
    expect(result.parallelDist!.value).toBeCloseTo(45, 4);
  });

  it("returns null for an unknown instance", () => {
    const { xMax, ids } = makeAssemblyPair(() => {});
    const result = getSceneManager().measure(getCurrentScene(), [faceRef(xMax, ids[0]), faceRef(xMax, "inst-99")]);
    expect(result).toBeNull();
  });
});
