import type { Adaptor3d_Surface, gp_Ax1, gp_Pnt, TopoDS_Face, TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { Axis } from "../math/axis.js";
import { Shape } from "../common/shape.js";
import type { Face } from "../common/face.js";
import { mmTol } from "../units/tolerance.js";

/** What a face's surface is, whatever the kernel stores it as. */
export type SurfaceKind =
  | 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus'
  | 'revolved' | 'extruded' | 'freeform';

/** A face's surface kind and the sizes that go with it; see {@link SurfaceClassifier.classify}. */
export type SurfaceClass = {
  kind: SurfaceKind;
  /** True when the kind was recovered from a non-analytic surface. */
  recovered: boolean;
  /** For a cylinder or a sphere. */
  radius?: number;
  /** For a torus. */
  majorRadius?: number;
  minorRadius?: number;
  /** For a cylinder, a cone, a torus or a revolved surface. */
  axis?: Axis;
  /** For a plane: a point on it. */
  origin?: Point;
  /** For a plane: the direction of its frame's main axis (either side of the face). */
  normal?: Vector3d;
  /** For a cone: its half-angle in radians, and its apex. */
  semiAngle?: number;
  apex?: Point;
  /** For a sphere: its centre. */
  center?: Point;
  areaMm2: number;
};

/** The class of one wrapper, with the tolerance it was classified at (unit-dependent). */
type CachedClass = { tolerance: number; value: SurfaceClass };

const classes = new WeakMap<Shape, CachedClass>();

/** The analytic part of a class: what a plane, cylinder, cone, sphere or torus reads off its surface. */
type Analytic = Omit<SurfaceClass, 'recovered' | 'areaMm2'>;

/**
 * The one classifier for faces. Filters, properties, selection probes and
 * measure all read a face's kind from here, so they cannot disagree.
 *
 * A native plane, cylinder, cone, sphere or torus reads straight off the
 * surface. Any other surface — what lofts, sweeps and STEP imports carry
 * even for flat walls and round bores — is handed to OCC's analytical
 * converter over the face's own UV bounds, which recovers the elementary
 * surface it approximates within {@link SurfaceClassifier.tolerance}. One it
 * cannot recover is `revolved` (a surface of revolution), `extruded` (a
 * surface of linear extrusion) or `freeform` (B-spline, Bezier, offset and
 * the rest).
 */
export class SurfaceClassifier {

  /** See {@link SurfaceClassifier.tolerance}. */
  private static readonly TOLERANCE_MM = 1e-3;

  /** The face's class, kept per wrapper for the tolerance it was classified at. */
  static classify(face: Face): SurfaceClass {
    const tolerance = SurfaceClassifier.tolerance();
    const cached = classes.get(face);
    if (cached?.tolerance === tolerance) {
      return cached.value;
    }
    const value = SurfaceClassifier.classifyRaw(face.getShape());
    classes.set(face, { tolerance, value });
    return value;
  }

  /** The class of a raw face, asked of OCCT every time. */
  static classifyRaw(face: TopoDS_Shape): SurfaceClass {
    const oc = getOC();
    const typed = oc.TopoDS.Face(face);
    try {
      const areaMm2 = SurfaceClassifier.measureArea(typed);
      const analytic = SurfaceClassifier.withAnalyticSurfaceOf(typed, (surface, recovered) => {
        const read = SurfaceClassifier.readAnalytic(surface);
        return read ? { ...read, recovered } : null;
      });
      if (analytic) {
        return { ...analytic, areaMm2 };
      }
      return { ...SurfaceClassifier.readNonAnalytic(typed), recovered: false, areaMm2 };
    } finally {
      typed.delete();
    }
  }

  /**
   * Runs `read` over the face's elementary surface: its own adaptor when the
   * kernel stores one, else an adaptor over the surface recovered from it.
   * A face with neither is read through its own adaptor, so a caller that
   * asks it for a plane fails as it would have without recovery.
   */
  static withAnalyticSurface<T>(face: TopoDS_Shape, read: (surface: Adaptor3d_Surface, recovered: boolean) => T): T {
    const oc = getOC();
    const typed = oc.TopoDS.Face(face);
    try {
      const result = SurfaceClassifier.withAnalyticSurfaceOf(typed, (surface, recovered) => ({ value: read(surface, recovered) }));
      if (result) {
        return result.value;
      }
      const adaptor = new oc.BRepAdaptor_Surface(typed, true);
      try {
        return read(adaptor, false);
      } finally {
        adaptor.delete();
      }
    } finally {
      typed.delete();
    }
  }

  /**
   * How far a recovered surface may stray from the face's own, and how
   * closely a recovered radius must match a requested one — the figure the
   * edge classifier recovers lines and circles at.
   */
  static tolerance(): number {
    return mmTol(SurfaceClassifier.TOLERANCE_MM);
  }

  /** Whether `kind` is one of the elementary surfaces a face can be recovered as. */
  static isAnalytic(kind: SurfaceKind): boolean {
    return kind === 'plane' || kind === 'cylinder' || kind === 'cone' || kind === 'sphere' || kind === 'torus';
  }

  /**
   * `read` over the face's native elementary surface, else over the one
   * recovered from it; null (without calling `read`) when there is neither.
   */
  private static withAnalyticSurfaceOf<T>(face: TopoDS_Face, read: (surface: Adaptor3d_Surface, recovered: boolean) => T): T | null {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Surface(face, true);
    try {
      if (SurfaceClassifier.isElementary(adaptor)) {
        return read(adaptor, false);
      }
    } finally {
      adaptor.delete();
    }
    const surface = oc.BRep_Tool.Surface(face);
    if (!surface) {
      return null;
    }
    const tolerance = SurfaceClassifier.tolerance();
    const bounds = oc.BRepTools.UVBounds(face);
    const converter = new oc.GeomConvert_SurfToAnaSurf(surface);
    let recovered: ReturnType<typeof converter.ConvertToAnalytical> | null = null;
    try {
      recovered = converter.ConvertToAnalytical(tolerance, bounds.UMin, bounds.UMax, bounds.VMin, bounds.VMax);
      if (!recovered || converter.Gap() > tolerance) {
        return null;
      }
      const recoveredAdaptor = new oc.GeomAdaptor_Surface(recovered);
      try {
        return SurfaceClassifier.isElementary(recoveredAdaptor) ? read(recoveredAdaptor, true) : null;
      } finally {
        recoveredAdaptor.delete();
      }
    } finally {
      recovered?.delete();
      converter.delete();
      surface.delete();
    }
  }

  private static isElementary(surface: Adaptor3d_Surface): boolean {
    const oc = getOC();
    const type = surface.GetType();
    return type === oc.GeomAbs_SurfaceType.GeomAbs_Plane
      || type === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder
      || type === oc.GeomAbs_SurfaceType.GeomAbs_Cone
      || type === oc.GeomAbs_SurfaceType.GeomAbs_Sphere
      || type === oc.GeomAbs_SurfaceType.GeomAbs_Torus;
  }

  /** An elementary surface's kind, frame and sizes; null for any other surface. */
  private static readAnalytic(surface: Adaptor3d_Surface): Analytic | null {
    const oc = getOC();
    const type = surface.GetType();
    if (type === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
      const plane = surface.Plane();
      const axis = SurfaceClassifier.axisOf(plane.Axis());
      plane.delete();
      return { kind: 'plane', origin: axis.origin, normal: axis.direction };
    }
    if (type === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) {
      const cylinder = surface.Cylinder();
      const analytic: Analytic = { kind: 'cylinder', radius: cylinder.Radius(), axis: SurfaceClassifier.axisOf(cylinder.Axis()) };
      cylinder.delete();
      return analytic;
    }
    if (type === oc.GeomAbs_SurfaceType.GeomAbs_Cone) {
      const cone = surface.Cone();
      const analytic: Analytic = {
        kind: 'cone',
        axis: SurfaceClassifier.axisOf(cone.Axis()),
        semiAngle: cone.SemiAngle(),
        apex: SurfaceClassifier.pointOf(cone.Apex()),
      };
      cone.delete();
      return analytic;
    }
    if (type === oc.GeomAbs_SurfaceType.GeomAbs_Sphere) {
      const sphere = surface.Sphere();
      const analytic: Analytic = { kind: 'sphere', radius: sphere.Radius(), center: SurfaceClassifier.pointOf(sphere.Location()) };
      sphere.delete();
      return analytic;
    }
    if (type === oc.GeomAbs_SurfaceType.GeomAbs_Torus) {
      const torus = surface.Torus();
      const analytic: Analytic = {
        kind: 'torus',
        majorRadius: torus.MajorRadius(),
        minorRadius: torus.MinorRadius(),
        axis: SurfaceClassifier.axisOf(torus.Axis()),
      };
      torus.delete();
      return analytic;
    }
    return null;
  }

  /** The kind of a face no elementary surface stands for. */
  private static readNonAnalytic(face: TopoDS_Face): Analytic {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Surface(face, true);
    try {
      const type = adaptor.GetType();
      if (type === oc.GeomAbs_SurfaceType.GeomAbs_SurfaceOfRevolution) {
        return { kind: 'revolved', axis: SurfaceClassifier.axisOf(adaptor.AxeOfRevolution()) };
      }
      if (type === oc.GeomAbs_SurfaceType.GeomAbs_SurfaceOfExtrusion) {
        return { kind: 'extruded' };
      }
      return { kind: 'freeform' };
    } finally {
      adaptor.delete();
    }
  }

  private static axisOf(axis: gp_Ax1): Axis {
    const location = axis.Location();
    const dir = axis.Direction();
    const result = new Axis(
      new Point(location.X(), location.Y(), location.Z()),
      new Vector3d(dir.X(), dir.Y(), dir.Z()),
    );
    dir.delete();
    location.delete();
    axis.delete();
    return result;
  }

  private static pointOf(p: gp_Pnt): Point {
    const point = new Point(p.X(), p.Y(), p.Z());
    p.delete();
    return point;
  }

  private static measureArea(face: TopoDS_Face): number {
    const oc = getOC();
    const props = new oc.GProp_GProps();
    oc.BRepGProp.SurfaceProperties(face, props, false, false);
    const area = props.Mass();
    props.delete();
    return area;
  }
}
