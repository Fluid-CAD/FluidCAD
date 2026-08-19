import {
  CircleGeometry,
  Color,
  DoubleSide,
  Group,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Vector3,
} from 'three';
import { SceneContext } from '../scene/scene-context';
import { PlaneData, SceneObjectRender, SourceLocation } from '../types';
import { projectToSketch, pixelToSketchThreshold, localToWorld } from './sketch-plane-utils';
import { EdgeEntry, CenterEntry, buildEdgeIndex, buildCenterIndex, pointToSegmentDist } from './sketch-edge-utils';
import { themeColors } from '../scene/theme-colors';
import { applyConstantPixelSize, pixelsToWorld } from '../meshes/screen-scale';
import { BadgeHitTarget } from '../meshes/containers/solved-constraint-meshes';

const HIGHLIGHT_THRESHOLD_PX = 12;
const CENTER_OVERLAY_RADIUS = 2.0;
const CENTER_OVERLAY_PX_RADIUS = 6;
/** Extra slack around a constraint badge's box before a hover counts. */
const BADGE_HIT_SLACK_PX = 3;

export class SketchHoverSelectHandler {
  /** Fired after any click mutates the selected set (operations read it). */
  onSelectionChange?: () => void;

  /** Fired when a solved-sketch constraint badge/dimension is clicked —
   * selecting the constraint statement (goto-source, timeline flash). */
  onConstraintPick?: (pick: { objId?: string; sourceLocation?: SourceLocation }) => void;

  private ctx: SceneContext;
  private plane: PlaneData;
  private canvas: HTMLCanvasElement;
  private edges: EdgeEntry[] = [];
  private centers: CenterEntry[] = [];
  private hoveredShapeId: string | null = null;
  private hoveredCenterOverlay: Group | null = null;
  private hoveredCenterPoint: [number, number] | null = null;
  private selectedShapeIds = new Set<string>();
  /** Solved-sketch constraint glyph pick targets (from the SketchMesh). */
  private badgeTargets: BadgeHitTarget[] = [];
  /** entityId → the entity statement's edge shapeIds (badge hover tint). */
  private entityShapeIds = new Map<number, string[]>();
  private hoveredBadge: BadgeHitTarget | null = null;
  private hoveredBadgeShapeIds: string[] = [];
  private isExternalResizing: () => boolean;
  private clickPolicy?: () => 'replace' | 'toggle';

  private boundMouseMove: (e: MouseEvent) => void;
  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;
  private downX = 0;
  private downY = 0;

  constructor(
    ctx: SceneContext,
    plane: PlaneData,
    isExternalResizing: () => boolean,
    /**
     * Per-click selection policy. `replace` is classic sketch editing: a
     * plain click replaces the selection, an empty-space click clears it
     * (Ctrl/Cmd toggles). `toggle` is the 3D create dialogs' pick contract —
     * every click toggles membership and empty-space clicks keep the picks —
     * for dialogs whose pick list is the dialog's own state (the 2D copy).
     */
    clickPolicy?: () => 'replace' | 'toggle',
  ) {
    this.ctx = ctx;
    this.plane = plane;
    this.canvas = ctx.renderer.domElement;
    this.isExternalResizing = isExternalResizing;
    this.clickPolicy = clickPolicy;

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
    this.clearBadgeHover();
    this.clearSelection();
    this.removeCenterOverlay();
  }

  updatePlane(plane: PlaneData): void {
    this.plane = plane;
  }

