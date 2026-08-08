import type { Geom_BSplineCurve, Geom_BSplineSurface, TopoDS_Shape, TopoDS_Wire, TopAbs_ShapeEnum } from "ocjs-fluidcad";
import { getOC } from "../init.js";
import { Explorer } from "../explorer.js";
import { ShapeProps } from "../props.js";
import { NCollections } from "../ncollection.js";
import { Vector3d } from "../../math/vector3d.js";
import { interpolateWithDerivatives, BSplineCurveData } from "../../math/bspline-interpolation.js";
import { Solid } from "../../common/solid.js";
import { CompatibleSections, CompatibleSection } from "./section-compatibility.js";
import { CurveData } from "./curve-data.js";

/** How a loft leaves (or arrives at) an end profile. */
export type LoftConditionKind = "normal" | "tangent";

export interface LoftEndCondition {
  kind: LoftConditionKind;
  /** Scales the takeoff tangent; 1 ≈ one loft length of influence. Negative flips the direction. */
  magnitude: number;
}

/** The u-direction surface basis every skinned section shares. */
export interface LoftSurfaceBasis {
  degree: number;
  knots: number[];
  multiplicities: number[];
  /** Shared weight vector, or null when polynomial. */
  weights: number[] | null;
  /** Interior u-knots with a real profile corner — face-split points. */
  creases?: number[];
}

export interface SkinnedGrid {
  /** Surface poles, indexed [uIndex][vIndex] — u runs around the sections, v along the loft. */
  grid: number[][][];
  /** The v-direction basis produced by the column interpolation. */
  vBasis: BSplineCurveData;
  /** The loft parameter assigned to each input section. */
  params: number[];
  /** Average flow-line length — the scale reference for condition magnitudes. */
  averageLength: number;
}

/**
 * The shared loft-skinning pipeline: interpolates matching pole columns of
 * compatible sections along the loft (optionally with end-derivative
 * constraints) and assembles the resulting `Geom_BSplineSurface` plus exact
 * boundary caps into a sewn solid. Used by `ConstrainedLoft` (conditions)
 * and `GuidedLoft` (virtual sections along rails).
 */
export class Skinning {
  private static readonly SEWING_TOLERANCE = 1e-6;

  /**
   * Interpolates each pole column along the loft. Every column shares the
   * same parameters and constraint pattern, so every column yields the same
   * v-basis.
   */
  static skinSections(
    compatible: CompatibleSections,
    startCondition?: LoftEndCondition,
    endCondition?: LoftEndCondition,
  ): SkinnedGrid {
    const { sections } = compatible;
    const { params, averageLength } = Skinning.loftParameters(sections);

    const startField = startCondition
      ? Skinning.derivativeField(sections[0], startCondition, averageLength, false)
      : null;
    const endField = endCondition
      ? Skinning.derivativeField(sections[sections.length - 1], endCondition, averageLength, true)
      : null;

    const columns = sections.map(section => section.poles);
    const { grid, vBasis } = Skinning.interpolateColumns(columns, params, startField, endField);
    return { grid, vBasis, params, averageLength };
  }

  /**
   * Interpolates pole columns across a stack of sections (sections[k] is the
   * full pole set of section k) at the given parameters, with optional
   * per-column end derivatives.
   */
  static interpolateColumns(
    sections: number[][][],
    params: number[],
    startField: number[][] | null = null,
    endField: number[][] | null = null,
  ): { grid: number[][][]; vBasis: BSplineCurveData } {
    const poleCount = sections[0].length;
    const grid: number[][][] = [];
    let vBasis: BSplineCurveData | null = null;
    for (let i = 0; i < poleCount; i++) {
      const column = sections.map(section => section[i]);
      const interpolated = interpolateWithDerivatives(
        column,
        params,
        startField ? startField[i] : undefined,
        endField ? endField[i] : undefined,
      );
      grid.push(interpolated.poles);
      vBasis = interpolated;
    }
    return { grid, vBasis: vBasis! };
  }

