import { Sketch } from "../features/2d/sketch.js";
import { SelectSceneObject } from "../features/select.js";
import { SceneObject } from "../common/scene-object.js";
import { Extrudable } from "../helpers/types.js";
import { Part } from "../features/part.js";
import { getUnitRegistry } from "../units/registry.js";
import type { LengthUnit } from "../units/units.js";

export type SceneObjectMesh = {
  label?: string;
  vertices: number[];
  normals: number[];
  indices: number[];
  color?: string;
  faceMapping?: number[];  // faceMapping[triangleIdx] = OCC face index (solid-faces meshes only)
  edgeIndex?: number;      // solid-edges meshes only
  smooth?: boolean;        // solid-edges meshes only — a tangent (G1) junction between two faces (dimmed when dimTangentEdges is on)
}

export type RenderedShape = {
  shapeId: string;
  /** Packed world xyz per topological vertex, in Explorer order. */
  vertices?: number[];
  /** Vertex indices belonging to each face, in the viewport's topology order. */
  faceVertices?: number[][];
  meshes: SceneObjectMesh[];
  shapeType: string;
  isMetaShape?: boolean;
  isGuide?: boolean;
  metaType?: string;
  metaData?: Record<string, any>;
  role?: string;
  roleIndex?: number;
  provenance?: string;
}

export type SketchInteractivity = 'draggable' | 'selectable' | 'construction';

export type SceneObjectRender = {
  id: string;
  name: string;
  /** True when `name` comes from a user's `.name('…')` chain, not the type. */
  hasCustomName?: boolean;
  parentId: string | null;
  isContainer: boolean;
  hideChildren?: boolean;
  object: any;
  sceneShapes: RenderedShape[];
  /**
   * Shapes the object publishes but never puts on screen — an `expose(…)`
   * row's source selection, which the exposure hides from the rendered scene.
   * The UI shows them on demand (a timeline-row click) as a highlight.
   */
  referencedShapes?: RenderedShape[];
  visible: boolean;
  /** The object carries a `.reusable()` chain — kept visible when consumed. */
  reusable?: boolean;
  /**
   * The object serves another statement's build (a sketch's own plane) rather
   * than being a feature the code wrote — the timeline leaves it out.
   */
  internal?: boolean;
  type: string;
  uniqueType: string;
  /** Viewport classification for sketch geometry children (server-driven). */
  interactivity?: SketchInteractivity;
  /** The unit the object's numbers are in (its creating statement's file). */
  unit?: LengthUnit;
  fromCache: boolean;
  hasError: boolean;
  errorMessage?: string;
  /**
   * `occurrence` is render-derived, never stamped: the 0-based execution
   * index of this object's call site, present only when a loop/helper ran
   * the statement more than once in this render.
   */
  sourceLocation?: { filePath: string; line: number; column: number; occurrence?: number };
  buildDurationMs?: number;
  profileCategories?: { category: string; durationMs: number }[];
  /**
   * Sketches only, tip sketch only: invisible plane-local 2D snap targets
   * for the interactive sketcher — where the sketch plane slices the scene's
   * bodies (the vertices an intersect() would produce) plus every prior
   * shape's topological vertices projected onto the plane.
   */
  snapVertices?: [number, number][];
}

/**
 * Structural view of a `PartDefinition` — kept structural so scene.ts never
 * imports the definition class (which imports scene-manager, which imports
 * this file).
 */
export type TrackedPartDefinition = {
  hasVariantIn(scene: Scene): boolean;
  materializeInto(scene: Scene): unknown;
};

/**
 * Parent / part lookups over the flat object list, derived in one pass. Valid
 * for one (list version, structure epoch) pair — see Scene.structure.
 */
type SceneStructure = {
  version: number;
  epoch: number;
  enclosingPart: Map<SceneObject, Part | null>;
  /** Each part's members — itself and everything nested in it — in scene order. */
  partMembers: Map<Part, SceneObject[]>;
  /** Objects by their parent's id, in scene order. */
  children: Map<string, SceneObject[]>;
};

const NO_OBJECTS: SceneObject[] = [];

export class Scene {

