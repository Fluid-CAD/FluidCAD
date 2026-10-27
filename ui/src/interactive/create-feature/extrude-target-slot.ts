import type { ExtrudeFaceTarget, GhostExtrudeTargetRef, SourceSlotRef } from '../../api';
import type { SelectedEntity } from '../../viewer';
import type { EntitySlotSelection } from './entity-slot';

/** The extrude dialog's direction and face-slot state, as the ghost reads it. */
export type ExtrudeTargetState = {
  /** The direction's literal target — "Up to first face" / "Up to last face". */
  literal: ExtrudeFaceTarget | null;
  /** The picked "Up to face" direction is selected. */
  picking: boolean;
  /** The face clicked this session for the picked direction (the service owns it). */
  picked: SelectedEntity | null;
  /** The face slot's state — `keep` is the edited statement's own target. */
  selection: EntitySlotSelection | null;
  /**
   * Edit mode: the statement's own target as the feature-sources query
   * resolved it — a face pick on the rolled-back solids, or opaque.
   */
  kept: SourceSlotRef | null;
};

/**
 * The up-to-face target an extrude ghost ends on, resolved from the dialog's
 * state the way the apply resolves it from the same state. The literal
 * directions need no pick: the kernel finds the face. The picked direction
 * ends on the clicked face, or — in the edit dialog, with the "Current: …"
 * chip kept — on the statement's own target once the sources query has
 * resolved it to a face on the rolled-back scene. A keep chip never travels
 * as such: the endpoint only ever sees an explicit pick, so it never learns
 * whether create or edit asked.
 */
export class ExtrudeTargetSlot {
  /**
   * What the ghost request carries for the target: the distance form carries
   * nothing, a face-bounded direction its target. Null when a face-bounded
   * direction has no target the ghost can end on — no face picked yet, or a
   * kept target the sources couldn't address — so there is nothing to draw.
   */
  static ghostTarget(state: ExtrudeTargetState): { toFace?: GhostExtrudeTargetRef } | null {
    if (state.literal) {
      return { toFace: { kind: state.literal } };
    }
    if (!state.picking) {
      return {};
    }
    const face = ExtrudeTargetSlot.pickedFace(state) ?? ExtrudeTargetSlot.keptFace(state);
    return face ? { toFace: { kind: 'face', ...face } } : null;
  }

  /** The face clicked this session, if it is one. */
  private static pickedFace(state: ExtrudeTargetState): { shapeId: string; index: number } | null {
    const picked = state.picked;
    return picked && picked.sub.type === 'face' ? { shapeId: picked.shapeId, index: picked.sub.index } : null;
  }

  /** The kept statement's own target, when the chip is kept and it resolved to a single face pick. */
  private static keptFace(state: ExtrudeTargetState): { shapeId: string; index: number } | null {
    if (state.selection?.kind !== 'keep' || state.kept?.kind !== 'entities' || state.kept.entities.length !== 1) {
      return null;
    }
    const entity = state.kept.entities[0];
    return entity.sub.type === 'face' ? { shapeId: entity.shapeId, index: entity.sub.index } : null;
  }
}
