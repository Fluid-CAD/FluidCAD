import { LineSegments, Object3D } from 'three';
import { SceneContext } from '../scene/scene-context';
import { PlaneData, SceneObjectRender } from '../types';
import { projectToSketch, pixelToSketchThreshold } from './sketch-plane-utils';
import { EdgeEntry, buildEdgeIndex, pointToSegmentDist } from './sketch-edge-utils';
import { themeColors } from '../scene/theme-colors';

const HIGHLIGHT_THRESHOLD_PX = 12;

export class SketchHoverSelectHandler {
  private ctx: SceneContext;
  private plane: PlaneData;
  private canvas: HTMLCanvasElement;
  private edges: EdgeEntry[] = [];
  private hoveredShapeId: string | null = null;
  private selectedShapeIds = new Set<string>();
  private isExternalResizing: () => boolean;

  private boundMouseMove: (e: MouseEvent) => void;
  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;
  private downX = 0;
  private downY = 0;

  constructor(
    ctx: SceneContext,
    plane: PlaneData,
    isExternalResizing: () => boolean,
  ) {
    this.ctx = ctx;
    this.plane = plane;
    this.canvas = ctx.renderer.domElement;
    this.isExternalResizing = isExternalResizing;

    this.boundMouseMove = this.handleMouseMove.bind(this);
    this.boundMouseDown = this.handleMouseDown.bind(this);
    this.boundMouseUp = this.handleMouseUp.bind(this);
  }

  activate(): void {
    this.canvas.addEventListener('mousemove', this.boundMouseMove);
    this.canvas.addEventListener('mousedown', this.boundMouseDown);
    this.canvas.addEventListener('mouseup', this.boundMouseUp);
  }

  deactivate(): void {
    this.canvas.removeEventListener('mousemove', this.boundMouseMove);
    this.canvas.removeEventListener('mousedown', this.boundMouseDown);
    this.canvas.removeEventListener('mouseup', this.boundMouseUp);
    this.clearHover();
    this.clearSelection();
  }

  updatePlane(plane: PlaneData): void {
    this.plane = plane;
  }

  updateSceneData(sceneObjects: SceneObjectRender[], sketchId: string): void {
    this.edges = buildEdgeIndex(sceneObjects, sketchId, this.plane);
    if (this.hoveredShapeId && !this.edges.some(e => e.shapeId === this.hoveredShapeId)) {
      this.clearHover();
    }
    const validIds = new Set(this.edges.map(e => e.shapeId));
    for (const id of this.selectedShapeIds) {
      if (!validIds.has(id)) {
        this.removeSelectionHighlight(id);
        this.selectedShapeIds.delete(id);
      }
    }
  }

  get selectedIds(): ReadonlySet<string> {
    return this.selectedShapeIds;
  }

  private handleMouseDown(e: MouseEvent): void {
    this.downX = e.clientX;
    this.downY = e.clientY;
  }

  private handleMouseMove(e: MouseEvent): void {
    if (this.isExternalResizing()) {
      if (this.hoveredShapeId) {
        this.clearHover();
      }
      return;
    }

    const point2d = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (!point2d) {
      if (this.hoveredShapeId) {
        this.clearHover();
      }
      return;
    }

    const threshold = pixelToSketchThreshold(this.ctx, HIGHLIGHT_THRESHOLD_PX);
    const nearest = this.findNearestEdge(point2d, threshold);

    if (nearest !== this.hoveredShapeId) {
      if (this.hoveredShapeId) {
        this.removeHoverHighlight(this.hoveredShapeId);
      }
      if (nearest) {
        this.applyHoverHighlight(nearest);
        this.canvas.style.cursor = 'pointer';
      } else {
        this.canvas.style.cursor = '';
      }
      this.hoveredShapeId = nearest;
      this.ctx.requestRender();
    }
  }

  private handleMouseUp(e: MouseEvent): void {
    if (this.isExternalResizing()) {
      return;
    }

    const dx = e.clientX - this.downX;
    const dy = e.clientY - this.downY;
    if (dx * dx + dy * dy > 64) {
      return;
    }

    const isMulti = e.ctrlKey || e.metaKey;

    if (!this.hoveredShapeId) {
      if (!isMulti) {
        this.clearSelection();
        this.ctx.requestRender();
      }
      return;
    }

    if (isMulti) {
      if (this.selectedShapeIds.has(this.hoveredShapeId)) {
        this.removeSelectionHighlight(this.hoveredShapeId);
        this.selectedShapeIds.delete(this.hoveredShapeId);
        this.applyHoverHighlight(this.hoveredShapeId);
      } else {
        this.selectedShapeIds.add(this.hoveredShapeId);
        this.applySelectionHighlight(this.hoveredShapeId);
      }
    } else {
      this.clearSelection();
      this.selectedShapeIds.add(this.hoveredShapeId);
      this.applySelectionHighlight(this.hoveredShapeId);
    }

    this.ctx.requestRender();
  }

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

  private applyHoverHighlight(shapeId: string): void {
    if (this.selectedShapeIds.has(shapeId)) {
      return;
    }
    this.traverseShapeEdges(shapeId, (line) => {
      if (line.userData.selectOriginalColor !== undefined) {
        return;
      }
      line.userData.hoverOriginalColor = (line as any).material.color.getHex();
      (line as any).material.color.set(themeColors.highlightColor);
    });
  }

  private removeHoverHighlight(shapeId: string): void {
    this.traverseShapeEdges(shapeId, (line) => {
      if (line.userData.hoverOriginalColor !== undefined) {
        (line as any).material.color.setHex(line.userData.hoverOriginalColor);
        delete line.userData.hoverOriginalColor;
      }
    });
  }

  private applySelectionHighlight(shapeId: string): void {
    this.traverseShapeEdges(shapeId, (line) => {
      if (line.userData.hoverOriginalColor !== undefined) {
        line.userData.selectOriginalColor = line.userData.hoverOriginalColor;
        delete line.userData.hoverOriginalColor;
      } else {
        line.userData.selectOriginalColor = (line as any).material.color.getHex();
      }
      (line as any).material.color.set(themeColors.selectEdgeColor);
    });
  }

  private removeSelectionHighlight(shapeId: string): void {
    this.traverseShapeEdges(shapeId, (line) => {
      if (line.userData.selectOriginalColor !== undefined) {
        (line as any).material.color.setHex(line.userData.selectOriginalColor);
        delete line.userData.selectOriginalColor;
      }
    });
  }

  private clearHover(): void {
    if (this.hoveredShapeId) {
      this.removeHoverHighlight(this.hoveredShapeId);
      this.hoveredShapeId = null;
      this.canvas.style.cursor = '';
      this.ctx.requestRender();
    }
  }

  private clearSelection(): void {
    for (const id of this.selectedShapeIds) {
      this.removeSelectionHighlight(id);
    }
    this.selectedShapeIds.clear();
  }

  private traverseShapeEdges(shapeId: string, fn: (line: LineSegments) => void): void {
    this.ctx.scene.traverse((obj: Object3D) => {
      if (obj.userData.isMetaShape) {
        return;
      }
      if ((obj as LineSegments).isLine && this.findShapeId(obj) === shapeId) {
        fn(obj as LineSegments);
      }
    });
  }

  private findShapeId(obj: Object3D): string | null {
    let cur: Object3D | null = obj;
    while (cur) {
      if (cur.userData.shapeId && !cur.userData.isMetaShape) {
        return cur.userData.shapeId as string;
      }
      cur = cur.parent;
    }
    return null;
  }
}
