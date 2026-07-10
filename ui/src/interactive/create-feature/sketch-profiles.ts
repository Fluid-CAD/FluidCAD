import { fetchSketchNames } from '../../api';
import { isTopLevel } from '../../helpers/scene-utils';
import { SceneObjectRender } from '../../types';

/** A sketch a create-feature dialog can consume (profile or path). */
export type SketchProfileOption = {
  /** `active` is the sketch being edited (implicit consumption). */
  kind: 'active' | 'other';
  label: string;
  filePath: string;
  line: number;
  column: number;
  /** False while the sketch has nothing drawn — Apply is refused with a hint. */
  hasGeometry: boolean;
};

/**
 * The sketches a feature could consume right now: the active sketch (the
 * last top-level object, while sketch mode is on) plus every other sketch
 * still rendering geometry — a consumed sketch's shapes are removed by its
 * consumer, so "has visible shapes" is exactly "unconsumed". The active
 * sketch is offered even while empty; Apply refuses it with a hint.
 */
export function collectSketchProfiles(sceneObjects: SceneObjectRender[]): SketchProfileOption[] {
  let lastTopLevel: SceneObjectRender | undefined;
  for (let i = sceneObjects.length - 1; i >= 0; i--) {
    if (isTopLevel(sceneObjects[i], sceneObjects)) {
      lastTopLevel = sceneObjects[i];
      break;
    }
  }
  const active = lastTopLevel?.type === 'sketch' && lastTopLevel.sourceLocation ? lastTopLevel : undefined;

  const options: SketchProfileOption[] = [];
  if (active) {
    options.push(toOption(active, 'active', sceneObjects));
  }
  for (const obj of sceneObjects) {
    if (obj === active || obj.type !== 'sketch' || !obj.sourceLocation) {
      continue;
    }
    if (!hasRenderedGeometry(obj, sceneObjects)) {
      continue;
    }
    options.push(toOption(obj, 'other', sceneObjects));
  }
  return options;
}

/**
 * Relabel options with the variable names their sketches are bound to
 * ("spine — line 3"); unbound sketches keep the plain label. Resolves over
 * the live buffer server-side, so it's async — callers apply the result if
 * the dialog is still armed on the same options.
 */
export async function labelWithSketchNames(options: SketchProfileOption[]): Promise<SketchProfileOption[]> {
  if (options.length === 0) {
    return options;
  }
  const names = await fetchSketchNames(options.map(o => o.line));
  return options.map((option, i) => {
    const name = names[i];
    if (!name) {
      return option;
    }
    return {
      ...option,
      label: option.kind === 'active' ? `Active sketch — ${name}` : `${name} — line ${option.line}`,
    };
  });
}

/** A stable signature for "same options" checks across async relabeling. */
export function optionsSignature(options: SketchProfileOption[]): string {
  return options.map(o => `${o.kind}:${o.filePath}:${o.line}`).join('|');
}

/** Resolve a timeline row to the sketch it belongs to (itself or its parent). */
export function resolveSketchRow(
  obj: SceneObjectRender,
  sceneObjects: SceneObjectRender[],
): SceneObjectRender | undefined {
  if (obj.type === 'sketch') {
    return obj;
  }
  if (obj.parentId != null) {
    const parent = sceneObjects.find(o => o.id === obj.parentId);
    if (parent?.type === 'sketch') {
      return parent;
    }
  }
  return undefined;
}

function toOption(
  obj: SceneObjectRender,
  kind: 'active' | 'other',
  sceneObjects: SceneObjectRender[],
): SketchProfileOption {
  const loc = obj.sourceLocation!;
  return {
    kind,
    label: kind === 'active' ? 'Active sketch' : `Sketch — line ${loc.line}`,
    filePath: loc.filePath,
    line: loc.line,
    column: loc.column,
    hasGeometry: hasRenderedGeometry(obj, sceneObjects),
  };
}

/**
 * A sketch's drawn geometry renders on its child objects (each entity — rect,
 * circle, line — is its own scene object under the sketch), so walk the
 * subtree, not just the sketch's own shapes.
 */
function hasRenderedGeometry(obj: SceneObjectRender, sceneObjects: SceneObjectRender[]): boolean {
  if ((obj.sceneShapes ?? []).some(s => !s.isMetaShape && !s.isGuide && (s.meshes?.length ?? 0) > 0)) {
    return true;
  }
  return sceneObjects.some(child =>
    child !== obj && child.parentId != null && child.parentId === obj.id
    && hasRenderedGeometry(child, sceneObjects));
}
