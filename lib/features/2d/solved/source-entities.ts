// Solver identity behind derived-op sources (post-P6 color cleanup): the
// 2D copies, mirror and rotate stamp RIGID duplicates of their sources'
// shapes, so a duplicate is exactly as constrained as the entities it
// derives from — including the entities that define the TRANSFORM itself
// (a mirror across a free line moves with it; a rotation about c.center()
// follows that center). Each op records this join at build time (state, so
// SceneCompare-cached renders keep serving it) and ships it on the payload;
// the viewport tints duplicates with their sources' constrained verdict.
//
// `allSolved` goes false when any shape-bearing source (or an
// unidentifiable transform input) carries no solver identity — an offset
// output, a nested copy, legacy geometry. No verdict there: never green.

import { SceneObject } from "../../../common/scene-object.js";
import { Axis } from "../../../math/axis.js";
import { AxisObjectBase } from "../../axis-renderable-base.js";
import { AxisFromEdge } from "../../axis-from-edge.js";
import { AxisFromSketch } from "../../axis-from-sketch.js";
import { AxisMiddle } from "../../axis-mid.js";
import { AxisObject } from "../../axis.js";
import { LazyVertex } from "../../lazy-vertex.js";
import { SolvedGeometryBase } from "./solved-base.js";
import { SolvedPointRef } from "./refs.js";
import type { ReferenceEntityRecord } from "./reference.js";

export type SourceEntitiesRecord = { ids: number[]; allSolved: boolean };

export type TransformInputs = {
  /** rotate / circular-copy center — a SolvedPointRef ties the stamped
   * geometry to the ref's owner entity; a literal center is a constant. */
  center?: LazyVertex | null;
  /** mirror axis / linear-copy axes — an AxisFromEdge over a solved line
   * ties the stamped geometry to that line; literal axes are constants. */
  axes?: (Axis | AxisObjectBase)[];
};

/** entityId of solver-backed objects; datums carry negative ids (fixed). */
function entityIdOf(obj: unknown): number | null {
  const id = (obj as { entityId?: unknown } | null | undefined)?.entityId;
  return typeof id === "number" ? id : null;
}

export function collectSourceEntities(
  objects: SceneObject[],
  inputs?: TransformInputs,
): SourceEntitiesRecord {
  const ids = new Set<number>();
  let allSolved = true;

  for (const obj of objects) {
    if (obj.getShapes({ excludeMeta: false, excludeGuide: false }).length === 0) {
      // Constraint statements and fully-consumed sources stamp nothing.
      continue;
    }
    if (obj instanceof SolvedGeometryBase && obj.entityId >= 0) {
      ids.add(obj.entityId);
      continue;
    }
    // Reference producers (project/intersect): duplicates of locked
    // geometry derive from the fixed entities.
    const refs = (obj as { referenceEntities?: () => ReferenceEntityRecord[] }).referenceEntities?.();
    if (refs && refs.length > 0) {
      for (const r of refs) {
        ids.add(r.entityId);
      }
      continue;
    }
    // Anchor-point statements (P8): ellipse / bezier / anchored text are
    // rigid functions of their position points (shape params are
    // literals), so they vouch through those entities.
    const anchored = (obj as {
      anchorSourceEntities?: () => SourceEntitiesRecord | undefined;
    }).anchorSourceEntities?.();
    if (anchored) {
      for (const id of anchored.ids) {
        ids.add(id);
      }
      if (!anchored.allSolved) {
        allSolved = false;
      }
      continue;
    }
    allSolved = false;
  }

  const center = inputs?.center;
  if (center instanceof SolvedPointRef) {
    ids.add(center.owner.entityId);
  }
  // Any other LazyVertex is a literal capture — a constant.

  const addAxis = (axis: Axis | AxisObjectBase): void => {
    if (axis instanceof Axis || axis instanceof AxisObject || axis instanceof AxisFromSketch) {
      // Literal axes and the sketch-plane axes (local('x')) are constants.
      return;
    }
    if (axis instanceof AxisMiddle) {
      addAxis(axis.axis1);
      addAxis(axis.axis2);
      return;
    }
    if (axis instanceof AxisFromEdge) {
      const source = axis.source;
      if (source instanceof AxisObjectBase) {
        addAxis(source);
        return;
      }
      const id = entityIdOf(source);
      if (id !== null && id >= 0) {
        ids.add(id);
      } else if (id === null) {
        allSolved = false; // an edge with no solver identity
      }
      // Negative id = datum axis: fixed, contributes nothing.
      return;
    }
    // Unknown axis object: no way to vouch for it.
    allSolved = false;
  };
  for (const axis of inputs?.axes ?? []) {
    addAxis(axis);
  }

  return { ids: [...ids].sort((a, b) => a - b), allSolved };
}

/** The serialize() fragment for a recorded join; empty when none recorded
 * (legacy sketches never record). */
export function sourceEntitiesPayload(
  record: SourceEntitiesRecord | undefined,
): Record<string, unknown> {
  if (!record) {
    return {};
  }
  return { sourceEntities: [...record.ids], sourcesSolved: record.allSolved };
}
