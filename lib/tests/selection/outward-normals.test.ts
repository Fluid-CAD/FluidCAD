import { describe, it, expect } from "vitest";
import { setupOC, render } from "../setup.js";
import { getSceneManager } from "../../scene-manager.js";
import sketch from "../../core/sketch.js";
import extrude from "../../core/extrude.js";
import cut from "../../core/cut.js";
import mirror from "../../core/mirror.js";
import part from "../../core/part.js";
import insert from "../../core/insert.js";
import { circle } from "../../core/2d/index.js";
import { testRect } from "../helpers/profiles.js";
import { Scene } from "../../rendering/scene.js";
import { Solid } from "../../common/solid.js";
import { getOC } from "../../oc/init.js";
import { FaceOps } from "../../oc/face-ops.js";
import { FaceQuery } from "../../oc/face-query.js";
import { SelectionResolver } from "../../selection/resolve-selection.js";
import type { ResolveSelectionRequest, ResolveSelectionResult, ResolvedSelectionMatch } from "../../selection/resolve-selection.js";
import type { TopoDS_Face } from "ocjs-fluidcad";

type FaceMatch = Exclude<ResolvedSelectionMatch, { kind: 'vertex' }>;

function resolveFaces(scene: Scene, request: ResolveSelectionRequest): FaceMatch[] {
  const result: ResolveSelectionResult = SelectionResolver.resolve(scene, request);
  expect(result.ok, result.ok === false ? result.reason : '').toBe(true);
  return (result as Extract<ResolveSelectionResult, { ok: true }>).matches.filter((m): m is FaceMatch => m.kind === 'face');
}

function expectNoErrors(scene: Scene): void {
  expect(scene.getRenderedObjects().filter(r => r.hasError).map(r => r.errorMessage)).toEqual([]);
}

/**
 * Every reported face normal points out of its solid: dotted with (face
 * center − solid center) it is positive. The solid center is the mean of
 * its face centers, exact for a box and a cylinder.
 */
function expectOutward(matches: FaceMatch[]): void {
  const bySolid = new Map<string, FaceMatch[]>();
  for (const match of matches) {
    bySolid.set(match.shapeId, [...(bySolid.get(match.shapeId) ?? []), match]);
  }
  for (const faces of bySolid.values()) {
    const center = [0, 1, 2].map(axis => faces.reduce((sum, f) => sum + f.summary.center[axis], 0) / faces.length);
    for (const face of faces) {
      if (!face.summary.normal) {
        continue;
      }
      const dot = face.summary.normal.reduce((sum, n, axis) => sum + n * (face.summary.center[axis] - center[axis]), 0);
      expect(dot, `face ${face.index}: normal [${face.summary.normal}] at [${face.summary.center}]`).toBeGreaterThan(0);
    }
  }
}

/**
 * A box's faces are TopAbs_REVERSED on five sides out of six, and a summary
 * that read the carrier plane's axis alone reported those normals inward
 * (the top face, FORWARD, looked right). A mirrored body's planes have
 * left-handed frames, where the axis is the opposite of the parametric
 * normal the orientation flag refers to — flipping the axis on REVERSED
 * alone would get every face of it wrong.
 */
