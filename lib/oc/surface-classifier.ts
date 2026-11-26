import type { Adaptor3d_Surface, Geom_Surface, gp_Ax1, gp_Ax3, gp_Cone, gp_Cylinder, gp_Pln, gp_Pnt, TopoDS_Face, TopoDS_Shape } from "ocjs-fluidcad";
import { getOC } from "./init.js";
import { Point } from "../math/point.js";
import { Vector3d } from "../math/vector3d.js";
import { Axis } from "../math/axis.js";
import { Shape } from "../common/shape.js";
import type { Face } from "../common/face.js";
import { mmTol } from "../units/tolerance.js";
import { getActiveUnit } from "../units/registry.js";
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
  /**
   * How far the recovered surface strays from the face's own, as OCC's
   * converter measures it; 0 for a surface the kernel stores as its kind.
   */
  readonly gap: number;
  /**
   * For a recovered face: its class without recovery — revolved, extruded
   * or freeform. What a feature builds on when {@link gap} is over
   * {@link SurfaceClassifier.buildingTolerance}.
   */
  readonly unrecovered?: SurfaceClass;
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
type Analytic = Omit<Read, 'recovered' | 'gap' | 'unrecovered'>;

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
 *
 * Two questions are asked of a face. Naming it (a filter, a property, a
 * measurement) reads {@link classify}. Building on it — taking its plane,
 * axis or radius to construct geometry — reads {@link forBuilding}, which
 * holds a recovered surface to the tighter {@link buildingTolerance}.
 */
export class SurfaceClassifier {

  /** See {@link SurfaceClassifier.tolerance}. */
  private static readonly TOLERANCE_MM = 1e-3;

  /** See {@link SurfaceClassifier.buildingTolerance}. */
  private static readonly BUILDING_TOLERANCE_MM = 1e-4;

  /** The face's class, kept per wrapper for the tolerance it was classified at. */
  static classify(face: Face): SurfaceClass {
    return SurfaceClassifier.cached(face).value;
  }

  /** The class of a raw face, asked of OCCT every time. */
  static classifyRaw(face: TopoDS_Shape): SurfaceClass {
    return SurfaceClassifier.classifyWith(face, () => face);
  }

  /**
   * The class a feature may build on: the face's own class when the kernel
   * stores that surface or recovery matched it within
   * {@link buildingTolerance}, else its class without recovery. Kept per
   * wrapper with {@link classify}.
   */
  static forBuilding(face: Face): SurfaceClass {
    return SurfaceClassifier.buildingOf(SurfaceClassifier.classify(face));
  }

  /** The class a feature may build on, given the face's class; see {@link forBuilding}. */
  static buildingOf(surface: SurfaceClass): SurfaceClass {
    return surface.unrecovered && surface.gap > SurfaceClassifier.buildingTolerance()
      ? surface.unrecovered
      : surface;
  }

