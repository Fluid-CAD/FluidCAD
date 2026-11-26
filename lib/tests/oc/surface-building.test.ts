import { describe, expect, it } from "vitest";
import type { Geom_Surface, TopoDS_Face } from "ocjs-fluidcad";
import { setupOC, render } from "../setup.js";
import { getOC } from "../../oc/init.js";
import { SurfaceClassifier } from "../../oc/surface-classifier.js";
import { FaceOps } from "../../oc/face-ops.js";
import { FaceQuery } from "../../oc/face-query.js";
import { classifyContactShape } from "../../oc/contact-classify.js";
import { resolveHelixFaceSource } from "../../features/helix-geometry.js";
import { Face } from "../../common/face.js";
import { Solid } from "../../common/solid.js";
import { SceneObject } from "../../common/scene-object.js";
import { sketch, line, loft, plane, circle, fillet, cut } from "../../core/index.js";

type Bound = { delete(): void };
type Own = <B extends Bound>(object: B) => B;

/** Runs `fn` with an `own` that records every object it is handed, and frees them all, last first. */
function withOwned<T>(fn: (own: Own) => T): T {
  const owned: Bound[] = [];
  const own = <B extends Bound>(object: B): B => {
    owned.push(object);
    return object;
  };
  try {
    return fn(own);
  } finally {
    for (const object of owned.reverse()) {
      object.delete();
    }
  }
}

/**
 * A Bezier sheet over `[-halfX, halfX] × [-halfY, halfY]`, a parabola across
 * x: z is `sag` along the two x ends and 0 down the middle, so the plane
 * nearest to it lies `sag / 2` from it.
 */
function sheet(own: Own, halfX: number, halfY: number, sag: number): Face {
  const oc = getOC();
  const poles = own(new oc.NCollection_Array2_gp_Pnt(1, 3, 1, 2));
  const xs = [-halfX, 0, halfX];
  const zs = [sag, -sag, sag];
  for (let i = 0; i < 3; i++) {
    poles.SetValue(i + 1, 1, own(new oc.gp_Pnt(xs[i], -halfY, zs[i])));
    poles.SetValue(i + 1, 2, own(new oc.gp_Pnt(xs[i], halfY, zs[i])));
  }
  const surface = own(new oc.Geom_BezierSurface(poles)) as unknown as Geom_Surface;
  return Face.fromTopoDSFace(own(own(new oc.BRepBuilderAPI_MakeFace(surface, 1e-6)).Face()));
}

function facesOf(obj: unknown): Face[] {
  return ((obj as SceneObject).getShapes()[0] as Solid).getFaces();
}

function roundedLoft(): Face[] {
  const rounded = (z: number) => sketch(plane("xy", z), () => {
    const b = line([-11, -8], [11, -8]);
    const r = line([11, -8], [11, 8]);
    const t = line([11, 8], [-11, 8]);
    const l = line([-11, 8], [-11, -8]);
    fillet(4, b, r, t, l);
  });
  const lofted = loft(rounded(0), rounded(20));
  render();
  return facesOf(lofted);
}

/**
 * Naming a face and building on it are two questions. A filter, a property
 * or a measurement may call a B-spline face a plane or a cylinder when it
 * matches within 1e-3 mm; a feature takes that plane or axis to construct
 * geometry only when it matches within 1e-4 mm.
 */