  private sceneObjects: SceneObject[] = [];
  /** Each object's position in `sceneObjects` — kept in step with every add and replace. */
  private order: Map<SceneObject, number> = new Map();
  /** Bumped by every change to `sceneObjects`. */
  private version = 0;
  private structureIndex: SceneStructure | null = null;
  private renderedObjects: Map<SceneObject, SceneObjectRender> = new Map();
  private cached: Set<SceneObject> = new Set();

  private progressiveContainers: SceneObject[] = [];

  private idMap: Map<string, SceneObject> = new Map();

  /** Every part definition created while this scene was current — see materializeLeftoverDefinitions. */
  private partDefinitions: TrackedPartDefinition[] = [];

  constructor() {
  }

  private _units: { unit: LengthUnit; declaredUnit: LengthUnit | null } | null = null;

  /**
   * The root document's unit and whether the document declared it itself,
   * frozen together on first read. Resolved by file, lazily: the root's
   * unit() runs during module evaluation, after startScene(), so nothing
   * reads this before the document has been evaluated. The first read
   * freezes it: a rolled-back previous scene is re-emitted after later
   * renders (possibly of another file) have replaced the registry, and it
   * must keep reporting its own unit.
   */
  private resolveUnits(): { unit: LengthUnit; declaredUnit: LengthUnit | null } {
    if (this._units === null) {
      const registry = getUnitRegistry();
      this._units = { unit: registry.rootUnit, declaredUnit: registry.declared(registry.rootFile) };
    }
    return this._units;
  }

  /**
   * The unit of this scene's root document: its own unit(), else the project
   * unit. An assembly scene always lands on the project unit — assembly
   * files can never declare one.
   */
  get unit(): LengthUnit {
    return this.resolveUnits().unit;
  }

  /**
   * The unit the root document declares with unit(), or null when it has no
   * statement and follows the project unit — the distinction the unit
   * chip's "Same as project" option is built on (`unit` alone can't tell an
   * explicit unit('mm') from an undeclared mm file).
   */
  get declaredUnit(): LengthUnit | null {
    return this.resolveUnits().declaredUnit;
  }

  trackPartDefinition(definition: TrackedPartDefinition): void {
    this.partDefinitions.push(definition);
  }

  /**
   * Build every tracked definition that has no variant in this scene yet —
   * the entry-file pass that keeps an open part file WYSIWYG: `part()` no
   * longer builds at call time, so definitions nothing exported or inserted
   * would otherwise silently vanish from the render. Called after module
   * evaluation for part-kind entry scenes only; assembly scenes build
   * strictly via insert().
   */
  materializeLeftoverDefinitions(): void {
    for (const definition of this.partDefinitions) {
      if (!definition.hasVariantIn(this)) {
        definition.materializeInto(this);
      }
    }
  }

  /**
   * Run `fn` with the progressive-container stack suspended — part
   * definition variants always materialize as top-level templates, even
   * when their build is triggered mid-build of another container.
   */
  runTopLevel<T>(fn: () => T): T {
    const saved = this.progressiveContainers;
    this.progressiveContainers = [];
    try {
      return fn();
    } finally {
      this.progressiveContainers = saved;
    }
  }

  addSceneObject(obj: SceneObject): void {
    if (this.order.has(obj)) {
      return;
    }

    obj.setOrder(this.sceneObjects.length);

    const activeObj = this.getActiveContainer();
    if (activeObj && !obj.getParent()) {
      activeObj.addChildObject(obj);
    }

    this.order.set(obj, this.sceneObjects.length);
    this.sceneObjects.push(obj);
    this.version++;
    this.idMap.set(obj.id, obj);
  }

