import type { Geom_BSplineCurve, TopoDS_Wire } from "ocjs-fluidcad";
import { getOC } from "../init.js";
import { Vector3d } from "../../math/vector3d.js";
import { NCollections } from "../ncollection.js";
import { SectionCurve } from "./section-curve.js";
import { CurveData } from "./curve-data.js";
import { closestCurveParameter } from "./curve-eval.js";

/** One profile as a compatible section: poles only — knots/degree/weights are shared. */
export interface CompatibleSection {
  poles: number[][];
  /** Centroid of the section (uniform parameter sampling). */
  centroid: Vector3d;
  /** Unit section normal, consistently oriented from first section towards last. */
  normal: Vector3d;
}

/**
 * Sections reduced to a common B-spline basis: every section shares the same
 * degree, knot vector, and weight vector, differing only in poles — exactly
 * the form a skinned `Geom_BSplineSurface` needs (its u-basis is this shared
 * basis; its v-poles come from interpolating matching pole columns).
 */
export interface CompatibleSections {
  degree: number;
  knots: number[];
  multiplicities: number[];
  /** Shared weight vector, or null when all sections are polynomial. */
  weights: number[] | null;
  /**
   * Interior knots where at least one section has a real tangent kink
   * (profile corners). The skinned surface must be split into separate
   * faces there — a corner buried inside one face renders with smeared
   * normals and offers no edge to select or fillet.
   */
  creases: number[];
  sections: CompatibleSection[];
}

/**
 * Brings profile wires onto a common B-spline basis for skinning:
 *
 * 1. each wire becomes a single clamped curve over [0, 1] (`SectionCurve`),
 * 2. winding directions are made consistent along the loft,
 * 3. seams are chained to the nearest point of the previous section's seam
 *    (minimal twist),
 * 4. degrees are raised and knot vectors merged to a common union,
 * 5. weight vectors must then agree across sections — when they don't (e.g.
 *    a circle lofted to a rectangle), all rational pieces are re-approximated
 *    as polynomials and the pipeline reruns once, making everything weightless.
 */
export class SectionCompatibility {
  private static readonly SAMPLES = 128;
  /** Knots closer than this (curves live on [0, 1]) are treated as one. */
  private static readonly KNOT_TOLERANCE = 1e-9;
  private static readonly WEIGHT_TOLERANCE = 1e-9;
  /** Tangent turns above this (radians) across a knot count as a profile corner. */
  private static readonly CREASE_ANGLE = 0.01;

  static build(wires: TopoDS_Wire[]): CompatibleSections {
    // Mixed rational/polynomial sections can never share a weight vector —
    // skip the doomed rational pass and go straight to the polynomial one.
    const curves = wires.map(wire => SectionCurve.fromWire(wire));
    const rationalCount = curves.filter(curve => curve.IsRational()).length;
    const mixed = rationalCount > 0 && rationalCount < curves.length;
    if (!mixed) {
      const firstTry = SectionCompatibility.buildFromCurves(curves);
      if (firstTry) {
        return firstTry;
      }
    } else {
      for (const curve of curves) {
        curve.delete();
      }
    }

    const secondTry = SectionCompatibility.buildFromCurves(
      wires.map(wire => SectionCurve.fromWire(wire, true)),
    );
    if (!secondTry) {
      throw new Error("Loft sections could not be reduced to a common rational basis.");
    }
    return secondTry;
  }

