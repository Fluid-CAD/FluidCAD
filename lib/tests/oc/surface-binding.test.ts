import { describe, expect, it } from "vitest";
import type {
  BRepAlgoAPI_Algo,
  Geom_Curve,
  Geom_Surface,
  GeomAbs_Shape,
  OpenCascadeInstance,
  TopoDS_Compound,
  TopoDS_Edge,
  TopoDS_Face,
  TopoDS_Shape,
  TopoDS_Shell,
  TopoDS_Wire,
  gp_Dir,
  gp_Pnt,
  gp_Pnt2d,
} from "ocjs-fluidcad";
import { setupOC } from "../setup.js";
import { getOC } from "../../oc/init.js";
import { BooleanBuilders } from "../../oc/boolean-builders.js";
import { Explorer } from "../../oc/explorer.js";
import { ShapeProps } from "../../oc/props.js";

/*
 * The kernel classes the curve and surface tools are built on, each called
 * once through the overload the engine uses.
 *
 * A registry install of the binding can predate these classes, and lib/tests
 * compiles with the library, so their surface is declared here as the
 * generated declarations give it rather than read from the installed ones.
 * `surfaceKernel()` then fails every case by naming what is missing, instead
 * of a bare "is not a constructor".
 */

type Bound = { delete(): void };

interface Projection extends Bound {
  IsDone(): boolean;
  Init(): void;
  More(): boolean;
  Next(): void;
  Current(): TopoDS_Wire;
  Shape(): TopoDS_Compound;
}

interface Defeaturing extends BRepAlgoAPI_Algo {
  SetShape(shape: TopoDS_Shape): void;
  AddFaceToRemove(face: TopoDS_Shape): void;
  SetToFillHistory(flag: boolean): void;
}

interface SurfToAnaSurf extends Bound {
  ConvertToAnalytical(tolerance: number, uMin: number, uMax: number, vMin: number, vMax: number): Geom_Surface | null;
  Gap(): number;
}

interface SurfaceAnalysis extends Bound {
  ValueOfUV(point: gp_Pnt, precision: number): gp_Pnt2d;
  Value(u: number, v: number): gp_Pnt;
  Gap(): number;
}

interface CurveProps extends Bound {
  IsTangentDefined(): boolean;
  Tangent(direction: gp_Dir): void;
  Curvature(): number;
}

interface Continuity extends Bound {
  IsDone(): boolean;
  IsC0(): boolean;
  IsG1(): boolean;
  C0Value(): number;
  G1Angle(): number;
}

type SurfaceKernel = OpenCascadeInstance & {
  BRepProj_Projection: new (wire: TopoDS_Shape, shape: TopoDS_Shape, direction: gp_Dir) => Projection;
  BRepAlgoAPI_Defeaturing: new () => Defeaturing;
  GeomConvert_SurfToAnaSurf: {
    new (surface: Geom_Surface): SurfToAnaSurf;
    IsCanonical(surface: Geom_Surface): boolean;
  };
  BRepFill: {
    Face(first: TopoDS_Edge, second: TopoDS_Edge): TopoDS_Face;
    Shell(first: TopoDS_Wire, second: TopoDS_Wire): TopoDS_Shell;
  };
  ShapeAnalysis_Surface: new (surface: Geom_Surface) => SurfaceAnalysis;
  GeomLProp_CLProps: new (curve: Geom_Curve, u: number, derivatives: number, resolution: number) => CurveProps;
  LocalAnalysis_CurveContinuity: new (
    first: Geom_Curve, u1: number, second: Geom_Curve, u2: number, order: GeomAbs_Shape,
  ) => Continuity;
  LocalAnalysis_SurfaceContinuity: new (
    first: Geom_Surface, u1: number, v1: number, second: Geom_Surface, u2: number, v2: number, order: GeomAbs_Shape,
    epsNul: number,
  ) => Continuity;
  LocalAnalysis_StatusErrorType: Record<string, string>;
};

const CLASSES = [
  "BRepProj_Projection",
  "BRepAlgoAPI_Defeaturing",
  "GeomConvert_SurfToAnaSurf",
  "BRepFill",
  "ShapeAnalysis_Surface",
  "GeomLProp_CLProps",
  "LocalAnalysis_CurveContinuity",
  "LocalAnalysis_SurfaceContinuity",
] as const;

function missingClasses(oc: OpenCascadeInstance): string[] {
  const all = oc as unknown as Record<string, unknown>;
  const missing: string[] = CLASSES.filter((name) => typeof all[name] !== "function");
  if (typeof all.LocalAnalysis_StatusErrorType !== "object" || all.LocalAnalysis_StatusErrorType === null) {
    missing.push("LocalAnalysis_StatusErrorType");
  }
  return missing;
}

