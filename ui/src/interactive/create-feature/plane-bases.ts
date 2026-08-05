import { fetchSketchNames } from '../../api';
import { SceneObjectRender } from '../../types';

/** The message when a picked plane cannot back the slot (not a plane()). */
export const PLANE_UNAVAILABLE_MESSAGE =
  'That plane cannot be referenced — only plane() features can mirror.';

/** An existing plane feature a new plane can use as a base. */
export type PlaneOption = {
  label: string;
  filePath: string;
  line: number;
  column: number;
};

/** A row's `filePath:line` — the granularity plane statements resolve at. */
function lineKey(loc: { filePath: string; line: number }): string {
  return `${loc.filePath}:${loc.line}`;
}

/**
 * Whether a plane row stands for a `plane()` statement of its own — exactly
 * the rows {@link collectPlaneOptions} offers. False for the plane a sketch
 * builds for itself and for one written inline in another call's arguments:
 * both carry the consuming call's source location, so that line holds no
 * plane statement to bind, reference or edit.
 */
export function isPlaneStatementRow(
  obj: SceneObjectRender,
  sceneObjects: SceneObjectRender[],
): boolean {
  return obj.type === 'plane' && obj.sourceLocation !== undefined
    && planeOptionForLocation(collectPlaneOptions(sceneObjects), obj.sourceLocation) !== undefined;
}

/**
 * The plane features rendered in the scene, one option per source line. A
 * single statement can register several plane objects (a mid plane adds its
 * two inputs, a from-face plane adds the selection), all sharing the call's
 * source location — the LAST object at a line is the statement's result.
 * A sketch's implicit plane is excluded (see {@link sketchOwningPlaneRow}):
 * its line holds no plane() call the transform could bind. (Only sketch lines
 * are filtered — a plane statement's own line legitimately hosts the
 * non-plane objects its selector arguments register.)
 *
 * The kernel flags the same case directly for planes written inline in another
 * call's arguments — `repeat('mirror', 'yz', …)` — as internal; those are out
 * for the same reason, whatever call registered them.
 */
export function collectPlaneOptions(sceneObjects: SceneObjectRender[]): PlaneOption[] {
  const sketchLines = new Set(
    sceneObjects
      .filter(o => o.type === 'sketch' && o.sourceLocation)
      .map(o => lineKey(o.sourceLocation!)),
  );
  const byLine = new Map<string, PlaneOption>();
  for (const obj of sceneObjects) {
    if (obj.type !== 'plane' || !obj.sourceLocation || obj.internal) {
      continue;
    }
    const loc = obj.sourceLocation;
    const key = lineKey(loc);
    if (sketchLines.has(key)) {
      continue;
    }
    byLine.set(key, {
      label: 'Plane',
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
    return name ? { ...option, label: name } : option;
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

/** Resolve a picked plane quad's shape to its owning plane object. */
export function resolvePlaneByShapeId(
  shapeId: string,
  sceneObjects: SceneObjectRender[],
): SceneObjectRender | undefined {
  return sceneObjects.find(o =>
    o.type === 'plane' && o.sceneShapes?.some(s => s.shapeId === shapeId));
}

/** The offered option at a source location (a timeline plane row's). */
export function planeOptionForLocation(
  planes: PlaneOption[],
  loc: { filePath: string; line: number },
): PlaneOption | undefined {
  return planes.find(o => o.filePath === loc.filePath && o.line === loc.line);
}

/**
 * The rendered quad shapes behind a plane option, for highlighting a chosen
 * base in the viewport. Several plane objects can share the option's line (a
 * mid plane registers its two inputs too) — the LAST one is the statement's
 * result, the same reading as {@link collectPlaneOptions}.
 */
export function planeQuadShapeIds(
  option: { filePath: string; line: number },
  sceneObjects: SceneObjectRender[],
): string[] {
  const rows = sceneObjects.filter(o => o.type === 'plane' && !o.internal
    && o.sourceLocation?.filePath === option.filePath
    && o.sourceLocation.line === option.line);
  const result = rows[rows.length - 1];
  return result?.sceneShapes?.flatMap(s => s.shapeId ? [s.shapeId] : []) ?? [];
}

/**
 * Resolve a picked plane-quad shape to its offered option; undefined means
 * the plane cannot back the slot (not a plane() feature).
 */
export function planeOptionForShape(
  shapeId: string,
  sceneObjects: SceneObjectRender[],
  planes: PlaneOption[],
): PlaneOption | undefined {
  const plane = resolvePlaneByShapeId(shapeId, sceneObjects);
  return plane?.sourceLocation ? planeOptionForLocation(planes, plane.sourceLocation) : undefined;
}
