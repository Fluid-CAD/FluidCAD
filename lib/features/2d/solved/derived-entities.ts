// The solver identity a derived-op statement exposes to ops downstream of
// it. A 2D copy's duplicates and a 2D mirror's images are real solver
// entities (rigidly tied to their sources); a mirror of a copy — or of
// another mirror — images each of those entities in turn, so the derived
// ops share one vocabulary for "the entities behind my stamped shapes".

import type { Shape } from "../../../common/shape.js";
import type { SceneObject } from "../../../common/scene-object.js";
import type { EntityKind } from "../../../sketch-solver/index.js";
import { SolvedGeometryBase } from "./solved-base.js";

export type SolverEntityRecord = { entityId: number; kind: EntityKind };

/** A statement whose stamped shapes carry solver entities of their own. */
export type DerivedEntityProducer = {
  /** Every solver entity this statement registered for its stamped
   * geometry, in stamping order. */
  solverDuplicates(): SolverEntityRecord[];
  /** The solver entity one stamped shape stands for, or null. */
  duplicateEntityForShape(shape: Shape): number | null;
};

export function isDerivedEntityProducer(obj: SceneObject): obj is SceneObject & DerivedEntityProducer {
  const candidate = obj as unknown as Partial<DerivedEntityProducer>;
  return typeof candidate.solverDuplicates === 'function'
    && typeof candidate.duplicateEntityForShape === 'function';
}

/**
 * The solver entities a candidate source statement contributes to a
 * derived op: a drawn line/arc/circle/point is its own single entity; a
 * derived producer (copy, mirror) contributes its duplicates. Null for a
 * statement with no solver identity at all (an offset result, a
 * projected reference, a macro shape).
 */
export function solverEntitiesOf(obj: SceneObject): SolverEntityRecord[] | null {
  if (obj instanceof SolvedGeometryBase) {
    return obj.entityId >= 0 ? [{ entityId: obj.entityId, kind: obj.solverKind }] : null;
  }
  if (isDerivedEntityProducer(obj)) {
    return obj.solverDuplicates();
  }
  return null;
}

/**
 * The solver entity behind one of a source statement's shapes at build
 * time — the stamped-shape join a derived op records for its payload and
 * instance accessors. A drawn entity's real (non-meta) shape is the
 * entity itself; a derived producer answers per shape.
 */
export function solverEntityForShape(obj: SceneObject, shape: Shape): number | null {
  if (obj instanceof SolvedGeometryBase) {
    return obj.entityId >= 0 && !shape.isMetaShape() ? obj.entityId : null;
  }
  if (isDerivedEntityProducer(obj)) {
    return obj.duplicateEntityForShape(shape);
  }
  return null;
}
