/**
 * Mesh references on the scene wire (generators S6b, P5).
 *
 * Every rendered shape the engine sends carries `meshKey` (lib `MeshKeys`):
 * the name of its mesh payload — `meshes`, `vertices`, `faceVertices`. The
 * same key is always the same payload. A page that keeps a mesh cache
 * (`ui-hello.meshCache`) is sent, in place of a payload it was sent before,
 * the shape with `meshRef: <key>` and those three fields left out; every
 * other field of the shape rides as always. A page that misses a key asks
 * `POST /api/meshes` (see {@link MeshStore}).
 */

/** One shape's mesh payload: what a mesh key names. */
export type MeshPayload = {
  meshes: unknown[];
  vertices?: number[];
  faceVertices?: number[][];
};

/** A rendered shape on the wire, as far as its mesh goes. */
export type WireShape = MeshPayload & { meshKey?: string; [field: string]: unknown };

/** A keyed shape of a scene message, with its weight (see {@link SceneMeshes.weightOf}). */
export type SceneMeshEntry = { key: string; shape: WireShape; weight: number };

/** Something that knows which keys a page holds. */
export type HeldKeys = { holds(key: string): boolean };

type WireRow = Record<string, unknown>;

export class SceneMeshes {
  /** The shape lists of a scene row that carry meshes. */
  static readonly SHAPE_LISTS = ['sceneShapes', 'hiddenShapes', 'referencedShapes'] as const;

  /**
   * The keyed shapes of a `scene-rendered` message's rows, in wire order —
   * every shape with a `meshKey` and its meshes (a shape the mesher could
   * not mesh sends `meshes: null` and no key).
   */
  static entriesOf(msg: { result?: unknown }): SceneMeshEntry[] {
    const entries: SceneMeshEntry[] = [];
    if (!Array.isArray(msg.result)) {
      return entries;
    }
    for (const row of msg.result as WireRow[]) {
      for (const list of SceneMeshes.SHAPE_LISTS) {
        const shapes = row?.[list];
        if (!Array.isArray(shapes)) {
          continue;
        }
        for (const shape of shapes as WireShape[]) {
          if (SceneMeshes.isKeyed(shape)) {
            entries.push({ key: shape.meshKey!, shape, weight: SceneMeshes.weightOf(shape) });
          }
        }
      }
    }
    return entries;
  }

  /**
   * How many numbers a shape's payload carries — every mesh's vertices,
   * normals, indices, face mapping and face sides, plus the topology
   * vertices and face-vertex lists. The one measure both ends bound their
   * mesh bookkeeping by: the page weighs what it keeps the same way.
   */
  static weightOf(shape: MeshPayload): number {
    let weight = 0;
    for (const mesh of shape.meshes as Record<string, unknown>[]) {
      for (const field of ['vertices', 'normals', 'indices', 'faceMapping', 'faceSides']) {
        const values = mesh?.[field];
        if (Array.isArray(values)) {
          weight += values.length;
        }
      }
    }
    weight += shape.vertices?.length ?? 0;
    for (const face of shape.faceVertices ?? []) {
      weight += face.length;
    }
    return weight;
  }

  /** The payload a shape's key names. */
  static payloadOf(shape: WireShape): MeshPayload {
    const payload: MeshPayload = { meshes: shape.meshes };
    if (shape.vertices !== undefined) {
      payload.vertices = shape.vertices;
    }
    if (shape.faceVertices !== undefined) {
      payload.faceVertices = shape.faceVertices;
    }
    return payload;
  }

  /**
   * The message one page is sent: every shape whose key the page holds —
   * or whose payload went out earlier in this same message — as a
   * `meshRef`, the rest whole. Rows and lists are copied only where a shape
   * changed; `msg` itself is never modified (other pages, the replay and
   * the editor hosts read it whole).
   */
  static forPage(msg: { result?: unknown }, held: HeldKeys): { msg: Record<string, unknown>; refs: number } {
    if (!Array.isArray(msg.result)) {
      return { msg: msg as Record<string, unknown>, refs: 0 };
    }
    const sentHere = new Set<string>();
    let refs = 0;
    const result = (msg.result as WireRow[]).map((row) => {
      let copy: WireRow | null = null;
      for (const list of SceneMeshes.SHAPE_LISTS) {
        const shapes = row?.[list];
        if (!Array.isArray(shapes)) {
          continue;
        }
        let listCopy: unknown[] | null = null;
        shapes.forEach((shape: WireShape, index: number) => {
          if (!SceneMeshes.isKeyed(shape)) {
            return;
          }
          const key = shape.meshKey!;
          if (!held.holds(key) && !sentHere.has(key)) {
            sentHere.add(key);
            return;
          }
          listCopy ??= [...shapes];
          listCopy[index] = SceneMeshes.reference(shape);
          refs++;
        });
        if (listCopy) {
          copy ??= { ...row };
          copy[list] = listCopy;
        }
      }
      return copy ?? row;
    });
    return { msg: refs > 0 ? { ...msg, result } : msg as Record<string, unknown>, refs };
  }

  /** A shape as a reference to its payload: every field but the payload's, plus `meshRef`. */
  private static reference(shape: WireShape): Record<string, unknown> {
    const { meshes: _meshes, vertices: _vertices, faceVertices: _faceVertices, meshKey, ...rest } = shape;
    return { ...rest, meshRef: meshKey };
  }

  private static isKeyed(shape: WireShape | null | undefined): boolean {
    return !!shape && typeof shape.meshKey === 'string' && Array.isArray(shape.meshes);
  }
}
