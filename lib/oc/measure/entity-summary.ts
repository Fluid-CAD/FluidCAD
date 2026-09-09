import type { LengthUnit } from "../../units/units.js";
import type { ClassifiedEntity, EdgeForm, FaceForm } from "./classify.js";

/** A rounded world-space vector, compact for tool payloads. */
export type SummaryVec = [number, number, number];

/**
 * The compact geometric description a tool consumer gets per face/edge —
 * enough to tell a bore from a boss without another call, small enough to
 * ship one per match. Lengths are in the document unit, rounded to that
 * unit's meaningful precision (see {@link EntitySummaryBuilder.decimalsFor}).
 */
export type EntitySummary = {
  /** Surface kind for a face, curve kind for an edge. */
  form: FaceForm | EdgeForm;
  /** The entity's center, else its area centroid / midpoint. */
  center: SummaryVec;
  /** Unit normal — planes, circles/arcs (their plane), tori (axis). */
  normal?: SummaryVec;
  /** Unit axis — lines, cylinders, cones. */
  axis?: SummaryVec;
  /** Faces only. */
  area?: number;
  /** Edges only. */
  length?: number;
  /** Cylinders, spheres, circles and arcs. */
  diameter?: number;
};

/**
 * Builds {@link EntitySummary} values from a classified entity. One place
 * owns the field set and the rounding so `measure` entities and
 * `resolve_selection` matches describe geometry identically.
 */
export class EntitySummaryBuilder {

  private static readonly DIRECTION_DECIMALS = 6;

  /**
   * Decimal places that resolve about one micrometre in the given unit —
   * finer than any modelling tolerance, coarse enough to drop the
   * floating-point noise that otherwise costs 16 digits per number.
   */
  static decimalsFor(unit: LengthUnit): number {
    switch (unit) {
      case 'mm':
        return 3;
      case 'cm':
        return 4;
      case 'm':
        return 6;
      case 'in':
        return 4;
      case 'ft':
        return 5;
      default:
        return 3;
    }
  }

  static round(value: number, decimals: number): number {
    const factor = Math.pow(10, decimals);
    const rounded = Math.round(value * factor) / factor;
    // Normalize -0 so the JSON never prints "-0".
    return rounded === 0 ? 0 : rounded;
  }

  static fromClassified(entity: ClassifiedEntity, unit: LengthUnit): EntitySummary {
    const decimals = EntitySummaryBuilder.decimalsFor(unit);
    const summary: EntitySummary = {
      form: entity.form,
      center: EntitySummaryBuilder.roundVec(entity.center ?? entity.anchor, decimals),
    };
    if (entity.dir && entity.dirKind === 'normal') {
      summary.normal = EntitySummaryBuilder.roundVec(entity.dir, EntitySummaryBuilder.DIRECTION_DECIMALS);
    } else if (entity.dir && entity.dirKind === 'axis') {
      summary.axis = EntitySummaryBuilder.roundVec(entity.dir, EntitySummaryBuilder.DIRECTION_DECIMALS);
    }
    if (entity.kind === 'face' && entity.area !== undefined) {
      summary.area = EntitySummaryBuilder.round(entity.area, decimals);
    }
    if (entity.kind === 'edge' && entity.length !== undefined) {
      summary.length = EntitySummaryBuilder.round(entity.length, decimals);
    }
    if (entity.radius !== undefined) {
      summary.diameter = EntitySummaryBuilder.round(entity.radius * 2, decimals);
    }
    return summary;
  }

  private static roundVec(v: { x: number; y: number; z: number }, decimals: number): SummaryVec {
    return [
      EntitySummaryBuilder.round(v.x, decimals),
      EntitySummaryBuilder.round(v.y, decimals),
      EntitySummaryBuilder.round(v.z, decimals),
    ];
  }
}
