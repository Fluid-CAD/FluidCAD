import { Vector3 } from 'three';
import { SceneContext } from '../scene/scene-context';
import { SnapManager } from '../snapping/snap-manager';
import { PlaneData, SceneObjectRender } from '../types';

/** Pre-computed edge data for fast 2D distance queries. */
type EdgeEntry = {
  shapeId: string;
  segments: { ax: number; ay: number; bx: number; by: number }[];
  /** World-space endpoint positions (first and last vertices of the edge). */
  endpoints: [number, number, number][];
};

export type HighlightInfo = {
  shapeId: string;
  /** World-space endpoint positions for vertex highlighting. */
  endpoints: [number, number, number][];
} | null;

const HIGHLIGHT_THRESHOLD_PX = 12;

export class PointPickMode {
  private canvas: HTMLCanvasElement;
  private ctx: SceneContext;
  private plane: PlaneData;
  private snapManager: SnapManager;
  private onPick: (point2d: [number, number]) => void;
  private onHighlight: (info: HighlightInfo) => void;

  private edges: EdgeEntry[] = [];
  private highlightedShapeId: string | null = null;
  private downX = 0;
  private downY = 0;

  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;

  constructor(
    ctx: SceneContext,
    plane: PlaneData,
    snapManager: SnapManager,
    sceneObjects: SceneObjectRender[],
    sketchId: string,
    onPick: (point2d: [number, number]) => void,
    onHighlight: (info: HighlightInfo) => void,
  ) {
    this.canvas = ctx.renderer.domElement;
    this.ctx = ctx;
    this.plane = plane;
    this.snapManager = snapManager;
    this.onPick = onPick;
    this.onHighlight = onHighlight;

    this.edges = buildEdgeIndex(sceneObjects, sketchId, plane);

    this.boundMouseDown = this.handleMouseDown.bind(this);
    this.boundMouseUp = this.handleMouseUp.bind(this);
    this.boundMouseMove = this.handleMouseMove.bind(this);
  }

  /** Rebuild the edge index (e.g. when the scene changes but the same trim call is active). */
  updateEdges(sceneObjects: SceneObjectRender[], sketchId: string): void {
    this.edges = buildEdgeIndex(sceneObjects, sketchId, this.plane);
    if (this.highlightedShapeId) {
      // Clear stale highlight if the shape no longer exists in the new index
      if (!this.edges.some(e => e.shapeId === this.highlightedShapeId)) {
        this.onHighlight(null);
        this.highlightedShapeId = null;
      }
    }
  }

  activate(): void {
    this.canvas.addEventListener('mousedown', this.boundMouseDown);
    this.canvas.addEventListener('mouseup', this.boundMouseUp);
    this.canvas.addEventListener('mousemove', this.boundMouseMove);
  }

  deactivate(): void {
    this.canvas.removeEventListener('mousedown', this.boundMouseDown);
    this.canvas.removeEventListener('mouseup', this.boundMouseUp);
    this.canvas.removeEventListener('mousemove', this.boundMouseMove);
    if (this.highlightedShapeId) {
      this.onHighlight(null);
      this.highlightedShapeId = null;
    }
  }

  private getEdgeEntry(shapeId: string): EdgeEntry | undefined {
    return this.edges.find(e => e.shapeId === shapeId);
  }

  private handleMouseDown(e: MouseEvent): void {
    this.downX = e.clientX;
    this.downY = e.clientY;
  }

  private handleMouseUp(e: MouseEvent): void {
    const dx = e.clientX - this.downX;
    const dy = e.clientY - this.downY;
    if (dx * dx + dy * dy > 64) {
      return; // drag, not click
    }

    // Only pick if an edge is highlighted (within proximity)
    if (!this.highlightedShapeId) {
      return;
    }

    const point2d = this.projectToSketch(e.clientX, e.clientY);
    if (!point2d) {
      return;
    }

    // Project the click point onto the highlighted edge so the sent coordinate
    // lies directly on it. This guarantees the server-side distance calculation
    // will find the same edge that was visually highlighted.
    const onEdge = this.projectOntoEdge(point2d, this.highlightedShapeId);
    const final = onEdge ?? point2d;

    const rounded: [number, number] = [
      Math.round(final[0] * 100) / 100,
      Math.round(final[1] * 100) / 100,
    ];
    this.onPick(rounded);
  }

