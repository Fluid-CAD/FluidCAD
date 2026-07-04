import { Vector3d } from "../../math/vector3d.js";
import { findSpan, basisFunctions } from "../../math/bspline-interpolation.js";
import { Wire } from "../../common/wire.js";
import { Solid } from "../../common/solid.js";
import { SectionCompatibility, CompatibleSections } from "./section-compatibility.js";
import { SectionCurve } from "./section-curve.js";
import { CurveData, RationalBSplineData } from "./curve-data.js";
import { Skinning, SkinnedGrid, LoftEndCondition } from "./skinning.js";
import { evaluateBSplinePoint, closestCurveParameter, flattenKnots } from "./curve-eval.js";

/** Where a guide meets one profile: guide parameter, section parameter, and the guide point. */
interface GuideAnchor {
  t: number;
  u: number;
  point: number[];
}

/**
 * Loft steered by one or two side rails. OCC's pipe-shell machinery distorts
 * pinned sections along curved rails (they tilt with the sweep frame, and
 * the auxiliary-spine contact mode rotates and smears non-circular sections),
 * so this path builds the surface itself:
 *
 * 1. skin the profiles alone (`Skinning`) — the unguided base surface,
 * 2. slice the base into virtual sections between the profiles,
 * 3. move each virtual section rigidly so its rail-contact point rides the
 *    guide (one rail), or map its two contact points onto both rails with a
 *    rotation + axial stretch (two rails) — profiles themselves stay exact,
 * 4. re-skin through the full stack and cap/sew into a solid.
 *
 * Guides must pass through every profile: sections are pinned where they
 * were sketched, so a rail that misses a profile is unsatisfiable.
 *
 * Start/end conditions compose with guides: the condition's takeoff field
 * fades smoothly to the natural (unconstrained) takeoff around each guide's
 * contact point — the rails own their sides of the surface, the condition
 * shapes the rest. The faded fields drive both the base skin (so the
 * virtual sections carry the conditioned shape) and the final re-skin (so
 * the takeoff is pinned exactly where the condition is in force).
 */
export class GuidedLoft {
  /** Virtual sections inserted between consecutive profiles. */
  private static readonly SECTIONS_PER_SPAN = 7;
  /** How far (mm) a guide may sit from a profile boundary and still count as touching. */
  private static readonly CONTACT_TOLERANCE = 1e-3;
  /** Fallback condition-falloff radius (in section parameter) for a single guide. */
  private static readonly SINGLE_GUIDE_FALLOFF = 0.25;

  static build(
    profileWires: Wire[],
    guideWires: Wire[],
    startCondition?: LoftEndCondition,
    endCondition?: LoftEndCondition,
  ): Solid[] {
    if (guideWires.length < 1 || guideWires.length > 2) {
      throw new Error("Guided loft supports one or two guide curves.");
    }
    for (const wire of profileWires) {
      if (!wire.isClosed()) {
        throw new Error("Loft with guides requires closed profiles.");
      }
    }

    const compatible = SectionCompatibility.build(profileWires.map(w => w.getShape()));

    const guides = guideWires.map(wire => {
      const curve = SectionCurve.fromWire(wire.getShape());
      const data = CurveData.read(curve);
      curve.delete();
      return data;
    });
    const anchors = guides.map((guide, guideIndex) =>
      GuidedLoft.anchorGuide(guide, guideIndex, compatible),
    );

    const base = GuidedLoft.skinBase(compatible, anchors, startCondition, endCondition);
    const { sections, params } = GuidedLoft.buildSectionStack(compatible, base, guides, anchors);
    const skinned = Skinning.interpolateColumns(
      sections,
      params,
      GuidedLoft.stackField(compatible, anchors, startCondition, base.averageLength, sections, params, false),
      GuidedLoft.stackField(compatible, anchors, endCondition, base.averageLength, sections, params, true),
    );
    return [Skinning.buildLoftSolid(compatible, skinned.grid, skinned.vBasis)];
  }

  /**
   * The unguided base skin, with any end conditions already faded around the
   * guide contacts (blended towards the natural chord takeoff, per column).
   */
  private static skinBase(
    compatible: CompatibleSections,
    anchors: GuideAnchor[][],
    startCondition: LoftEndCondition | undefined,
    endCondition: LoftEndCondition | undefined,
  ): SkinnedGrid {
    const { sections } = compatible;
    const { params, averageLength } = Skinning.loftParameters(sections);
    const columns = sections.map(section => section.poles);

    const startField = GuidedLoft.stackField(
      compatible, anchors, startCondition, averageLength, columns, params, false,
    );
    const endField = GuidedLoft.stackField(
      compatible, anchors, endCondition, averageLength, columns, params, true,
    );

    const { grid, vBasis } = Skinning.interpolateColumns(columns, params, startField, endField);
    return { grid, vBasis, params, averageLength };
  }

