// The relation model: a `relation()` couples the free scalar of two mates
// — two rotations (gear) or a rotation and a slide (rack-and-pinion) —
// so a change in one is a fixed multiple of the change in the other.
//
// The coupling is INCREMENTAL, measured per solve against the input poses
// (the previous frame): Δb = gain · Δa, where each side's value is the
// mate's authored-space free parameter read off the body poses through
// the joint model's log map (`extract`), in the LM's internal units —
// radians for a rotation, mm for a slide. Nothing is remembered between
// solves; the file's poses set the phase of the mesh, and a render's
// re-posed instances re-phase it. An angle is unwrapped onto the branch
// nearest the baseline, so a per-solve step under 180° (every interactive
// step) stays continuous across the atan2 cut.
//
// Residual rows are what the LM enforces: one row per relation, scaled so
// a radian of gear mismatch costs like ORIENTATION_WEIGHT mm (the same
// trade the orientation rows make), a mm of rack mismatch like a mm.

import type { BodyState, ConnectorState, MateRecord, RelationRecord } from './types.js';
import { ORIENTATION_WEIGHT, extract } from './joint-model.js';

/** A relation with its two mates resolved (the graph builder's job). */
export type ComponentRelation = {
  record: RelationRecord;
  mateA: MateRecord;
  mateB: MateRecord;
};

/** The two sides' values at the start of the solve, in internal units. */
export type RelationBaseline = { a: number; b: number };

type SideParam = 'rotZ' | 'slideZ';

type ResolvedSide = {
  a: BodyState;
  aConn: ConnectorState;
  b: BodyState;
  bConn: ConnectorState;
  param: SideParam;
};

export class RelationModel {
  /** The free scalar side A couples: always a rotation. */
  static paramA(record: RelationRecord): SideParam {
    return 'rotZ';
  }

  /** The free scalar side B couples: a rotation for a gear, the travel for a rack. */
  static paramB(record: RelationRecord): SideParam {
    return record.type === 'gear' ? 'rotZ' : 'slideZ';
  }

  /**
   * Δb per unit Δa in internal units: a gear's ratio in rad/rad, a rack's
   * travel per revolution in mm/rad. `reverse` flips the sign.
   */
  static gain(record: RelationRecord): number {
    const sign = record.reverse ? -1 : 1;
    return record.type === 'gear' ? sign * record.ratio : (sign * record.ratio) / (2 * Math.PI);
  }

  /** How a relation's row is scaled into the LM cost (see the header). */
  static rowScale(record: RelationRecord): number {
    return record.type === 'gear' ? ORIENTATION_WEIGHT : 1;
  }

  /**
   * The baseline of every relation at the INPUT poses — taken before any
   * warm-start moves a body, so the coupling measures this solve's motion.
   * Relations whose mates don't resolve are left out (the graph warns).
   */
  static baselines(
    relations: ComponentRelation[],
    bodyById: Map<string, BodyState>,
  ): Map<string, RelationBaseline> {
    const out = new Map<string, RelationBaseline>();
    for (const relation of relations) {
      const a = RelationModel.measure(relation.mateA, RelationModel.paramA(relation.record), bodyById, null);
      const b = RelationModel.measure(relation.mateB, RelationModel.paramB(relation.record), bodyById, null);
      if (a === null || b === null) continue;
      out.set(relation.record.relationId, { a, b });
    }
    return out;
  }

  /**
   * The relation's residual at the CURRENT poses: (Δb − gain·Δa) · scale,
   * zero iff the sides moved in ratio since the baseline. Null when a side
   * no longer resolves or the relation has no baseline.
   */
  static residual(
    relation: ComponentRelation,
    bodyById: Map<string, BodyState>,
    baselines: Map<string, RelationBaseline>,
  ): number | null {
    const baseline = baselines.get(relation.record.relationId);
    if (!baseline) return null;
    const a = RelationModel.measure(relation.mateA, RelationModel.paramA(relation.record), bodyById, baseline.a);
    const b = RelationModel.measure(relation.mateB, RelationModel.paramB(relation.record), bodyById, baseline.b);
    if (a === null || b === null) return null;
    const gain = RelationModel.gain(relation.record);
    return ((b - baseline.b) - gain * (a - baseline.a)) * RelationModel.rowScale(relation.record);
  }

  /**
   * One side's value in authored (A-side) space and internal units: the
   * mate's rotZ in radians or slideZ in mm, read off the current poses.
   * With `near`, an angle is unwrapped onto the branch nearest it.
   */
  static measure(
    mate: MateRecord,
    param: SideParam,
    bodyById: Map<string, BodyState>,
    near: number | null,
  ): number | null {
    const side = RelationModel.resolveSide(mate, bodyById);
    if (!side) return null;
    const measured = extract(side.a, side.aConn, side.b, side.bConn);
    if (param === 'slideZ') return measured.slideZ;
    const angle = (measured.rotZ * Math.PI) / 180;
    return near === null ? angle : RelationModel.unwrapNear(angle, near);
  }

  /** Shift `angle` (radians) by whole turns onto the branch nearest `ref`. */
  static unwrapNear(angle: number, ref: number): number {
    return angle + 2 * Math.PI * Math.round((ref - angle) / (2 * Math.PI));
  }

  /**
   * Whether the mate has the free scalar the relation side needs: a
   * rotation for `rotZ` (revolute, cylindrical), a slide for `slideZ`
   * (slider, cylindrical). The kernel refuses the rest at parse time; the
   * graph builder re-checks so a provisional record can't couple nothing.
   */
  static sideHasParam(mate: MateRecord, param: SideParam): boolean {
    if (param === 'rotZ') return mate.type === 'revolute' || mate.type === 'cylindrical';
    return mate.type === 'slider' || mate.type === 'cylindrical';
  }

  private static resolveSide(mate: MateRecord, bodyById: Map<string, BodyState>): ResolvedSide | null {
    if (!mate.connectorA || !mate.connectorB) return null;
    const a = bodyById.get(mate.connectorA.instanceId);
    const b = bodyById.get(mate.connectorB.instanceId);
    if (!a || !b) return null;
    const aConn = a.connectors.find(c => c.connectorId === mate.connectorA!.connectorId);
    const bConn = b.connectors.find(c => c.connectorId === mate.connectorB!.connectorId);
    if (!aConn || !bConn) return null;
    return { a, aConn, b, bConn, param: 'rotZ' };
  }
}
