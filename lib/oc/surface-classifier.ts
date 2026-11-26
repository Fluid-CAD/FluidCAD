import type { Adaptor3d_Surface, gp_Ax1, gp_Ax3, gp_Cone, gp_Cylinder, gp_Pln, gp_Pnt, TopoDS_Face, TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { Axis } from "../math/axis.js";
import { Shape } from "../common/shape.js";
import type { Face } from "../common/face.js";
import { mmTol } from "../units/tolerance.js";
import { lazily } from "../helpers/lazily.js";

/** What a face's surface is, whatever the kernel stores it as. */
export type SurfaceKind =
  | 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus'
  | 'revolved' | 'extruded' | 'freeform';

/** Where an elementary surface sits: the frame its parameters are read in. */
export type SurfacePlacement = {
  origin: Point;
  /** The frame's main direction: a plane's normal, a cylinder's, cone's or torus's axis. */
  direction: Vector3d;
  /** Where the surface's u parameter starts. */
  xDirection: Vector3d;
  /** False for a left-handed frame. */
  direct: boolean;
};

/** A face's surface kind and the sizes that go with it; see {@link SurfaceClassifier.classify}. */
export type SurfaceClass = {
  readonly kind: SurfaceKind;
  /** True when the kind was recovered from a non-analytic surface. */
  readonly recovered: boolean;
  /** For a cylinder or a sphere. */
  readonly radius?: number;
  /** For a torus. */
  readonly majorRadius?: number;
  readonly minorRadius?: number;
  /** For a cylinder, a cone, a torus or a revolved surface. */
  readonly axis?: Axis;
  /** For a plane: a point on it. */
  readonly origin?: Point;
  /** For a plane: the direction of its frame's main axis (either side of the face). */
  readonly normal?: Vector3d;
  /** For a cone: its half-angle in radians, its apex, and its radius at the frame's origin. */
  readonly semiAngle?: number;
  readonly apex?: Point;
  readonly refRadius?: number;
  /** For a sphere: its centre. */
  readonly center?: Point;
  /** For a plane, cylinder, cone, sphere or torus: its frame, enough to rebuild the surface. */
  readonly placement?: SurfacePlacement;
  /**
   * The face's area, integrated on first read and kept. A class from
   * {@link SurfaceClassifier.classifyRaw} reads it off the raw face, so
   * read it while that face lives.
   */
  readonly areaMm2: number;
};

/**
 * One wrapper's class with the tolerance it was classified at
 * (unit-dependent), and what readers derived from it.
 */
type CachedClass = { tolerance: number; value: SurfaceClass; derived: Map<string, unknown> };

const classes = new WeakMap<Shape, CachedClass>();

type Writable<T> = { -readonly [K in keyof T]: T[K] };

/** What classification reads at once; the area comes on demand. */
type Read = Writable<Omit<SurfaceClass, 'areaMm2'>>;

/** The analytic part of a class: what a plane, cylinder, cone, sphere or torus reads off its surface. */
type Analytic = Omit<Read, 'recovered'>;

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
    return SurfaceClassifier.cached(face).value;
  }

  /** The class of a raw face, asked of OCCT every time. */
  static classifyRaw(face: TopoDS_Shape): SurfaceClass {
    return SurfaceClassifier.classifyWith(face, () => face);
  }

  /**
   * What a reader derives from the face's class (a rim walk, say), computed
   * once and kept beside the class: it is dropped when the class is, so it
   * never outlives the tolerance it was derived at.
   */
  static derived<T>(face: Face, key: string, compute: () => T): T {
    const { derived } = SurfaceClassifier.cached(face);
    if (!derived.has(key)) {
      derived.set(key, compute());
    }
    return derived.get(key) as T;
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

  /** The plane a `plane` class describes, for OCCT; the caller deletes it. */
  static gpPlane(surface: SurfaceClass): gp_Pln {
    const frame = SurfaceClassifier.gpFrame(surface, 'plane');
    try {
      return new (getOC().gp_Pln)(frame);
    } finally {
      frame.delete();
    }
  }

  /** The cylinder a `cylinder` class describes, for OCCT; the caller deletes it. */
  static gpCylinder(surface: SurfaceClass): gp_Cylinder {
    const frame = SurfaceClassifier.gpFrame(surface, 'cylinder');
    try {
      return new (getOC().gp_Cylinder)(frame, surface.radius ?? 0);
    } finally {
      frame.delete();
    }
  }

  /** The cone a `cone` class describes, for OCCT; the caller deletes it. */
  static gpCone(surface: SurfaceClass): gp_Cone {
    const frame = SurfaceClassifier.gpFrame(surface, 'cone');
    try {
      return new (getOC().gp_Cone)(frame, surface.semiAngle ?? 0, surface.refRadius ?? 0);
    } finally {
      frame.delete();
    }
  }

  /** The frame of a class of the given kind; throws for any other class. */
  private static gpFrame(surface: SurfaceClass, kind: SurfaceKind): gp_Ax3 {
    if (surface.kind !== kind || !surface.placement) {
      throw new Error(`The face is not a ${kind} (got '${surface.kind}')`);
    }
    const oc = getOC();
    const { origin, direction, xDirection, direct } = surface.placement;
    const location = new oc.gp_Pnt(origin.x, origin.y, origin.z);
    const main = new oc.gp_Dir(direction.x, direction.y, direction.z);
    const x = new oc.gp_Dir(xDirection.x, xDirection.y, xDirection.z);
    try {
      const frame = new oc.gp_Ax3(location, main, x);
      if (!direct) {
        frame.YReverse();
      }
      return frame;
    } finally {
      x.delete();
      main.delete();
      location.delete();
    }
  }

  private static cached(face: Face): CachedClass {
    const tolerance = SurfaceClassifier.tolerance();
    let cached = classes.get(face);
    if (cached?.tolerance !== tolerance) {
      cached = {
        tolerance,
        value: SurfaceClassifier.classifyWith(face.getShape(), () => face.getShape()),
        derived: new Map(),
      };
      classes.set(face, cached);
    }
    return cached;
  }

  /** Classifies `face`; `source` hands the area integration the face when it is first asked for. */
  private static classifyWith(face: TopoDS_Shape, source: () => TopoDS_Shape): SurfaceClass {
    const oc = getOC();
    const typed = oc.TopoDS.Face(face);
    try {
      return lazily(SurfaceClassifier.read(typed), 'areaMm2', () => SurfaceClassifier.measureArea(source()));
    } finally {
      typed.delete();
    }
  }

  /**
   * The face's class but for its area: its native elementary surface, else
   * the one recovered from it, else what the kernel stores.
   */
  private static read(face: TopoDS_Face): Read {
    const oc = getOC();
    const adaptor = new oc.BRepAdaptor_Surface(face, true);
    try {
      const native = SurfaceClassifier.readAnalytic(adaptor);
      if (native) {
        return { ...native, recovered: false };
      }
      const recovered = SurfaceClassifier.recover(face);
      if (recovered) {
        return { ...recovered, recovered: true };
      }
      return { ...SurfaceClassifier.readNonAnalytic(adaptor), recovered: false };
    } finally {
      adaptor.delete();
    }
  }

  /**
   * The elementary surface a non-analytic face approximates over its own UV
   * bounds within {@link tolerance}; null when there is none.
   */
  private static recover(face: TopoDS_Face): Analytic | null {
    const oc = getOC();
    const surface = oc.BRep_Tool.Surface(face);
    if (!surface) {
      return null;
    }
    const owned: { delete(): void }[] = [surface];
    try {
      const tolerance = SurfaceClassifier.tolerance();
      const bounds = oc.BRepTools.UVBounds(face);
      const converter = new oc.GeomConvert_SurfToAnaSurf(surface);
      owned.push(converter);
      const recovered = converter.ConvertToAnalytical(tolerance, bounds.UMin, bounds.UMax, bounds.VMin, bounds.VMax);
      if (!recovered) {
        return null;
      }
      owned.push(recovered);
      if (converter.Gap() > tolerance) {
        return null;
      }
      const adaptor = new oc.GeomAdaptor_Surface(recovered);
      owned.push(adaptor);
      return SurfaceClassifier.readAnalytic(adaptor);
    } finally {
      for (const object of owned.reverse()) {
        object.delete();
      }
    }
  }

  /** An elementary surface's kind, frame and sizes; null for any other surface. */
  private static readAnalytic(surface: Adaptor3d_Surface): Analytic | null {
    const oc = getOC();
    const type = surface.GetType();
    if (type === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
      const plane = surface.Plane();
      const placement = SurfaceClassifier.placementOf(plane.Position());
      plane.delete();
      return { kind: 'plane', origin: placement.origin, normal: placement.direction, placement };
    }
    if (type === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) {
      const cylinder = surface.Cylinder();
      const analytic: Analytic = {
        kind: 'cylinder',
        radius: cylinder.Radius(),
        axis: SurfaceClassifier.axisOf(cylinder.Axis()),
        placement: SurfaceClassifier.placementOf(cylinder.Position()),
      };
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
        refRadius: cone.RefRadius(),
        placement: SurfaceClassifier.placementOf(cone.Position()),
      };
      cone.delete();
      return analytic;
    }
    if (type === oc.GeomAbs_SurfaceType.GeomAbs_Sphere) {
      const sphere = surface.Sphere();
      const analytic: Analytic = {
        kind: 'sphere',
        radius: sphere.Radius(),
        center: SurfaceClassifier.pointOf(sphere.Location()),
        placement: SurfaceClassifier.placementOf(sphere.Position()),
      };
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
        placement: SurfaceClassifier.placementOf(torus.Position()),
      };
      torus.delete();
      return analytic;
    }
    return null;
  }

  /** The kind of a surface that is no elementary one. */
  private static readNonAnalytic(surface: Adaptor3d_Surface): Analytic {
    const oc = getOC();
    const type = surface.GetType();
    if (type === oc.GeomAbs_SurfaceType.GeomAbs_SurfaceOfRevolution) {
      return { kind: 'revolved', axis: SurfaceClassifier.axisOf(surface.AxeOfRevolution()) };
    }
    if (type === oc.GeomAbs_SurfaceType.GeomAbs_SurfaceOfExtrusion) {
      return { kind: 'extruded' };
    }
    return { kind: 'freeform' };
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

  private static placementOf(frame: gp_Ax3): SurfacePlacement {
    const location = frame.Location();
    const dir = frame.Direction();
    const x = frame.XDirection();
    const placement: SurfacePlacement = {
      origin: new Point(location.X(), location.Y(), location.Z()),
      direction: new Vector3d(dir.X(), dir.Y(), dir.Z()),
      xDirection: new Vector3d(x.X(), x.Y(), x.Z()),
      direct: frame.Direct(),
    };
    x.delete();
    dir.delete();
    location.delete();
    frame.delete();
    return placement;
  }

  private static pointOf(p: gp_Pnt): Point {
    const point = new Point(p.X(), p.Y(), p.Z());
    p.delete();
    return point;
  }

  private static measureArea(face: TopoDS_Shape): number {
    const oc = getOC();
    const props = new oc.GProp_GProps();
    try {
      oc.BRepGProp.SurfaceProperties(face, props, false, false);
      return props.Mass();
    } finally {
      props.delete();
    }
  }
}