  /**
   * Loft parameters v_k in [0, 1] by chord length averaged over the pole
   * columns (the standard skinning parameterization), plus the average
   * flow-line length used to scale condition magnitudes.
   */
  static loftParameters(
    sections: CompatibleSection[],
  ): { params: number[]; averageLength: number } {
    const sectionCount = sections.length;
    const poleCount = sections[0].poles.length;

    const sums = new Array<number>(sectionCount).fill(0);
    let usableColumns = 0;
    let totalLength = 0;
    for (let i = 0; i < poleCount; i++) {
      const cumulative = new Array<number>(sectionCount).fill(0);
      for (let k = 1; k < sectionCount; k++) {
        const a = sections[k - 1].poles[i];
        const b = sections[k].poles[i];
        cumulative[k] = cumulative[k - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      }
      const total = cumulative[sectionCount - 1];
      if (total > 1e-12) {
        usableColumns++;
        totalLength += total;
        for (let k = 1; k < sectionCount; k++) {
          sums[k] += cumulative[k] / total;
        }
      }
    }
    if (usableColumns === 0) {
      throw new Error("Loft profiles are coincident — nothing to loft between.");
    }

    const params = sums.map(sum => sum / usableColumns);
    params[0] = 0;
    params[sectionCount - 1] = 1;
    for (let k = 1; k < sectionCount; k++) {
      if (params[k] <= params[k - 1]) {
        throw new Error("Loft has coincident consecutive profiles.");
      }
    }

    return { params, averageLength: totalLength / usableColumns };
  }

  /**
   * The takeoff derivative per pole column at an end section. `normal` uses
   * the section's plane normal (constant across the section — the surface
   * leaves perpendicular everywhere); `tangent` uses the in-plane outward
   * direction per column (winding tangent × section normal).
   *
   * At the last section the surface *arrives* rather than departs: a normal
   * arrival still travels along the loft (no flip), but an outward-bulging
   * tangent arrival must descend back from the bulge — the in-plane
   * derivative flips inward so a positive magnitude bulges both ends outward.
   */
  static derivativeField(
    section: CompatibleSection,
    condition: LoftEndCondition,
    averageLength: number,
    isEnd: boolean,
  ): number[][] {
    const poleCount = section.poles.length;
    let scale = condition.magnitude * averageLength;

    if (condition.kind === "normal") {
      const direction = section.normal.multiply(scale);
      const vector = [direction.x, direction.y, direction.z];
      return new Array(poleCount).fill(vector);
    }

    if (isEnd) {
      scale = -scale;
    }

    // Closed sections repeat the first pole at the end; wrap around it so
    // the seam column gets the same direction from both sides.
    const field: number[][] = [];
    for (let i = 0; i < poleCount; i++) {
      const previous = section.poles[i === 0 ? poleCount - 2 : i - 1];
      const next = section.poles[i === poleCount - 1 ? 1 : i + 1];
      const tangent = new Vector3d(
        next[0] - previous[0],
        next[1] - previous[1],
        next[2] - previous[2],
      );
      let outward = tangent.cross(section.normal);
      if (outward.length() < 1e-12) {
        throw new Error("Loft tangent condition: profile winding is degenerate at a pole.");
      }
      outward = outward.normalize().multiply(scale);
      field.push([outward.x, outward.y, outward.z]);
    }
    return field;
  }

  /**
   * Builds the side surface from the pole grid, caps it with the exact
   * boundary sections (the first and last v-columns of the grid), and sews
   * everything into one correctly-oriented solid.
   */
  static buildLoftSolid(
    uBasis: LoftSurfaceBasis,
    grid: number[][][],
    vBasis: BSplineCurveData,
  ): Solid {
    const faces = Skinning.sideFaces(uBasis, grid, vBasis);
    faces.push(Skinning.capFace(uBasis, grid.map(row => row[0])));
    faces.push(Skinning.capFace(uBasis, grid.map(row => row[row.length - 1])));
    return Skinning.sewSolid(faces);
  }

  /**
   * The wall faces of a skinned grid, split at profile corners: a corner
   * buried inside one face has no edge to render, select or fillet, and its
   * mesh normals smear. Each u-range between creases (the seam is always a
   * boundary) becomes its own face; smooth profiles keep the single closed
   * face.
   */
  static sideFaces(
    uBasis: LoftSurfaceBasis,
    grid: number[][][],
    vBasis: BSplineCurveData,
  ): TopoDS_Shape[] {
    const oc = getOC();

    const [poles, disposePoles] = NCollections.toArray2Pnt(grid);
    const [uKnots, disposeUKnots] = NCollections.toArray1Double(uBasis.knots);
    const [uMults, disposeUMults] = NCollections.toArray1Int(uBasis.multiplicities);
    const [vKnots, disposeVKnots] = NCollections.toArray1Double(vBasis.knots);
    const [vMults, disposeVMults] = NCollections.toArray1Int(vBasis.multiplicities);

    let surface: Geom_BSplineSurface;
    try {
      if (uBasis.weights) {
        const weightGrid = grid.map((row, uIndex) =>
          row.map(() => uBasis.weights![uIndex]),
        );
        const [weights, disposeWeights] = NCollections.toArray2Double(weightGrid);
        try {
          surface = new oc.Geom_BSplineSurface(
            poles, weights, uKnots, vKnots, uMults, vMults,
            uBasis.degree, vBasis.degree, false, false,
          );
        } finally {
          disposeWeights();
        }
      } else {
        surface = new oc.Geom_BSplineSurface(
          poles, uKnots, vKnots, uMults, vMults,
          uBasis.degree, vBasis.degree, false, false,
        );
      }
    } finally {
      disposePoles();
      disposeUKnots();
      disposeUMults();
      disposeVKnots();
      disposeVMults();
    }

    const ranges = Skinning.uRanges(uBasis);
    const faces: TopoDS_Shape[] = [];
    for (const [from, to] of ranges) {
      let piece: Geom_BSplineSurface = surface;
      if (ranges.length > 1) {
        piece = oc.GeomConvert.SplitBSplineSurface(surface, from, to, true, 1e-9, true);
      }
      const faceMaker = new oc.BRepBuilderAPI_MakeFace(piece, Skinning.SEWING_TOLERANCE);
      const isDone = faceMaker.IsDone();
      if (isDone) {
        faces.push(faceMaker.Face());
      }
      faceMaker.delete();
      if (piece !== surface) {
        piece.delete();
      }
      if (!isDone) {
        surface.delete();
        throw new Error("Loft failed to build its side surface.");
      }
    }
    surface.delete();
    return faces;
  }

  /** Sews faces into a watertight shell and wraps it into a solid. */
  static sewSolid(faces: TopoDS_Shape[]): Solid {
    const oc = getOC();
    const sewing = new oc.BRepBuilderAPI_Sewing(Skinning.SEWING_TOLERANCE, true, true, true, false);
    for (const face of faces) {
      sewing.Add(face);
    }
    const progress = new oc.Message_ProgressRange();
    sewing.Perform(progress);
    progress.delete();

    if (sewing.NbFreeEdges() > 0) {
      sewing.delete();
      throw new Error("Loft surface and caps did not close into a watertight shell.");
    }
    const sewn = sewing.SewedShape();
    sewing.delete();

    return Skinning.solidFromShell(sewn);
  }

  /**
   * The section's exact boundary as a wire, segmented at the same crease
   * points as the wall faces so sewing pairs edges exactly.
   */
  static capWire(uBasis: LoftSurfaceBasis, poles: number[][]): TopoDS_Wire {
    const oc = getOC();
    const boundary: Geom_BSplineCurve = CurveData.build({
      poles,
      weights: uBasis.weights,
      knots: uBasis.knots,
      multiplicities: uBasis.multiplicities,
      degree: uBasis.degree,
    });

    const ranges = Skinning.uRanges(uBasis);
    const wireMaker = new oc.BRepBuilderAPI_MakeWire();
    for (const [from, to] of ranges) {
      let segment: Geom_BSplineCurve = boundary;
      if (ranges.length > 1) {
        segment = oc.GeomConvert.SplitBSplineCurve(boundary, from, to, 1e-9, true);
      }
      const edgeMaker = new oc.BRepBuilderAPI_MakeEdge(segment);
      wireMaker.Add(edgeMaker.Edge());
      edgeMaker.delete();
      if (segment !== boundary) {
        segment.delete();
      }
    }
    boundary.delete();

    const wire = wireMaker.Wire();
    wireMaker.delete();
    return wire;
  }

  /** Planar cap built from the section's exact boundary curve. */
  private static capFace(uBasis: LoftSurfaceBasis, poles: number[][]): TopoDS_Shape {
    const oc = getOC();
    const faceMaker = new oc.BRepBuilderAPI_MakeFace(Skinning.capWire(uBasis, poles), true);
    if (!faceMaker.IsDone()) {
      faceMaker.delete();
      throw new Error("Loft could not cap a profile — guided and conditioned lofts require planar profiles.");
    }
    const face = faceMaker.Face();
    faceMaker.delete();
    return face;
  }

  /** Consecutive u-ranges between profile corners; one full range when the profile is smooth. */
  private static uRanges(uBasis: LoftSurfaceBasis): [number, number][] {
    const bounds = [
      uBasis.knots[0],
      ...(uBasis.creases ?? []),
      uBasis.knots[uBasis.knots.length - 1],
    ];
    const ranges: [number, number][] = [];
    for (let i = 0; i + 1 < bounds.length; i++) {
      ranges.push([bounds[i], bounds[i + 1]]);
    }
    return ranges;
  }

  /** Wraps the sewn shell into a correctly-oriented solid. */
  private static solidFromShell(sewn: TopoDS_Shape): Solid {
    const oc = getOC();

    let shellShape = sewn;
    if (sewn.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_SHELL) {
      const shells = Explorer.findShapes(sewn, oc.TopAbs_ShapeEnum.TopAbs_SHELL as TopAbs_ShapeEnum);
      if (shells.length !== 1) {
        throw new Error("Loft sewing did not produce a single shell.");
      }
      shellShape = shells[0];
    }

    const builder = new oc.BRep_Builder();
    let solid = new oc.TopoDS_Solid();
    builder.MakeSolid(solid);
    builder.Add(solid, oc.TopoDS.Shell(shellShape));
    builder.delete();

    if (ShapeProps.getProperties(solid).volumeMm3 < 0) {
      solid = oc.TopoDS.Solid(solid.Reversed());
    }
    return Solid.fromTopoDSSolid(solid);
  }
}
