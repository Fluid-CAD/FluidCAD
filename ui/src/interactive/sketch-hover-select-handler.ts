import {
  CircleGeometry,
  DoubleSide,
  Group,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Vector3,
} from 'three';
import { SceneContext } from '../scene/scene-context';
import { PlaneData, SceneObjectRender } from '../types';
import { projectToSketch, pixelToSketchThreshold, localToWorld } from './sketch-plane-utils';
import { EdgeEntry, CenterEntry, buildEdgeIndex, buildCenterIndex, pointToSegmentDist } from './sketch-edge-utils';
import { themeColors } from '../scene/theme-colors';
import { applyConstantPixelSize } from '../meshes/screen-scale';

const HIGHLIGHT_THRESHOLD_PX = 12;
const CENTER_OVERLAY_RADIUS = 2.0;
const CENTER_OVERLAY_PX_RADIUS = 6;

export class SketchHoverSelectHandler {
  private ctx: SceneContext;
  private plane: PlaneData;
  private canvas: HTMLCanvasElement;
  private edges: EdgeEntry[] = [];
  private centers: CenterEntry[] = [];
  private hoveredShapeId: string | null = null;
  private hoveredCenterOverlay: Group | null = null;
  private hoveredCenterPoint: [number, number] | null = null;
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
    this.removeCenterOverlay();
  }

  updatePlane(plane: PlaneData): void {
    this.plane = plane;
  }

  updateSceneData(sceneObjects: SceneObjectRender[], sketchId: string): void {
    this.edges = buildEdgeIndex(sceneObjects, sketchId, this.plane);
    this.centers = buildCenterIndex(sceneObjects, sketchId, this.plane);
    const validIds = new Set(this.edges.map(e => e.shapeId));
    for (const c of this.centers) {
      validIds.add(c.shapeId);
    }
    if (this.hoveredShapeId && !validIds.has(this.hoveredShapeId)) {
      this.clearHover();
    }
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
    const hit = this.findNearestEdge(point2d, threshold);
    const nearest = hit?.shapeId ?? null;

    if (nearest !== this.hoveredShapeId) {
      if (this.hoveredShapeId) {
        this.removeHoverHighlight(this.hoveredShapeId);
      }
      this.removeCenterOverlay();
      if (nearest) {
        this.applyHoverHighlight(nearest);
        this.canvas.style.cursor = 'pointer';
      } else {
        this.canvas.style.cursor = '';
      }
      this.hoveredShapeId = nearest;
      this.ctx.requestRender();
    }

    if (hit?.isCenter && hit.centerPoint) {
      const samePoint = this.hoveredCenterPoint
        && this.hoveredCenterPoint[0] === hit.centerPoint[0]
        && this.hoveredCenterPoint[1] === hit.centerPoint[1];
      if (!samePoint) {
        this.removeCenterOverlay();
        this.addCenterOverlay(hit.centerPoint);
        this.hoveredCenterPoint = hit.centerPoint;
        this.ctx.requestRender();
      }
    } else if (this.hoveredCenterOverlay) {
      this.removeCenterOverlay();
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

  private findNearestEdge(point: [number, number], threshold: number): { shapeId: string; isCenter: boolean; centerPoint?: [number, number] } | null {
    let minDist = Infinity;
    let bestId: string | null = null;
    let isCenter = false;
    let centerPoint: [number, number] | null = null;

    for (const entry of this.edges) {
      for (const seg of entry.segments) {
        const d = pointToSegmentDist(point[0], point[1], seg.ax, seg.ay, seg.bx, seg.by);
        if (d < minDist) {
          minDist = d;
          bestId = entry.shapeId;
          isCenter = false;
          centerPoint = null;
        }
      }
    }

    for (const entry of this.centers) {
      const dx = entry.point2d[0] - point[0];
      const dy = entry.point2d[1] - point[1];
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < minDist) {
        minDist = d;
        bestId = entry.shapeId;
        isCenter = true;
        centerPoint = entry.point2d;
      }
    }

    if (minDist > threshold || !bestId) {
      return null;
    }
    return centerPoint
      ? { shapeId: bestId, isCenter, centerPoint }
      : { shapeId: bestId, isCenter };
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
      (line as any).material.color.set(themeColors.highlightColor);
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
      this.removeCenterOverlay();
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

  private addCenterOverlay(point2d: [number, number]): void {
    this.removeCenterOverlay();

    const pos = localToWorld(point2d, this.plane);
    const normal = this.plane.normal;
    const planeNormal = new Vector3(normal.x, normal.y, normal.z);

    const geo = new CircleGeometry(CENTER_OVERLAY_RADIUS, 16);
    const mat = new MeshBasicMaterial({
      color: themeColors.highlightColor,
      side: DoubleSide,
      depthTest: false,
      transparent: true,
      opacity: 0.9,
    });
    const dot = new Mesh(geo, mat);
    dot.renderOrder = 6;

    const group = new Group();
    group.renderOrder = 6;
    group.userData.isCenterOverlay = true;
    group.add(dot);
    group.position.copy(pos);
    group.lookAt(pos.clone().add(planeNormal));

    applyConstantPixelSize(dot, group, pos, CENTER_OVERLAY_PX_RADIUS, CENTER_OVERLAY_RADIUS);

    this.ctx.scene.add(group);
    this.hoveredCenterOverlay = group;
  }

  private removeCenterOverlay(): void {
    if (this.hoveredCenterOverlay) {
      this.ctx.scene.remove(this.hoveredCenterOverlay);
      const dot = this.hoveredCenterOverlay.children[0] as Mesh;
      dot.geometry.dispose();
      (dot.material as MeshBasicMaterial).dispose();
      this.hoveredCenterOverlay = null;
      this.hoveredCenterPoint = null;
    }
  }

}
