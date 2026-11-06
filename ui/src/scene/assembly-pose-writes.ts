import type { SerializedAssemblyInstance } from '../types';
import { previewScene } from '../interactive/generated/preview-scene';

/** An instance whose pose may be written: it has the source location the write addresses. */
export type WritableInstance = SerializedAssemblyInstance & { sourceLocation: NonNullable<SerializedAssemblyInstance['sourceLocation']> };

/**
 * Whether a moved part's pose is written back to its `insert()` — the one
 * rule the free-drag release and the transform gizmo share. A move that is
 * not written stays live: the part moves (along its joints, the solver in
 * the loop) and the next render's warm start re-derives it; no error shows.
 *
 * The rules — written only when all hold:
 * - the scene is the file's own, not an assembly preview ({@link previewScene}):
 *   a preview's rows are the previewed code's, whose lines are not the editor's;
 * - the instance's statement is the open file's own insert(): not one a
 *   sub-assembly's body inserted (`owner`: its pose there is local to the
 *   occurrence, and its file is another), not a replica (its statement is
 *   the `replicate()` call), not an engine-owned part a generator made
 *   (`generatedBy`, read-only, G8); and it has a source location;
 * - it is grounded, or unmated: a mated part's position comes from its
 *   mates (and its rotation isn't persisted), so writing `.translate()`
 *   would undo the drag on reload.
 */
export class AssemblyPoseWrites {
  static writable(
    inst: SerializedAssemblyInstance | undefined,
    hasMate: (instanceId: string) => boolean,
  ): inst is WritableInstance {
    if (!inst?.sourceLocation || previewScene.active) {
      return false;
    }
    if (inst.owner || inst.replica || inst.generatedBy) {
      return false;
    }
    return inst.grounded || !hasMate(inst.instanceId);
  }
}
