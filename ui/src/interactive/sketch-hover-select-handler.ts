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
import {
  SolvedSketchModel,
  buildSolvedSketchModel,
  solvedHitTest,
} from '../sketch-solver-client';
import type { SolvedEntityKind } from '../sketch-solver-client';

const HIGHLIGHT_THRESHOLD_PX = 12;
/** Grab radius for solved entity vertices. Deliberately equal to the edge
 * threshold: a click that can see both must prefer the vertex, or a
 * near-endpoint pick silently records the edge instead (a line's endpoint
 * is ON the line, so the edge is always in range there too). */
const VERTEX_PICK_PX = 12;

/** An ordered pick the solved constraint toolbar consumes: a whole entity
 * (edge click) or one of its named points (vertex click). */
export type SolvedPick = {
  entityId: number;
  kind: SolvedEntityKind;
  /** Point pick: 'start'/'end'/'center', or null for a point entity's own
   * point. Undefined = the whole entity (edge pick). */
  role?: 'start' | 'end' | 'center' | null;
  sourceLocation?: SourceLocation;
};

type SelectedVertexPick = {
  entityId: number;
  role: 'start' | 'end' | 'center' | null;
  overlay: Group;
};

type HoveredVertex = {
  key: string;
  entityId: number;
  role: 'start' | 'end' | 'center' | null;
  at: [number, number];
};
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

  /** Fired when a badge/dimension glyph is double-clicked — the dimensional
   * constraints open their value input from here (P4). */
  onConstraintDoubleClick?: (pick: {
    objId?: string;
    sourceLocation?: SourceLocation;
    clientX: number;
    clientY: number;
  }) => void;

  private ctx: SceneContext;
  private plane: PlaneData;
  private canvas: HTMLCanvasElement;
  private edges: EdgeEntry[] = [];
  private centers: CenterEntry[] = [];
  private hoveredShapeId: string | null = null;
  private hoveredCenterOverlay: Group | null = null;
  private hoveredCenterPoint: [number, number] | null = null;
  private selectedShapeIds = new Set<string>();
  /** Read model of the active solved sketch — vertex picking (P4). */
  private solvedModel: SolvedSketchModel | null = null;
  /** Selected solved-entity vertices, keyed `entityId:role`, each with its
   * own overlay ring. Vertex identity is stable across renders (unlike
   * shapeIds), so these survive re-renders and only re-anchor. */
  private selectedVertexPicks = new Map<string, SelectedVertexPick>();
  /** Every pick in click order — `e:<shapeId>` and `v:<vertexKey>` — the
   * constraint toolbar's ordered two-pick currency. */
  private pickSequence: string[] = [];
  private hoveredVertex: HoveredVertex | null = null;
  private hoveredVertexOverlay: Group | null = null;
  /** Solved-sketch constraint glyph pick targets (from the SketchMesh). */
  private badgeTargets: BadgeHitTarget[] = [];
  /** entityId → the entity statement's edge shapeIds (badge hover tint). */
  private entityShapeIds = new Map<number, string[]>();
  private hoveredBadge: BadgeHitTarget | null = null;
  private hoveredBadgeShapeIds: string[] = [];
  /** The active sketch's id — the key for finding its SketchMesh (whose
   * read model is the one mutated in place during live drags). */
  private sketchId = '';
  private isExternalResizing: () => boolean;
  private clickPolicy?: () => 'replace' | 'toggle';

  private boundMouseMove: (e: MouseEvent) => void;
  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;
  private boundDoubleClick: (e: MouseEvent) => void;
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
    this.boundDoubleClick = this.handleDoubleClick.bind(this);
  }

  activate(): void {
    this.canvas.addEventListener('mousemove', this.boundMouseMove);
    this.canvas.addEventListener('mousedown', this.boundMouseDown);
    this.canvas.addEventListener('mouseup', this.boundMouseUp);
    this.canvas.addEventListener('dblclick', this.boundDoubleClick);
  }

  deactivate(): void {
    this.canvas.removeEventListener('mousemove', this.boundMouseMove);
    this.canvas.removeEventListener('mousedown', this.boundMouseDown);
    this.canvas.removeEventListener('mouseup', this.boundMouseUp);
    this.canvas.removeEventListener('dblclick', this.boundDoubleClick);
    this.clearHover();
    this.clearBadgeHover();
    this.clearVertexHover();
    this.clearSelection();
    this.removeCenterOverlay();
  }

  updatePlane(plane: PlaneData): void {
    this.plane = plane;
  }

  updateSceneData(sceneObjects: SceneObjectRender[], sketchId: string): void {
    this.sketchId = sketchId;
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
        this.dropFromSequence(`e:${id}`);
      }
    }

    // The solved read model for vertex picking. Vertex identity (entityId +
    // role) is stable across renders, so selected vertices survive — they
    // just re-anchor to the fresh solve's positions (or drop if the entity
    // is gone).
    const sketchObj = sceneObjects.find(o => o.id === sketchId) ?? null;
    this.solvedModel = sketchObj ? buildSolvedSketchModel(sketchObj, sceneObjects) : null;
    this.clearVertexHover();
    for (const [key, pick] of this.selectedVertexPicks) {
      const at = this.vertexPosition(pick.entityId, pick.role);
      if (!at) {
        this.disposeVertexOverlay(pick.overlay);
        this.selectedVertexPicks.delete(key);
        this.dropFromSequence(`v:${key}`);
        continue;
      }
      pick.overlay.position.copy(localToWorld(at, this.plane));
    }
  }

  /** Sketch-local position of a solved entity's named point, if it exists. */
  private vertexPosition(entityId: number, role: 'start' | 'end' | 'center' | null): [number, number] | null {
    const e = this.solvedModel?.entities.get(entityId);
    if (!e) {
      return null;
    }
    if (role === null) {
      return e.point ?? null;
    }
    return e[role] ?? null;
  }

  /**
   * The read model that tracks a live drag: the SketchMesh mutates its own
   * model instance in place per drag frame (updateSolvedGeometry), while
   * `this.solvedModel` is a payload-time copy that never sees mid-drag
   * state. Falls back to the copy when the mesh is gone.
   */
  private liveSolvedModel(): SolvedSketchModel | null {
    let live: SolvedSketchModel | null = null;
    this.ctx.scene.traverse((obj: Object3D) => {
      if (obj.userData.isSketchRoot && obj.userData.sketchObjectId === this.sketchId) {
        live = (obj as unknown as { solved?: SolvedSketchModel | null }).solved ?? null;
      }
    });
    return live ?? this.solvedModel;
  }

  /** Mid-drag: move the selected picks' rings onto the live model's current
   * positions, so a selected vertex being dragged keeps its ring instead of
   * leaving it stranded at the grab position. */
  private reanchorVertexPicks(): void {
    if (this.selectedVertexPicks.size === 0) {
      return;
    }
    const model = this.liveSolvedModel();
    if (!model) {
      return;
    }
    for (const pick of this.selectedVertexPicks.values()) {
      const e = model.entities.get(pick.entityId);
      const at = !e ? null : pick.role === null ? e.point ?? null : e[pick.role] ?? null;
      if (at) {
        pick.overlay.position.copy(localToWorld(at, this.plane));
      }
    }
  }

  private dropFromSequence(key: string): void {
    const index = this.pickSequence.indexOf(key);
    if (index >= 0) {
      this.pickSequence.splice(index, 1);
    }
  }

  /**
   * The current picks in click order, resolved to solver entities: edge
   * picks map to their owning entity (guides and non-entity edges are
   * skipped), vertex picks carry their point role. The solved constraint
   * toolbar consumes this (P4).
   */
  getSolvedPicks(): SolvedPick[] {
    const model = this.solvedModel;
    if (!model) {
      return [];
    }
    const shapeToEntity = new Map<string, number>();
    for (const [entityId, shapeIds] of this.entityShapeIds) {
      for (const shapeId of shapeIds) {
        shapeToEntity.set(shapeId, entityId);
      }
    }
    const picks: SolvedPick[] = [];
    for (const key of this.pickSequence) {
      if (key.startsWith('v:')) {
        const pick = this.selectedVertexPicks.get(key.slice(2));
        const e = pick ? model.entities.get(pick.entityId) : undefined;
        if (pick && e) {
          picks.push({
            entityId: pick.entityId,
            kind: e.kind,
            role: pick.role,
            sourceLocation: e.obj.sourceLocation,
          });
        }
      } else {
        const entityId = shapeToEntity.get(key.slice(2));
        const e = entityId !== undefined ? model.entities.get(entityId) : undefined;
        if (e) {
          picks.push({ entityId: e.entityId, kind: e.kind, sourceLocation: e.obj.sourceLocation });
        }
      }
    }
    return picks;
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
      // A drag owns the cursor: hover feedback (edge tint, vertex ring)
      // must not linger at the grab position while the geometry moves away
      // from under it.
      if (this.hoveredShapeId) {
        this.clearHover();
      }
      this.clearVertexHover();
      this.reanchorVertexPicks();
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
      this.clearVertexHover();
      return;
    }

    // Solved entity vertices beat edge hover: a line endpoint is pickable on
    // top of its own edge (constraint targets are usually points).
    if (this.solvedModel) {
      const vertexHit = solvedHitTest(
        this.solvedModel, point2d, pixelToSketchThreshold(this.ctx, VERTEX_PICK_PX), 0,
      );
      if (vertexHit && vertexHit.type === 'vertex') {
        const key = `${vertexHit.entityId}:${vertexHit.role ?? 'point'}`;
        if (this.hoveredVertex?.key !== key) {
          this.clearVertexHover();
          this.hoveredVertex = {
            key,
            entityId: vertexHit.entityId,
            role: vertexHit.role,
            at: vertexHit.at,
          };
          this.hoveredVertexOverlay = this.buildVertexOverlay(vertexHit.at, 0.9);
          this.ctx.requestRender();
        }
        if (this.hoveredShapeId) {
          this.clearHover();
        }
        this.canvas.style.cursor = 'pointer';
        return;
      }
      this.clearVertexHover();
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

    if (this.hoveredVertex) {
      const key = this.hoveredVertex.key;
      const existing = this.selectedVertexPicks.get(key);
      if (existing) {
        this.disposeVertexOverlay(existing.overlay);
        this.selectedVertexPicks.delete(key);
        this.dropFromSequence(`v:${key}`);
      } else {
        if (!isMulti) {
          this.clearSelection();
        }
        this.selectedVertexPicks.set(key, {
          entityId: this.hoveredVertex.entityId,
          role: this.hoveredVertex.role,
          overlay: this.buildVertexOverlay(this.hoveredVertex.at, 1),
        });
        this.pickSequence.push(`v:${key}`);
      }
      this.ctx.requestRender();
      this.onSelectionChange?.();
      return;
    }

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
        this.dropFromSequence(`e:${this.hoveredShapeId}`);
        this.applyHoverHighlight(this.hoveredShapeId);
      } else {
        this.selectedShapeIds.add(this.hoveredShapeId);
        this.pickSequence.push(`e:${this.hoveredShapeId}`);
        this.applySelectionHighlight(this.hoveredShapeId);
      }
    } else {
      this.clearSelection();
      this.selectedShapeIds.add(this.hoveredShapeId);
      this.pickSequence.push(`e:${this.hoveredShapeId}`);
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
    for (const pick of this.selectedVertexPicks.values()) {
      this.disposeVertexOverlay(pick.overlay);
    }
    this.selectedVertexPicks.clear();
    this.pickSequence = [];
  }

  /** Screen-constant ring at a solved vertex: hover feedback and the
   * selected-pick marker (opacity tells them apart). */
  private buildVertexOverlay(point2d: [number, number], opacity: number): Group {
    const pos = localToWorld(point2d, this.plane);
    const normal = this.plane.normal;
    const geo = new CircleGeometry(CENTER_OVERLAY_RADIUS, 16);
    const mat = new MeshBasicMaterial({
      color: themeColors.highlightColor,
      side: DoubleSide,
      depthTest: false,
      transparent: true,
      opacity,
    });
    const dot = new Mesh(geo, mat);
    dot.renderOrder = 6;
    const group = new Group();
    group.renderOrder = 6;
    group.userData.isMetaShape = true;
    group.add(dot);
    group.position.copy(pos);
    group.lookAt(pos.clone().add(new Vector3(normal.x, normal.y, normal.z)));
    // The group's own position anchors the scaling, so re-anchoring a
    // surviving pick after a re-render keeps its size honest.
    applyConstantPixelSize(dot, group, group.position, CENTER_OVERLAY_PX_RADIUS, CENTER_OVERLAY_RADIUS);
    this.ctx.scene.add(group);
    return group;
  }

  private disposeVertexOverlay(group: Group): void {
    this.ctx.scene.remove(group);
    const dot = group.children[0] as Mesh;
    dot.geometry.dispose();
    (dot.material as MeshBasicMaterial).dispose();
  }

  private clearVertexHover(): void {
    if (this.hoveredVertexOverlay) {
      this.disposeVertexOverlay(this.hoveredVertexOverlay);
      this.hoveredVertexOverlay = null;
      this.ctx.requestRender();
    }
    this.hoveredVertex = null;
  }

  /**
   * Select a single shape programmatically (the constraint mini-toolbar
   * re-selects the converted segment after its re-render, whose ids are all
   * new). Fires the change hook like a click would.
   */
  selectShape(shapeId: string): void {
    this.clearSelection();
    this.selectedShapeIds.add(shapeId);
    this.pickSequence.push(`e:${shapeId}`);
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
        this.pickSequence.push(`e:${shapeId}`);
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
    this.dropFromSequence(`e:${shapeId}`);
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

  /** Offset badges take pick priority over geometry — the solved drag
   * handler consults this before claiming a pointerdown (P4). */
  hasBadgeAt(clientX: number, clientY: number): boolean {
    return this.findBadgeAt(clientX, clientY) !== null;
  }

  private handleDoubleClick(e: MouseEvent): void {
    if (this.isExternalResizing()) {
      return;
    }
    const badge = this.findBadgeAt(e.clientX, e.clientY);
    if (badge) {
      this.onConstraintDoubleClick?.({
        objId: badge.objId,
        sourceLocation: badge.sourceLocation,
        clientX: e.clientX,
        clientY: e.clientY,
      });
    }
  }

  private findBadgeAt(clientX: number, clientY: number): BadgeHitTarget | null {
    let best: BadgeHitTarget | null = null;
    let bestDist = Infinity;
    for (const target of this.badgeTargets) {
      // On-geometry glyphs (coincident dots sit permanently ON the shared
      // vertex) are annotations, not pick targets — hover/click/drag on that
      // spot belongs to the vertex; the statement is picked from the
      // timeline's constraint group instead (P4).
      if (target.onGeometry) {
        continue;
      }
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
