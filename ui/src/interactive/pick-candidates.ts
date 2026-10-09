import { LineSegments, type Material, Mesh, Object3D, Vector3 } from 'three';
import { clippedByMaterial } from './pick-visibility';

/** Candidate buckets that are only collected while their pick channel is armed. */
export interface PickChannels {
  sketchWires: boolean;
  /** Top-level offset outlines as profile picks (the extrude dialog only). */
  profileWires: boolean;
  axes: boolean;
  planes: boolean;
  vertices?: boolean;
  vertexScope?: ReadonlySet<string> | null;
}

export type VertexCandidate = {
  shapeId: string;
  index: number;
  position: Vector3;
  instanceId: string | null;
};

/** Assembly occurrences share shape ids, so every pick retains its instance. */
export function pickInstanceId(object: Object3D): string | null {
  for (let parent: Object3D | null = object; parent; parent = parent.parent) {
    if (typeof parent.userData.instanceId === 'string') {
      return parent.userData.instanceId;
    }
  }
  return null;
}

/** Raycast targets for one pick query, split by the geometry they resolve to. */
export interface PickCandidates {
  faces: Mesh[];
  edges: LineSegments[];
  sketchWires: LineSegments[];
  axes: LineSegments[];
  planeQuads: Mesh[];
  vertices: VertexCandidate[];
}

/** A shape carrying topology vertices, before its positions are expanded. */
export type VertexSource = {
  object: Object3D;
  shapeId: string;
  coordinates: readonly number[];
  instanceId: string | null;
  /** Its visible materials: a vertex every one of them clips is no candidate. */
  materials: Material[];
};

/** A solid's face mesh: what hides a vertex or an edge behind it. */
function isFaceOccluder(obj: Object3D): obj is Mesh {
  return Boolean((obj as Mesh).isMesh && obj.userData.faceMapping);
}

/** The vertex source `obj` is, or null: no topology vertices, or outside `scope`. */
function vertexSourceOf(obj: Object3D, scope: ReadonlySet<string> | null): VertexSource | null {
  const { shapeId, topologyVertices } = obj.userData;
  if (typeof shapeId !== 'string' || !Array.isArray(topologyVertices) || (scope && !scope.has(shapeId))) {
    return null;
  }
  const materials: Material[] = [];
  obj.traverseVisible(child => {
    const material = (child as Mesh).material;
    if (material) {
      materials.push(...(Array.isArray(material) ? material : [material]));
    }
  });
  return { object: obj, shapeId, coordinates: topologyVertices, instanceId: pickInstanceId(obj), materials };
}

/** The world positions of a source's vertices, the clipped ones left out. */
export function expandVertexSource(source: VertexSource, out: VertexCandidate[]): void {
  const { coordinates, materials, object, shapeId, instanceId } = source;
  for (let i = 0; i + 2 < coordinates.length; i += 3) {
    const position = new Vector3(coordinates[i], coordinates[i + 1], coordinates[i + 2])
      .applyMatrix4(object.matrixWorld);
    if (materials.length > 0 && materials.every(material => clippedByMaterial(position, material))) {
      continue;
    }
    out.push({ shapeId, index: i / 3, position, instanceId });
  }
}

/**
 * The vertex sources and the face occluders under `root`, walked exactly as
 * {@link collectPickCandidates} walks them but expanding no positions: the
 * cheap half a per-frame check can afford, the vertices expanded only when
 * a source changed. `visit` sees every visible object the walk passes, so a
 * caller with more to find needs no walk of its own.
 */
export function collectVertexSources(
  root: Object3D, scope: ReadonlySet<string> | null, visit?: (obj: Object3D) => void,
): { faces: Mesh[]; sources: VertexSource[] } {
  const faces: Mesh[] = [];
  const sources: VertexSource[] = [];
  root.traverseVisible((obj) => {
    visit?.(obj);
    if (obj.userData.isMetaShape) {
      return;
    }
    const source = vertexSourceOf(obj, scope);
    if (source) {
      sources.push(source);
    }
    if (isFaceOccluder(obj)) {
      faces.push(obj);
    }
  });
  return { faces, sources };
}

/**
 * Collect the raycast targets under `root`.
 *
 * Walks with `traverseVisible`, so hiding a shape drops it out of every bucket.
 * That is load-bearing rather than an optimization: hiding sets
 * `visible = false` on the container carrying the shapeId and leaves its
 * face/edge descendants flagged visible, and three's `Raycaster` tests only
 * `layers` — it ignores `visible` entirely. Collecting with a plain `traverse`
 * therefore leaves hidden geometry selectable.
 */
export function collectPickCandidates(root: Object3D, channels: PickChannels): PickCandidates {
  const candidates: PickCandidates = {
    faces: [],
    edges: [],
    sketchWires: [],
    axes: [],
    planeQuads: [],
    vertices: [],
  };

  root.traverseVisible((obj) => {
    if (obj.userData.isMetaShape) {
      return;
    }
    const source = channels.vertices ? vertexSourceOf(obj, channels.vertexScope ?? null) : null;
    if (source) {
      expandVertexSource(source, candidates.vertices);
    }
    if (isFaceOccluder(obj)) {
      candidates.faces.push(obj as Mesh);
    } else if (channels.profileWires && obj.userData.isProfileWire) {
      // Before the edge bucket: a top-level offset's edges wear BOTH stamps
      // (edgeIndex for the plain edge picks every other mode uses,
      // isProfileWire for the extrude dialog's profile channel) — while that
      // channel is armed, the wire pick wins, like a sketch's own wires.
      candidates.sketchWires.push(obj as LineSegments);
    } else if (channels.sketchWires && obj.userData.isSketchWire) {
      candidates.sketchWires.push(obj as LineSegments);
    } else if (((obj as LineSegments).isLine || obj.userData.isEdgeLine) && obj.userData.edgeIndex !== undefined) {
      candidates.edges.push(obj as LineSegments);
    } else if (channels.axes && obj.userData.isAxisLine) {
      candidates.axes.push(obj as LineSegments);
    } else if (channels.planes && obj.userData.isConstructionPlaneQuad) {
      candidates.planeQuads.push(obj as Mesh);
    }
  });

  return candidates;
}
