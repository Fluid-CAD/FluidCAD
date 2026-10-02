import type { Geom_BSplineCurve, Geom_BSplineSurface, TopoDS_Shape, TopoDS_Wire, TopAbs_ShapeEnum } from "ocjs-fluidcad";
import { getOC } from "../init.js";
import { Explorer } from "../explorer.js";
import { ShapeProps } from "../props.js";
import { NCollections } from "../ncollection.js";
import { interpolateWithDerivatives, BSplineCurveData } from "../../math/bspline-interpolation.js";
import { Solid } from "../../common/solid.js";
import { SectionCompatibility, CompatibleSections, CompatibleSection } from "./section-compatibility.js";
import { CurveData } from "./curve-data.js";
import { TakeoffField } from "./takeoff-field.js";
import { mmTol } from "../../units/tolerance.js";

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
  /** Interior u-knots with a real profile corner — the wall is always split into faces there. */
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
 * boundary caps into a sewn solid. Used by `SkinnedLoft` (plain lofts,
 * connections, conditions) and `GuidedLoft` (virtual sections along rails).
 */
export class Skinning {
  /** 1e-6 mm, in the active unit. */
  private static get SEWING_TOLERANCE(): number {
    return mmTol(1e-6);
  }
  /** Knots closer than this (sections live on [0, 1]) are treated as one. */
  private static readonly KNOT_TOLERANCE = 1e-9;
  /** How many times a span may be halved for a tangent condition's takeoff field. */
  private static readonly TAKEOFF_REFINEMENTS = 6;