  /**
   * Why a feature cannot build on a face that is named a plane, a cylinder
   * or another elementary surface, in plain words; null when it can, or
   * when the face is named as none.
   */
  static buildingRefusal(surface: SurfaceClass): string | null {
    if (SurfaceClassifier.buildingOf(surface) === surface) {
      return null;
    }
    const unit = getActiveUnit();
    const length = (value: number) => `${Number(value.toPrecision(2))} ${unit}`;
    const limit = length(SurfaceClassifier.buildingTolerance());
    return surface.kind === 'plane'
      ? `The face is flat within ${length(surface.gap)} but not flat enough to build on: it must be flat within ${limit}.`
      : `The face is a ${surface.kind} within ${length(surface.gap)} but not close enough to one to build on: it must match within ${limit}.`;
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
   * How far a recovered surface may stray from the face's own for the face
   * to be named by it, and how closely a recovered radius must match a
   * requested one — the figure the edge classifier recovers lines and
   * circles at.
   */
  static tolerance(): number {
    return mmTol(SurfaceClassifier.TOLERANCE_MM);
  }

  /**
   * How far a recovered surface may stray from the face's own for a feature
   * to build on it as that surface. Naming tolerates {@link tolerance}, at
   * which a small or shallow free-form patch already reads as a plane or a
   * cylinder (a 1 mm patch of an R≈500 mm surface is flat within 7.6e-4 mm;
   * a 40 mm parabolic sheet is a cylinder within 5.2e-4 mm, of a radius
   * that depends on the trim): harmless for a name, wrong for geometry
   * built from that plane or axis. The flat walls, round corners and cones
   * FluidCAD's own lofts and sweeps store as B-splines recover within
   * 1e-12 mm, so 1e-4 mm keeps every one of them buildable with eight
   * decades to spare. OCC measures the gap on a coarse grid and can
   * under-read it by a fifth; at this figure that is 0.02 µm, below
   * anything a feature would show.
   */
  static buildingTolerance(): number {
    return mmTol(SurfaceClassifier.BUILDING_TOLERANCE_MM);
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
      const read = SurfaceClassifier.read(typed);
      const area = () => SurfaceClassifier.measureArea(source());
      const value = lazily(read, 'areaMm2', area);
      if (read.unrecovered) {
        // One integration serves both classes of the face.
        lazily(read.unrecovered, 'areaMm2', () => value.areaMm2);
      }
      return value;
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
        return { ...native, recovered: false, gap: 0 };
      }
      const stored: Read = { ...SurfaceClassifier.readNonAnalytic(adaptor), recovered: false, gap: 0 };
      const recovered = SurfaceClassifier.recover(face);
      if (recovered) {
        return { ...recovered.analytic, recovered: true, gap: recovered.gap, unrecovered: stored as SurfaceClass };
      }
      return stored;
    } finally {
      adaptor.delete();
    }
  }

  /**
   * The elementary surface a non-analytic face approximates over its own UV
   * bounds within {@link tolerance}, with how far it strays; null when
   * there is none.
   */
  private static recover(face: TopoDS_Face): { analytic: Analytic; gap: number } | null {
    const oc = getOC();
    const surface = oc.BRep_Tool.Surface(face);
    if (!surface) {
      return null;
    }
    const owned: { delete(): void }[] = [surface];
    try {
      const tolerance = SurfaceClassifier.tolerance();
      const { uMin, uMax, vMin, vMax } = SurfaceClassifier.convertibleBounds(face, surface);
      const converter = new oc.GeomConvert_SurfToAnaSurf(surface);
      owned.push(converter);
      const recovered = converter.ConvertToAnalytical(tolerance, uMin, uMax, vMin, vMax);
      if (!recovered) {
        return null;
      }
      owned.push(recovered);
      const gap = converter.Gap();
      if (gap > tolerance) {
        return null;
      }
      const adaptor = new oc.GeomAdaptor_Surface(recovered);
      owned.push(adaptor);
      const analytic = SurfaceClassifier.readAnalytic(adaptor);
      return analytic ? { analytic, gap } : null;
    } finally {
      for (const object of owned.reverse()) {
        object.delete();
      }
    }
  }

  /**
   * The face's UV bounds as the converter takes them: within the surface's
   * own. A face on a periodic surface may be parametrized any number of
   * periods away from the surface's base range (an import's bore with u in
   * [5, 8] on a surface defined over [0, 2π]), which the converter refuses;
   * such a range is shifted back by whole periods, and one that still
   * crosses the seam is widened to the full period, so the gap is measured
   * over at least the face.
   */
  private static convertibleBounds(face: TopoDS_Face, surface: Geom_Surface): { uMin: number; uMax: number; vMin: number; vMax: number } {
    const oc = getOC();
    const bounds = oc.BRepTools.UVBounds(face);
    const own = surface.Bounds(0, 0, 0, 0);
    const [uMin, uMax] = SurfaceClassifier.withinPeriod(bounds.UMin, bounds.UMax, own.U1, own.U2, surface.IsUPeriodic());
    const [vMin, vMax] = SurfaceClassifier.withinPeriod(bounds.VMin, bounds.VMax, own.V1, own.V2, surface.IsVPeriodic());
    return { uMin, uMax, vMin, vMax };
  }

  /** A parameter range brought into `[first, last]`, one period of a periodic direction. */
  private static withinPeriod(min: number, max: number, first: number, last: number, periodic: boolean): [number, number] {
    const period = last - first;
    // unit: dimensionless (surface parameter)
    const slack = 1e-9;
    if (!periodic || !(period > 0) || !Number.isFinite(period) || (min >= first - slack && max <= last + slack)) {
      return [min, max];
    }
    const shift = Math.floor((min - first + slack) / period) * period;
    if (max - shift > last + slack) {
      return [first, last];
    }
    return [min - shift, max - shift];
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