describe("building on a recovered surface", () => {
  setupOC();

  it("holds the two tolerances a decade apart", () => {
    expect(SurfaceClassifier.tolerance()).toBeCloseTo(1e-3, 12);
    expect(SurfaceClassifier.buildingTolerance()).toBeCloseTo(1e-4, 12);
  });

  it("records no gap on a native surface, and nothing it would be without recovery", () => {
    const oc = getOC();
    withOwned(own => {
      const cylinder = own(own(new oc.BRepPrimAPI_MakeCylinder(4, 10)).Shape());
      const faces = own(new oc.TopExp_Explorer(cylinder, oc.TopAbs_ShapeEnum.TopAbs_FACE as any, oc.TopAbs_ShapeEnum.TopAbs_SHAPE as any));
      const surface = SurfaceClassifier.classifyRaw(own(faces.Current()));
      expect(surface.recovered).toBe(false);
      expect(surface.gap).toBe(0);
      expect(surface.unrecovered).toBeUndefined();
      expect(SurfaceClassifier.buildingOf(surface)).toBe(surface);
      expect(SurfaceClassifier.buildingRefusal(surface)).toBeNull();
    });
  });

  it("keeps FluidCAD's own lofted walls buildable, eight decades inside the tolerance", () => {
    const faces = roundedLoft();
    const walls = faces.filter(f => SurfaceClassifier.classify(f).recovered);
    expect(walls).toHaveLength(8);
    for (const wall of walls) {
      const named = SurfaceClassifier.classify(wall);
      expect(named.gap).toBeLessThan(1e-12);
      expect(named.unrecovered?.kind).toBe("freeform");
      expect(SurfaceClassifier.forBuilding(wall)).toBe(named);
      expect(FaceQuery.forBuilding.surfaceType(wall)).toBe(named.kind);
    }
  });

  it("gives the plane of every face it calls planar, facing out of the body", () => {
    // A flat loft wall is a B-spline: planar() and getPlane() once disagreed on it.
    const faces = roundedLoft();
    const planar = faces.filter(f => FaceQuery.isPlanarFace(f));
    expect(planar).toHaveLength(6);
    for (const face of planar) {
      expect(FaceQuery.forBuilding.isPlanar(face)).toBe(true);
      const facePlane = face.getPlane();
      expect(facePlane.normal.dot(FaceQuery.meanNormal(face)!)).toBeCloseTo(1, 9);
      expect(FaceOps.tryGetPlane(face)!.normal.dot(facePlane.normal)).toBeCloseTo(1, 12);
    }
    const curved = faces.filter(f => !FaceQuery.isPlanarFace(f));
    for (const face of curved) {
      expect(FaceOps.tryGetPlane(face)).toBeNull();
      expect(() => face.getPlane()).toThrow("Face is not planar");
    }
  });

  it("reads a recovered wall's cylinder for OCCT off its class", () => {
    const corners = roundedLoft().filter(f => SurfaceClassifier.classify(f).kind === "cylinder");
    expect(corners).toHaveLength(4);
    withOwned(own => {
      for (const corner of corners) {
        const cylinder = own(FaceQuery.gpCylinderOf(corner));
        expect(cylinder.Radius()).toBeCloseTo(4, 9);
        const axis = own(cylinder.Axis());
        expect(Math.abs(own(axis.Direction()).Z())).toBeCloseTo(1, 12);
        expect(() => FaceQuery.gpPlaneOf(corner)).toThrow("not a plane");
        const axial = FaceOps.axialSurfaceAxis(corner);
        expect(Math.abs(axial!.direction.z)).toBeCloseTo(1, 12);
      }
    });
  });

  it("rebuilds a left-handed frame as it was stored", () => {
    const oc = getOC();
    withOwned(own => {
      const frame = own(new oc.gp_Ax3(own(new oc.gp_Pnt(1, 2, 3)), own(new oc.gp_Dir(0, 0.6, 0.8)), own(new oc.gp_Dir(1, 0, 0))));
      frame.YReverse();
      expect(frame.Direct()).toBe(false);
      const surface = own(new oc.Geom_CylindricalSurface(frame, 5)) as unknown as Geom_Surface;
      const face = own(own(new oc.BRepBuilderAPI_MakeFace(surface, 0, Math.PI, 0, 10, 1e-6)).Face());
      const classified = SurfaceClassifier.classifyRaw(face);
      expect(classified.placement!.direct).toBe(false);
      const rebuilt = own(SurfaceClassifier.gpCylinder(classified));
      const position = own(rebuilt.Position());
      expect(position.Direct()).toBe(false);
      expect(rebuilt.Radius()).toBe(5);
      const stored = own(frame.YDirection());
      const y = own(position.YDirection());
      expect(y.X() * stored.X() + y.Y() * stored.Y() + y.Z() * stored.Z()).toBeCloseTo(1, 12);
      expect(own(position.Location()).Z()).toBe(3);
    });
  });

  it("names a shallow sheet a cylinder and does not build on it", () => {
    withOwned(own => {
      // 40 mm wide, 1 mm deep: a cylinder of about r = 200 passes within 5e-4 mm.
      const face = sheet(own, 20, 20, 1);
      const named = SurfaceClassifier.classify(face);
      expect(named.kind).toBe("cylinder");
      expect(named.recovered).toBe(true);
      expect(named.gap).toBeGreaterThan(SurfaceClassifier.buildingTolerance());
      expect(named.gap).toBeLessThanOrEqual(SurfaceClassifier.tolerance());
      expect(named.unrecovered).toMatchObject({ kind: "freeform", recovered: false, gap: 0 });

      expect(SurfaceClassifier.forBuilding(face)).toBe(named.unrecovered);
      expect(FaceQuery.getSurfaceType(face)).toBe("cylinder");
      expect(FaceQuery.forBuilding.surfaceType(face)).toBe("other");
      expect(FaceQuery.isSameSurface(face, face)).toBe(true);
      expect(FaceQuery.forBuilding.isSameSurface(face, face)).toBe(false);
      expect(FaceOps.axialSurfaceAxis(face)).toBeNull();
      expect(() => FaceQuery.gpCylinderOf(face)).toThrow("not a cylinder");
      expect(() => resolveHelixFaceSource(face)).toThrow("must be cylindrical or conical");
      expect(classifyContactShape(face)).toBeNull();
      expect(SurfaceClassifier.buildingRefusal(named)).toMatch(/^The face is a cylinder within 0\.000\d+ mm but not close enough to one to build on: it must match within 0\.0001 mm\.$/);
    });
  });

  it("shares one area between a face's two classes", () => {
    withOwned(own => {
      const named = SurfaceClassifier.classify(sheet(own, 20, 20, 1));
      expect(named.unrecovered!.areaMm2).toBe(named.areaMm2);
      expect(named.areaMm2).toBeGreaterThan(1600);
    });
  });

  it("names a nearly flat patch planar, and says why it will not build on it", () => {
    withOwned(own => {
      // 1 mm square, 6e-4 mm deep: flat within 3e-4 mm.
      const face = sheet(own, 0.5, 0.5, 6e-4);
      expect(FaceQuery.isPlanarFace(face)).toBe(true);
      expect(FaceQuery.forBuilding.isPlanar(face)).toBe(false);
      expect(FaceOps.tryGetPlane(face)).toBeNull();
      expect(() => face.getPlane()).toThrow(/^The face is flat within 0\.0003 mm but not flat enough to build on: it must be flat within 0\.0001 mm\.$/);
      expect(() => FaceQuery.getSurfacePlane(face)).toThrow("not a plane");
    });
  });

  it("builds on a patch that is flat within the building tolerance", () => {
    withOwned(own => {
      // 1 mm square, 5e-5 mm deep: flat within 2.5e-5 mm.
      const face = sheet(own, 0.5, 0.5, 5e-5);
      expect(SurfaceClassifier.classify(face).gap).toBeLessThan(SurfaceClassifier.buildingTolerance());
      expect(FaceQuery.forBuilding.isPlanar(face)).toBe(true);
      expect(Math.abs(face.getPlane().normal.z)).toBeCloseTo(1, 9);
      expect(Math.abs(FaceQuery.getSurfacePlane(face).normal.z)).toBeCloseTo(1, 9);
    });
  });

  it("reads a recovered cylinder's extent along its axis exactly on a slanted cut", () => {
    // A lofted r = 10 cylinder, 40 tall, cut off along the plane z = x + 20:
    // the wall runs from z = 0 up to z = 30 at x = 10. Points sampled along
    // the slanted rim stop short of that top.
    const base = sketch(plane("xy", 0), () => { circle([0, 0], 20); });
    const top = sketch(plane("xy", 40), () => { circle([0, 0], 20); });
    loft(base, top);
    sketch("xz", () => {
      line([-15, 5], [15, 35]);
      line([15, 35], [15, 60]);
      line([15, 60], [-15, 60]);
      line([-15, 60], [-15, 5]);
    });
    const slanted = cut().symmetric();
    render();
    const wall = facesOf(slanted).find(f => SurfaceClassifier.classify(f).kind === "cylinder")!;
    expect(SurfaceClassifier.classify(wall).recovered).toBe(true);
    const { vMin, vMax } = FaceQuery.getSurfaceVBounds(wall);
    expect(vMax - vMin).toBeCloseTo(30, 5);
    const source = resolveHelixFaceSource(wall);
    expect(source.kind).toBe("cylinder-face");
  });
});
