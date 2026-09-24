import { fetchSketchNames, gotoSource } from '../../api';
import { SceneIndex } from '../../helpers/scene-index';
import { findActiveSketch, isTopLevel } from '../../helpers/scene-utils';
import { SceneObjectPart, SceneObjectRender } from '../../types';
import { PickSlotChip } from '../pick-slot';

/** A sketch, helix or offset a create-feature dialog can consume (profile or path). */
export type SketchProfileOption = {
  /** `active` is the sketch being edited (implicit consumption). */
  kind: 'active' | 'other';
  /**
   * The producing statement: a sketch, a helix, or a top-level face offset.
   * A helix is a bare wire — offered only where a wire is valid (a sweep
   * path, a loft guide), never as a planar profile. An offset is a planar
   * profile — offered only where one is extruded, never as a wire.
   */
  feature: 'sketch' | 'helix' | 'offset';
  label: string;
  filePath: string;
  line: number;
  column: number;
  /** False while the sketch has nothing drawn — Apply is refused with a hint. */
  hasGeometry: boolean;
  /**
   * The display name of the feature that consumed the sketch (hid it) in
   * this world — the option is a sketch drawn no more, which the dialog
   * reveals while it holds it. Absent for a sketch still on screen.
   */
  consumer?: string;
};

/**
 * The sketches a feature could consume right now: the active sketch (the
 * active scope's last object, while sketch mode is on) first, then every
 * other sketch in scene order — those still rendering geometry and those a
 * feature already used (their consumer hid them, but a sketch is never used
 * up, so each is offered again, named after that consumer). The active
 * sketch is offered even while empty; Apply refuses it with a hint.
 */
export function collectSketchProfiles(sceneObjects: SceneObjectRender[]): SketchProfileOption[] {
  const tip = findActiveSketch(sceneObjects);
  const active = tip?.sourceLocation ? tip : undefined;

  const options: SketchProfileOption[] = [];
  if (active) {
    options.push(toOption(active, 'active', sceneObjects));
  }
  for (const obj of sceneObjects) {
    if (obj === active || obj.type !== 'sketch' || !obj.sourceLocation) {
      continue;
    }
    if (hasRenderedGeometry(obj, sceneObjects)) {
      options.push(toOption(obj, 'other', sceneObjects));
    } else if (obj.consumedBy !== undefined && hasHiddenGeometry(obj, sceneObjects)) {
      options.push(toConsumedOption(obj, sceneObjects));
    }
  }
  return options;
}

/**
 * The profiles an extrude can consume right now: every offered sketch (see
 * {@link collectSketchProfiles}) plus every top-level face offset still
 * rendering its outline — an offset is extrudable exactly like a sketch,
 * with the face plane as its plane. In-sketch offsets ride their sketch.
 */
export function collectExtrudeProfiles(sceneObjects: SceneObjectRender[]): SketchProfileOption[] {
  const options = collectSketchProfiles(sceneObjects);
  for (const obj of sceneObjects) {
    if (obj.type !== 'offset' || !obj.sourceLocation || !isTopLevel(obj, sceneObjects)) {
      continue;
    }
    if (!hasRenderedGeometry(obj, sceneObjects)) {
      continue;
    }
    const loc = obj.sourceLocation;
    options.push({
      kind: 'other',
      feature: 'offset',
      label: 'Offset',
      filePath: loc.filePath,
      line: loc.line,
      column: loc.column,
      hasGeometry: true,
    });
  }
  return options;
}

/**
 * The wire sources a path/guide slot can consume right now: every offered
 * sketch (see {@link collectSketchProfiles}) plus every unconsumed helix —
 * a helix is a bare wire, valid exactly where a sketch is consumed as one
 * (a sweep path, a loft guide). Sketches keep their order (the active one
 * first), helixes follow.
 */
export function collectWireSources(sceneObjects: SceneObjectRender[]): SketchProfileOption[] {
  const options = collectSketchProfiles(sceneObjects);
  for (const obj of sceneObjects) {
    if (obj.type !== 'helix' || !obj.sourceLocation) {
      continue;
    }
    if (!hasRenderedGeometry(obj, sceneObjects)) {
      continue;
    }
    const loc = obj.sourceLocation;
    options.push({
      kind: 'other',
      feature: 'helix',
      label: 'Helix',
      filePath: loc.filePath,
      line: loc.line,
      column: loc.column,
      hasGeometry: true,
    });
  }
  return options;
}

