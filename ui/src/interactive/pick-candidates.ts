import { LineSegments, Mesh, Object3D } from 'three';

/** Candidate buckets that are only collected while their pick channel is armed. */
export interface PickChannels {
  sketchWires: boolean;
  /** Top-level offset outlines as profile picks (the extrude dialog only). */
  profileWires: boolean;
  axes: boolean;
  planes: boolean;
}

/** Raycast targets for one pick query, split by the geometry they resolve to. */
export interface PickCandidates {
  faces: Mesh[];
  edges: LineSegments[];
  sketchWires: LineSegments[];
  axes: LineSegments[];
  planeQuads: Mesh[];
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
  };

  root.traverseVisible((obj) => {
    if (obj.userData.isMetaShape) {
      return;
    }
    if ((obj as Mesh).isMesh && obj.userData.faceMapping) {
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
