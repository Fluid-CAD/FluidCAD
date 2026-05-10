import { SceneContext } from '../scene/scene-context';
import { SnapManager } from '../snapping/snap-manager';
import { PlaneData, SceneObjectRender } from '../types';
import { projectToSketch as projectToSketchShared, pixelToSketchThreshold, roundPoint } from './sketch-plane-utils';
import { EdgeEntry, buildEdgeIndex, pointToSegmentDist, closestPointOnSegment } from './sketch-edge-utils';

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

    this.onPick(roundPoint(final));
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

  private computeSketchThreshold(): number {
    return pixelToSketchThreshold(this.ctx, HIGHLIGHT_THRESHOLD_PX);
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
    return projectToSketchShared(this.ctx, this.plane, clientX, clientY);
  }
}

