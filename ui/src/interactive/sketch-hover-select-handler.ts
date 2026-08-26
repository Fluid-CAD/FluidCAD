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
import { applyConstantPixelSize } from '../meshes/screen-scale';
import { BadgeHitTarget } from '../meshes/containers/solved-constraint-meshes';
import { insideGlyphBox } from '../meshes/containers/glyph-box';
import {
  SolvedSketchModel,
  buildSolvedSketchModel,
  datumHitTest,
  solvedHitTest,
} from '../sketch-solver-client';
import type { SketchDatumName, SolvedDatumHit, SolvedEntityKind } from '../sketch-solver-client';

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
  /** Edge picks: where on the sketch plane the click landed (the "touch").
   * Circle/arc dimensions read the side of the circumference from it —
   * near-side touch reads min, far-side max. Valid for the render the pick
   * was made in; consumers use it at pick time only. */
  at?: [number, number];
  /** Datum picks: the implicit origin/axes (reserved negative entityIds, no
   * source statement — emission addresses them by this name instead). */
  datum?: SketchDatumName;
  /** Fixed reference picks (P6): a project()/intersect() output. Emission
   * addresses the producer statement plus `.ref(i)` (refIndex null = the
   * terse single-entity form). */
  reference?: { refIndex: number | null; producer: 'project' | 'intersect' };
  /** Copy-duplicate picks: a 2D copy()'s solver-backed duplicate. Emission
   * addresses the copy statement plus the duplicate's instance() slot —
   * `sourceLocation` is the copy() line. Not fixed, unlike references. */
  copyInstance?: { slot: number };
  /** Anchor-point picks (P8): an ellipse center, text anchor, or bezier
   * literal control point. Emission addresses the owning statement and
   * renders `.center()` / `.anchor()` / `.point(i)`. */
  anchor?: { owner: 'ellipse' | 'text' | 'bezier'; pointIndex: number };
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
  /** Hovered datum (origin/axes) — lowest hover priority, solved sketches
   * with datums only. Origin hover wears a vertex-style ring; axis hover
   * tints the scene-mode axis line. */
  private hoveredDatum: SolvedDatumHit | null = null;
  private hoveredDatumOverlay: Group | null = null;
  /** Selected datum picks, keyed by datum name — `d:<name>` in the pick
   * sequence. Origin selection keeps a ring overlay; axis selection keeps
   * the line tinted. */
  private selectedDatums = new Map<SketchDatumName, { overlay: Group | null }>();
  /** Solved-sketch constraint glyph pick targets (from the SketchMesh). */
  private badgeTargets: BadgeHitTarget[] = [];
  /** entityId → the entity statement's edge shapeIds (badge hover tint). */
  private entityShapeIds = new Map<number, string[]>();
  /** Sketch-space click point per selected edge pick (see SolvedPick.at). */
  private edgePickAt = new Map<string, [number, number]>();
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
    this.clearDatumHover();
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
      if (obj.parentId !== sketchId) {
        continue;
      }
      const shapes = (obj.sceneShapes ?? []).filter(shape => shape.shapeId && !shape.isMetaShape);
      if (typeof obj.object?.entityId === 'number') {
        const ids = shapes.map(shape => shape.shapeId as string);
        if (ids.length) {
          this.entityShapeIds.set(obj.object.entityId, ids);
        }
        continue;
      }
      // Reference producers (P6) join each emitted edge to its fixed entity
      // by edgeIndex into the emission-ordered non-meta shapes. Copy
      // duplicates join by shapeIndex into the RAW sceneShapes array —
      // skips and the original make ordinal position unreliable, so the
      // kernel records the rendered index explicitly.
      if (Array.isArray(obj.object?.entities)) {
        for (const record of obj.object.entities as { entityId: number; edgeIndex?: number; shapeIndex?: number }[]) {
          const shape = record.shapeIndex !== undefined
            ? obj.sceneShapes?.[record.shapeIndex]
            : record.edgeIndex !== undefined ? shapes[record.edgeIndex] : undefined;
          if (shape?.shapeId && !shape.isMetaShape) {
            this.entityShapeIds.set(record.entityId, [shape.shapeId as string]);
          }
        }
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
    this.clearDatumHover();
    if (!this.solvedModel?.hasDatums) {
      for (const datum of [...this.selectedDatums.keys()]) {
        this.deselectDatum(datum);
      }
    } else {
      // Axis lines are rebuilt on sketch-mode transitions — re-apply the
      // selection tint so a selected axis stays lit.
      for (const datum of this.selectedDatums.keys()) {
        if (datum !== 'origin') {
          this.tintAxis(datum, true);
        }
      }
    }
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
      if (key.startsWith('d:')) {
        const datum = key.slice(2) as SketchDatumName;
        if (this.selectedDatums.has(datum) && model.hasDatums) {
          picks.push({
            entityId: datum === 'origin' ? -1 : datum === 'x-axis' ? -2 : -3,
            kind: datum === 'origin' ? 'point' : 'line',
            datum,
          });
        }
        continue;
      }
      if (key.startsWith('v:')) {
        const pick = this.selectedVertexPicks.get(key.slice(2));
        const e = pick ? model.entities.get(pick.entityId) : undefined;
        if (pick && e) {
          picks.push({
            entityId: pick.entityId,
            kind: e.kind,
            role: pick.role,
            sourceLocation: e.obj.sourceLocation,
            ...(e.reference ? { reference: e.reference } : {}),
            ...(e.copyInstance ? { copyInstance: e.copyInstance } : {}),
            ...(e.anchor ? { anchor: e.anchor } : {}),
          });
        }
      } else {
        const shapeId = key.slice(2);
        const entityId = shapeToEntity.get(shapeId);
        const e = entityId !== undefined ? model.entities.get(entityId) : undefined;
        if (e) {
          const at = this.edgePickAt.get(shapeId);
          picks.push({
            entityId: e.entityId,
            kind: e.kind,
            sourceLocation: e.obj.sourceLocation,
            ...(at ? { at } : {}),
            ...(e.reference ? { reference: e.reference } : {}),
            ...(e.copyInstance ? { copyInstance: e.copyInstance } : {}),
            // An anchor statement's edges (text glyphs, the ellipse
            // perimeter) resolve to its anchor POINT — the only solver
            // entity it has, so an edge click means "constrain its
            // position" (P8).
            ...(e.anchor ? { anchor: e.anchor } : {}),
          });
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
      this.clearDatumHover();
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
        this.clearDatumHover();
        this.canvas.style.cursor = 'pointer';
        return;
      }
      this.clearVertexHover();

      // The origin datum: vertex-like, but loses to real vertices (above) —
      // a coincident endpoint at (0,0) stays the pick.
      const originHit = datumHitTest(
        this.solvedModel, point2d, pixelToSketchThreshold(this.ctx, VERTEX_PICK_PX), 0,
      );
      if (originHit) {
        this.applyDatumHover(originHit);
        if (this.hoveredShapeId) {
          this.clearHover();
        }
        this.canvas.style.cursor = 'pointer';
        return;
      }
    }

    const threshold = pixelToSketchThreshold(this.ctx, HIGHLIGHT_THRESHOLD_PX);
    const hit = this.findNearestEdge(point2d, threshold);

    // Datum axes: the lowest hover priority — real geometry near an axis
    // always wins (it is pickable elsewhere; the axis is infinite).
    if (!hit && this.solvedModel) {
      const axisHit = datumHitTest(this.solvedModel, point2d, 0, threshold);
      if (axisHit) {
        this.applyDatumHover(axisHit);
        if (this.hoveredShapeId) {
          this.clearHover();
        }
        this.canvas.style.cursor = 'pointer';
        return;
      }
    }
    this.clearDatumHover();

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

    if (this.hoveredDatum) {
      const datum = this.hoveredDatum.datum;
      if (this.selectedDatums.has(datum)) {
        this.deselectDatum(datum);
      } else {
        if (!isMulti) {
          this.clearSelection();
        }
        this.selectDatum(this.hoveredDatum);
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

    const touch = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (isMulti) {
      if (this.selectedShapeIds.has(this.hoveredShapeId)) {
        this.removeSelectionHighlight(this.hoveredShapeId);
        this.selectedShapeIds.delete(this.hoveredShapeId);
        this.edgePickAt.delete(this.hoveredShapeId);
        this.dropFromSequence(`e:${this.hoveredShapeId}`);
        this.applyHoverHighlight(this.hoveredShapeId);
      } else {
        this.selectedShapeIds.add(this.hoveredShapeId);
        if (touch) {
          this.edgePickAt.set(this.hoveredShapeId, touch);
        }
        this.pickSequence.push(`e:${this.hoveredShapeId}`);
        this.applySelectionHighlight(this.hoveredShapeId);
      }
    } else {
      this.clearSelection();
      this.selectedShapeIds.add(this.hoveredShapeId);
      if (touch) {
        this.edgePickAt.set(this.hoveredShapeId, touch);
      }
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
    this.edgePickAt.clear();
    for (const pick of this.selectedVertexPicks.values()) {
      this.disposeVertexOverlay(pick.overlay);
    }
    this.selectedVertexPicks.clear();
    for (const [datum, sel] of this.selectedDatums) {
      if (sel.overlay) {
        this.disposeVertexOverlay(sel.overlay);
      }
      if (datum !== 'origin') {
        this.tintAxis(datum, false);
      }
    }
    this.selectedDatums.clear();
    this.pickSequence = [];
  }

  // -- datum (origin/axes) hover & selection --------------------------------

  private selectDatum(hit: SolvedDatumHit): void {
    const overlay = hit.datum === 'origin' ? this.buildVertexOverlay([0, 0], 1) : null;
    if (hit.datum !== 'origin') {
      this.tintAxis(hit.datum, true);
    }
    this.selectedDatums.set(hit.datum, { overlay });
    this.pickSequence.push(`d:${hit.datum}`);
  }

  private deselectDatum(datum: SketchDatumName): void {
    const sel = this.selectedDatums.get(datum);
    if (!sel) {
      return;
    }
    if (sel.overlay) {
      this.disposeVertexOverlay(sel.overlay);
    }
    if (datum !== 'origin') {
      // Keep the tint while still hovered — the move handler restores it.
      this.tintAxis(datum, this.hoveredDatum?.datum === datum);
    }
    this.selectedDatums.delete(datum);
    this.dropFromSequence(`d:${datum}`);
  }

  private applyDatumHover(hit: SolvedDatumHit): void {
    if (this.hoveredDatum?.datum === hit.datum) {
      return;
    }
    this.clearDatumHover();
    this.hoveredDatum = hit;
    if (hit.datum === 'origin') {
      if (!this.selectedDatums.has('origin')) {
        this.hoveredDatumOverlay = this.buildVertexOverlay([0, 0], 0.9);
      }
    } else {
      this.tintAxis(hit.datum, true);
    }
    this.ctx.requestRender();
  }

  private clearDatumHover(): void {
    if (!this.hoveredDatum) {
      return;
    }
    const datum = this.hoveredDatum.datum;
    if (this.hoveredDatumOverlay) {
      this.disposeVertexOverlay(this.hoveredDatumOverlay);
      this.hoveredDatumOverlay = null;
    }
    if (datum !== 'origin' && !this.selectedDatums.has(datum)) {
      this.tintAxis(datum, false);
    }
    this.hoveredDatum = null;
    this.ctx.requestRender();
  }

  /** Tint a scene-mode datum axis line (hover/selection feedback). The line
   * is scene furniture rebuilt on sketch-mode transitions, so the original
   * color/opacity ride its userData rather than handler state. */
  private tintAxis(datum: SketchDatumName, on: boolean): void {
    this.ctx.scene.traverse((obj: Object3D) => {
      if (!obj.userData.isSketchDatumAxis || obj.userData.datum !== datum) {
        return;
      }
      const material = (obj as LineSegments).material as { color?: Color; opacity?: number };
      if (!(material.color instanceof Color)) {
        return;
      }
      if (on) {
        if (obj.userData.datumBaseColor === undefined) {
          obj.userData.datumBaseColor = material.color.getHex();
          obj.userData.datumBaseOpacity = material.opacity;
        }
        material.color.set(themeColors.highlightColor);
        material.opacity = 1;
      } else if (obj.userData.datumBaseColor !== undefined) {
        material.color.setHex(obj.userData.datumBaseColor);
        material.opacity = obj.userData.datumBaseOpacity;
        delete obj.userData.datumBaseColor;
        delete obj.userData.datumBaseOpacity;
      }
    });
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
   * Drop a vertex or datum pick on behalf of a dialog (the rotate dialog
   * keeps exactly one center pick, so a newer one evicts the last). Fires
   * the change hook like a viewport click on the pick would. Edge picks go
   * through {@link deselectShape}.
   */
  deselectSolvedPick(pick: {
    entityId: number;
    role?: 'start' | 'end' | 'center' | null;
    datum?: SketchDatumName;
  }): void {
    if (pick.datum !== undefined) {
      if (!this.selectedDatums.has(pick.datum)) {
        return;
      }
      this.deselectDatum(pick.datum);
      this.ctx.requestRender();
      this.onSelectionChange?.();
      return;
    }
    if (pick.role === undefined) {
      return;
    }
    const key = `${pick.entityId}:${pick.role ?? 'point'}`;
    const existing = this.selectedVertexPicks.get(key);
    if (!existing) {
      return;
    }
    this.disposeVertexOverlay(existing.overlay);
    this.selectedVertexPicks.delete(key);
    this.dropFromSequence(`v:${key}`);
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

  /** Screen position of a badge's center: its anchor projected, plus the
   * screen-pixel offset the layout pass parked it at. Hidden glyphs (rows
   * that collapsed into a `+N` pill) report no position at all — the pill
   * itself is read-only and never a pick target. */
  private badgeScreenCenter(target: BadgeHitTarget): { x: number; y: number } | null {
    if (!target.placement.visible) {
      return null;
    }
    const camera = this.ctx.camera;
    const rect = this.canvas.getBoundingClientRect();
    const projected = target.anchorWorld.clone().project(camera);
    if (projected.z > 1) {
      return null;
    }
    return {
      x: rect.left + ((projected.x + 1) / 2) * rect.width + target.placement.dx,
      y: rect.top + ((1 - projected.y) / 2) * rect.height + target.placement.dy,
    };
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

  /**
   * A point target — a solved entity vertex, or the origin datum — under the
   * cursor, at the hover pass's own threshold. Whatever vetoes a glyph here
   * is exactly what the pick then lands on.
   */
  private hasPointTargetAt(clientX: number, clientY: number): boolean {
    if (!this.solvedModel) {
      return false;
    }
    const point2d = projectToSketch(this.ctx, this.plane, clientX, clientY);
    if (!point2d) {
      return false;
    }
    const threshold = pixelToSketchThreshold(this.ctx, VERTEX_PICK_PX);
    if (solvedHitTest(this.solvedModel, point2d, threshold, 0)?.type === 'vertex') {
      return true;
    }
    return datumHitTest(this.solvedModel, point2d, threshold, 0) !== null;
  }

  private findBadgeAt(clientX: number, clientY: number): BadgeHitTarget | null {
    // A point target under the cursor keeps its own pick. Dimension labels are
    // big boxes that legitimately lie over the geometry they measure — a
    // diameter's value rides the chord, one gap off the circle's CENTER —
    // while a vertex is a 12 px disc with nowhere else to be grabbed. The
    // label stays pickable everywhere else in its box, and hover, click,
    // double-click and the drag handler's veto all agree because all four ask
    // this one question.
    if (this.hasPointTargetAt(clientX, clientY)) {
      return null;
    }
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
      const dx = clientX - centerPos.x;
      const dy = clientY - centerPos.y;
      // Tested in the glyph's OWN frame: an aligned label lies along its
      // dimension line, so a screen-axis box would claim corners the label
      // never covers — twice its area at 45°, all of it over the circle it
      // is dimensioning.
      if (!insideGlyphBox(dx, dy, target, BADGE_HIT_SLACK_PX)) {
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
