// Dragging a dimension's value to where it reads best.
//
// Press a dimension label in the sketch being edited and drag: the text
// follows the cursor and its dimension line, leader or arc trails along,
// previewed live on the mesh's own read model. Releasing writes the
// placement into the statement as a chained `.labelAt(u, v)` — one edit, one
// undo step — in the dimension's own frame, so it keeps following the
// geometry afterwards (sketch-solver-client/dimension-label.ts).
//
// A press that never travels the drag threshold is left alone: the hover
// handler still reads it as the click that selects the constraint, and a
// double-click still opens the value input.

import { SceneContext } from '../../scene/scene-context';
import { PlaneData } from '../../types';
import { setDimensionLabel } from '../../api';
import { roundToUnitDecimals } from '../../units/units';
import { sceneUnit } from '../../units/scene-unit';
import { pixelToSketchThreshold, projectToSketch, sketchToClient } from '../sketch-plane-utils';
import { dimensionFrame, labelCoordsForCenter } from '../../sketch-solver-client';
import type {
  DimensionFrame, LabelCoords, SolvedConstraintView, SolvedSketchModel,
} from '../../sketch-solver-client';
import type { Vec2 } from '../../sketch-solver-client/resolve';
import type { SketchMesh } from '../../meshes/containers/sketch-mesh';
import type { BadgeHitTarget } from '../../meshes/containers/solved-constraint-meshes';
import { placedLabelOffsetPx } from '../../meshes/containers/glyph-box';
import { themeColors } from '../../scene/theme-colors';
import { DRAG_THRESHOLD_PX } from './types';

/** An angle's arc cannot be dragged tighter than this around its corner. */
const MIN_ANGLE_ARC_PX = 12;
/** Screen span used to read a sketch direction off the camera — long enough
 * to stay well conditioned at any zoom. */
const DIRECTION_PROBE_PX = 100;

/** A press on a dimension label, and — once it travels — the drag it became. */
type LabelGrab = {
  constraint: SolvedConstraintView;
  frame: DimensionFrame;
  /** The placement before the drag — what a cancel or a refusal restores. */
  before: LabelCoords | undefined;
  /** Drawn text center minus cursor at the press, sketch-local: the text
   * stays under the spot it was grabbed by. */
  grabOffset: Vec2;
  /** The label's drawn box, px. */
  halfWidthPx: number;
  halfHeightPx: number;
  clientX: number;
  clientY: number;
};

export class DimensionLabelDragHandler {
  private canvas: HTMLCanvasElement;
  private sketchId = '';
  private sketchMesh: SketchMesh | null = null;
  private model: SolvedSketchModel | null = null;

  private pending: LabelGrab | null = null;
  private drag: LabelGrab | null = null;
  /** Bumped on every scene update: a write-back answered after a fresh
   * render must not touch the model that render brought. */
  private generation = 0;

  private boundCanvasPointerDown: (e: PointerEvent) => void;
  private boundPointerMove: (e: PointerEvent) => void;
  private boundPointerUp: (e: PointerEvent) => void;
  private boundKeyDown: (e: KeyboardEvent) => void;

  constructor(
    private ctx: SceneContext,
    private plane: PlaneData,
    /** The glyph under the cursor — the hover handler's own pick, so the
     * press grabs exactly what the hover highlighted. */
    private glyphAt: (clientX: number, clientY: number) => BadgeHitTarget | null,
    /** The annotations were rebuilt (every drag frame, and on a restore):
     * whoever holds their pick targets must re-read them. */
    private onGlyphsRebuilt: () => void,
    private showMessage: (message: string) => void,
  ) {
    this.canvas = ctx.renderer.domElement;
    this.boundCanvasPointerDown = this.handleCanvasPointerDown.bind(this);
    this.boundPointerMove = this.handlePointerMove.bind(this);
    this.boundPointerUp = this.handlePointerUp.bind(this);
    this.boundKeyDown = this.handleKeyDown.bind(this);
  }

  /** True from the moment a press becomes a drag until it is released. */
  get isDragging(): boolean {
    return this.drag !== null;
  }

  activate(): void {
    this.canvas.addEventListener('pointerdown', this.boundCanvasPointerDown, { capture: true });
    window.addEventListener('pointermove', this.boundPointerMove);
    window.addEventListener('pointerup', this.boundPointerUp, { capture: true });
    window.addEventListener('keydown', this.boundKeyDown);
  }

