import type { TopAbs_ShapeEnum, TopoDS_Shape } from "ocjs-fluidcad";
import type { Face } from "../common/face.js";
import { getOC } from "./init.js";
import { Explorer } from "./explorer.js";
import { FaceQuery } from "./face-query.js";
import { CurveClassifier } from "./curve-classifier.js";
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
   * predicate it instantiates agree on every face. A plane bounded by
   * circles and arcs, one of them full, is a `circle`.
   *
   * Reads the wrapper's kept class, and integrates the area only when it is
   * read.
   */
  static of(face: Face): FaceProperties {
    return FaceProps.fromClass(
      SurfaceClassifier.classify(face),
      () => FaceProps.circularRim(face.getShape()),
      () => FaceQuery.hasClosedCircularRim(face),
    );
  }

  /** {@link of} for a raw face: classified afresh, with every property read at once. */
  static getProperties(face: TopoDS_Shape): FaceProperties {
    // Spread out: the properties may outlive the raw face, which a lazy area would still read.
    return {
      ...FaceProps.fromClass(
        SurfaceClassifier.classifyRaw(face),
        () => FaceProps.circularRim(face),
        () => FaceQuery.hasClosedCircularRimRaw(face),
      ),
    };
  }

  /** A surface class as the properties shown for its face, given the radius of a flat face's circular rim and whether a cylinder closes. */
  private static fromClass(surface: SurfaceClass, circularRim: () => number | null, closedRim: () => boolean): FaceProperties {
    const recovered = surface.recovered;
    switch (surface.kind) {
      case 'plane': {
        const rim = circularRim();
        if (rim !== null) {
          return { surfaceType: 'circle', recovered, radius: rim };
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

  /**
   * The radius of the full circle bounding a planar face whose edges are
   * all circles or arcs (see {@link CurveClassifier}), else null.
   */
  private static circularRim(face: TopoDS_Shape): number | null {
    const oc = getOC();
    // The explorer copies are this read's own.
    return Explorer.withShapes(face, oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum, edges => {
      let radius: number | null = null;
      for (const edge of edges) {
        const curve = CurveClassifier.classifyRaw(edge);
        if (curve.kind !== 'circle' && curve.kind !== 'arc') {
          return null;
        }
        if (curve.kind === 'circle') {
          radius = curve.radius ?? null;
        }
      }
      return radius;
    });
  }
}
