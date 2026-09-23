import type { SceneObjectRender, SourceLocation } from '../../types';

/** A statement the Delete key removes, resolved from a selected edge. */
export type DeleteTarget = {
  /** 1-indexed line of the statement. */
  line: number;
  /** The statement's render type (`line`, `circle`, `rect`, `text`, `copy`, …). */
  type: string;
  sourceLocation: SourceLocation;
};

/** What Delete would do for the selected edges, or why it will not. */
export type DeletePlan =
  | { ok: true; targets: DeleteTarget[]; label: string }
  | { ok: false; reason: string };

/** How a statement type reads in the Delete button's tooltip. */
const TYPE_LABELS: Record<string, string> = {
  line: 'line',
  arc: 'arc',
  circle: 'circle',
  ellipse: 'ellipse',
  bezier: 'bezier',
  text: 'text',
  rect: 'rectangle',
  polygon: 'polygon',
  slot: 'slot',
  copy: 'copy',
  mirror: 'mirror',
  project: 'projection',
  projection: 'projection',
  intersect: 'intersection',
};

/**
 * The statements the selected edges were drawn by, one per statement (a
 * rectangle's four edges, a copy's duplicates, a text's glyphs are each one
 * statement), or the reason one of them cannot be deleted: an edge drawn
 * by a loop (the statement draws every iteration) or one with no statement
 * at all. Null when no edge is selected.
 */
export function buildDeletePlan(
  shapeIds: readonly string[],
  sceneObjects: readonly SceneObjectRender[],
): DeletePlan | null {
  if (shapeIds.length === 0) {
    return null;
  }
  const targets = new Map<string, DeleteTarget>();
  for (const shapeId of shapeIds) {
    const owner = sceneObjects.find(obj => obj.sceneShapes?.some(shape => shape.shapeId === shapeId));
    const location = owner?.sourceLocation;
    if (!owner || !location || typeof location.line !== 'number') {
      return { ok: false, reason: 'This edge has no statement to delete' };
    }
    if (location.occurrence !== undefined) {
      return { ok: false, reason: 'This edge is drawn by a loop — edit the source instead' };
    }
    const key = `${location.filePath}:${location.line}`;
    if (!targets.has(key)) {
      targets.set(key, { line: location.line, type: owner.type ?? 'entity', sourceLocation: location });
    }
  }
  const list = [...targets.values()].sort((a, b) => a.line - b.line);
  return { ok: true, targets: list, label: deleteLabel(list) };
}

/** `Delete the line` / `Delete 3 entities` — what the button and its key do. */
function deleteLabel(targets: DeleteTarget[]): string {
  if (targets.length === 1) {
    const type = targets[0].type;
    return `Delete the ${TYPE_LABELS[type] ?? type}`;
  }
  return `Delete ${targets.length} entities`;
}

/** The toast for statements the delete swept because they consumed the picked geometry. */
export function describeDependents(dependents: { kind: string }[]): string {
  if (dependents.length === 1) {
    return `Also deleted the ${TYPE_LABELS[dependents[0].kind] ?? dependents[0].kind} that used it`;
  }
  const kinds = [...new Set(dependents.map(d => TYPE_LABELS[d.kind] ?? d.kind))];
  return `Also deleted ${dependents.length} statements that used it (${kinds.join(', ')})`;
}