  /**
   * The condition's takeoff field for one end of a section stack, faded to
   * the stack's own natural takeoff (the chord to the neighbouring section)
   * around each guide contact. Null when no condition applies to that end.
   */
  private static stackField(
    compatible: CompatibleSections,
    anchors: GuideAnchor[][],
    condition: LoftEndCondition | undefined,
    averageLength: number,
    sections: number[][][],
    params: number[],
    isEnd: boolean,
  ): number[][] | null {
    if (!condition) {
      return null;
    }

    const endIndex = isEnd ? compatible.sections.length - 1 : 0;
    const conditionField = Skinning.derivativeField(
      compatible.sections[endIndex], condition, averageLength, isEnd,
    );

    const contacts = anchors.map(anchor => {
      const u = anchor[endIndex].u;
      return ((u % 1) + 1) % 1;
    });
    const weights = GuidedLoft.falloffWeights(compatible, contacts);

    const last = sections.length - 1;
    const [nearIndex, farIndex] = isEnd ? [last, last - 1] : [0, 1];
    const chordSpan = Math.abs(params[nearIndex] - params[farIndex]);

    return conditionField.map((target, i) => {
      // Natural takeoff: the chord towards the neighbouring stack section
      // (points along increasing v at both ends).
      const natural = sections[nearIndex][i].map((v, d) =>
        ((isEnd ? v - sections[farIndex][i][d] : sections[farIndex][i][d] - v)) / chordSpan,
      );
      const w = weights[i];
      return target.map((t, d) => natural[d] + (t - natural[d]) * w);
    });
  }

  /**
   * Per-column condition weight: 0 at each guide contact, smoothstepping to
   * 1 beyond the falloff radius (half the closest contact separation for two
   * guides). Columns are located by their Greville parameters.
   */
  private static falloffWeights(compatible: CompatibleSections, contacts: number[]): number[] {
    const circularDistance = (a: number, b: number) => {
      const d = Math.abs(a - b) % 1;
      return Math.min(d, 1 - d);
    };

    let radius = GuidedLoft.SINGLE_GUIDE_FALLOFF;
    for (let a = 0; a < contacts.length; a++) {
      for (let b = a + 1; b < contacts.length; b++) {
        radius = Math.min(radius, circularDistance(contacts[a], contacts[b]) / 2);
      }
    }
    radius = Math.max(radius, 0.05);

    const flat = flattenKnots(compatible.knots, compatible.multiplicities);
    const degree = compatible.degree;
    const poleCount = compatible.sections[0].poles.length;

    const weights: number[] = [];
    for (let i = 0; i < poleCount; i++) {
      let greville = 0;
      for (let j = 1; j <= degree; j++) {
        greville += flat[i + j];
      }
      greville /= degree;
      const wrapped = ((greville % 1) + 1) % 1;

      let distance = Infinity;
      for (const contact of contacts) {
        distance = Math.min(distance, circularDistance(wrapped, contact));
      }
      const t = Math.min(1, Math.max(0, distance / radius));
      weights.push(t * t * (3 - 2 * t));
    }
    return weights;
  }