  /**
   * Re-proportions every section's parameterization so that the given
   * per-section parameters land on shared targets (their cross-section
   * averages), then re-unifies the basis. Rail-guided lofts use this to make
   * each rail's contact sit at one parameter on every profile — otherwise
   * the surface's flow lines (and any profile corner riding a rail) drift
   * away from the rail between and at the profiles.
   *
   * `sectionParams[k]` lists the contact parameters of section k, one per
   * rail, in matching order across sections. Parameters at the seam are
   * aligned already and are ignored. Returns the input unchanged when there
   * is nothing to align or when the re-unified sections would lose their
   * shared weight vector (exotic rational cases degrade gracefully).
   */
  static alignParameters(
    compatible: CompatibleSections,
    sectionParams: number[][],
  ): { compatible: CompatibleSections; targets: (number | null)[] } {
    const sectionCount = compatible.sections.length;
    const railCount = sectionParams[0].length;
    const noTargets = new Array<number | null>(railCount).fill(null);

    // Rails aligned by the seam itself (or wrapping across it on some
    // profile) are left alone; only rails interior on every profile move.
    const interior = (u: number) => u > 1e-4 && u < 1 - 1e-4;
    const interiorRails: number[] = [];
    for (let g = 0; g < railCount; g++) {
      if (sectionParams.every(params => interior(params[g]))) {
        interiorRails.push(g);
      }
    }
    if (interiorRails.length === 0) {
      return { compatible, targets: noTargets };
    }
    interiorRails.sort((a, b) => sectionParams[0][a] - sectionParams[0][b]);

    // Rails must keep the same order around every profile.
    const splits = sectionParams.map(params => interiorRails.map(g => params[g]));
    for (const params of splits) {
      for (let j = 1; j < params.length; j++) {
        if (params[j] <= params[j - 1]) {
          return { compatible, targets: noTargets };
        }
      }
    }

    const targets = interiorRails.map((_, j) =>
      splits.reduce((sum, params) => sum + params[j], 0) / sectionCount,
    );
    const railTargets: (number | null)[] = [...noTargets];
    interiorRails.forEach((g, j) => {
      railTargets[g] = targets[j];
    });

    const aligned = splits.every(params =>
      params.every((u, j) => Math.abs(u - targets[j]) < SectionCompatibility.KNOT_TOLERANCE),
    );
    if (aligned) {
      return { compatible, targets: railTargets };
    }

    const oc = getOC();
    const curves = compatible.sections.map((section, k) => {
      const curve = CurveData.build({
        poles: section.poles,
        weights: compatible.weights,
        knots: compatible.knots,
        multiplicities: compatible.multiplicities,
        degree: compatible.degree,
      });

      const bounds = [0, ...splits[k], 1];
      const pieces: Geom_BSplineCurve[] = [];
      for (let i = 0; i + 1 < bounds.length; i++) {
        pieces.push(oc.GeomConvert.SplitBSplineCurve(curve, bounds[i], bounds[i + 1], 1e-9, true));
      }
      curve.delete();

      const targetSpans = [targets[0], ...targets.slice(1).map((t, j) => t - targets[j]), 1 - targets[targets.length - 1]];
      const reproportioned = SectionCurve.concatenate(pieces, true, targetSpans);
      for (const piece of pieces) {
        piece.delete();
      }
      return reproportioned;
    });

    const rebuilt = SectionCompatibility.rebuildAligned(curves, compatible);
    if (!rebuilt) {
      return { compatible, targets: noTargets };
    }
    return { compatible: rebuilt, targets: railTargets };
  }

  /** Re-unifies re-proportioned section curves, keeping the original frames. */
  private static rebuildAligned(
    curves: Geom_BSplineCurve[],
    original: CompatibleSections,
  ): CompatibleSections | null {
    try {
      SectionCompatibility.unifyDegree(curves);
      SectionCompatibility.unifyKnots(curves);

      const datas = curves.map(curve => CurveData.read(curve));
      const poleCount = datas[0].poles.length;
      for (const data of datas) {
        if (data.poles.length !== poleCount) {
          return null;
        }
      }

      const weights = SectionCompatibility.sharedWeights(datas.map(data => data.weights), poleCount);
      if (weights === undefined) {
        return null;
      }

      return {
        degree: datas[0].degree,
        knots: datas[0].knots,
        multiplicities: datas[0].multiplicities,
        weights,
        creases: SectionCompatibility.detectCreases(curves),
        sections: datas.map((data, i) => ({
          poles: data.poles,
          centroid: original.sections[i].centroid,
          normal: original.sections[i].normal,
        })),
      };
    } finally {
      for (const curve of curves) {
        curve.delete();
      }
    }
  }

  /** Returns null when the sections end up with mismatched weight vectors. */
  private static buildFromCurves(curves: Geom_BSplineCurve[]): CompatibleSections | null {
    try {
      const frames = SectionCompatibility.orientConsistently(curves);
      SectionCompatibility.alignSeams(curves);
      SectionCompatibility.unifyDegree(curves);
      SectionCompatibility.unifyKnots(curves);

      const datas = curves.map(curve => CurveData.read(curve));

      const poleCount = datas[0].poles.length;
      for (const data of datas) {
        if (data.poles.length !== poleCount) {
          throw new Error("Loft internal error: unified sections have differing pole counts.");
        }
      }

      const weights = SectionCompatibility.sharedWeights(datas.map(data => data.weights), poleCount);
      if (weights === undefined) {
        return null;
      }

      return {
        degree: datas[0].degree,
        knots: datas[0].knots,
        multiplicities: datas[0].multiplicities,
        weights,
        creases: SectionCompatibility.detectCreases(curves),
        sections: datas.map((data, i) => ({
          poles: data.poles,
          centroid: frames[i].centroid,
          normal: frames[i].normal,
        })),
      };
    } finally {
      for (const curve of curves) {
        curve.delete();
      }
    }
  }