  updateSceneData(sceneObjects: SceneObjectRender[], sketchId: string): void {
    // Guides are hover/selectable here — the Guide toggle converts a selected
    // construction statement back to real geometry (they still don't snap,
    // drag-resize, or grow vertex dots).
    this.edges = buildEdgeIndex(sceneObjects, sketchId, this.plane, { includeGuides: true });
    this.centers = buildCenterIndex(sceneObjects, sketchId, this.plane);
    // The mesh tree was rebuilt with this scene — re-collect the solved
    // sketch's badge pick targets and the entity→shape join for hover tints.
    this.clearBadgeHover();
    this.badgeTargets = this.collectBadgeTargets(sketchId);
    this.entityShapeIds = new Map();
    for (const obj of sceneObjects) {
      if (obj.parentId !== sketchId || typeof obj.object?.entityId !== 'number') {
        continue;
      }
      const ids = (obj.sceneShapes ?? [])
        .filter(shape => shape.shapeId && !shape.isMetaShape)
        .map(shape => shape.shapeId as string);
      if (ids.length) {
        this.entityShapeIds.set(obj.object.entityId, ids);
      }
    }
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

    const badge = this.findBadgeAt(e.clientX, e.clientY);
    if (badge !== this.hoveredBadge) {
      this.clearBadgeHover();
      if (badge) {
        this.applyBadgeHover(badge);
      }
    }
    if (badge) {
      // Badges draw over the geometry — while one is hovered it owns the
      // cursor and no edge hover competes.
      if (this.hoveredShapeId) {
        this.clearHover();
      }
      this.canvas.style.cursor = 'pointer';
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

    if (this.hoveredBadge) {
      this.onConstraintPick?.({
        objId: this.hoveredBadge.objId,
        sourceLocation: this.hoveredBadge.sourceLocation,
      });
      return;
    }

    const isMulti = e.ctrlKey || e.metaKey || this.clickPolicy?.() === 'toggle';

    if (!this.hoveredShapeId) {
      if (!isMulti) {
        this.clearSelection();
        this.ctx.requestRender();
        this.onSelectionChange?.();
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
    this.onSelectionChange?.();
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

  /**
   * The line's color wherever the material keeps it: plain line materials
   * expose `.color`, the guide dash-dot ShaderMaterial carries it as the
   * `color` uniform. Returns the live Color object, so mutating it recolors
   * the line in place.
   */
  private static lineColor(line: LineSegments): Color | null {
    const mat = (line as any).material;
    if (!mat) {
      return null;
    }
    if (mat.color instanceof Color) {
      return mat.color;
    }
    const uniform = mat.uniforms?.color?.value;
    return uniform instanceof Color ? uniform : null;
  }

  private applyHoverHighlight(shapeId: string): void {
    if (this.selectedShapeIds.has(shapeId)) {
      return;
    }
    this.traverseShapeEdges(shapeId, (line) => {
      const color = SketchHoverSelectHandler.lineColor(line);
      if (!color || line.userData.selectOriginalColor !== undefined) {
        return;
      }
      line.userData.hoverOriginalColor = color.getHex();
      color.set(themeColors.highlightColor);
    });
  }

  private removeHoverHighlight(shapeId: string): void {
    this.traverseShapeEdges(shapeId, (line) => {
      const color = SketchHoverSelectHandler.lineColor(line);
      if (color && line.userData.hoverOriginalColor !== undefined) {
        color.setHex(line.userData.hoverOriginalColor);
        delete line.userData.hoverOriginalColor;
      }
    });
  }

  private applySelectionHighlight(shapeId: string): void {
    this.traverseShapeEdges(shapeId, (line) => {
      const color = SketchHoverSelectHandler.lineColor(line);
      if (!color) {
        return;
      }
      if (line.userData.hoverOriginalColor !== undefined) {
        line.userData.selectOriginalColor = line.userData.hoverOriginalColor;
        delete line.userData.hoverOriginalColor;
      } else {
        line.userData.selectOriginalColor = color.getHex();
      }
      color.set(themeColors.highlightColor);
    });
  }

  private removeSelectionHighlight(shapeId: string): void {
    this.traverseShapeEdges(shapeId, (line) => {
      const color = SketchHoverSelectHandler.lineColor(line);
      if (color && line.userData.selectOriginalColor !== undefined) {
        color.setHex(line.userData.selectOriginalColor);
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

  /**
   * Select a single shape programmatically (the constraint mini-toolbar
   * re-selects the converted segment after its re-render, whose ids are all
   * new). Fires the change hook like a click would.
   */
  selectShape(shapeId: string): void {
    this.clearSelection();
    this.selectedShapeIds.add(shapeId);
    this.applySelectionHighlight(shapeId);
    this.ctx.requestRender();
    this.onSelectionChange?.();
  }

  /**
   * Replace the selection with `shapeIds` on behalf of a dialog (the offset
   * edit seeding the statement's own targets). Ids the current scene doesn't
   * know are skipped. Fires the change hook once, like a click would.
   */
  selectShapes(shapeIds: string[]): void {
    this.clearSelection();
    const known = new Set(this.edges.map(e => e.shapeId));
    for (const shapeId of shapeIds) {
      if (known.has(shapeId) && !this.selectedShapeIds.has(shapeId)) {
        this.selectedShapeIds.add(shapeId);
        this.applySelectionHighlight(shapeId);
      }
    }
    this.ctx.requestRender();
    this.onSelectionChange?.();
  }

  /**
   * Drop a single pick on behalf of a dialog (an op dialog's chip ✕). Fires
   * the change hook like a viewport ctrl-click on the shape would.
   */
  deselectShape(shapeId: string): void {
    if (!this.selectedShapeIds.has(shapeId)) {
      return;
    }
    this.removeSelectionHighlight(shapeId);
    this.selectedShapeIds.delete(shapeId);
    this.ctx.requestRender();
    this.onSelectionChange?.();
  }

  /**
   * Drop the current selection on behalf of a dialog (the subtract dialog
   * clears between its base and tool slots). Fires the change hook so the
   * dialog preview stays in sync.
   */
  resetSelection(): void {
    this.clearSelection();
    this.ctx.requestRender();
    this.onSelectionChange?.();
  }

  /** The active sketch's badge pick targets, stashed on its SketchMesh. */
  private collectBadgeTargets(sketchId: string): BadgeHitTarget[] {
    let targets: BadgeHitTarget[] = [];
    this.ctx.scene.traverse((obj: Object3D) => {
      if (obj.userData.isSketchRoot && obj.userData.sketchObjectId === sketchId
        && Array.isArray(obj.userData.solvedBadgeTargets)) {
        targets = obj.userData.solvedBadgeTargets as BadgeHitTarget[];
      }
    });
    return targets;
  }

  /** Screen position of a badge's center: its anchor projected, pushed the
   * glyph's pixel offset along its (projected) offset direction — the same
   * math the badge meshes run per frame in onBeforeRender. */
  private badgeScreenCenter(target: BadgeHitTarget): { x: number; y: number } | null {
    const camera = this.ctx.camera;
    const rect = this.canvas.getBoundingClientRect();
    const projected = target.anchorWorld.clone().project(camera);
    if (projected.z > 1) {
      return null;
    }
    let x = rect.left + ((projected.x + 1) / 2) * rect.width;
    let y = rect.top + ((1 - projected.y) / 2) * rect.height;
    if (target.offsetDirWorld && target.offsetPx) {
      const step = pixelsToWorld(this.ctx.renderer, camera, target.anchorWorld, 100);
      const stepped = target.anchorWorld.clone()
        .addScaledVector(target.offsetDirWorld, step)
        .project(camera);
      const sx = rect.left + ((stepped.x + 1) / 2) * rect.width - x;
      const sy = rect.top + ((1 - stepped.y) / 2) * rect.height - y;
      const len = Math.hypot(sx, sy);
      if (len > 1e-6) {
        x += (sx / len) * target.offsetPx;
        y += (sy / len) * target.offsetPx;
      }
    }
    return { x, y };
  }

  private findBadgeAt(clientX: number, clientY: number): BadgeHitTarget | null {
    let best: BadgeHitTarget | null = null;
    let bestDist = Infinity;
    for (const target of this.badgeTargets) {
      const centerPos = this.badgeScreenCenter(target);
      if (!centerPos) {
        continue;
      }
      const dx = Math.abs(clientX - centerPos.x);
      const dy = Math.abs(clientY - centerPos.y);
      if (dx > target.halfWidthPx + BADGE_HIT_SLACK_PX || dy > target.halfHeightPx + BADGE_HIT_SLACK_PX) {
        continue;
      }
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        best = target;
      }
    }
    return best;
  }

  private applyBadgeHover(target: BadgeHitTarget): void {
    this.hoveredBadge = target;
    for (const material of target.materials) {
      material.color.set(themeColors.highlightColor);
    }
    // Light up the entities the constraint references.
    this.hoveredBadgeShapeIds = [];
    for (const entityId of target.refEntityIds) {
      for (const shapeId of this.entityShapeIds.get(entityId) ?? []) {
        this.hoveredBadgeShapeIds.push(shapeId);
        this.applyHoverHighlight(shapeId);
      }
    }
    this.ctx.requestRender();
  }

  private clearBadgeHover(): void {
    if (!this.hoveredBadge) {
      return;
    }
    for (const material of this.hoveredBadge.materials) {
      material.color.copy(this.hoveredBadge.baseColor);
    }
    for (const shapeId of this.hoveredBadgeShapeIds) {
      this.removeHoverHighlight(shapeId);
    }
    this.hoveredBadgeShapeIds = [];
    this.hoveredBadge = null;
    if (!this.hoveredShapeId) {
      this.canvas.style.cursor = '';
    }
    this.ctx.requestRender();
  }

  private traverseShapeEdges(shapeId: string, fn: (line: LineSegments) => void): void {
    this.ctx.scene.traverse((obj: Object3D) => {
      if (obj.userData.isMetaShape && !obj.userData.isGuideShape) {
        return;
      }
      if (((obj as LineSegments).isLine || obj.userData.isEdgeLine) && this.findShapeId(obj) === shapeId) {
        fn(obj as LineSegments);
      }
    });
  }

  private findShapeId(obj: Object3D): string | null {
    let cur: Object3D | null = obj;
    while (cur) {
      // Guide groups carry isMetaShape (they share the dash-dot meta
      // rendering) but are selectable — their shapeId counts.
      if (cur.userData.shapeId && (!cur.userData.isMetaShape || cur.userData.isGuideShape)) {
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
