import { fetchSketchNames } from '../../api';
import { SceneObjectRender } from '../../types';

/** An existing plane feature a new plane can use as a base. */
export type PlaneOption = {
  label: string;
  filePath: string;
  line: number;
  column: number;
};

/**
 * The plane features rendered in the scene, one option per source line. A
 * single statement can register several plane objects (a mid plane adds its
 * two inputs, a from-face plane adds the selection), all sharing the call's
 * source location — the LAST object at a line is the statement's result.
 * A sketch's implicit plane carries the sketch call's location and is
 * excluded: its line holds no plane() call the transform could bind. (Only
 * sketch lines are filtered — a plane statement's own line legitimately
 * hosts the non-plane objects its selector arguments register.)
 */
export function collectPlaneOptions(sceneObjects: SceneObjectRender[]): PlaneOption[] {
  const otherFeatureLines = new Set(
    sceneObjects
      .filter(o => o.type === 'sketch' && o.sourceLocation)
      .map(o => `${o.sourceLocation!.filePath}:${o.sourceLocation!.line}`),
  );
  const byLine = new Map<string, PlaneOption>();
  for (const obj of sceneObjects) {
    if (obj.type !== 'plane' || !obj.sourceLocation) {
      continue;
    }
    const loc = obj.sourceLocation;
    const key = `${loc.filePath}:${loc.line}`;
    if (otherFeatureLines.has(key)) {
      continue;
    }
    byLine.set(key, {
      label: `Plane — line ${loc.line}`,
      filePath: loc.filePath,
      line: loc.line,
      column: loc.column,
    });
  }
  return [...byLine.values()];
}

/**
 * Relabel options with the variable names their planes are bound to
 * ("top — line 3"); unbound planes keep the plain label. Resolves over the
 * live buffer server-side, so it's async — callers apply the result if the
 * dialog is still armed on the same options.
 */
export async function labelWithPlaneNames(options: PlaneOption[]): Promise<PlaneOption[]> {
  if (options.length === 0) {
    return options;
  }
  const names = await fetchSketchNames(options.map(o => o.line), 'plane');
  return options.map((option, i) => {
    const name = names[i];
    return name ? { ...option, label: `${name} — line ${option.line}` } : option;
  });
}

/** A stable signature for "same options" checks across async relabeling. */
export function planeOptionsSignature(options: PlaneOption[]): string {
  return options.map(o => `${o.filePath}:${o.line}`).join('|');
}

/** Resolve a timeline row to a plane feature (planes have no child rows). */
export function resolvePlaneRow(obj: SceneObjectRender): SceneObjectRender | undefined {
  return obj.type === 'plane' && obj.sourceLocation ? obj : undefined;
}
