import { SceneObjectRender } from '../../types';

/** A solid-bearing statement the copy dialog can clone, by call site. */
export type CopyTargetOption = {
  label: string;
  filePath: string;
  line: number;
  column: number;
  /** The statement's rendered solid shape ids — highlight + pick matching. */
  shapeIds: string[];
};

/**
 * The statements whose solids a copy could clone right now, one option per
 * source line. Only objects that currently own a rendered solid are offered
 * — the dialog picks whole solids in the viewport, unlike repeat's
 * feature-statement rows. Clones stamped by an existing copy or repeat carry
 * their original's call site, so every same-line object's solids pool into
 * one option and the FIRST object at a line — the original, built before its
 * clones — names it.
 */
export function collectCopyTargets(sceneObjects: SceneObjectRender[]): CopyTargetOption[] {
  const byLine = new Map<string, CopyTargetOption>();
  for (const obj of sceneObjects) {
    if (!obj.sourceLocation || !obj.type || isInsideSketch(obj, sceneObjects)) {
      continue;
    }
    const solidIds = (obj.sceneShapes ?? [])
      .filter(part => part.shapeId && part.shapeType === 'solid')
      .map(part => part.shapeId!);
    if (solidIds.length === 0) {
      continue;
    }
    const loc = obj.sourceLocation;
    const key = `${loc.filePath}:${loc.line}`;
    const existing = byLine.get(key);
    if (existing) {
      existing.shapeIds.push(...solidIds);
      continue;
    }
    byLine.set(key, {
      label: obj.name || obj.type || 'Solid',
      filePath: loc.filePath,
      line: loc.line,
      column: loc.column,
      shapeIds: solidIds,
    });
  }
  return [...byLine.values()];
}

/** The option owning a picked solid shape, or undefined. */
export function copyTargetForShapeId(
  shapeId: string,
  options: CopyTargetOption[],
): CopyTargetOption | undefined {
  return options.find(option => option.shapeIds.includes(shapeId));
}

/**
 * Resolve a timeline row to its solid target option, or undefined — rows
 * without a rendered solid (sketches, planes, axes, consumed inputs) are
 * not copyable.
 */
export function copyTargetForRow(
  obj: SceneObjectRender,
  options: CopyTargetOption[],
): CopyTargetOption | undefined {
  const loc = obj.sourceLocation;
  if (!loc) {
    return undefined;
  }
  return options.find(option => option.filePath === loc.filePath && option.line === loc.line);
}

/** Rows inside a sketch (its drawn entities) are 2D geometry, never targets. */
function isInsideSketch(obj: SceneObjectRender, sceneObjects: SceneObjectRender[]): boolean {
  let current: SceneObjectRender | undefined = obj;
  while (current?.parentId != null) {
    current = sceneObjects.find(o => o.id === current!.parentId);
    if (current?.type === 'sketch') {
      return true;
    }
  }
  return false;
}
