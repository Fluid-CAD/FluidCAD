import { describe, it, expect, vi } from "vitest";
import type { Geom_Surface } from "ocjs-fluidcad";
import { setupOC, render } from "../setup.js";
import { getOC } from "../../oc/init.js";
import { ShapeOps } from "../../oc/shape-ops.js";
import { SurfaceClassifier } from "../../oc/surface-classifier.js";
import { Face } from "../../common/face.js";
import { Edge } from "../../common/edge.js";
import { Plane } from "../../math/plane.js";
import { Point } from "../../math/point.js";
import { Vector3d } from "../../math/vector3d.js";
import type { Scene } from "../../rendering/scene.js";
import { FreeformBodies } from "../helpers/freeform-bodies.js";
import { findSolids } from "../selection/pick-helpers.js";

const XY = Plane.fromPointAndNormal(new Point(0, 0, 0), new Vector3d(0, 0, 1));
const TILTED = [new Vector3d(1, 2, 3), new Vector3d(-1, 0.3, 0.2), new Vector3d(0.2, 1, -0.4)].map(v => v.normalize());

function facesOf(scene: Scene): Face[] {
  return findSolids(scene).flatMap(solid => solid.getSubShapes("face"));
}

function edgesOf(scene: Scene): Edge[] {
  return findSolids(scene).flatMap(solid => solid.getSubShapes("edge"));
}

/** The surface the kernel stores for the face, by its adaptor's name. */
function storedSurface(face: Face): string {
  const oc = getOC();
  const typed = oc.TopoDS.Face(face.getShape());
  const adaptor = new oc.BRepAdaptor_Surface(typed, true);
  try {
    const type = adaptor.GetType();
    const named = Object.entries(oc.GeomAbs_SurfaceType).find(([, value]) => value === type);
    return named ? named[0].replace("GeomAbs_", "") : "unknown";
  } finally {
    adaptor.delete();
    typed.delete();
  }
}

/** A scene holding every kind of free-form face the helpers build. */
function everyFreeformBody(): Scene {
  FreeformBodies.filletedSlab();
  FreeformBodies.ellipseLoft(200);
  FreeformBodies.revolvedSpline();
  return render();
}

