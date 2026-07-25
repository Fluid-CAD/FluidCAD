import { fetchSketchNames, RevolveAxisRef } from '../../api';
import { SceneObjectRender } from '../../types';
import { SelectedEntity } from '../../viewer';

/** The message when a picked axis is no longer offered (already consumed). */
export const AXIS_CONSUMED_MESSAGE =
  'That axis was already consumed — only axes still shown in the scene can be picked.';

/** An axis statement the revolve dialog can consume, by call site. */
export type AxisOption = {
  label: string;
  filePath: string;
  line: number;
  column: number;
};

/**
 * The axis statements a revolve could reference right now: every `axis(…)`
 * object still rendering its dashed guide line — an axis consumed by a
 * revolve has its line removed by the consumer, so "has a rendered line" is
 * exactly "unconsumed". Axis shapes are meta shapes, so this checks meshes
 * directly instead of reusing the sketches' non-meta geometry walk.
 */
export function collectAxisOptions(sceneObjects: SceneObjectRender[]): AxisOption[] {
  const options: AxisOption[] = [];
  for (const obj of sceneObjects) {
    if (obj.type !== 'axis' || !obj.sourceLocation) {
      continue;
    }
    if (!(obj.sceneShapes ?? []).some(s => (s.meshes?.length ?? 0) > 0)) {
      continue;
    }
    const loc = obj.sourceLocation;
    options.push({
      label: 'Axis',
      filePath: loc.filePath,
      line: loc.line,
      column: loc.column,
    });
  }
  return options;
}

/**
 * Relabel options with the variable names their axes are bound to
 * ("ringAxis — line 3"); unbound axes keep the plain label. Resolves over
 * the live buffer server-side, so it's async — callers apply the result if
 * the dialog is still armed on the same options.
 */
export async function labelWithAxisNames(options: AxisOption[]): Promise<AxisOption[]> {
  if (options.length === 0) {
    return options;
  }
  const names = await fetchSketchNames(options.map(o => o.line), 'axis');
  return options.map((option, i) => {
    const name = names[i];
    return name ? { ...option, label: name } : option;
  });
}

/** A stable signature for "same options" checks across async relabeling. */
export function axisOptionsSignature(options: AxisOption[]): string {
  return options.map(o => `${o.filePath}:${o.line}`).join('|');
}

/** Resolve a picked axis line's shape to its owning axis object. */
export function resolveAxisByShapeId(
  shapeId: string,
  sceneObjects: SceneObjectRender[],
): SceneObjectRender | undefined {
  return sceneObjects.find(o =>
    o.type === 'axis' && o.sceneShapes?.some(s => s.shapeId === shapeId));
}

/** The offered option at a source location (a timeline axis row's). */
export function axisOptionForLocation(
  axes: AxisOption[],
  loc: { filePath: string; line: number },
): AxisOption | undefined {
  return axes.find(o => o.filePath === loc.filePath && o.line === loc.line);
}

/**
 * Resolve a picked axis-line shape to its offered option; undefined means
 * the axis is not pickable anymore (already consumed).
 */
export function axisOptionForShape(
  shapeId: string,
  sceneObjects: SceneObjectRender[],
  axes: AxisOption[],
): AxisOption | undefined {
  const axis = resolveAxisByShapeId(shapeId, sceneObjects);
  return axis?.sourceLocation ? axisOptionForLocation(axes, axis.sourceLocation) : undefined;
}

/**
 * Serialize a re-picked axis selection to its apply-request ref — the shared
 * write-side of the axis slot (revolve, helix, repeat). Keep selections are
 * the caller's business (they are feature-specific); an edge selection
 * without its picked entity blocks with `missingEdgeError`.
 */
export function pickedAxisRef(
  selection:
    | { kind: 'standard'; axis: 'x' | 'y' | 'z' }
    | { kind: 'axis'; option: AxisOption }
    | { kind: 'edge' },
  edgeEntity: SelectedEntity | null,
  missingEdgeError: string,
): RevolveAxisRef | { error: string } {
  if (selection.kind === 'standard') {
    return { kind: 'standard', axis: selection.axis };
  }
  if (selection.kind === 'axis') {
    const { filePath, line, column } = selection.option;
    return { kind: 'axis', filePath, line, column };
  }
  if (!edgeEntity) {
    return { error: missingEdgeError };
  }
  return { kind: 'edge', entity: edgeEntity };
}

/**
 * Shape ids of the dashed line an axis statement renders — the highlight
 * targets for an axis selected in the revolve dialog. Addressed by source
 * location like the options, so it re-resolves after every render.
 */
export function axisLineShapeIds(
  option: { filePath: string; line: number },
  sceneObjects: SceneObjectRender[],
): string[] {
  const axis = sceneObjects.find(o => o.type === 'axis'
    && o.sourceLocation?.filePath === option.filePath && o.sourceLocation?.line === option.line);
  if (!axis) {
    return [];
  }
  const ids: string[] = [];
  for (const shape of axis.sceneShapes ?? []) {
    if (shape.shapeId && (shape.meshes?.length ?? 0) > 0) {
      ids.push(shape.shapeId);
    }
  }
  return ids;
}
