// Solver-driven drag for solved-mode sketches (sketch-rewrite P4).
//
// Replaces the per-type constraint ladders wholesale: pointermove adds drag
// rows on the grabbed point (or the whole entity's points for a body grab),
// runs a warm-started local solve (lib/sketch-solver via the client's
// LiveSolvedSystem — no server round-trip per frame), and rewrites the live
// SketchMesh geometry in place. Pointerup batch-writes every drifted literal
// across all touched statements through /api/update-sketch-positions — one
// undo step; a refusal resets the preview to the payload state, because a
// refused write-back means the source did NOT change.

import { SceneContext } from '../../scene/scene-context';
import { PlaneData, SceneObjectRender } from '../../types';
import { SnapController } from '../../snapping/snap-controller';
import { updateSketchPositions } from '../../api';
import { pixelToSketchThreshold, projectToSketch } from '../sketch-plane-utils';
import {
  LiveSolvedSystem,
  SolvedSketchModel,
  buildPositionWriteBack,
  solvedHitTest,
  updateDragTargets,
} from '../../sketch-solver-client';
import type { SolvedDragMode, SolvedDragTarget, SolvedHit } from '../../sketch-solver-client';
import type { SolveOutcome } from '../../../../lib/sketch-solver/types.js';
import type { SketchMesh } from '../../meshes/containers/sketch-mesh';
import { DRAG_THRESHOLD_PX } from './types';

// Equal thresholds: a grab that can see both must take the vertex — a
// line's endpoint is on the line, so the body is always in range there too.
const VERTEX_GRAB_PX = 12;
const EDGE_GRAB_PX = 12;

type PendingSolvedHit = {
  hit: SolvedHit;
  point2d: [number, number];
  clientX: number;
  clientY: number;
};

export class SolvedDragHandler {
  private ctx: SceneContext;
  private plane: PlaneData;
  private snapController: SnapController;
  private canvas: HTMLCanvasElement;
  private sketchId = '';
  private sketchMesh: SketchMesh | null = null;
  private model: SolvedSketchModel | null = null;
  private live: LiveSolvedSystem | null = null;

  private _isResizing = false;
  private pendingHit: PendingSolvedHit | null = null;
  private targets: SolvedDragTarget[] = [];
  /** Vertex grabs chase the cursor; body grabs translate by its delta.
   * Decided by the hit, never by the target count — a circle body grab has
   * exactly one target (its center). */
  private dragMode: SolvedDragMode = 'vertex';
  private grabStart: [number, number] | null = null;
  /** Outcome of the latest dragSolve — a commit is only honest for a real
   * solution. Writing back a least-squares compromise (conflicted sketch)
   * would bake a non-solution into the source literals — that is how the
   * pre-guard collapse bug turned a drag into zero-length line literals. */
  private lastDragOutcome: SolveOutcome | null = null;
  /** True while the write-back round-trip is in flight — a re-render landing
   * meanwhile must win over our stale preview reset. */
  private committing = false;

  private boundCanvasPointerDown: (e: PointerEvent) => void;
  private boundPointerMove: (e: PointerEvent) => void;
  private boundPointerUp: (e: PointerEvent) => void;
  private boundKeyDown: (e: KeyboardEvent) => void;

  constructor(
    ctx: SceneContext,
    plane: PlaneData,
    snapController: SnapController,
    /** Badges take pick priority over geometry — the hover handler owns
     * them, so a press on one must not claim the gesture. */
    private hasBadgeAt: (clientX: number, clientY: number) => boolean,
    private showMessage: (message: string) => void,
  ) {
    this.ctx = ctx;
    this.plane = plane;
    this.snapController = snapController;
    this.canvas = ctx.renderer.domElement;
    this.boundCanvasPointerDown = this.handleCanvasPointerDown.bind(this);
    this.boundPointerMove = this.handlePointerMove.bind(this);
    this.boundPointerUp = this.handlePointerUp.bind(this);
    this.boundKeyDown = this.handleKeyDown.bind(this);
  }

  get isResizing(): boolean {
    return this._isResizing;
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
    if (this._isResizing) {
      this.resetPreview();
      this.endDrag();
    }
    this.pendingHit = null;
  }

  updatePlane(plane: PlaneData): void {
    this.plane = plane;
  }

  updateSnapController(snapController: SnapController): void {
    this.snapController = snapController;
  }

  updateSceneData(sceneObjects: SceneObjectRender[], sketchId: string): void {
    this.sketchId = sketchId;
    this.sketchMesh = this.findSketchMesh();
    this.model = this.sketchMesh?.solved ?? null;
    this.live = LiveSolvedSystem.fromSnapshot(this.model?.solver);
    // A fresh render replaced the meshes mid-commit — the authoritative
    // geometry has arrived and any pending preview reset is moot.
    this.committing = false;
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
    if (e.button !== 0 || this._isResizing || !this.model || !this.live) {
      return;
    }
    if (this.hasBadgeAt(e.clientX, e.clientY)) {
      return;
    }
    const point2d = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (!point2d) {
      return;
    }
    const hit = solvedHitTest(
      this.model,
      point2d,
      pixelToSketchThreshold(this.ctx, VERTEX_GRAB_PX),
      pixelToSketchThreshold(this.ctx, EDGE_GRAB_PX),
    );
    if (!hit || this.isFixedEntity(hit.entityId)) {
      return;
    }
    this.pendingHit = { hit, point2d, clientX: e.clientX, clientY: e.clientY };
    this.ctx.cameraControls.enabled = false;
    e.stopPropagation();
  }