function surfaceKernel(): SurfaceKernel {
  const oc = getOC();
  const missing = missingClasses(oc);
  if (missing.length > 0) {
    throw new Error(
      `ocjs-fluidcad lacks ${missing.join(", ")}. FluidCAD needs a binding built with them: `
      + `link the local build (npm link ocjs-fluidcad) or install a release that has them.`,
    );
  }
  return oc as SurfaceKernel;
}

/** Runs `fn` with an `own` that records every object it is handed, and frees them all, last first. */
function withOwned<T>(fn: (own: <B extends Bound>(object: B) => B) => T): T {
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

function length(oc: OpenCascadeInstance, shape: TopoDS_Shape): number {
  const props = new oc.GProp_GProps();
  try {
    oc.BRepGProp.LinearProperties(shape, props, false, false);
    return props.Mass();
  } finally {
    props.delete();
  }
}

function centreZ(oc: OpenCascadeInstance, shape: TopoDS_Shape): number {
  const props = new oc.GProp_GProps();
  try {
    oc.BRepGProp.SurfaceProperties(shape, props, false, false);
    const centre = props.CentreOfMass();
    const z = centre.Z();
    centre.delete();
    return z;
  } finally {
    props.delete();
  }
}

function surfaceType(oc: OpenCascadeInstance, face: TopoDS_Shape) {
  const cast = oc.TopoDS.Face(face);
  const adaptor = new oc.BRepAdaptor_Surface(cast, true);
  try {
    return adaptor.GetType();
  } finally {
    adaptor.delete();
    cast.delete();
  }
}

/** A plane through `origin` with normal `normal`, its u axis along `xAxis`. */
function plane(oc: OpenCascadeInstance, own: <B extends Bound>(o: B) => B, origin: number[], normal: number[], xAxis: number[]) {
  const frame = own(new oc.gp_Ax3(
    own(new oc.gp_Pnt(origin[0], origin[1], origin[2])),
    own(new oc.gp_Dir(normal[0], normal[1], normal[2])),
    own(new oc.gp_Dir(xAxis[0], xAxis[1], xAxis[2])),
  ));
  return own(new oc.Geom_Plane(frame));
}

function segment(oc: OpenCascadeInstance, own: <B extends Bound>(o: B) => B, from: number[], to: number[]) {
  const maker = own(new oc.GC_MakeSegment(
    own(new oc.gp_Pnt(from[0], from[1], from[2])),
    own(new oc.gp_Pnt(to[0], to[1], to[2])),
  ));
  return own(maker.Value());
}

function edge(oc: OpenCascadeInstance, own: <B extends Bound>(o: B) => B, from: number[], to: number[]): TopoDS_Edge {
  const maker = own(new oc.BRepBuilderAPI_MakeEdge(
    own(new oc.gp_Pnt(from[0], from[1], from[2])),
    own(new oc.gp_Pnt(to[0], to[1], to[2])),
  ));
  return own(maker.Edge());
}

function square(oc: OpenCascadeInstance, own: <B extends Bound>(o: B) => B, side: number, z: number): TopoDS_Wire {
  const maker = own(new oc.BRepBuilderAPI_MakePolygon(
    own(new oc.gp_Pnt(0, 0, z)),
    own(new oc.gp_Pnt(side, 0, z)),
    own(new oc.gp_Pnt(side, side, z)),
    own(new oc.gp_Pnt(0, side, z)),
    true,
  ));
  return own(maker.Wire());
}

describe("surface modeling kernel classes", () => {
  setupOC();

  it("are linked into the binding", () => {
    expect(missingClasses(getOC())).toEqual([]);
  });

  it("projects a wire onto a face along a direction", () => {
    const oc = surfaceKernel();
    withOwned((own) => {
      const box = own(own(new oc.BRepPrimAPI_MakeBox(10, 10, 10)).Shape());
      const faces = Explorer.findShapes(box, oc.TopAbs_ShapeEnum.TopAbs_FACE).map(own);
      const top = faces.find((face) => Math.abs(centreZ(oc, face) - 10) < 1e-9);
      const above = edge(oc, own, [2, 5, 20], [8, 5, 20]);
      const wire = own(own(new oc.BRepBuilderAPI_MakeWire(above)).Wire());
      const down = own(new oc.gp_Dir(0, 0, -1));

      const projection = own(new oc.BRepProj_Projection(wire, top, down));
      expect(projection.IsDone()).toBe(true);
      const images: TopoDS_Wire[] = [];
      for (projection.Init(); projection.More(); projection.Next()) {
        images.push(own(projection.Current()));
      }
      expect(images).toHaveLength(1);
      expect(length(oc, images[0])).toBeCloseTo(6, 6);
    });
  });

  it("removes a fillet face and heals the box back", () => {
    const oc = surfaceKernel();
    withOwned((own) => {
      const box = own(own(new oc.BRepPrimAPI_MakeBox(10, 10, 10)).Shape());
      const edges = Explorer.findShapes(box, oc.TopAbs_ShapeEnum.TopAbs_EDGE).map(own);
      const fillet = own(new oc.BRepFilletAPI_MakeFillet(box));
      fillet.Add(2, own(oc.TopoDS.Edge(edges[0])));
      fillet.Build();
      const filleted = own(fillet.Shape());
      const faces = Explorer.findShapes(filleted, oc.TopAbs_ShapeEnum.TopAbs_FACE).map(own);
      expect(faces).toHaveLength(7);
      const round = faces.find((face) => surfaceType(oc, face) === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder);

      const defeaturing = new oc.BRepAlgoAPI_Defeaturing();
      try {
        defeaturing.SetShape(filleted);
        defeaturing.AddFaceToRemove(round);
        defeaturing.SetToFillHistory(true);
        defeaturing.Build();
        expect(defeaturing.IsDone()).toBe(true);
        expect(defeaturing.IsDeleted(round)).toBe(true);
        const healed = own(defeaturing.Shape());
        expect(Explorer.findShapes(healed, oc.TopAbs_ShapeEnum.TopAbs_SOLID).map(own)).toHaveLength(1);
        const healedFaces = Explorer.findShapes(healed, oc.TopAbs_ShapeEnum.TopAbs_FACE).map(own);
        expect(healedFaces).toHaveLength(6);
        expect(ShapeProps.getProperties(healed).volumeMm3).toBeCloseTo(1000, 6);
      } finally {
        BooleanBuilders.release(defeaturing);
      }
    });
  });

  it("recovers a cylinder stored as a B-spline surface", () => {
    const oc = surfaceKernel();
    withOwned((own) => {
      const axes = own(new oc.gp_Ax3());
      const cylinder = own(new oc.Geom_CylindricalSurface(axes, 4));
      const patch = own(new oc.Geom_RectangularTrimmedSurface(cylinder, 0, Math.PI, 0, 10));
      const bspline = own(oc.GeomConvert.SurfaceToBSplineSurface(patch));
      const { U1, U2, V1, V2 } = bspline.Bounds(0, 0, 0, 0);
      expect(oc.GeomConvert_SurfToAnaSurf.IsCanonical(bspline)).toBe(false);

      const tolerance = 1e-3;
      const converter = own(new oc.GeomConvert_SurfToAnaSurf(bspline));
      const recovered = converter.ConvertToAnalytical(tolerance, U1, U2, V1, V2);
      expect(recovered).not.toBeNull();
      own(recovered);
      expect(converter.Gap()).toBeLessThan(tolerance);
      expect(oc.GeomConvert_SurfToAnaSurf.IsCanonical(recovered)).toBe(true);
      const adaptor = own(new oc.GeomAdaptor_Surface(recovered));
      expect(adaptor.GetType()).toBe(oc.GeomAbs_SurfaceType.GeomAbs_Cylinder);
      expect(own(adaptor.Cylinder()).Radius()).toBeCloseTo(4, 6);
    });
  });

  it("builds exact ruled faces between two curves", () => {
    const oc = surfaceKernel();
    withOwned((own) => {
      const ruled = own(oc.BRepFill.Face(edge(oc, own, [0, 0, 0], [10, 0, 0]), edge(oc, own, [0, 5, 0], [10, 5, 0])));
      expect(ShapeProps.getProperties(ruled).surfaceAreaMm2).toBeCloseTo(50, 6);
      const finder = own(new oc.BRepBuilderAPI_FindPlane(ruled, 1e-7));
      expect(finder.Found()).toBe(true);
      own(finder.Plane());

      const shell = own(oc.BRepFill.Shell(square(oc, own, 10, 0), square(oc, own, 10, 5)));
      expect(shell.ShapeType()).toBe(oc.TopAbs_ShapeEnum.TopAbs_SHELL);
      const walls = Explorer.findShapes(shell, oc.TopAbs_ShapeEnum.TopAbs_FACE).map(own);
      expect(walls).toHaveLength(4);
      expect(ShapeProps.getProperties(shell).surfaceAreaMm2).toBeCloseTo(200, 6);
    });
  });

  it("finds the UV of a point on a cylinder", () => {
    const oc = surfaceKernel();
    withOwned((own) => {
      const cylinder = own(new oc.Geom_CylindricalSurface(own(new oc.gp_Ax3()), 5));
      const analysis = own(new oc.ShapeAnalysis_Surface(cylinder));
      const angle = Math.PI / 3;
      const point = own(new oc.gp_Pnt(5 * Math.cos(angle), 5 * Math.sin(angle), 3));

      const uv = own(analysis.ValueOfUV(point, 1e-7));
      expect(uv.X()).toBeCloseTo(angle, 9);
      expect(uv.Y()).toBeCloseTo(3, 9);
      expect(analysis.Gap()).toBeLessThan(1e-7);
      expect(own(analysis.Value(uv.X(), uv.Y())).Distance(point)).toBeLessThan(1e-7);
    });
  });

  it("reads a circle's curvature", () => {
    const oc = surfaceKernel();
    withOwned((own) => {
      const circle = own(new oc.Geom_Circle(own(new oc.gp_Ax2()), 5));
      const props = own(new oc.GeomLProp_CLProps(circle, 0.3, 2, 1e-9));
      expect(props.IsTangentDefined()).toBe(true);
      const tangent = own(new oc.gp_Dir(1, 0, 0));
      props.Tangent(tangent);
      expect(tangent.X()).toBeCloseTo(-Math.sin(0.3), 9);
      expect(tangent.Y()).toBeCloseTo(Math.cos(0.3), 9);
      expect(props.Curvature()).toBeCloseTo(0.2, 9);
    });
  });

  it("tells a tangent joint between curves from a corner", () => {
    const oc = surfaceKernel();
    withOwned((own) => {
      const first = segment(oc, own, [0, 0, 0], [10, 0, 0]);
      const onward = segment(oc, own, [10, 0, 0], [20, 0, 0]);
      const upward = segment(oc, own, [10, 0, 0], [10, 10, 0]);
      const g1 = oc.GeomAbs_Shape.GeomAbs_G1 as GeomAbs_Shape;

      const smooth = own(new oc.LocalAnalysis_CurveContinuity(first, first.LastParameter(), onward, onward.FirstParameter(), g1));
      expect(smooth.IsDone()).toBe(true);
      expect(smooth.IsC0()).toBe(true);
      expect(smooth.IsG1()).toBe(true);

      const corner = own(new oc.LocalAnalysis_CurveContinuity(first, first.LastParameter(), upward, upward.FirstParameter(), g1));
      expect(corner.IsDone()).toBe(true);
      expect(corner.IsC0()).toBe(true);
      expect(corner.C0Value()).toBeLessThan(1e-9);
      expect(corner.IsG1()).toBe(false);
      expect(corner.G1Angle()).toBeCloseTo(Math.PI / 2, 9);
    });
  });

  it("tells a tangent joint between surfaces from a corner", () => {
    const oc = surfaceKernel();
    withOwned((own) => {
      const g1 = oc.GeomAbs_Shape.GeomAbs_G1 as GeomAbs_Shape;
      // EpsNul is passed on purpose: with exactly seven arguments the call has
      // the arity of the seven-tolerance batch constructor, the dispatcher
      // picks that one, and every verdict comes back meaningless.
      const epsNul = 0.001;
      // Two coplanar faces meeting along x = 10; the point (10, 5, 0) is
      // (10, 5) on the first plane and (0, 5) on the second.
      const left = plane(oc, own, [0, 0, 0], [0, 0, 1], [1, 0, 0]);
      const right = plane(oc, own, [10, 0, 0], [0, 0, 1], [1, 0, 0]);
      const flat = own(new oc.LocalAnalysis_SurfaceContinuity(left, 10, 5, right, 0, 5, g1, epsNul));
      expect(flat.IsDone()).toBe(true);
      expect(flat.IsC0()).toBe(true);
      expect(flat.IsG1()).toBe(true);

      // The top and +x faces of a 10 mm box, meeting at (10, 5, 10): (10, 5)
      // on the top plane, (5, 10) on the side plane (u along y, v along z).
      const top = plane(oc, own, [0, 0, 10], [0, 0, 1], [1, 0, 0]);
      const side = plane(oc, own, [10, 0, 0], [1, 0, 0], [0, 1, 0]);
      const corner = own(new oc.LocalAnalysis_SurfaceContinuity(top, 10, 5, side, 5, 10, g1, epsNul));
      expect(corner.IsDone()).toBe(true);
      expect(corner.IsC0()).toBe(true);
      expect(corner.C0Value()).toBeLessThan(1e-9);
      expect(corner.IsG1()).toBe(false);
      expect(corner.G1Angle()).toBeCloseTo(Math.PI / 2, 9);
    });
  });
});