  private handleMouseMove(e: MouseEvent): void {
    const point2d = this.projectToSketch(e.clientX, e.clientY);
    if (!point2d) {
      if (this.highlightedShapeId) {
        this.onHighlight(null);
        this.highlightedShapeId = null;
      }
      return;
    }

    const threshold = this.computeSketchThreshold();
    const nearest = this.findNearestEdge(point2d, threshold);

    if (nearest !== this.highlightedShapeId) {
      if (nearest) {
        const entry = this.getEdgeEntry(nearest);
        this.onHighlight({ shapeId: nearest, endpoints: entry?.endpoints ?? [] });
      } else {
        this.onHighlight(null);
      }
      this.highlightedShapeId = nearest;
    }
  }

  /** Convert a screen-pixel threshold to sketch-plane units. */
  private computeSketchThreshold(): number {
    const camera = this.ctx.camera;
    const rect = this.ctx.renderer.domElement.getBoundingClientRect();
    const canvasHeight = rect.height || 1;

    let worldHeight: number;
    const cam = camera as any;
    if (cam.isOrthographicCamera) {
      worldHeight = (cam.top - cam.bottom) / (cam.zoom || 1);
    } else {
      const target = new Vector3();
      this.ctx.cameraControls.getTarget(target);
      const d = camera.position.distanceTo(target);
      const fovRad = (cam.fov * Math.PI) / 180;
      worldHeight = 2 * d * Math.tan(fovRad / 2);
    }

    return (worldHeight / canvasHeight) * HIGHLIGHT_THRESHOLD_PX;
  }

  /** Find the shapeId of the nearest edge within threshold, using 2D sketch distances. */
  private findNearestEdge(point: [number, number], threshold: number): string | null {
    let minDist = Infinity;
    let bestId: string | null = null;

    for (const entry of this.edges) {
      for (const seg of entry.segments) {
        const d = pointToSegmentDist(point[0], point[1], seg.ax, seg.ay, seg.bx, seg.by);
        if (d < minDist) {
          minDist = d;
          bestId = entry.shapeId;
        }
      }
    }

    return minDist <= threshold ? bestId : null;
  }

  /** Project a 2D point onto the closest segment of the given edge shape.
   *  Returns the closest point ON the edge, or null if the shape isn't found. */
  private projectOntoEdge(point: [number, number], shapeId: string): [number, number] | null {
    const entry = this.edges.find(e => e.shapeId === shapeId);
    if (!entry) {
      return null;
    }

    let minDist = Infinity;
    let bestPoint: [number, number] | null = null;

    for (const seg of entry.segments) {
      const result = closestPointOnSegment(point[0], point[1], seg.ax, seg.ay, seg.bx, seg.by);
      if (result.dist < minDist) {
        minDist = result.dist;
        bestPoint = [result.x, result.y];
      }
    }

    return bestPoint;
  }