  /**
   * The sections on a basis fine enough for their `tangent` conditions: the
   * takeoff field of an end section is blended by the section's own basis,
   * and a span too wide to carry it (one span is a whole ellipse) is halved
   * until it can. Circles and polygons carry theirs exactly and are left
   * alone, as is everything without a tangent condition.
   */
  static refineForConditions(
    compatible: CompatibleSections,
    startCondition?: LoftEndCondition,
    endCondition?: LoftEndCondition,
  ): CompatibleSections {
    const ends = [
      startCondition?.kind === "tangent" ? 0 : -1,
      endCondition?.kind === "tangent" ? compatible.sections.length - 1 : -1,
    ].filter(index => index >= 0);

    for (let round = 0; round < Skinning.TAKEOFF_REFINEMENTS; round++) {
      const coarse = new Set<number>();
      for (const index of ends) {
        const section = compatible.sections[index];
        for (const knot of TakeoffField.coarseSpans({ ...compatible, poles: section.poles }, section.normal)) {
          coarse.add(knot);
        }
      }
      if (coarse.size === 0) {
        break;
      }
      compatible = SectionCompatibility.insertKnots(compatible, [...coarse].sort((a, b) => a - b));
    }
    return compatible;
  }

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
      ? Skinning.derivativeField(compatible, sections[0], startCondition, averageLength, false)
      : null;
    const endField = endCondition
      ? Skinning.derivativeField(compatible, sections[sections.length - 1], endCondition, averageLength, true)
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
    const singleCondition = (startField !== null) !== (endField !== null);
    const grid: number[][][] = [];
    let vBasis: BSplineCurveData | null = null;
    for (let i = 0; i < poleCount; i++) {
      const column = sections.map(section => section[i]);
      let startDerivative = startField?.[i];
      let endDerivative = endField?.[i];
      if (singleCondition) {
        // Keep the unconstrained end's automatic takeoff. With three
        // profiles, a lone derivative otherwise fits one global cubic:
        // satisfying the constrained end can throw the opposite tangent
        // outward and balloon that span. Retaining its original derivative
        // adds the degree of freedom needed to accommodate the condition
        // while still interpolating every section with C2 continuity.
        const automatic = interpolateWithDerivatives(column, params);
        if (!startDerivative) {
          startDerivative = Skinning.endpointDerivative(automatic, false);
        }
        if (!endDerivative) {
          endDerivative = Skinning.endpointDerivative(automatic, true);
        }
      }
      const interpolated = interpolateWithDerivatives(
        column,
        params,
        startDerivative,
        endDerivative,
      );
      grid.push(interpolated.poles);
      vBasis = interpolated;
    }
    return { grid, vBasis: vBasis! };
  }

  /** Exact endpoint derivative of the clamped, polynomial column curve. */
  private static endpointDerivative(curve: BSplineCurveData, isEnd: boolean): number[] {
    const { poles, knots, degree } = curve;
    const last = poles.length - 1;
    const a = poles[isEnd ? last - 1 : 0];
    const b = poles[isEnd ? last : 1];
    const span = isEnd ? knots[knots.length - 1] - knots[knots.length - 2] : knots[1] - knots[0];
    return a.map((value, d) => (b[d] - value) * degree / span);
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
   * leaves perpendicular everywhere); `tangent` leaves inside the section's
   * plane, outward along the profile's own normal (`TakeoffField`).
   *
   * At the last section the surface *arrives* rather than departs: a normal
   * arrival still travels along the loft (no flip), but an outward-bulging
   * tangent arrival must descend back from the bulge — the in-plane
   * derivative flips inward so a positive magnitude bulges both ends outward.
   */
  static derivativeField(
    uBasis: LoftSurfaceBasis,
    section: CompatibleSection,
    condition: LoftEndCondition,
    averageLength: number,
    isEnd: boolean,
  ): number[][] {
    const scale = condition.magnitude * averageLength;

    if (condition.kind === "normal") {
      const direction = section.normal.multiply(scale);
      const vector = [direction.x, direction.y, direction.z];
      return new Array(section.poles.length).fill(vector);
    }

    return TakeoffField.outward({
      degree: uBasis.degree,
      knots: uBasis.knots,
      multiplicities: uBasis.multiplicities,
      weights: uBasis.weights,
      poles: section.poles,
    }, section.normal, isEnd ? -scale : scale);
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
    ({ uBasis, grid } = Skinning.relaxSmoothKnots(uBasis, grid, vBasis));
    const faces = Skinning.sideFaces(uBasis, grid, vBasis);
    faces.push(Skinning.capFace(uBasis, grid.map(row => row[0])));
    faces.push(Skinning.capFace(uBasis, grid.map(row => row[row.length - 1])));
    return Skinning.sewSolid(faces);
  }

  /** The wall surface of a skinned grid: the section basis in u, the column basis in v. */
  private static wallSurface(
    uBasis: LoftSurfaceBasis,
    grid: number[][][],
    vBasis: BSplineCurveData,
  ): Geom_BSplineSurface {
    const oc = getOC();
    const [poles, disposePoles] = NCollections.toArray2Pnt(grid);
    const [uKnots, disposeUKnots] = NCollections.toArray1Double(uBasis.knots);
    const [uMults, disposeUMults] = NCollections.toArray1Int(uBasis.multiplicities);
    const [vKnots, disposeVKnots] = NCollections.toArray1Double(vBasis.knots);
    const [vMults, disposeVMults] = NCollections.toArray1Int(vBasis.multiplicities);

    try {
      if (uBasis.weights) {
        const weightGrid = grid.map((row, uIndex) =>
          row.map(() => uBasis.weights![uIndex]),
        );
        const [weights, disposeWeights] = NCollections.toArray2Double(weightGrid);
        try {
          return new oc.Geom_BSplineSurface(
            poles, weights, uKnots, vKnots, uMults, vMults,
            uBasis.degree, vBasis.degree, false, false,
          );
        } finally {
          disposeWeights();
        }
      }
      return new oc.Geom_BSplineSurface(
        poles, uKnots, vKnots, uMults, vMults,
        uBasis.degree, vBasis.degree, false, false,
      );
    } finally {
      disposePoles();
      disposeUKnots();
      disposeUMults();
      disposeVKnots();
      disposeVMults();
    }
  }

  /**
   * Lowers each smooth C0 u-knot as far as the wall allows: a vertex between
   * edges of one conic disappears altogether, the old start of a closed
   * curve whose seam moved keeps only the multiplicity the curve's own
   * continuity needs. Such a knot is bookkeeping, not shape, and left at
   * full multiplicity it would cost a face split (see `sideFaces`). Poles
   * move by less than the sewing tolerance, and the caps are cut from the
   * same relaxed grid. Creases are kept, and so is any knot the wall really
   * is only G1 across.
   */
  static relaxSmoothKnots(
    uBasis: LoftSurfaceBasis,
    grid: number[][][],
    vBasis: BSplineCurveData,
  ): { uBasis: LoftSurfaceBasis; grid: number[][][] } {
    const creases = uBasis.creases ?? [];
    const candidates: number[] = [];
    for (let i = 1; i < uBasis.knots.length - 1; i++) {
      if (uBasis.multiplicities[i] >= uBasis.degree
        && !creases.some(crease => Math.abs(crease - uBasis.knots[i]) <= Skinning.KNOT_TOLERANCE)) {
        candidates.push(i);
      }
    }
    if (candidates.length === 0) {
      return { uBasis, grid };
    }

    const surface = Skinning.wallSurface(uBasis, grid, vBasis);
    try {
      let relaxed = false;
      // Highest index first: a knot removed outright shifts the ones after it.
      for (const i of candidates.reverse()) {
        for (let multiplicity = 0; multiplicity < uBasis.degree; multiplicity++) {
          if (surface.RemoveUKnot(i + 1, multiplicity, Skinning.SEWING_TOLERANCE / 10)) {
            relaxed = true;
            break;
          }
        }
      }
      if (!relaxed) {
        return { uBasis, grid };
      }

      const knots: number[] = [];
      const multiplicities: number[] = [];
      for (let i = 1; i <= surface.NbUKnots(); i++) {
        knots.push(surface.UKnot(i));
        multiplicities.push(surface.UMultiplicity(i));
      }
      const relaxedGrid: number[][][] = [];
      const weights: number[] | null = uBasis.weights ? [] : null;
      for (let i = 1; i <= surface.NbUPoles(); i++) {
        const row: number[][] = [];
        for (let j = 1; j <= surface.NbVPoles(); j++) {
          const pole = surface.Pole(i, j);
          row.push([pole.X(), pole.Y(), pole.Z()]);
          pole.delete();
        }
        relaxedGrid.push(row);
        weights?.push(surface.Weight(i, 1));
      }
      return {
        uBasis: { degree: uBasis.degree, knots, multiplicities, weights, creases },
        grid: relaxedGrid,
      };
    } finally {
      surface.delete();
    }
  }

  /**
   * The wall faces of a skinned grid, one per u-range between splits (the
   * seam is always a boundary); a smooth closed profile keeps the single
   * closed face. The wall is split
   *
   * - at creases: a corner buried inside one face has no edge to render,
   *   select or fillet, and its mesh normals smear;
   * - at any other knot left C0 after `relaxSmoothKnots`: OCC's offset
   *   refuses a face whose surface is formally C0 — a shell fails at every
   *   thickness — however smooth the wall is there. With conics kept to one
   *   span this is a smooth joint between two different profile edges.
   */
  static sideFaces(
    uBasis: LoftSurfaceBasis,
    grid: number[][][],
    vBasis: BSplineCurveData,
  ): TopoDS_Shape[] {
    const oc = getOC();
    const surface = Skinning.wallSurface(uBasis, grid, vBasis);

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

  /** Interior u-values the wall is split at: the creases and every knot still C0, ascending. */
  private static splitKnots(uBasis: LoftSurfaceBasis): number[] {
    const splits = [...(uBasis.creases ?? [])];
    for (let i = 1; i < uBasis.knots.length - 1; i++) {
      const knot = uBasis.knots[i];
      if (uBasis.multiplicities[i] >= uBasis.degree
        && !splits.some(split => Math.abs(split - knot) <= Skinning.KNOT_TOLERANCE)) {
        splits.push(knot);
      }
    }
    return splits.sort((a, b) => a - b);
  }

  /** Consecutive u-ranges between splits; one full range when the section basis is C1 throughout. */
  private static uRanges(uBasis: LoftSurfaceBasis): [number, number][] {
    const bounds = [
      uBasis.knots[0],
      ...Skinning.splitKnots(uBasis),
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
