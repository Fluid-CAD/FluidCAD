import { describe, expect, it } from "vitest";
import type { Geom_Surface, TopoDS_Face, TopoDS_Shape } from "ocjs-fluidcad";
import { setupOC, render } from "../setup.js";
import { getOC } from "../../oc/init.js";
import { Explorer } from "../../oc/explorer.js";
import { SurfaceClass, SurfaceClassifier, SurfaceKind } from "../../oc/surface-classifier.js";
import { Face } from "../../common/face.js";
import { Solid } from "../../common/solid.js";
import { SceneObject } from "../../common/scene-object.js";
import { Point } from "../../math/point.js";
import { sketch, line, loft, plane, extrude, revolve, circle, ellipse, spline, fillet } from "../../core/index.js";

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

/** A frame at (1, 2, 3) whose axis runs along `direction`. */
function frame(own: Own, direction: [number, number, number]) {
  const oc = getOC();
  return own(new oc.gp_Ax3(own(new oc.gp_Pnt(1, 2, 3)), own(new oc.gp_Dir(...direction))));
}

/** A face on the `[u1, u2] × [v1, v2]` patch of `surface`, stored as a B-spline surface. */
function bsplineFace(own: Own, surface: Geom_Surface, u1: number, u2: number, v1: number, v2: number): TopoDS_Face {
  const oc = getOC();
  const patch = own(new oc.Geom_RectangularTrimmedSurface(surface, u1, u2, v1, v2, true, true));
  const bspline = own(oc.GeomConvert.SurfaceToBSplineSurface(patch)) as unknown as Geom_Surface;
  const face = own(own(new oc.BRepBuilderAPI_MakeFace(bspline, 1e-6)).Face());
  expect(nativeType(face)).toBe(oc.GeomAbs_SurfaceType.GeomAbs_BSplineSurface);
  return face;
}

function nativeType(face: TopoDS_Shape) {
  const oc = getOC();
  const typed = oc.TopoDS.Face(face);
  const adaptor = new oc.BRepAdaptor_Surface(typed, true);
  const type = adaptor.GetType();
  adaptor.delete();
  typed.delete();
  return type;
}

function kindsOf(shape: TopoDS_Shape): SurfaceKind[] {
  const oc = getOC();
  return Explorer.withShapes(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE as any, faces =>
    faces.map(face => SurfaceClassifier.classifyRaw(face).kind));
}

function facesOf(obj: SceneObject): Face[] {
  return (obj.getShapes()[0] as Solid).getFaces();
}

function expectAxis(surface: SurfaceClass, direction: [number, number, number]) {
  expect(surface.axis).toBeDefined();
  const axis = surface.axis!;
  const [x, y, z] = direction;
  expect(Math.abs(axis.direction.x * x + axis.direction.y * y + axis.direction.z * z)).toBeCloseTo(1, 6);
  // The axis passes through the frame's origin.
  const offset = new Point(1, 2, 3).subtract(axis.origin).toVector3d();
  expect(offset.cross(axis.direction.normalize()).length()).toBeLessThan(1e-6);
}