describe("resolve_selection face normals point out of the solid", () => {
  setupOC();

  it("on a plain box: all six faces", () => {
    sketch("xy", () => {
      testRect(40, 30);
    });
    extrude(10);
    const scene = render();
    expectNoErrors(scene);
    const faces = resolveFaces(scene, { expression: 'face()' });
    const normals = faces.map(f => ({ center: f.summary.center, normal: f.summary.normal }));
    expect(normals).toEqual(expect.arrayContaining([
      { center: [0, 15, 5], normal: [-1, 0, 0] },
      { center: [40, 15, 5], normal: [1, 0, 0] },
      { center: [20, 0, 5], normal: [0, -1, 0] },
      { center: [20, 30, 5], normal: [0, 1, 0] },
      { center: [20, 15, 0], normal: [0, 0, -1] },
      { center: [20, 15, 10], normal: [0, 0, 1] },
    ]));
    expect(faces).toHaveLength(6);
  });

  it("on a box and a cylinder inside a part; the cylinder's side reports its axis", () => {
    part("block", () => {
      sketch("xy", () => {
        testRect(40, 30);
      });
      extrude(10);
      sketch("xy", () => {
        circle([80, 0], 20);
      });
      extrude(15);
    });
    const scene = render();
    expectNoErrors(scene);
    const faces = resolveFaces(scene, { expression: 'face()' });
    expect(faces).toHaveLength(9);
    expectOutward(faces);
    const side = faces.find(f => f.summary.form === 'cylinder');
    expect(side?.summary.normal).toBeUndefined();
    expect(side?.summary.axis).toBeDefined();
  });

  it("on a mirrored box, whose planes have left-handed frames", () => {
    sketch("xy", () => {
      testRect(40, 30, { at: [10, 0] });
    });
    const e = extrude(10);
    mirror("yz", e).new();
    const scene = render();
    expectNoErrors(scene);
    const faces = resolveFaces(scene, { expression: 'face()' });
    expect(new Set(faces.map(f => f.shapeId)).size).toBe(2);
    expect(faces).toHaveLength(12);
    expectOutward(faces);
  });

  it("on assembly instances, at home and under a rotated, translated pose", () => {
    const scene = getSceneManager().startAssemblyScene();
    const def = part("box", () => {
      sketch("xy", () => {
        testRect(40, 30);
      });
      extrude(10);
    });
    insert(def);
    insert(def).rotate("z", 30).rotate("x", 50).translate(60, -20, 15);
    render();
    expectNoErrors(scene);
    const instances = scene.getSerializedInstances();
    expect(instances).toHaveLength(2);
    for (const { instanceId } of instances) {
      const faces = resolveFaces(scene, { expression: 'face()', scope: { instanceId } });
      expect(faces).toHaveLength(6);
      expectOutward(faces);
    }
  });

  it("measure's entity summaries carry the same outward normals, posed", () => {
    const scene = getSceneManager().startAssemblyScene();
    const def = part("box", () => {
      sketch("xy", () => {
        testRect(40, 30);
      });
      extrude(10);
    });
    insert(def).rotate("x", 90).translate(0, 0, 50);
    render();
    expectNoErrors(scene);
    const [{ instanceId }] = scene.getSerializedInstances();
    const faces = resolveFaces(scene, { expression: 'face()', scope: { instanceId } });
    const measured = getSceneManager().measure(scene, faces);
    expect(measured).not.toBeNull();
    // Rotated 90° about x, the part's bottom (local −z) faces world +y.
    const bottom = measured!.entities.find(entity => entity.summary.center[1] === 0);
    expect(bottom?.summary.normal).toEqual([0, 1, 0]);
    for (const [i, entity] of measured!.entities.entries()) {
      expect(entity.summary.normal).toEqual(faces[i].summary.normal);
    }
  });
});

describe("FaceOps.outwardNormalRaw on curved faces", () => {
  setupOC();

  it("points away from a boss's axis and toward a bore's", () => {
    sketch("xy", () => {
      testRect(60, 60);
    });
    const e = extrude(10);
    sketch(e.endFaces(), () => {
      circle([30, 30], 20);
    });
    cut(10);
    sketch("xy", () => {
      circle([100, 30], 20);
    });
    extrude(10);
    const scene = render();
    expectNoErrors(scene);
    const oc = getOC();
    const solids = scene.getAllSceneObjects().flatMap(o => o.getAddedShapes()).filter((s): s is Solid => s instanceof Solid);
    const cylinders = solids.flatMap(solid => solid.getIndexedShapes('face'))
      .filter(face => FaceQuery.getSurfaceTypeRaw(face.getShape()) === 'cylinder');
    expect(cylinders.map(face => FaceOps.axialSurfaceAxisRaw(face.getShape() as TopoDS_Face)!.origin.x).sort((a, b) => a - b))
      .toEqual([30, 100]);
    for (const face of cylinders) {
      const raw = face.getShape() as TopoDS_Face;
      const axis = FaceOps.axialSurfaceAxisRaw(raw)!;
      const normal = FaceOps.outwardNormalRaw(raw)!;
      // The surface point the default probe evaluates: the centre of the UV bounds.
      const bounds = oc.BRepTools.UVBounds(raw);
      const adaptor = new oc.BRepAdaptor_Surface(raw, true);
      const point = adaptor.Value((bounds.UMin + bounds.UMax) / 2, (bounds.VMin + bounds.VMax) / 2);
      const radial = [point.X() - axis.origin.x, point.Y() - axis.origin.y];
      point.delete();
      adaptor.delete();
      expect(Math.abs(normal.z)).toBeLessThan(1e-9);
      const along = (normal.x * radial[0] + normal.y * radial[1]) / Math.hypot(radial[0], radial[1]);
      // A boss's material is inside its wall, a bore's outside.
      expect(along).toBeCloseTo(axis.origin.x === 100 ? 1 : -1, 9);
    }
  });
});