  /**
   * The derived lookups, rebuilt in one pass when the list or any object's
   * parent / id changed since they were built. A render mutates neither, so
   * its per-object queries share one index instead of each filtering the
   * whole list — that filter, once per object, was quadratic in scene size.
   * Part membership is the parent chain, never an index range: a definition
   * materialized mid-body interleaves with its consumer's children.
   */
  private structure(): SceneStructure {
    const current = this.structureIndex;
    if (current && current.version === this.version && current.epoch === SceneObject.structureEpoch) {
      return current;
    }
    const enclosingPart = new Map<SceneObject, Part | null>();
    const partMembers = new Map<Part, SceneObject[]>();
    const children = new Map<string, SceneObject[]>();
    for (const obj of this.sceneObjects) {
      const part = this.walkToEnclosingPart(obj);
      enclosingPart.set(obj, part);
      if (part) {
        const members = partMembers.get(part);
        if (members) {
          members.push(obj);
        } else {
          partMembers.set(part, [obj]);
        }
      }
      const parentId = obj.parentId;
      if (parentId) {
        const siblings = children.get(parentId);
        if (siblings) {
          siblings.push(obj);
        } else {
          children.set(parentId, [obj]);
        }
      }
    }
    this.structureIndex = { version: this.version, epoch: SceneObject.structureEpoch, enclosingPart, partMembers, children };
    return this.structureIndex;
  }