describe("SurfaceClassifier", () => {
  setupOC();

  it("reads the native kinds", () => {
    const oc = getOC();
    withOwned(own => {
      const box = own(own(new oc.BRepPrimAPI_MakeBox(10, 10, 10)).Shape());
      expect(new Set(kindsOf(box))).toEqual(new Set(["plane"]));
      const cylinder = own(own(new oc.BRepPrimAPI_MakeCylinder(4, 10)).Shape());
      expect(kindsOf(cylinder).sort()).toEqual(["cylinder", "plane", "plane"]);
      const cone = own(own(new oc.BRepPrimAPI_MakeCone(4, 2, 10)).Shape());
      expect(kindsOf(cone).sort()).toEqual(["cone", "plane", "plane"]);
      const sphere = own(own(new oc.BRepPrimAPI_MakeSphere(6)).Shape());
      expect(kindsOf(sphere)).toEqual(["sphere"]);
      const torus = own(own(new oc.BRepPrimAPI_MakeTorus(10, 2)).Shape());
      expect(kindsOf(torus)).toEqual(["torus"]);
    });
  });

  it("reports a native face as not recovered, with its area", () => {
    const oc = getOC();
    withOwned(own => {
      const box = own(own(new oc.BRepPrimAPI_MakeBox(10, 20, 30)).Shape());
      const faces = Explorer.findShapes(box, oc.TopAbs_ShapeEnum.TopAbs_FACE).map(own);
      const surface = SurfaceClassifier.classifyRaw(faces[0]);
      expect(surface.kind).toBe("plane");
      expect(surface.recovered).toBe(false);
      expect(surface.areaMm2).toBeCloseTo(600, 6);
    });
  });

  describe("recovery from B-spline surfaces", () => {
    it("recovers a plane", () => {
      const oc = getOC();
      withOwned(own => {
        const surface = own(new oc.Geom_Plane(frame(own, [0, 0, 1]))) as unknown as Geom_Surface;
        const cls = SurfaceClassifier.classifyRaw(bsplineFace(own, surface, 0, 10, 0, 5));
        expect(cls.kind).toBe("plane");
        expect(cls.recovered).toBe(true);
        expect(Math.abs(cls.normal!.z)).toBeCloseTo(1, 9);
        expect(cls.origin!.z).toBeCloseTo(3, 6);
        expect(cls.areaMm2).toBeCloseTo(50, 6);
      });
    });

    it("recovers a cylinder with its radius and axis", () => {
      const oc = getOC();
      withOwned(own => {
        const direction: [number, number, number] = [0, 0.6, 0.8];
        const surface = own(new oc.Geom_CylindricalSurface(frame(own, direction), 4)) as unknown as Geom_Surface;
        const cls = SurfaceClassifier.classifyRaw(bsplineFace(own, surface, 0, Math.PI, 0, 10));
        expect(cls.kind).toBe("cylinder");
        expect(cls.recovered).toBe(true);
        expect(cls.radius).toBeCloseTo(4, 6);
        expectAxis(cls, direction);
      });
    });

    it("recovers a cone with its axis and half-angle", () => {
      const oc = getOC();
      withOwned(own => {
        const surface = own(new oc.Geom_ConicalSurface(frame(own, [1, 0, 0]), 0.3, 4)) as unknown as Geom_Surface;
        const cls = SurfaceClassifier.classifyRaw(bsplineFace(own, surface, 0, Math.PI, 0, 10));
        expect(cls.kind).toBe("cone");
        expect(cls.recovered).toBe(true);
        expect(Math.abs(cls.semiAngle!)).toBeCloseTo(0.3, 6);
        expectAxis(cls, [1, 0, 0]);
      });
    });

    it("recovers a sphere with its radius and centre", () => {
      const oc = getOC();
      withOwned(own => {
        const surface = own(new oc.Geom_SphericalSurface(frame(own, [0, 0, 1]), 6)) as unknown as Geom_Surface;
        const cls = SurfaceClassifier.classifyRaw(bsplineFace(own, surface, 0, Math.PI, -1, 1));
        expect(cls.kind).toBe("sphere");
        expect(cls.recovered).toBe(true);
        expect(cls.radius).toBeCloseTo(6, 6);
        expect(cls.center!.distanceTo(new Point(1, 2, 3))).toBeLessThan(1e-6);
      });
    });

    it("recovers a torus with its radii and axis", () => {
      const oc = getOC();
      withOwned(own => {
        const surface = own(new oc.Geom_ToroidalSurface(frame(own, [0, 1, 0]), 10, 2)) as unknown as Geom_Surface;
        const cls = SurfaceClassifier.classifyRaw(bsplineFace(own, surface, 0, Math.PI, 0, Math.PI));
        expect(cls.kind).toBe("torus");
        expect(cls.recovered).toBe(true);
        expect(cls.majorRadius).toBeCloseTo(10, 6);
        expect(cls.minorRadius).toBeCloseTo(2, 6);
        expectAxis(cls, [0, 1, 0]);
      });
    });
  });

  it("recovers the flat walls and round corners of a loft", () => {
    const rounded = (z: number) => sketch(plane("xy", z), () => {
      const b = line([-11, -8], [11, -8]);
      const r = line([11, -8], [11, 8]);
      const t = line([11, 8], [-11, 8]);
      const l = line([-11, 8], [-11, -8]);
      fillet(4, b, r, t, l);
    });
    const lofted = loft(rounded(0), rounded(20)) as unknown as SceneObject;
    render();
    const classes = facesOf(lofted).map(face => SurfaceClassifier.classify(face));
    const walls = classes.filter(c => c.recovered);
    expect(walls.filter(c => c.kind === "plane")).toHaveLength(4);
    const corners = walls.filter(c => c.kind === "cylinder");
    expect(corners).toHaveLength(4);
    for (const corner of corners) {
      expect(corner.radius).toBeCloseTo(4, 6);
      expect(Math.abs(corner.axis!.direction.z)).toBeCloseTo(1, 9);
    }
    // The end caps are native planes.
    expect(classes.filter(c => c.kind === "plane" && !c.recovered)).toHaveLength(2);
  });

  it("calls a loft wall that is no elementary surface free-form", () => {
    const base = sketch(plane("xy", 0), () => {
      circle([0, 0], 20);
    });
    const top = sketch(plane("xy", 30), () => {
      ellipse([0, 0], 5, 9);
    });
    const lofted = loft(base, top) as unknown as SceneObject;
    render();
    const kinds = facesOf(lofted).map(face => SurfaceClassifier.classify(face).kind).sort();
    expect(kinds).toEqual(["freeform", "plane", "plane"]);
  });

  it("calls a revolved spline profile revolved, with its axis", () => {
    sketch("xz", () => {
      line([0, 0], [10, 0]);
      spline([10, 0], [14, 5], [9, 10], [13, 15]);
      line([13, 15], [0, 15]);
      line([0, 15], [0, 0]);
    });
    const revolved = revolve("z") as unknown as SceneObject;
    render();
    const classes = facesOf(revolved).map(face => SurfaceClassifier.classify(face));
    const wall = classes.find(c => c.kind === "revolved");
    expect(wall).toBeDefined();
    expect(wall!.recovered).toBe(false);
    expect(Math.abs(wall!.axis!.direction.z)).toBeCloseTo(1, 9);
    expect(classes.filter(c => c.kind === "plane")).toHaveLength(2);
  });

  it("calls an extruded spline extruded", () => {
    sketch("xy", () => {
      line([0, 0], [10, 0]);
      spline([10, 0], [14, 5], [9, 10], [13, 15]);
      line([13, 15], [0, 15]);
      line([0, 15], [0, 0]);
    });
    const extruded = extrude(10) as unknown as SceneObject;
    render();
    const kinds = facesOf(extruded).map(face => SurfaceClassifier.classify(face).kind);
    expect(kinds.filter(k => k === "extruded")).toHaveLength(1);
    expect(kinds.filter(k => k === "plane")).toHaveLength(5);
  });

  it("keeps a wrapper's class", () => {
    const oc = getOC();
    withOwned(own => {
      const box = own(own(new oc.BRepPrimAPI_MakeBox(10, 10, 10)).Shape());
      const raw = Explorer.findShapes(box, oc.TopAbs_ShapeEnum.TopAbs_FACE).map(own)[0];
      const face = Face.fromTopoDSFace(oc.TopoDS.Face(raw));
      expect(SurfaceClassifier.classify(face)).toBe(SurfaceClassifier.classify(face));
    });
  });
});
