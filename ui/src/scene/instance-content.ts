import type { Object3D } from 'three';
import { SceneIndex } from '../helpers/scene-index';
import type { SceneObjectRender } from '../types';

/**
 * What an assembly instance draws, named so two renders can be compared
 * (generators S6b): its part template's subtree — every row in the order
 * the mesh factory walks it, with its depth — with each shape's payload
 * named by its `meshKey` instead of carried, and every row id and shape id
 * of the subtree, wherever it appears (a connector's `hostShapeIds` too),
 * named by its place in the walk.
 *
 * An assembly render re-mints every scene id (AssemblyCompare inherits no
 * identity) and a template rebuilt into the same mesh (another detail
 * tier) has new shape ids, so ids cannot tell an unchanged part from a
 * changed one; this can. **Equal content ⇒ the group built for one render
 * draws exactly what a rebuild for the other would**, but for the ids the
 * mesh tree stamps on its objects ({@link ID_KEYS}), which {@link restamp}
 * moves to the new render's rows and shapes. The rule that keeps it exact:
 * - every row field is part of the content except {@link VOLATILE_FIELDS} —
 *   fields that change from render to render and that no mesh builder
 *   reads (a test pins that the builders stamp the subtree's ids under
 *   {@link ID_KEYS} only);
 * - a shape with meshes but no key (an engine before S6b) makes the content
 *   unnameable: {@link of} answers null and the instance is rebuilt.
 */
export class InstanceContent {
  /** Row fields that change every render and never reach a mesh: left out of the content. */
  static readonly VOLATILE_FIELDS: readonly string[] = ['id', 'parentId', 'fromCache', 'buildDurationMs', 'profileCategories', 'sourceLocation'];
  /** The shape lists of a row; their shapes' payloads are named by key. */
  static readonly SHAPE_LISTS: readonly string[] = ['sceneShapes', 'hiddenShapes', 'referencedShapes'];
  /** The payload fields a mesh key names. */
  static readonly PAYLOAD_FIELDS: readonly string[] = ['meshes', 'vertices', 'faceVertices'];
  /**
   * The userData keys under which the mesh builders stamp a row's id
   * (ConnectorMesh, SketchMesh) or a shape's (ShapeGroup, SketchMesh,
   * PlaneMesh; a connector's host shapes) — one id or a list of them.
   */
  static readonly ID_KEYS: readonly string[] = ['connectorId', 'sketchObjectId', 'shapeId', 'hostShapeIds'];

  private constructor(
    /** The subtree, payloads named by key, ids named by their place in the walk. */
    readonly signature: string,
    /** The subtree's row ids, then its shapes' ids, in walk order. */
    readonly ids: readonly string[],
  ) {}

  /** The subtree's row ids, in walk order. */
  get rowIds(): readonly string[] {
    return this.ids.filter(id => !id.startsWith(InstanceContent.SHAPE_MARK));
  }

  /** Marks a shape id in {@link ids} (row ids and shape ids are listed together, in walk order). */
  private static readonly SHAPE_MARK = '\u0001';

  /** The content of part `partId`'s subtree in `objects`, or null when it cannot be named. */
  static of(partId: string, objects: readonly SceneObjectRender[]): InstanceContent | null {
    const index = SceneIndex.of(objects);
    const root = index.byId(partId);
    if (!root) {
      return null;
    }
    const rows: unknown[] = [];
    const ids: string[] = [];
    const places = new Map<string, string>();
    const name = (id: unknown, kind: 'r' | 's') => {
      if (typeof id === 'string' && !places.has(id)) {
        places.set(id, `\u0000${kind}${places.size}`);
        ids.push(kind === 's' ? `${InstanceContent.SHAPE_MARK}${id}` : id);
      }
    };
    const walk = (row: SceneObjectRender, depth: number): boolean => {
      const projected = InstanceContent.project(row);
      if (!projected) {
        return false;
      }
      rows.push([depth, projected]);
      name(row.id, 'r');
      for (const list of InstanceContent.SHAPE_LISTS) {
        const shapes = (row as unknown as Record<string, unknown>)[list];
        if (Array.isArray(shapes)) {
          shapes.forEach(shape => name(shape?.shapeId, 's'));
        }
      }
      return index.children(row.id).every(child => walk(child, depth + 1));
    };
    if (!walk(root, 0)) {
      return null;
    }
    // Every id of the subtree, wherever it appears, by its place in the walk.
    const signature = JSON.stringify(rows, (_key, value) => (typeof value === 'string' && places.has(value) ? places.get(value) : value));
    return new InstanceContent(signature, ids);
  }

  equals(other: InstanceContent | null): boolean {
    return other !== null && other.signature === this.signature;
  }

  /**
   * Move the row and shape ids `group` was built with — `built`'s, the
   * render that built it — to this render's, which correspond one to one
   * in walk order (equal content).
   */
  restamp(group: Object3D, built: InstanceContent): void {
    const renamed = new Map<string, string>();
    built.ids.forEach((id, i) => {
      if (id !== this.ids[i]) {
        renamed.set(InstanceContent.bare(id), InstanceContent.bare(this.ids[i]));
      }
    });
    if (renamed.size === 0) {
      return;
    }
    const rename = (id: unknown): unknown => (typeof id === 'string' && renamed.has(id) ? renamed.get(id) : id);
    group.traverse((object) => {
      for (const key of InstanceContent.ID_KEYS) {
        const value = object.userData[key];
        if (Array.isArray(value)) {
          object.userData[key] = value.map(rename);
        } else if (value !== undefined) {
          object.userData[key] = rename(value);
        }
      }
    });
  }

  /** An object's fields, in name order. */
  private static fieldsOf(value: object): [string, unknown][] {
    return Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /** An id of {@link ids} without its shape mark. */
  private static bare(id: string): string {
    return id.startsWith(InstanceContent.SHAPE_MARK) ? id.slice(InstanceContent.SHAPE_MARK.length) : id;
  }

  /**
   * A row without its volatile fields and with its shapes' payloads named —
   * null when a payload has no name. Fields in name order: a shape whose
   * reference the page resolved carries its fields in another order than
   * one sent whole.
   */
  private static project(row: SceneObjectRender): Record<string, unknown> | null {
    const projected: Record<string, unknown> = {};
    for (const [field, value] of InstanceContent.fieldsOf(row)) {
      if (InstanceContent.VOLATILE_FIELDS.includes(field)) {
        continue;
      }
      if (InstanceContent.SHAPE_LISTS.includes(field) && Array.isArray(value)) {
        const shapes = value.map(shape => InstanceContent.projectShape(shape));
        if (shapes.some(shape => shape === null)) {
          return null;
        }
        projected[field] = shapes;
        continue;
      }
      projected[field] = value;
    }
    return projected;
  }

  private static projectShape(shape: Record<string, unknown>): Record<string, unknown> | null {
    if (Array.isArray(shape.meshes) && typeof shape.meshKey !== 'string') {
      return null;
    }
    const projected: Record<string, unknown> = {};
    for (const [field, value] of InstanceContent.fieldsOf(shape)) {
      if (!InstanceContent.PAYLOAD_FIELDS.includes(field)) {
        projected[field] = value;
      }
    }
    return projected;
  }
}
