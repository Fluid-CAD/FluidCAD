import { SceneIndex } from '../../helpers/scene-index';
import { ConnectorData, SceneObjectRender } from '../../types';

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
 * a readable reason. Connectors are left out as well, with a pointer to what
 * does take them ({@link connectorRepeatRefusal}).
 */
const NON_TARGET_TYPES = new Set(['sketch', 'plane', 'axis']);

/**
 * Why a row is a connector repeat() refuses, or null: a connector, or a
 * `copy()` that copies nothing but connectors. repeat() re-applies features
 * and refuses connectors, so the dialog says so at the pick — and names the
 * Copy dialog, which copies them (`copy(…, bolt)` makes `bolt.instance(1)`,
 * …) — instead of offering the row and failing at apply.
 */
export function connectorRepeatRefusal(obj: SceneObjectRender): string | null {
  if (obj.type === 'connector') {
    const name = (obj.object as ConnectorData | undefined)?.name;
    const label = name ? `${name} is a connector` : 'That is a connector';
    return `${label} — repeat re-applies features. Copy a connector with the Copy dialog instead.`;
  }
  if (SceneIndex.copiesOnlyConnectors(obj)) {
    return 'That copy copies connectors — repeat re-applies features. Edit its pattern in the Copy dialog instead.';
  }
  return null;
}

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
  if (!obj.sourceLocation || !obj.type || NON_TARGET_TYPES.has(obj.type)
    || connectorRepeatRefusal(obj) !== null) {
    return undefined;
  }
  if (SceneIndex.of(sceneObjects).enclosing(obj, 'sketch')) {
    return undefined;
  }
  return obj;
}
