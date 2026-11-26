import type { TopAbs_ShapeEnum, TopoDS_Shape } from "ocjs-fluidcad";
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
   */
  static getProperties(face: TopoDS_Shape): FaceProperties {
    return FaceProps.fromClass(SurfaceClassifier.classifyRaw(face), face);
  }

  /** A surface class as the properties shown for `face`. */
  static fromClass(surface: SurfaceClass, face: TopoDS_Shape): FaceProperties {
    const recovered = surface.recovered;
    switch (surface.kind) {
      case 'plane': {
        const rim = FaceProps.circularRim(face);
        if (rim !== null) {
          return { surfaceType: 'circle', recovered, radius: rim };
        }
        return { surfaceType: 'plane', recovered, areaMm2: surface.areaMm2 };
      }
      case 'cylinder':
        return { surfaceType: 'cylinder', recovered, radius: surface.radius, closed: FaceQuery.hasClosedCircularRimRaw(face) };
      case 'sphere':
        return { surfaceType: 'sphere', recovered, radius: surface.radius };
      case 'torus':
        return { surfaceType: 'torus', recovered, majorRadius: surface.majorRadius, minorRadius: surface.minorRadius };
      case 'cone':
        return { surfaceType: 'cone', recovered, halfAngleDeg: (surface.semiAngle ?? 0) * (180 / Math.PI) };
      default:
        return { surfaceType: surface.kind, recovered, areaMm2: surface.areaMm2 };
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