  /**
   * Locates the guide's contact with every profile: the guide parameter
   * where it crosses the profile plane, and the profile parameter of the
   * nearest boundary point. Off-boundary rails are reported with their gap —
   * sections stay where they were sketched, so such rails are unsatisfiable.
   */
  private static anchorGuide(
    guide: RationalBSplineData,
    guideIndex: number,
    compatible: CompatibleSections,
  ): GuideAnchor[] {
    const anchors: GuideAnchor[] = [];

    for (let k = 0; k < compatible.sections.length; k++) {
      const section = compatible.sections[k];
      const t = GuidedLoft.planeCrossing(guide, section.centroid, section.normal);
      if (t === null) {
        throw new Error(
          `Loft guide ${guideIndex + 1} does not cross the plane of profile ${k + 1} — `
          + "each guide must pass through every profile.",
        );
      }
      const point = evaluateBSplinePoint(guide, t);

      const sectionCurve = {
        degree: compatible.degree,
        knots: compatible.knots,
        multiplicities: compatible.multiplicities,
        poles: section.poles,
        weights: compatible.weights,
      };
      let u = closestCurveParameter(tt => evaluateBSplinePoint(sectionCurve, tt), point);
      const boundaryPoint = evaluateBSplinePoint(sectionCurve, u);
      const gap = Math.hypot(
        boundaryPoint[0] - point[0],
        boundaryPoint[1] - point[1],
        boundaryPoint[2] - point[2],
      );
      if (gap > GuidedLoft.CONTACT_TOLERANCE) {
        throw new Error(
          `Loft guide ${guideIndex + 1} does not touch profile ${k + 1} `
          + `(gap ${gap.toFixed(3)} mm) — guides must pass through every profile boundary.`,
        );
      }

      // Sections are closed in u — unwrap so per-span interpolation of the
      // contact parameter never jumps across the seam.
      if (k > 0) {
        while (u - anchors[k - 1].u > 0.5) {
          u -= 1;
        }
        while (u - anchors[k - 1].u < -0.5) {
          u += 1;
        }
      }

      anchors.push({ t, u, point });
    }

    return anchors;
  }

