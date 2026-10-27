import type { ApplyFeatureEntity, GhostAxisRef, SourceSlotRef } from '../../api';

/**
 * A kept "Current: …" axis chip as the feature-sources query resolved the
 * edited statement's own axis argument — what an edit dialog's ghost draws in
 * its place. An `axis()` statement resolves by call site; the bare
 * `axis(<edge>)` an edge pick writes inline resolves to that edge on the
 * rolled-back solid; a connector (`bolt`, `bolt.instance(2)`) to its site,
 * its Z axis what the ghost turns around. A world-axis literal never reaches
 * here (the slot reads `'z'` as the standard selection itself), and anything
 * else is an expression no ghost can stand in for.
 */
export class KeptAxisSlot {
  /** The `axis()` statement the kept axis names, by call site. */
  static statement(slot: SourceSlotRef | null | undefined): { filePath: string; line: number } | null {
    return slot?.kind === 'sketch' ? { filePath: slot.filePath, line: slot.line } : null;
  }

  /** The kept axis in the form the ghost endpoint resolves; null when nothing can stand in for it. */
  static ghostRef(slot: SourceSlotRef | null | undefined): GhostAxisRef | null {
    if (slot?.kind === 'connector') {
      return { kind: 'connector', filePath: slot.filePath, line: slot.line, ...(slot.slot !== undefined ? { slot: slot.slot } : {}) };
    }
    const loc = KeptAxisSlot.statement(slot);
    if (loc) {
      return { kind: 'axis', filePath: loc.filePath, line: loc.line };
    }
    const edge = KeptAxisSlot.edge(slot);
    return edge ? { kind: 'edge', shapeId: edge.shapeId, index: edge.sub.index } : null;
  }

  /** The one edge an inline `axis(<edge>)` was built on. */
  private static edge(slot: SourceSlotRef | null | undefined): ApplyFeatureEntity | null {
    if (slot?.kind !== 'entities' || slot.entities.length !== 1) {
      return null;
    }
    const entity = slot.entities[0];
    return entity.sub.type === 'edge' ? entity : null;
  }
}
