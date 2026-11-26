import type { TopoDS_Shape } from "ocjs-fluidcad";
import type { Face } from "../common/face.js";
import { FaceCircle, FaceQuery } from "./face-query.js";
import { SurfaceClass, SurfaceClassifier } from "./surface-classifier.js";

export interface FaceProperties {
  surfaceType: 'plane' | 'circle' | 'cylinder' | 'sphere' | 'torus' | 'cone' | 'revolved' | 'extruded' | 'freeform';
  /** True when the kind was recovered from a non-analytic surface: a flat or round face a loft or an import stores as a B-spline. */
  recovered: boolean;
  areaMm2?: number;
  radius?: number;
  /**
   * Cylinders only: whether the face wraps fully around its axis and so
   * carries a closed circular rim. `true` is what `face().cylinder()`
   * admits (a bore, a boss wall); `false` is a `face().cylinderCurve()`
   * (a fillet, a rounded corner, a bore opened by a slot).
   */
  closed?: boolean;
  majorRadius?: number;
  minorRadius?: number;
  halfAngleDeg?: number;
}

export class FaceProps {
  /**
   * The face's kind and sizes, read off its {@link SurfaceClassifier} class
   * — the classification the face filters read too, so a probe and the
   * predicate it instantiates agree on every face. A flat face with a full
   * circle for its outer boundary is a `circle` of that circle's radius,
   * as `face().circle()` has it (see {@link FaceQuery.circlesOf}).
   *
   * Reads the wrapper's kept class, and integrates the area only when it is
   * read.
   */
  static of(face: Face): FaceProperties {
    return FaceProps.fromClass(
      SurfaceClassifier.classify(face),
      () => FaceQuery.circlesOf(face).disc,
      () => FaceQuery.hasClosedCircularRim(face),
    );
  }

  /** {@link of} for a raw face: classified afresh, with every property read at once. */
  static getProperties(face: TopoDS_Shape): FaceProperties {
    const surface = SurfaceClassifier.classifyRaw(face);
    // Spread out: the properties may outlive the raw face, which a lazy area would still read.
    return {
      ...FaceProps.fromClass(
        surface,
        () => FaceQuery.circlesOfRaw(face, surface).disc,
        () => FaceQuery.hasClosedCircularRimRaw(face),
      ),
    };
  }

  /** A surface class as the properties shown for its face, given the face's disc circle and whether a cylinder closes. */
  private static fromClass(surface: SurfaceClass, disc: () => FaceCircle | null, closedRim: () => boolean): FaceProperties {
    const recovered = surface.recovered;
    switch (surface.kind) {
      case 'plane': {
        const rim = disc();
        if (rim !== null) {
          return { surfaceType: 'circle', recovered, radius: rim.radius };
        }
        return { surfaceType: 'plane', recovered, get areaMm2() { return surface.areaMm2; } };
      }
      case 'cylinder':
        return { surfaceType: 'cylinder', recovered, radius: surface.radius, closed: closedRim() };
      case 'sphere':
        return { surfaceType: 'sphere', recovered, radius: surface.radius };
      case 'torus':
        return { surfaceType: 'torus', recovered, majorRadius: surface.majorRadius, minorRadius: surface.minorRadius };
      case 'cone':
        return { surfaceType: 'cone', recovered, halfAngleDeg: (surface.semiAngle ?? 0) * (180 / Math.PI) };
      default:
        return { surfaceType: surface.kind, recovered, get areaMm2() { return surface.areaMm2; } };
    }
  }
}
