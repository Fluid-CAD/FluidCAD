import { SceneIndex } from '../../helpers/scene-index';
import { modelShapesOf, type ModelShapeKind } from '../../helpers/scene-utils';
import { SceneObjectRender } from '../../types';

/** A statement holding material a dialog can target (a solid, unless the dialog takes more), by call site. */
export type SolidTargetOption = {
  label: string;
  filePath: string;
  line: number;
  column: number;
  /** The statement's rendered shape ids of the kinds asked for — highlight + pick matching. */
  shapeIds: string[];
};

/**
 * The statements whose material a dialog can target right now, one option
 * per source line. Only objects that currently own a rendered shape of one
 * of `kinds` are offered — solids alone for the tools that work on solids
 * (booleans, split), surfaces and curves too for the ones that move, copy or
 * paint them. These dialogs pick whole shapes in the viewport, unlike
 * repeat's feature-statement rows. Clones stamped by an existing copy or
 * repeat carry their original's call site, so every same-line object's
 * shapes pool into one option and the FIRST object at a line — the
 * original, built before its clones — names it.
 */
export function collectSolidTargets(
  sceneObjects: SceneObjectRender[],
  kinds: readonly ModelShapeKind[] = ['solid'],
): SolidTargetOption[] {
  const byLine = new Map<string, SolidTargetOption>();
  for (const obj of sceneObjects) {
    if (!obj.sourceLocation || !obj.type || isInsideSketch(obj, sceneObjects)) {
      continue;
    }
    const shapeIds = modelShapesOf(obj, sceneObjects, kinds)
      .filter(part => part.shapeId)
      .map(part => part.shapeId!);
    if (shapeIds.length === 0) {
      continue;
    }
    const loc = obj.sourceLocation;
    const key = `${loc.filePath}:${loc.line}`;
    const existing = byLine.get(key);
    if (existing) {
      existing.shapeIds.push(...shapeIds);
      continue;
    }
    byLine.set(key, {
      label: obj.name || obj.type || 'Solid',
      filePath: loc.filePath,
      line: loc.line,
      column: loc.column,
      shapeIds,
    });
  }
  return [...byLine.values()];
}

/** The option owning a picked shape, or undefined. */
export function solidTargetForShapeId(
  shapeId: string,
  options: SolidTargetOption[],
): SolidTargetOption | undefined {
  return options.find(option => option.shapeIds.includes(shapeId));
}

/**
 * Resolve a timeline row to its target option, or undefined — rows without
 * a rendered shape of the kinds collected (sketches, planes, axes, consumed
 * inputs) are not targetable.
 */
export function solidTargetForRow(
  obj: SceneObjectRender,
  options: SolidTargetOption[],
): SolidTargetOption | undefined {
  const loc = obj.sourceLocation;
  if (!loc) {
    return undefined;
  }
  return options.find(option => option.filePath === loc.filePath && option.line === loc.line);
}

/** Rows inside a sketch (its drawn entities) are 2D geometry, never targets. */
function isInsideSketch(obj: SceneObjectRender, sceneObjects: SceneObjectRender[]): boolean {
  return SceneIndex.of(sceneObjects).enclosing(obj, 'sketch') !== undefined;
}