  /**
   * The shared weight vector: null if every section is polynomial, the common
   * vector if all rational sections agree (after normalizing to weight 1 on
   * the first pole), and undefined — "no shared basis" — otherwise.
   */
  private static sharedWeights(
    weightVectors: (number[] | null)[],
    poleCount: number,
  ): number[] | null | undefined {
    if (weightVectors.every(w => w === null)) {
      return null;
    }

    const normalized = weightVectors.map(w => {
      if (w === null) {
        return new Array<number>(poleCount).fill(1);
      }
      const scale = 1 / w[0];
      return w.map(value => value * scale);
    });

    const reference = normalized[0];
    for (const candidate of normalized) {
      for (let i = 0; i < poleCount; i++) {
        if (Math.abs(candidate[i] - reference[i]) > SectionCompatibility.WEIGHT_TOLERANCE) {
          return undefined;
        }
      }
    }
    if (reference.every(w => Math.abs(w - 1) < SectionCompatibility.WEIGHT_TOLERANCE)) {
      return null;
    }
    return reference;
  }

  /**
   * Makes all sections wind the same way along the loft: the first section's
   * normal (from its winding, via Newell's method) is oriented towards the
   * next centroid, then each further section is flipped whenever its winding
   * normal opposes its predecessor's. Reversing the curve flips its normal.
   */
  private static orientConsistently(
    curves: Geom_BSplineCurve[],
  ): { centroid: Vector3d; normal: Vector3d }[] {
    const frames = curves.map(curve => SectionCompatibility.sectionFrame(curve));

    if (curves.length > 1) {
      const advance = frames[1].centroid.subtract(frames[0].centroid);
      if (advance.length() > 1e-9 && frames[0].normal.dot(advance) < 0) {
        curves[0].Reverse();
        frames[0] = { ...frames[0], normal: frames[0].normal.multiply(-1) };
      }
    }

    for (let i = 1; i < curves.length; i++) {
      if (frames[i].normal.dot(frames[i - 1].normal) < 0) {
        curves[i].Reverse();
        frames[i] = { ...frames[i], normal: frames[i].normal.multiply(-1) };
      }
    }

    return frames;
  }