/**
 * Relabel options with the variable names their statements are bound to
 * ("spine — line 3"); unbound statements keep the plain label. Resolves over
 * the live buffer server-side, so it's async — callers apply the result if
 * the dialog is still armed on the same options. Sketch and helix options
 * resolve against their own callee, one fetch per kind present.
 */
export async function labelWithSketchNames(options: SketchProfileOption[]): Promise<SketchProfileOption[]> {
  if (options.length === 0) {
    return options;
  }
  const names = new Array<string | null>(options.length).fill(null);
  await Promise.all((['sketch', 'helix', 'offset'] as const).map(async (feature) => {
    const indexes = options.flatMap((o, i) => o.feature === feature ? [i] : []);
    if (indexes.length === 0) {
      return;
    }
    const resolved = await fetchSketchNames(indexes.map(i => options[i].line), feature);
    indexes.forEach((optionIndex, i) => {
      names[optionIndex] = resolved[i];
    });
  }));
  return options.map((option, i) => {
    const name = names[i];
    if (!name) {
      return option;
    }
    return {
      ...option,
      label: option.kind === 'active' ? `Last Sketch — ${name}` : consumedLabel(name, option.consumer),
    };
  });
}

/** "s2 · used by Extrude" for a consumed sketch; the plain name otherwise. */
function consumedLabel(name: string, consumer: string | undefined): string {
  return consumer ? `${name} · used by ${consumer}` : name;
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
 * The edit-mode keep chip for any source slot (an axis, plane, face, path):
 * the statement's own expression, kept verbatim and not removable — a re-pick
 * is undone by its ✕, never the statement's own source.
 */
export function keepChip(text: string): PickSlotChip {
  return { label: `Current: ${text}`, badge: '●', removable: false };
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
  return options.map(o => `${o.feature}:${o.kind}:${o.filePath}:${o.line}`).join('|');
}

/** Resolve a timeline row to the sketch it belongs to (itself or its parent). */
export function resolveSketchRow(
  obj: SceneObjectRender,
  sceneObjects: SceneObjectRender[],
): SceneObjectRender | undefined {
  if (obj.type === 'sketch') {
    return obj;
  }
  const parent = SceneIndex.of(sceneObjects).parent(obj);
  return parent?.type === 'sketch' ? parent : undefined;
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
  // A shown consumed sketch draws its hidden wires — a click lands on those.
  const owner = sceneObjects.find(o => o.sceneShapes?.some(s => s.shapeId === shapeId)
    || o.hiddenShapes?.some(s => s.shapeId === shapeId));
  return owner ? resolveSketchRow(owner, sceneObjects) : undefined;
}

/**
 * Resolve a timeline row to the extrudable profile it belongs to: a
 * top-level offset row is its own source (it carries its outline on itself;
 * an in-sketch offset row resolves to its sketch); anything else resolves
 * like a sketch row. For the extrude profile slot.
 */
export function resolveProfileRow(
  obj: SceneObjectRender,
  sceneObjects: SceneObjectRender[],
): SceneObjectRender | undefined {
  if (obj.type === 'offset' && isTopLevel(obj, sceneObjects)) {
    return obj;
  }
  return resolveSketchRow(obj, sceneObjects);
}

/**
 * Resolve a picked wire shape to its extrudable profile: a top-level offset
 * owns its outline edges directly; sketch wires resolve through their entity
 * object's parent.
 */
export function resolveProfileByShapeId(
  shapeId: string,
  sceneObjects: SceneObjectRender[],
): SceneObjectRender | undefined {
  const owner = sceneObjects.find(o => o.sceneShapes?.some(s => s.shapeId === shapeId));
  return owner ? resolveProfileRow(owner, sceneObjects) : undefined;
}

/**
 * Resolve a timeline row to the wire source it belongs to: a helix row is
 * its own source (it carries its wire on itself); anything else resolves
 * like a sketch row. For the wire-consuming slots (sweep path, loft guides).
 */
export function resolveWireRow(
  obj: SceneObjectRender,
  sceneObjects: SceneObjectRender[],
): SceneObjectRender | undefined {
  if (obj.type === 'helix') {
    return obj;
  }
  return resolveSketchRow(obj, sceneObjects);
}

/**
 * Resolve a picked shape to its wire source: a helix owns its wire shape
 * directly; sketch wires resolve through their entity object's parent.
 */
export function resolveWireByShapeId(
  shapeId: string,
  sceneObjects: SceneObjectRender[],
): SceneObjectRender | undefined {
  const owner = sceneObjects.find(o => o.sceneShapes?.some(s => s.shapeId === shapeId));
  return owner ? resolveWireRow(owner, sceneObjects) : undefined;
}

/**
 * The wire parts a source renders — a helix's own non-meta, non-guide shapes,
 * or a sketch's direct children's, mirroring what SketchMesh draws as wire
 * lines. Addressed by source location like the options, so it re-resolves
 * after every render.
 */
function wireShapeParts(
  option: { filePath: string; line: number },
  sceneObjects: SceneObjectRender[],
): SceneObjectPart[] {
  const source = sceneObjects.find(o => (o.type === 'sketch' || o.type === 'helix' || o.type === 'offset')
    && o.sourceLocation?.filePath === option.filePath && o.sourceLocation?.line === option.line);
  if (!source) {
    return [];
  }
  const drawn = (parts: SceneObjectPart[] | undefined): SceneObjectPart[] =>
    (parts ?? []).filter(s => !s.isMetaShape && !s.isGuide && s.shapeId);
  // A helix (or a top-level offset) carries its wires on its own object —
  // there are no children.
  if (source.type === 'helix' || source.type === 'offset') {
    return drawn(source.sceneShapes);
  }
  // A consumed sketch's wires are its hidden shapes — the dialog that holds
  // it reveals them, so they are the highlight targets too.
  return SceneIndex.of(sceneObjects).children(source.id)
    .flatMap(obj => drawn(obj.sceneShapes).concat(drawn(obj.hiddenShapes)));
}

/**
 * Shape ids of the wires a sketch renders. These are the highlight targets
 * for a sketch selected in a create dialog.
 */
export function sketchWireShapeIds(
  option: { filePath: string; line: number },
  sceneObjects: SceneObjectRender[],
): string[] {
  return wireShapeParts(option, sceneObjects).map(s => s.shapeId!);
}

/**
 * The source's whole rendered geometry is one edge — what a slot taking a
 * bare edge (a from-edge plane's base) can consume. A helix always qualifies;
 * a sketch only while it draws a single curve, since the expression addresses
 * the sketch as a whole and a multi-segment one resolves to a wire, not an
 * edge.
 */
export function isSingleEdgeWire(
  option: { filePath: string; line: number },
  sceneObjects: SceneObjectRender[],
): boolean {
  const parts = wireShapeParts(option, sceneObjects);
  return parts.length === 1 && parts[0].shapeType === 'edge';
}

function toOption(
  obj: SceneObjectRender,
  kind: 'active' | 'other',
  sceneObjects: SceneObjectRender[],
): SketchProfileOption {
  const loc = obj.sourceLocation!;
  return {
    kind,
    feature: 'sketch',
    label: kind === 'active' ? 'Last Sketch' : 'Sketch',
    filePath: loc.filePath,
    line: loc.line,
    column: loc.column,
    hasGeometry: hasRenderedGeometry(obj, sceneObjects),
  };
}

/** A consumed sketch as an option: the consumer's display name rides along for the label. */
function toConsumedOption(obj: SceneObjectRender, sceneObjects: SceneObjectRender[]): SketchProfileOption {
  const consumer = sceneObjects.find(o => o.id === obj.consumedBy);
  const name = consumer?.name || 'a feature';
  return {
    ...toOption(obj, 'other', sceneObjects),
    label: consumedLabel('Sketch', name),
    hasGeometry: true,
    consumer: name,
  };
}

/**
 * A sketch's drawn geometry renders on its child objects (each entity — rect,
 * circle, line — is its own scene object under the sketch), so the whole
 * subtree counts, not just the sketch's own shapes.
 */
function hasRenderedGeometry(obj: SceneObjectRender, sceneObjects: SceneObjectRender[]): boolean {
  return SceneIndex.of(sceneObjects).hasRenderedGeometry(obj);
}

/** A consumed sketch whose entities carry the wires their consumer hid. */
function hasHiddenGeometry(obj: SceneObjectRender, sceneObjects: SceneObjectRender[]): boolean {
  return SceneIndex.of(sceneObjects).children(obj.id)
    .some(child => (child.hiddenShapes ?? []).some(s => !s.isMetaShape && !s.isGuide && (s.meshes?.length ?? 0) > 0));
}