  /**
   * Guide parameter where the guide crosses the plane (centroid, normal):
   * the sign-change bracket (or on-plane endpoint) whose crossing point lies
   * closest to the centroid, refined by bisection. Null when the guide never
   * reaches the plane.
   */
  private static planeCrossing(
    guide: RationalBSplineData,
    centroid: Vector3d,
    normal: Vector3d,
  ): number | null {
    const signedDistance = (t: number) => {
      const p = evaluateBSplinePoint(guide, t);
      return (p[0] - centroid.x) * normal.x + (p[1] - centroid.y) * normal.y + (p[2] - centroid.z) * normal.z;
    };

    const samples = 256;
    const values: number[] = [];
    for (let i = 0; i <= samples; i++) {
      values.push(signedDistance(i / samples));
    }

    const candidates: number[] = [];
    if (Math.abs(values[0]) <= GuidedLoft.CONTACT_TOLERANCE) {
      candidates.push(0);
    }
    if (Math.abs(values[samples]) <= GuidedLoft.CONTACT_TOLERANCE) {
      candidates.push(1);
    }
    for (let i = 0; i < samples; i++) {
      if (values[i] === 0 || values[i] * values[i + 1] < 0) {
        let low = i / samples;
        let high = (i + 1) / samples;
        let lowValue = values[i];
        for (let iteration = 0; iteration < 60; iteration++) {
          const mid = (low + high) / 2;
          const midValue = signedDistance(mid);
          if (lowValue * midValue <= 0) {
            high = mid;
          } else {
            low = mid;
            lowValue = midValue;
          }
        }
        candidates.push((low + high) / 2);
      }
    }

    let best: number | null = null;
    let bestDistance = Infinity;
    for (const t of candidates) {
      const p = evaluateBSplinePoint(guide, t);
      const distance = Math.hypot(p[0] - centroid.x, p[1] - centroid.y, p[2] - centroid.z);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = t;
      }
    }
    return best;
  }

  /**
   * The full section stack: the exact profiles at their own parameters, and
   * between each pair the base surface's iso-sections carried onto the rails.
   */
  private static buildSectionStack(
    compatible: CompatibleSections,
    base: SkinnedGrid,
    guides: RationalBSplineData[],
    anchors: GuideAnchor[][],
  ): { sections: number[][][]; params: number[] } {
    const sections: number[][][] = [];
    const params: number[] = [];

    for (let k = 0; k < compatible.sections.length; k++) {
      sections.push(compatible.sections[k].poles);
      params.push(base.params[k]);

      if (k === compatible.sections.length - 1) {
        break;
      }
      for (let m = 1; m <= GuidedLoft.SECTIONS_PER_SPAN; m++) {
        const s = m / (GuidedLoft.SECTIONS_PER_SPAN + 1);
        const v = base.params[k] + (base.params[k + 1] - base.params[k]) * s;
        const poles = GuidedLoft.isoSectionPoles(base, v);
        sections.push(GuidedLoft.applyRails(poles, compatible, guides, anchors, k, s));
        params.push(v);
      }
    }

    return { sections, params };
  }

  /** Poles of the base surface's iso-section at loft parameter v (a v-basis row blend). */
  private static isoSectionPoles(base: SkinnedGrid, v: number): number[][] {
    const flat = flattenKnots(base.vBasis.knots, base.vBasis.multiplicities);
    const vPoleCount = base.grid[0].length;
    const span = findSpan(vPoleCount, base.vBasis.degree, v, flat);
    const values = basisFunctions(span, v, base.vBasis.degree, flat);

    return base.grid.map(row => {
      const pole = [0, 0, 0];
      for (let j = 0; j <= base.vBasis.degree; j++) {
        const source = row[span - base.vBasis.degree + j];
        pole[0] += values[j] * source[0];
        pole[1] += values[j] * source[1];
        pole[2] += values[j] * source[2];
      }
      return pole;
    });
  }

  /**
   * Carries a virtual section onto the rails. One rail translates the
   * section rigidly; two rails additionally rotate and stretch it along the
   * contact axis so both contact points land on their rails. Affine maps
   * leave NURBS weights untouched, so transforming poles transforms the
   * section exactly.
   */
  private static applyRails(
    poles: number[][],
    compatible: CompatibleSections,
    guides: RationalBSplineData[],
    anchors: GuideAnchor[][],
    span: number,
    s: number,
  ): number[][] {
    const sectionCurve = {
      degree: compatible.degree,
      knots: compatible.knots,
      multiplicities: compatible.multiplicities,
      poles,
      weights: compatible.weights,
    };

    const current: Vector3d[] = [];
    const target: Vector3d[] = [];
    for (let g = 0; g < guides.length; g++) {
      const from = anchors[g][span];
      const to = anchors[g][span + 1];
      const u = from.u + (to.u - from.u) * s;
      const wrapped = ((u % 1) + 1) % 1;
      const a = evaluateBSplinePoint(sectionCurve, wrapped);
      current.push(new Vector3d(a[0], a[1], a[2]));

      const t = from.t + (to.t - from.t) * s;
      const A = evaluateBSplinePoint(guides[g], t);
      target.push(new Vector3d(A[0], A[1], A[2]));
    }

    if (guides.length === 1) {
      const delta = target[0].subtract(current[0]);
      return poles.map(p => [p[0] + delta.x, p[1] + delta.y, p[2] + delta.z]);
    }

    return GuidedLoft.mapSegment(poles, current[0], current[1], target[0], target[1]);
  }

  /**
   * Affine map taking segment (a1, a2) onto (A1, A2): stretch along the
   * segment axis, minimal rotation aligning the axes, rigid perpendicular
   * components. Degenerate segments fall back to the average translation.
   */
  private static mapSegment(
    poles: number[][],
    a1: Vector3d,
    a2: Vector3d,
    A1: Vector3d,
    A2: Vector3d,
  ): number[][] {
    const d = a2.subtract(a1);
    const D = A2.subtract(A1);
    if (d.length() < 1e-9 || D.length() < 1e-9) {
      const delta = A1.subtract(a1).add(A2.subtract(a2)).multiply(0.5);
      return poles.map(p => [p[0] + delta.x, p[1] + delta.y, p[2] + delta.z]);
    }

    const dHat = d.normalize();
    const DHat = D.normalize();
    const stretch = D.length() / d.length();
    const rotate = GuidedLoft.minimalRotation(dHat, DHat);

    return poles.map(p => {
      const relative = new Vector3d(p[0] - a1.x, p[1] - a1.y, p[2] - a1.z);
      const axial = relative.dot(dHat);
      const perpendicular = relative.subtract(dHat.multiply(axial));
      const mapped = DHat.multiply(axial * stretch).add(rotate(perpendicular));
      return [A1.x + mapped.x, A1.y + mapped.y, A1.z + mapped.z];
    });
  }

  /** Rodrigues rotation taking unit vector `from` to unit vector `to`. */
  private static minimalRotation(from: Vector3d, to: Vector3d): (v: Vector3d) => Vector3d {
    const cosAngle = from.dot(to);
    const axis = from.cross(to);
    const sinAngle = axis.length();

    if (sinAngle < 1e-12) {
      if (cosAngle > 0) {
        return v => v;
      }
      // Antiparallel: 180° about any axis perpendicular to `from`.
      const helper = Math.abs(from.x) < 0.9 ? new Vector3d(1, 0, 0) : new Vector3d(0, 1, 0);
      const perpendicular = from.cross(helper).normalize();
      return v => perpendicular.multiply(2 * v.dot(perpendicular)).subtract(v);
    }

    const axisHat = axis.normalize();
    return v => v.multiply(cosAngle)
      .add(axisHat.cross(v).multiply(sinAngle))
      .add(axisHat.multiply(axisHat.dot(v) * (1 - cosAngle)));
  }
}
