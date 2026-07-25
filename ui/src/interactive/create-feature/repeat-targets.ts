import { SceneObjectRender } from '../../types';

/** A feature statement the repeat dialog can replay, by call site. */
export type RepeatTargetOption = {
  label: string;
  filePath: string;
  line: number;
  column: number;
};

/**
 * Object types a repeat can never target: construction inputs. Everything
 * else with a source location is offered — select() rows too, so a wrap or
 * fillet can be repeated together with the selection it consumes — and the
 * server validates the statement's callee and refuses unsupported ones with
 * a readable reason.
 */
const NON_TARGET_TYPES = new Set(['sketch', 'plane', 'axis']);

/**
 * The feature statements a repeat could replay right now, one option per
 * source line. Clones stamped by an existing repeat carry their original's
 * call site, so the FIRST object at a line — the original, built before its
 * clones — names the option.
 */
export function collectRepeatTargets(sceneObjects: SceneObjectRender[]): RepeatTargetOption[] {
  const byLine = new Map<string, RepeatTargetOption>();
  for (const obj of sceneObjects) {
    const target = resolveRepeatTargetRow(obj, sceneObjects);
    if (!target) {
      continue;
    }
    const loc = target.sourceLocation!;
    const key = `${loc.filePath}:${loc.line}`;
    if (byLine.has(key)) {
      continue;
    }
    byLine.set(key, {
      label: target.name || target.type || 'Feature',
      filePath: loc.filePath,
      line: loc.line,
      column: loc.column,
    });
  }
  return [...byLine.values()];
}

/**
 * Resolve a timeline row to a repeatable feature, or undefined. Rows inside
 * a sketch (its drawn entities) are 2D geometry, never repeat targets.
 */
export function resolveRepeatTargetRow(
  obj: SceneObjectRender,
  sceneObjects: SceneObjectRender[],
): SceneObjectRender | undefined {
  if (!obj.sourceLocation || !obj.type || NON_TARGET_TYPES.has(obj.type)) {
    return undefined;
  }
  let current: SceneObjectRender | undefined = obj;
  while (current?.parentId != null) {
    current = sceneObjects.find(o => o.id === current!.parentId);
    if (current?.type === 'sketch') {
      return undefined;
    }
  }
  return obj;
}