  /**
   * How many leading entries of `objects` (in scene order) sit before `obj`.
   * An object that is not in the scene sits at the last position — what
   * `slice(0, indexOf(obj))` answers for it.
   */
  private countBefore(objects: SceneObject[], obj: SceneObject): number {
    const limit = this.order.get(obj) ?? this.sceneObjects.length - 1;
    let low = 0;
    let high = objects.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.order.get(objects[mid])! < limit) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }

  startProgressiveContainer(obj: SceneObject): void {
    this.addSceneObject(obj);
    this.progressiveContainers.push(obj);
  }

  getActiveContainer(): SceneObject | null {
    if (this.progressiveContainers.length > 0) {
      return this.progressiveContainers[this.progressiveContainers.length - 1];
    }
    return null;
  }

  endProgressiveContainer() {
    const obj = this.progressiveContainers.pop();
    if (!obj) {
      throw new Error('No progressive container to end.');
    }
    return obj;
  }

  getActiveSketch(): Sketch | null {
    const activeObject = this.getActiveContainer();
    if (activeObject && activeObject instanceof Sketch) {
      return activeObject;
    }
    return null;
  }

  getActivePart(): Part | null {
    for (let i = this.progressiveContainers.length - 1; i >= 0; i--) {
      if (this.progressiveContainers[i] instanceof Part) {
        return this.progressiveContainers[i] as Part;
      }
    }
    return null;
  }

  findEnclosingPart(obj: SceneObject): Part | null {
    // Answered from the index only while it is current: module evaluation
    // asks this between adds, and rebuilding the index per question there
    // would cost far more than the walk.
    const index = this.structureIndex;
    if (index && index.version === this.version && index.epoch === SceneObject.structureEpoch) {
      const known = index.enclosingPart.get(obj);
      if (known !== undefined) {
        return known;
      }
    }
    return this.walkToEnclosingPart(obj);
  }

  private walkToEnclosingPart(obj: SceneObject): Part | null {
    let current = obj.getParent();
    while (current) {
      if (current instanceof Part) {
        return current;
      }
      current = current.getParent();
    }
    // The object itself might be a Part
    if (obj instanceof Part) {
      return obj;
    }
    return null;
  }

  getPartScopedObjectsUpTo(obj: SceneObject): SceneObject[] {
    const part = this.findEnclosingPart(obj);
    if (!part) {
      return this.getSceneObjectsUpTo(obj);
    }
    const members = this.membersOf(part);
    return members.slice(0, this.countBefore(members, obj));
  }

  getPartScopedActiveObjectsUpTo(obj: SceneObject): SceneObject[] {
    const part = this.findEnclosingPart(obj);
    if (!part) {
      return this.getActiveSceneObjectsUpTo(obj);
    }
    return this.getPartScopedObjectsUpTo(obj).filter(f => f.hasShapes());
  }

  /** The part and everything nested in it, in scene order. Callers get a copy. */
  private membersOf(part: Part): SceneObject[] {
    return this.structure().partMembers.get(part) ?? NO_OBJECTS;
  }

  getSceneObjects(): SceneObject[] {
    const object = this.sceneObjects
    return object;
  }

  getPartScopedSceneObjects(): SceneObject[] {
    const activePart = this.getActivePart();
    if (!activePart) {
      return this.sceneObjects;
    }
    return [...this.membersOf(activePart)];
  }

  getPartScopedAllObjects(obj: SceneObject): SceneObject[] {
    const part = this.findEnclosingPart(obj);
    if (!part) {
      return this.sceneObjects;
    }
    return [...this.membersOf(part)];
  }

  getActiveSceneObjectsUpTo(obj: SceneObject): SceneObject[] {
    return this.sceneObjects.slice(0, this.indexOf(obj)).filter(f => f.hasShapes());
  }

  getSceneObjectsUpTo(obj: SceneObject): SceneObject[] {
    return this.sceneObjects.slice(0, this.indexOf(obj));
  }

  getSceneObjectsFromTo(obj: SceneObject, to:SceneObject): SceneObject[] {
    const fromIndex = this.indexOf(obj);
    const toIndex = this.indexOf(to);
    const objects = this.sceneObjects
      .slice(fromIndex, toIndex)

    return objects;
  }

  getAllSceneObjects(): SceneObject[] {
    return this.sceneObjects;
  }

  getLastExtrudable(): Extrudable | null {
    const activePart = this.getActivePart();
    let count = this.sceneObjects.length;

    while (count--) {
      const object = this.sceneObjects[count];
      if (!object.isExtrudable()) {
        continue;
      }

      if (activePart) {
        // Inside a Part: find extrudables that are direct children of this Part
        if (object.getParent() === activePart) {
          return object as Extrudable;
        }
      } else {
        // Outside any Part: original behavior (top-level only)
        if (!object.parentId) {
          return object as Extrudable;
        }
      }
    }

    return null;
  }

  getLastSelections(): SelectSceneObject[] {
    let count = this.sceneObjects.length;
    const selections = [];

    while (count--) {
      const obj = this.sceneObjects[count];
      if (obj instanceof SelectSceneObject) {
        selections.push(obj);
      }
    }

    return selections;
  }

  /**
   * The implicit selection a bare `color()` / `fillet(2)` / `shell()` falls
   * back to: the most recent `select(...)` statement no other feature call has
   * already taken as an operand.
   */
  getLastSelection(): SelectSceneObject | null {
    let count = this.sceneObjects.length;

    while (count--) {
      const obj = this.sceneObjects[count];
      if (obj instanceof SelectSceneObject && !obj.isClaimed()) {
        return obj;
      }
    }

    return null;
  }

  replaceSceneObject(currentSceneObject: SceneObject, newSceneObject: SceneObject): void {
    const index = this.indexOf(currentSceneObject);
    if (index !== -1) {
      this.sceneObjects[index] = newSceneObject;
      this.order.delete(currentSceneObject);
      this.order.set(newSceneObject, index);
      this.version++;
    }
  }

  addRenderedObject(object: SceneObject, rendered: SceneObjectRender) {
    this.renderedObjects.set(object, rendered);
  }

  getRenderedObject(obj: SceneObject): SceneObjectRender | null {
    return this.renderedObjects.get(obj) || null;
  }

  getRenderedObjects() {
    return Array.from(this.renderedObjects.values());
  }

  clearRenderedObjects() {
    this.renderedObjects.clear();
  }

  removeRenderedObject(obj: SceneObject) {
    this.renderedObjects.delete(obj);
  }

  markCached(obj: SceneObject) {
    this.cached.add(obj);
  }

  /** Undo markCached — the compare decided the object must rebuild after all. */
  unmarkCached(obj: SceneObject) {
    this.cached.delete(obj);
  }

  isCached(obj: SceneObject) {
    return this.cached.has(obj);
  }

  indexOf(obj: SceneObject): number {
    return this.order.get(obj) ?? -1;
  }

  getSceneObjectAt(index: number): SceneObject {
    return this.sceneObjects[index];
  }

  getSceneObjectById(id: string): SceneObject | null {
    return this.idMap.get(id) || null;
  }

  reindexObject(obj: SceneObject, oldId: string): void {
    this.version++;
    this.idMap.delete(oldId);
    this.idMap.set(obj.id, obj);
  }

  getChildren(parent: SceneObject): SceneObject[] {
    return [...(this.structure().children.get(parent.id) ?? NO_OBJECTS)];
  }

}