describe("a shape's extent along a plane's normal", () => {
  setupOC();

  describe("ShapeOps.extentAlong", () => {
    it("measures a face once for every plane along the three world axes", () => {
      FreeformBodies.filletedSlab();
      const fillets = facesOf(render()).filter(face => SurfaceClassifier.classify(face).kind === "freeform");
      expect(fillets).toHaveLength(6);
      const face = fillets[0];

      const box = vi.spyOn(ShapeOps, "getExactBoundingBoxRaw");
      const framed = vi.spyOn(ShapeOps, "extentAlongRaw");
      try {
        const planes = [
          Plane.fromPointAndNormal(new Point(0, 0, 0), new Vector3d(0, 0, 1)),
          Plane.fromPointAndNormal(new Point(3, -4, 7.5), new Vector3d(0, 0, 1)),
          Plane.fromPointAndNormal(new Point(0, 0, -2), new Vector3d(0, 0, -1)),
          Plane.fromPointAndNormal(new Point(0, 11, 0), new Vector3d(0, -1, 0)),
          Plane.fromPointAndNormal(new Point(-6, 0, 0), new Vector3d(1, 0, 0)),
        ];
        const read = planes.map(plane => ShapeOps.extentAlong(face, plane));
        expect(box).toHaveBeenCalledTimes(1);
        expect(framed).not.toHaveBeenCalled();

        planes.forEach((plane, i) => {
          const measured = ShapeOps.extentAlongRaw(face.getShape(), plane);
          expect(read[i].min).toBeCloseTo(measured.min, 9);
          expect(read[i].max).toBeCloseTo(measured.max, 9);
        });
      } finally {
        box.mockRestore();
        framed.mockRestore();
      }
    });

    it("measures a face once for every plane sharing a tilted normal", () => {
      FreeformBodies.ellipseLoft();
      const wall = facesOf(render()).find(face => SurfaceClassifier.classify(face).kind === "freeform")!;

      const framed = vi.spyOn(ShapeOps, "extentAlongRaw");
      try {
        for (const normal of TILTED) {
          framed.mockClear();
          const planes = [0, 12.5, -40].map(d => Plane.fromPointAndNormal(new Point(d, 2 * d, -d), normal));
          const read = planes.map(plane => ShapeOps.extentAlong(wall, plane));
          expect(framed).toHaveBeenCalledTimes(1);

          planes.forEach((plane, i) => {
            const measured = ShapeOps.extentAlongRaw(wall.getShape(), plane);
            expect(read[i].min).toBeCloseTo(measured.min, 9);
            expect(read[i].max).toBeCloseTo(measured.max, 9);
          });
        }
      } finally {
        framed.mockRestore();
      }
    });
  });

  describe("the control hull", () => {
    it("is given for faces on B-spline surfaces, and for nothing else", () => {
      const scene = everyFreeformBody();
      const hulled = new Map<string, boolean[]>();
      for (const face of facesOf(scene)) {
        const stored = storedSurface(face);
        hulled.set(stored, [...(hulled.get(stored) ?? []), ShapeOps.controlHullRaw(face.getShape()) !== null]);
      }
      // Six fillets along the splines and the loft's wall.
      expect(hulled.get("BSplineSurface")).toEqual(Array(7).fill(true));
      for (const stored of ["Plane", "Cylinder", "SurfaceOfExtrusion", "SurfaceOfRevolution"]) {
        expect(hulled.get(stored)!.length, stored).toBeGreaterThan(0);
        expect(hulled.get(stored)!.every(has => !has), stored).toBe(true);
      }
      for (const edge of edgesOf(scene)) {
        expect(ShapeOps.controlHullRaw(edge.getShape())).toBeNull();
      }
    });

    it("is given for the offset of a B-spline surface a shell leaves inside a fillet", () => {
      FreeformBodies.shelledSlab();
      const offsets = facesOf(render()).filter(face => storedSurface(face) === "OffsetSurface");
      expect(offsets.length).toBeGreaterThan(0);
      for (const face of offsets) {
        expect(ShapeOps.controlHullRaw(face.getShape())).not.toBeNull();
      }
    });

    it("is not given for a face read past its surface's own parameters, where the kernel samples a grid", () => {
      const oc = getOC();
      const frame = new oc.gp_Ax3();
      const cylinder = new oc.Geom_CylindricalSurface(frame, 5) as unknown as Geom_Surface;
      const band = new oc.Geom_RectangularTrimmedSurface(cylinder, 0, 10, false, true);
      // Closed and periodic in u, over [0, 2π].
      const periodic = oc.GeomConvert.SurfaceToBSplineSurface(band) as unknown as Geom_Surface;
      const faceOver = (u1: number, u2: number) => {
        const maker = new oc.BRepBuilderAPI_MakeFace(periodic, u1, u2, 0, 10, 1e-6);
        const face = maker.Face();
        maker.delete();
        return face;
      };
      const within = faceOver(1, 3);
      const past = faceOver(5, 8);
      try {
        expect(ShapeOps.controlHullRaw(within)).not.toBeNull();
        expect(ShapeOps.controlHullRaw(past)).toBeNull();
      } finally {
        for (const owned of [past, within, periodic, band, cylinder, frame]) {
          owned.delete();
        }
      }
    });

    it.each([
      ["fillets along splines, a loft's wall", everyFreeformBody, 7],
      ["a shelled body's offset faces", () => { FreeformBodies.shelledSlab(); return render(); }, 17],
    ])("encloses the exact extent of every face it is given for, from any plane: %s", (_name, build, expected) => {
      // The exact extent is padded by the kernel's confusion tolerance; the hull is not.
      const padding = getOC().Precision.Confusion();
      const origin = new Point(4, -9, 6);
      const normals = [new Vector3d(1, 0, 0), new Vector3d(0, -1, 0), new Vector3d(0, 0, 1), ...TILTED];
      let hulled = 0;
      for (const face of facesOf(build())) {
        if (!ShapeOps.controlHullRaw(face.getShape())) {
          expect(ShapeOps.outerExtentAlong(face, XY)).toBeNull();
          continue;
        }
        hulled++;
        for (const normal of normals) {
          const plane = Plane.fromPointAndNormal(origin, normal);
          const outer = ShapeOps.outerExtentAlong(face, plane)!;
          const exact = ShapeOps.extentAlong(face, plane);
          expect(outer.min).toBeLessThanOrEqual(exact.min + padding);
          expect(outer.max).toBeGreaterThanOrEqual(exact.max - padding);
        }
      }
      expect(hulled).toBe(expected);
    });
  });
});