  /** Centroid and winding normal (Newell's method) from uniform parameter samples. */
  private static sectionFrame(curve: Geom_BSplineCurve): { centroid: Vector3d; normal: Vector3d } {
    const points = SectionCompatibility.samplePoints(curve, SectionCompatibility.SAMPLES);

    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const p of points) {
      cx += p[0];
      cy += p[1];
      cz += p[2];
    }
    const centroid = new Vector3d(cx / points.length, cy / points.length, cz / points.length);

    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const ax = a[0] - centroid.x;
      const ay = a[1] - centroid.y;
      const az = a[2] - centroid.z;
      const bx = b[0] - centroid.x;
      const by = b[1] - centroid.y;
      const bz = b[2] - centroid.z;
      nx += ay * bz - az * by;
      ny += az * bx - ax * bz;
      nz += ax * by - ay * bx;
    }
    const normal = new Vector3d(nx, ny, nz);
    if (normal.length() < 1e-12) {
      throw new Error("Loft profile is degenerate (no measurable winding).");
    }

    return { centroid, normal: normal.normalize() };
  }

  /**
   * Chains each section's seam (curve origin) to the point nearest the
   * previous section's seam, so the skinned surface doesn't twist. Closed
   * clamped curves can't shift their origin in place; the curve is split at
   * the new seam and re-concatenated.
   */
  private static alignSeams(curves: Geom_BSplineCurve[]) {
    const oc = getOC();
    const seam = new oc.gp_Pnt();
    curves[0].D0(0, seam);
    let reference: number[] = [seam.X(), seam.Y(), seam.Z()];
    seam.delete();

    for (let i = 1; i < curves.length; i++) {
      const t = SectionCompatibility.closestParameter(curves[i], reference);
      curves[i] = SectionCompatibility.moveSeam(curves[i], t);

      const point = new oc.gp_Pnt();
      curves[i].D0(0, point);
      reference = [point.X(), point.Y(), point.Z()];
      point.delete();
    }
  }

  /** Parameter of the point on the curve closest to `target` (sampling + golden-section refine). */
  private static closestParameter(curve: Geom_BSplineCurve, target: number[]): number {
    const oc = getOC();
    const point = new oc.gp_Pnt();
    const result = closestCurveParameter(t => {
      curve.D0(t, point);
      return [point.X(), point.Y(), point.Z()];
    }, target);
    point.delete();
    return result;
  }

  /**
   * Returns the curve re-parameterized so its origin sits at parameter `t`
   * (splitting and re-concatenating), consuming the input. No-op near the
   * existing seam.
   */
  private static moveSeam(curve: Geom_BSplineCurve, t: number): Geom_BSplineCurve {
    const oc = getOC();
    if (t < 1e-6 || t > 1 - 1e-6) {
      return curve;
    }

    const tail = oc.GeomConvert.SplitBSplineCurve(curve, t, 1, 1e-9, true);
    const head = oc.GeomConvert.SplitBSplineCurve(curve, 0, t, 1e-9, true);
    const moved = SectionCurve.concatenate([tail, head], true);
    tail.delete();
    head.delete();
    curve.delete();
    return moved;
  }

  private static unifyDegree(curves: Geom_BSplineCurve[]) {
    const degree = Math.max(...curves.map(curve => curve.Degree()));
    for (const curve of curves) {
      if (curve.Degree() < degree) {
        curve.IncreaseDegree(degree);
      }
    }
  }

  /**
   * Merges every section's interior knots into one union (values clustered
   * within `KNOT_TOLERANCE` are snapped to a single representative first)
   * and inserts the union into each curve, so all sections share one knot
   * vector — and therefore one pole count.
   */
  private static unifyKnots(curves: Geom_BSplineCurve[]) {
    const degree = curves[0].Degree();

    // Cluster interior knot values across sections.
    const allKnots: number[] = [];
    for (const curve of curves) {
      for (let i = 2; i < curve.NbKnots(); i++) {
        allKnots.push(curve.Knot(i));
      }
    }
    allKnots.sort((a, b) => a - b);
    const representatives: number[] = [];
    for (const knot of allKnots) {
      if (
        representatives.length === 0
        || knot - representatives[representatives.length - 1] > SectionCompatibility.KNOT_TOLERANCE
      ) {
        representatives.push(knot);
      }
    }

    // Snap each curve's interior knots to their cluster representative.
    for (const curve of curves) {
      for (let i = 2; i < curve.NbKnots(); i++) {
        const knot = curve.Knot(i);
        const representative = SectionCompatibility.nearestRepresentative(representatives, knot);
        if (
          representative !== knot
          && representative > curve.Knot(i - 1)
          && representative < curve.Knot(i + 1)
        ) {
          curve.SetKnot(i, representative);
        }
      }
    }

    // Union multiplicities per representative, then insert into every curve.
    const targetMults = representatives.map(representative => {
      let mult = 1;
      for (const curve of curves) {
        for (let i = 2; i < curve.NbKnots(); i++) {
          if (Math.abs(curve.Knot(i) - representative) <= SectionCompatibility.KNOT_TOLERANCE) {
            mult = Math.max(mult, curve.Multiplicity(i));
          }
        }
      }
      return Math.min(mult, degree);
    });

    if (representatives.length === 0) {
      return;
    }

    for (const curve of curves) {
      const [knots, disposeKnots] = NCollections.toArray1Double(representatives);
      const [mults, disposeMults] = NCollections.toArray1Int(targetMults);
      curve.InsertKnots(knots, mults, SectionCompatibility.KNOT_TOLERANCE, false);
      disposeKnots();
      disposeMults();
    }
  }

  /**
   * Interior knots where any section makes a real corner: only knots of full
   * multiplicity (structurally C0) can, and the tangent turn across them is
   * measured on every section — profile corners turn by degrees, while
   * smooth junctions from concatenation or seam moves turn by ~0.
   */
  private static detectCreases(curves: Geom_BSplineCurve[]): number[] {
    const oc = getOC();
    const degree = curves[0].Degree();
    const point = new oc.gp_Pnt();
    const vector = new oc.gp_Vec();

    const tangentAt = (curve: Geom_BSplineCurve, t: number): Vector3d => {
      curve.D1(t, point, vector);
      return new Vector3d(vector.X(), vector.Y(), vector.Z()).normalize();
    };

    const creases: number[] = [];
    for (let i = 2; i < curves[0].NbKnots(); i++) {
      if (curves[0].Multiplicity(i) < degree) {
        continue;
      }
      const knot = curves[0].Knot(i);
      const step = Math.min(knot - curves[0].Knot(i - 1), curves[0].Knot(i + 1) - knot) * 1e-3;

      for (const curve of curves) {
        const angle = Math.acos(Math.min(1, Math.max(-1,
          tangentAt(curve, knot - step).dot(tangentAt(curve, knot + step)),
        )));
        if (angle > SectionCompatibility.CREASE_ANGLE) {
          creases.push(knot);
          break;
        }
      }
    }

    point.delete();
    vector.delete();
    return creases;
  }

  private static nearestRepresentative(representatives: number[], value: number): number {
    let best = value;
    let bestDistance = Infinity;
    for (const representative of representatives) {
      const distance = Math.abs(representative - value);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = representative;
      }
    }
    return bestDistance <= SectionCompatibility.KNOT_TOLERANCE ? best : value;
  }

  private static samplePoints(curve: Geom_BSplineCurve, count: number): number[][] {
    const oc = getOC();
    const point = new oc.gp_Pnt();
    const points: number[][] = [];
    for (let i = 0; i < count; i++) {
      curve.D0(i / count, point);
      points.push([point.X(), point.Y(), point.Z()]);
    }
    point.delete();
    return points;
  }
}
