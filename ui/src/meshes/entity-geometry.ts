import { BufferGeometry, Mesh, Object3D } from 'three';

/** The triangles of one B-rep face, in the owning mesh's local space. */
export type FaceTriangles = {
  /** The solid's face mesh the triangles were lifted from — overlays attach beside it. */
  mesh: Mesh;
  /** Flat xyz triples, three vertices per triangle. */
  positions: Float32Array;
};

/**
 * Locates the rendered geometry of a B-rep face or edge — the triangles a
 * `faceMapping` assigns to a face index, the fat-line objects carrying an
 * edge index — under a traversal root. The viewer's selection highlight and
 * the screenshot overlay both build their meshes from this one lookup, so an
 * entity picked on screen and an entity named through the API light up the
 * same pixels.
 */
export class EntityGeometry {

  /** Whether `obj` sits inside the non-meta shape group with this id. */
  static belongsToShape(obj: Object3D, shapeId: string): boolean {
    let cur: Object3D | null = obj;
    while (cur) {
      if (cur.userData.shapeId === shapeId && !cur.userData.isMetaShape) {
        return true;
      }
      cur = cur.parent;
    }
    return false;
  }

  /**
   * The triangles of face `faceIndex` on shape `shapeId`, one entry per face
   * mesh that carries some of them (a shape renders as one mesh, but an
   * instance group may hold clones). Empty when nothing under `scope`
   * matches.
   */
  static faceTriangles(scope: Object3D, shapeId: string, faceIndex: number): FaceTriangles[] {
    const found: FaceTriangles[] = [];
    scope.traverse((obj) => {
      if (!(obj as Mesh).isMesh) {
        return;
      }
      const mapping: number[] | undefined = obj.userData.faceMapping;
      if (!mapping || !EntityGeometry.belongsToShape(obj, shapeId)) {
        return;
      }
      const mesh = obj as Mesh;
      const positions = EntityGeometry.liftTriangles(mesh.geometry as BufferGeometry, mapping, faceIndex);
      if (positions) {
        found.push({ mesh, positions });
      }
    });
    return found;
  }

  /** The line objects rendering edge `edgeIndex` of shape `shapeId` under `scope`. */
  static edgeLines(scope: Object3D, shapeId: string, edgeIndex: number): Object3D[] {
    const found: Object3D[] = [];
    scope.traverse((obj) => {
      const isLine = (obj as any).isLine || obj.userData.isEdgeLine;
      if (!isLine || obj.userData.edgeIndex !== edgeIndex) {
        return;
      }
      if (EntityGeometry.belongsToShape(obj, shapeId)) {
        found.push(obj);
      }
    });
    return found;
  }

  private static liftTriangles(geometry: BufferGeometry, mapping: number[], faceIndex: number): Float32Array | null {
    const indexAttr = geometry.index;
    if (!indexAttr) {
      return null;
    }
    const indices = indexAttr.array;
    const positions = geometry.getAttribute('position').array as Float32Array;
    const lifted: number[] = [];
    for (let tri = 0; tri < mapping.length; tri++) {
      if (mapping[tri] !== faceIndex) {
        continue;
      }
      for (let corner = 0; corner < 3; corner++) {
        const base = (indices[tri * 3 + corner] as number) * 3;
        lifted.push(positions[base], positions[base + 1], positions[base + 2]);
      }
    }
    if (lifted.length === 0) {
      return null;
    }
    return new Float32Array(lifted);
  }
}
