import { fetchSketchNames, gotoSource } from '../../api';
import { isTopLevel } from '../../helpers/scene-utils';
import { SceneObjectRender } from '../../types';
import { PickSlotChip } from '../pick-slot';

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
      label: option.kind === 'active' ? `Last Sketch — ${name}` : name,
    };
  });
}

/**
 * A pick chip for a source-backed option (a sketch, axis or plane): its label
 * plus a muted, right-aligned line badge that jumps to the option's source
 * line. Callers pass the badge/removable flags; the line and its jump target
 * come from the option.
 */
export function sourceChip(
  option: { label: string; filePath: string; line: number; column: number },
  opts: { badge?: string; badgeMuted?: boolean; removable?: boolean } = {},
): PickSlotChip {
  return {
    label: option.label,
    badge: opts.badge,
    badgeMuted: opts.badgeMuted,
    removable: opts.removable,
    line: option.line,
    onGoto: () => gotoSource({ filePath: option.filePath, line: option.line, column: option.column }),
  };
}

/**
 * The edit-mode keep chip for a sketch slot: the statement's own profile
 * expression, or a bare "(implicit)" when the statement names no sketch and
 * consumes the last one (`extrude(25)`) — there is no expression to show.
 */
export function keepSketchChip(text: string | null): PickSlotChip {
  return {
    label: text === null ? 'Last Sketch (implicit)' : `Last Sketch: ${text}`,
    badge: '●',
    removable: false,
  };
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

/**
 * Resolve a picked sketch-wire shape to its sketch: the shape belongs to a
 * sketch entity object (rect/circle/line — the sketch's children), whose
 * parent is the sketch itself.
 */
export function resolveSketchByShapeId(
  shapeId: string,
  sceneObjects: SceneObjectRender[],
): SceneObjectRender | undefined {
  const owner = sceneObjects.find(o => o.sceneShapes?.some(s => s.shapeId === shapeId));
  return owner ? resolveSketchRow(owner, sceneObjects) : undefined;
}

/**
 * Shape ids of the wires a sketch renders — its direct children's non-meta,
 * non-guide shapes, mirroring what SketchMesh draws as wire lines. These are
 * the highlight targets for a sketch selected in a create dialog. Addressed
 * by source location like the options, so it re-resolves after every render.
 */
export function sketchWireShapeIds(
  option: { filePath: string; line: number },
  sceneObjects: SceneObjectRender[],
): string[] {
  const sketch = sceneObjects.find(o => o.type === 'sketch'
    && o.sourceLocation?.filePath === option.filePath && o.sourceLocation?.line === option.line);
  if (!sketch) {
    return [];
  }
  const ids: string[] = [];
  for (const obj of sceneObjects) {
    if (obj.parentId !== sketch.id) {
      continue;
    }
    for (const shape of obj.sceneShapes ?? []) {
      if (!shape.isMetaShape && !shape.isGuide && shape.shapeId) {
        ids.push(shape.shapeId);
      }
    }
  }
  return ids;
}

function toOption(
  obj: SceneObjectRender,
  kind: 'active' | 'other',
  sceneObjects: SceneObjectRender[],
): SketchProfileOption {
  const loc = obj.sourceLocation!;
  return {
    kind,
    label: kind === 'active' ? 'Last Sketch' : 'Sketch',
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