  deactivate(): void {
    this.canvas.removeEventListener('pointerdown', this.boundCanvasPointerDown, { capture: true });
    window.removeEventListener('pointermove', this.boundPointerMove);
    window.removeEventListener('pointerup', this.boundPointerUp, { capture: true });
    window.removeEventListener('keydown', this.boundKeyDown);
    this.cancel();
  }

  updatePlane(plane: PlaneData): void {
    this.plane = plane;
  }

  updateSceneData(sketchId: string): void {
    // A render replaced the mesh and its model: whatever was grabbed belongs
    // to the old one, and the new payload is the truth about every label.
    this.generation++;
    this.release();
    this.sketchId = sketchId;
    this.sketchMesh = this.findSketchMesh();
    this.model = this.sketchMesh?.solved ?? null;
  }

  private findSketchMesh(): SketchMesh | null {
    let found: SketchMesh | null = null;
    this.ctx.scene.traverse((child) => {
      if (!found && child.userData.isSketchRoot && child.userData.sketchObjectId === this.sketchId) {
        found = child as SketchMesh;
      }
    });
    return found;
  }

  private handleCanvasPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || this.drag || !this.model) {
      return;
    }
    const target = this.glyphAt(e.clientX, e.clientY);
    const grab = target ? this.grabOf(target, e.clientX, e.clientY) : null;
    if (!grab) {
      return;
    }
    this.pending = grab;
    // The press is ours until it proves to be a click: the camera must not
    // start orbiting under a label that is about to move.
    this.ctx.cameraControls.enabled = false;
    e.stopPropagation();
  }

  /**
   * What pressing `target` grabs, or null when it is not a label this
   * handler moves: a positional badge, a dimension with no frame to place a
   * label in right now, or one whose statement has no source to write to.
   */
  private grabOf(target: BadgeHitTarget, clientX: number, clientY: number): LabelGrab | null {
    const model = this.model;
    if (!model || !target.objId || !target.placement.visible) {
      return null;
    }
    const constraint = model.constraints.find(c => c.obj.id === target.objId);
    if (!constraint?.obj.sourceLocation) {
      return null;
    }
    const frame = dimensionFrame(model, constraint);
    if (!frame) {
      return null;
    }
    const cursor = projectToSketch(this.ctx, this.plane, clientX, clientY);
    const center = this.drawnCenterOf(target);
    if (!cursor || !center) {
      return null;
    }
    return {
      constraint,
      frame,
      before: constraint.label,
      grabOffset: [center[0] - cursor[0], center[1] - cursor[1]],
      halfWidthPx: target.halfWidthPx,
      halfHeightPx: target.halfHeightPx,
      clientX,
      clientY,
    };
  }

  /** Where the glyph's text is drawn right now, in sketch coordinates: its
   * anchor on screen, plus the pixel offset the layout parked it at. */
  private drawnCenterOf(target: BadgeHitTarget): Vec2 | null {
    const rect = this.canvas.getBoundingClientRect();
    const projected = target.anchorWorld.clone().project(this.ctx.camera);
    if (projected.z > 1) {
      return null;
    }
    return projectToSketch(
      this.ctx,
      this.plane,
      rect.left + ((projected.x + 1) / 2) * rect.width + target.placement.dx,
      rect.top + ((1 - projected.y) / 2) * rect.height + target.placement.dy,
    );
  }

  private handlePointerMove(e: PointerEvent): void {
    if (this.pending && !this.drag) {
      const dx = e.clientX - this.pending.clientX;
      const dy = e.clientY - this.pending.clientY;
      if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
        return;
      }
      this.drag = this.pending;
      this.pending = null;
    }
    const drag = this.drag;
    if (!drag) {
      return;
    }
    const cursor = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (!cursor) {
      return;
    }
    const center: Vec2 = [cursor[0] + drag.grabOffset[0], cursor[1] + drag.grabOffset[1]];
    const localPerPx = pixelToSketchThreshold(this.ctx, 1);
    this.preview(drag, labelCoordsForCenter(drag.frame, center, {
      clearance: push => this.clearancePx(drag, push, center) * localPerPx,
      minArcRadius: MIN_ANGLE_ARC_PX * localPerPx,
    }));
  }

  /**
   * How far the text's center sits off its attach point when pushed along
   * `push` (sketch-local), px — the sprite layer's own rule, so the preview
   * lands where the placement will be drawn. An aligned value rolls to its
   * line, which puts its short side across the push whatever the angle; an
   * upright one reaches differently along every screen direction.
   */
  private clearancePx(drag: LabelGrab, push: Vec2, at: Vec2): number {
    const box = { halfWidthPx: drag.halfWidthPx, halfHeightPx: drag.halfHeightPx, roll: 0 };
    const aligned = drag.frame.type === 'radial' || (drag.frame.type === 'span' && drag.frame.aligned);
    return placedLabelOffsetPx(box, aligned ? { x: 0, y: 1 } : this.screenDirection(push, at));
  }

  /** A sketch-plane direction as a unit screen direction (px, y down). */
  private screenDirection(dir: Vec2, at: Vec2): { x: number; y: number } {
    const reach = pixelToSketchThreshold(this.ctx, DIRECTION_PROBE_PX);
    const from = sketchToClient(this.ctx, this.plane, at);
    const to = sketchToClient(this.ctx, this.plane, [at[0] + dir[0] * reach, at[1] + dir[1] * reach]);
    const x = to.clientX - from.clientX;
    const y = to.clientY - from.clientY;
    const length = Math.hypot(x, y);
    // Edge-on to the sketch nothing is readable anyway — any direction does.
    return length > 1e-6 ? { x: x / length, y: y / length } : { x: 0, y: -1 };
  }

  private handlePointerUp(e: PointerEvent): void {
    if (e.button !== 0) {
      return;
    }
    if (this.drag) {
      this.commit(this.drag);
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    if (this.pending) {
      // A click after all — the hover handler's mouseup picks the constraint.
      this.pending = null;
      this.ctx.cameraControls.enabled = true;
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && this.drag) {
      this.cancel();
    }
  }

  /** Show `coords` on the live mesh: the model is the mesh's own, so the
   * annotations re-derive from it exactly as a render's would. */
  private preview(drag: LabelGrab, coords: LabelCoords | undefined): void {
    if (coords) {
      drag.constraint.label = coords;
    } else {
      delete drag.constraint.label;
    }
    this.sketchMesh?.refreshConstraintGlyphs();
    this.onGlyphsRebuilt();
    if (this.drag === drag) {
      // The rebuild made fresh, untinted glyphs and dropped the hover that
      // lit the grabbed one: the label in hand stays lit, and the cursor
      // keeps saying so.
      this.tint(drag);
      this.canvas.style.cursor = 'grabbing';
    }
    this.ctx.requestRender();
  }

  /** Light the dragged dimension's glyph like a hover does. */
  private tint(drag: LabelGrab): void {
    const targets = this.sketchMesh?.userData.solvedBadgeTargets as BadgeHitTarget[] | undefined;
    for (const target of targets ?? []) {
      if (target.objId === drag.constraint.obj.id) {
        for (const material of target.materials) {
          material.color.set(themeColors.highlightColor);
        }
      }
    }
  }

  private commit(drag: LabelGrab): void {
    this.release();
    const dropped = drag.constraint.label;
    const location = drag.constraint.obj.sourceLocation;
    if (!dropped || !location) {
      return;
    }
    // What is written is what stays on screen: round first, then show it.
    const position: LabelCoords = [
      roundToUnitDecimals(dropped[0], sceneUnit.current),
      roundToUnitDecimals(dropped[1], sceneUnit.current),
    ];
    this.preview(drag, position);
    if (drag.before && drag.before[0] === position[0] && drag.before[1] === position[1]) {
      return;
    }
    const generation = this.generation;
    void setDimensionLabel({
      line: location.line,
      filePath: location.filePath,
      kind: drag.constraint.kind,
      position,
    }).then((result) => {
      if (result.success) {
        // The re-render brings the placement back as payload; the preview
        // already shows it, so there is nothing to do here.
        return;
      }
      this.showMessage(result.reason ?? 'The dimension could not be moved');
      // A refused write means the source did NOT change — unless a render
      // landed meanwhile, in which case its model is already the truth.
      if (generation === this.generation) {
        this.preview(drag, drag.before);
      }
    });
  }

  /** Abandon the gesture in progress, putting a dragged label back. */
  private cancel(): void {
    const drag = this.drag;
    this.release();
    if (drag) {
      this.preview(drag, drag.before);
    }
  }

  /** End the gesture's hold on the canvas, whatever it had become. */
  private release(): void {
    if (!this.pending && !this.drag) {
      return;
    }
    const wasDragging = this.drag !== null;
    this.pending = null;
    this.drag = null;
    this.ctx.cameraControls.enabled = true;
    if (wasDragging) {
      this.canvas.style.cursor = 'default';
    }
  }
}