  private isFixedEntity(entityId: number): boolean {
    return this.model?.solver?.entities.find(e => e.id === entityId)?.fixed === true;
  }

  private startDrag(pending: PendingSolvedHit): void {
    const model = this.model;
    const live = this.live;
    if (!model || !live) {
      return;
    }
    const hit = pending.hit;
    const view = model.entities.get(hit.entityId);
    if (!view) {
      return;
    }

    this.targets = [];
    this.dragMode = hit.type === 'vertex' ? 'vertex' : 'body';
    if (hit.type === 'vertex') {
      this.targets.push({ point: { ref: hit.ref, x: hit.at[0], y: hit.at[1] }, origin: hit.at });
    } else {
      // Body grab: translate every named point of the entity by the cursor
      // delta; the solve keeps whatever the constraints pin.
      const roles: ('start' | 'end' | 'center')[] =
        view.kind === 'line' ? ['start', 'end']
          : view.kind === 'arc' ? ['start', 'end', 'center']
            : ['center'];
      if (view.kind === 'point') {
        const at = view.point ?? pending.point2d;
        this.targets.push({ point: { ref: { entity: hit.entityId }, x: at[0], y: at[1] }, origin: at });
      } else {
        for (const role of roles) {
          const at = view[role];
          if (at) {
            this.targets.push({
              point: { ref: { entity: hit.entityId, point: role }, x: at[0], y: at[1] },
              origin: at,
            });
          }
        }
      }
    }
    if (this.targets.length === 0) {
      return;
    }

    this._isResizing = true;
    this.grabStart = pending.point2d;
    this.ctx.cameraControls.enabled = false;
    this.canvas.style.cursor = 'crosshair';
    this.snapController.setExcludedVertices(this.targets.map(t => t.origin));
  }

  private handlePointerMove(e: PointerEvent): void {
    if (this.pendingHit && !this._isResizing) {
      const dx = e.clientX - this.pendingHit.clientX;
      const dy = e.clientY - this.pendingHit.clientY;
      if (dx * dx + dy * dy >= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
        const pending = this.pendingHit;
        this.pendingHit = null;
        this.startDrag(pending);
      } else {
        return;
      }
    }
    if (!this._isResizing || !this.live || !this.grabStart) {
      return;
    }
    const raw = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (!raw) {
      return;
    }

    const snapped = this.snapController.snap(raw).point2d;
    updateDragTargets(this.dragMode, this.targets, this.grabStart, snapped);

    this.lastDragOutcome = this.live.dragSolve(this.targets.map(t => t.point));
    this.sketchMesh?.updateSolvedGeometry(id => this.live!.entityGeometry(id));
    this.ctx.requestRender();
  }

  private handlePointerUp(e: PointerEvent): void {
    if (e.button !== 0) {
      return;
    }
    if (this._isResizing) {
      this.commitDrag();
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    if (this.pendingHit) {
      this.pendingHit = null;
      this.ctx.cameraControls.enabled = true;
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && this._isResizing) {
      this.resetPreview();
      this.endDrag();
    }
  }

  private commitDrag(): void {
    const model = this.model;
    const live = this.live;
    this.endDrag();
    if (!model || !live) {
      return;
    }
    const { edits, filePath } = buildPositionWriteBack(model, id => live.entityGeometry(id));
    if (edits.length === 0) {
      // Nothing drifted beyond 2dp — put the preview back on the payload.
      this.resetPreview();
      return;
    }
    if (this.lastDragOutcome !== 'solved') {
      this.showMessage('Sketch constraints are not satisfied — the drag was not saved');
      this.resetPreview();
      return;
    }
    this.committing = true;
    void updateSketchPositions(edits, filePath).then((result) => {
      if (!this.committing) {
        return;
      }
      this.committing = false;
      if (!result.success) {
        this.showMessage(result.reason ?? 'The sketch positions could not be written back');
        this.resetPreview();
      }
      // On success the re-render replaces the meshes; the preview already
      // shows the solved geometry, so there is nothing to do here.
    });
  }

  /** Put the live system and the mesh preview back on the payload state. */
  private resetPreview(): void {
    const model = this.model;
    const live = this.live;
    if (!model?.solver || !live) {
      return;
    }
    live.reset(model.solver);
    this.sketchMesh?.updateSolvedGeometry(id => live.entityGeometry(id));
    this.ctx.requestRender();
  }

  private endDrag(): void {
    this._isResizing = false;
    this.pendingHit = null;
    this.targets = [];
    this.grabStart = null;
    this.ctx.cameraControls.enabled = true;
    this.canvas.style.cursor = 'default';
    this.snapController.setExcludedVertices([]);
  }
}
