import { Shape } from "../common/shape.js";
import { Point } from "../math/point.js";
import { Explorer } from "../oc/explorer.js";
import { ShapeHasher } from "../oc/shape-hash.js";

// Shape geometry is immutable: transforms create new wrappers. Cache only
// plain coordinates, never native vertex handles that outlive scene disposal.
const positions = new WeakMap<Shape, number[]>();
const faceIndices = new WeakMap<Shape, number[][]>();

/** Exact topology membership, using the same face/vertex order as viewport picks. */
export function topologyFaceVertices(shape: Shape): number[][] {
  const cached = faceIndices.get(shape);
  if (cached) {
    return cached;
  }
  const vertices = Explorer.findVerticesWrapped(shape);
  const faces = Explorer.findFacesWrapped(shape);
  const hasher = new ShapeHasher();
  try {
    const indices = new Map(vertices.map((vertex, index) => [hasher.key(vertex.getShape()), index]));
    const result = faces.map(face => {
      const members = Explorer.findVerticesWrapped(face);
      try {
        return members.map(member => indices.get(hasher.key(member.getShape()))!).sort((a, b) => a - b);
      } finally {
        for (const member of members) {
          member.dispose();
        }
      }
    });
    faceIndices.set(shape, result);
    return result;
  } finally {
    hasher.delete();
    for (const wrapper of [...faces, ...vertices]) {
      wrapper.dispose();
    }
  }
}

/** Packed xyz in Explorer vertex order, shared by rendering and pick resolution. */
export function topologyVertices(shape: Shape): number[] {
  const cached = positions.get(shape);
  if (cached) {
    return cached;
  }
  const vertices = Explorer.findVerticesWrapped(shape);
  try {
    const result = vertices.flatMap(vertex => vertex.toPoint().toArray());
    positions.set(shape, result);
    return result;
  } finally {
    for (const vertex of vertices) {
      vertex.dispose();
    }
  }
}

export function pickedVertexPoint(shape: Shape, index: number): Point | null {
  const vertices = topologyVertices(shape);
  if (!Number.isInteger(index) || index < 0 || index * 3 + 2 >= vertices.length) {
    return null;
  }
  return new Point(vertices[index * 3], vertices[index * 3 + 1], vertices[index * 3 + 2]);
}