  private projectToSketch(clientX: number, clientY: number): [number, number] | null {
    const renderer = this.ctx.renderer;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;

    const raycaster = this.ctx.createPickingRaycaster(ndcX, ndcY);

    const rayOrigin = raycaster.ray.origin;
    const rayDir = raycaster.ray.direction;

    const planeOrigin = new Vector3(this.plane.origin.x, this.plane.origin.y, this.plane.origin.z);
    const planeNormal = new Vector3(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z);

    const denom = rayDir.dot(planeNormal);
    if (Math.abs(denom) < 1e-6) {
      return null;
    }

    const t = planeOrigin.clone().sub(rayOrigin).dot(planeNormal) / denom;
    if (t < 0) {
      return null;
    }

    const worldPoint = rayOrigin.clone().add(rayDir.clone().multiplyScalar(t));

    const rel = worldPoint.clone().sub(planeOrigin);
    const xDir = new Vector3(this.plane.xDirection.x, this.plane.xDirection.y, this.plane.xDirection.z);
    const yDir = new Vector3(this.plane.yDirection.x, this.plane.yDirection.y, this.plane.yDirection.z);

    return [rel.dot(xDir), rel.dot(yDir)];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an index of all sketch edge shapes with their 2D line segments. */
function buildEdgeIndex(
  sceneObjects: SceneObjectRender[],
  sketchId: string,
  plane: PlaneData,
): EdgeEntry[] {
  const result: EdgeEntry[] = [];
  const ox = plane.origin.x, oy = plane.origin.y, oz = plane.origin.z;
  const xx = plane.xDirection.x, xy = plane.xDirection.y, xz = plane.xDirection.z;
  const yx = plane.yDirection.x, yy = plane.yDirection.y, yz = plane.yDirection.z;

  // When trim meta shapes exist, use only those for the hover index so
  // individual split segments are highlighted instead of full originals.
  const hasTrimMeta = sceneObjects.some(obj =>
    obj.parentId === sketchId &&
    obj.sceneShapes.some(s => s.metaType === 'trim'),
  );

  for (const obj of sceneObjects) {
    if (obj.parentId !== sketchId) {
      continue;
    }
    for (const shape of obj.sceneShapes) {
      if (!shape.shapeId) {
        continue;
      }
      if (hasTrimMeta) {
        if (shape.metaType !== 'trim') {
          continue;
        }
      } else {
        if (shape.isMetaShape || shape.isGuide) {
          continue;
        }
      }
      const segments: EdgeEntry['segments'] = [];
      const endpoints: [number, number, number][] = [];

      for (const mesh of shape.meshes) {
        const verts = mesh.vertices;
        const indices = mesh.indices;
        if (!indices.length) {
          continue;
        }

        // Find topological endpoints (vertex indices appearing exactly once)
        const count = new Map<number, number>();
        for (const idx of indices) {
          count.set(idx, (count.get(idx) || 0) + 1);
        }
        for (const [idx, c] of count) {
          if (c === 1) {
            endpoints.push([verts[idx * 3], verts[idx * 3 + 1], verts[idx * 3 + 2]]);
          }
        }

        // indices are pairs for LineSegments
        for (let k = 0; k < indices.length; k += 2) {
          const ia = indices[k] * 3;
          const ib = indices[k + 1] * 3;

          // World → 2D sketch coords
          const rax = verts[ia] - ox, ray = verts[ia + 1] - oy, raz = verts[ia + 2] - oz;
          const ax = rax * xx + ray * xy + raz * xz;
          const ay = rax * yx + ray * yy + raz * yz;

          const rbx = verts[ib] - ox, rby = verts[ib + 1] - oy, rbz = verts[ib + 2] - oz;
          const bx = rbx * xx + rby * xy + rbz * xz;
          const by = rbx * yx + rby * yy + rbz * yz;

          segments.push({ ax, ay, bx, by });
        }
      }

      if (segments.length > 0) {
        result.push({ shapeId: shape.shapeId, segments, endpoints });
      }
    }
  }

  return result;
}

/** Distance from point (px,py) to line segment (ax,ay)-(bx,by). */
function pointToSegmentDist(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  return closestPointOnSegment(px, py, ax, ay, bx, by).dist;
}

/** Closest point on segment (ax,ay)-(bx,by) to point (px,py). */
function closestPointOnSegment(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): { x: number; y: number; dist: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;

  let cx: number;
  let cy: number;

  if (lenSq === 0) {
    cx = ax;
    cy = ay;
  } else {
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    if (t < 0) {
      t = 0;
    } else if (t > 1) {
      t = 1;
    }
    cx = ax + t * dx;
    cy = ay + t * dy;
  }

  const ex = cx - px;
  const ey = cy - py;
  return { x: cx, y: cy, dist: Math.sqrt(ex * ex + ey * ey) };
}
