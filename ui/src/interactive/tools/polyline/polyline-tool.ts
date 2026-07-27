import { Vector3 } from 'three';
import { SketchTool, InsertGeometryFn, FetchVariablesFn } from '../../sketch-tool';
import { SceneContext } from '../../../scene/scene-context';
import { PlaneData, SceneObjectRender } from '../../../types';
import { SnapController } from '../../../snapping/snap-controller';
import { SnapManager } from '../../../snapping/snap-manager';
import { projectToSketch, roundPoint } from '../../sketch-plane-utils';
import { ICON_POLYLINE } from '../../../ui/icons';
import { ExpressionInput, VariableInfo } from '../../../ui/expression-input';
import { CONNECTABLE_TYPES, meshToSketch2D, tangentFromVertices } from '../tangent-utils';
import { SNAP_VERTEX_COLOR, SNAP_GRID_COLOR, addDot } from '../tool-preview-utils';
import { ModeIndicator } from './mode-indicator';
import { LineMode } from './mode-line';
import { ConstrainedLineMode } from './mode-constrained-line';
import { ALineMode } from './mode-aline';
import { ArcMode } from './mode-arc';
import { TArcMode } from './mode-tarc';
import { TLineMode } from './mode-tline';
import {
  PolylinePhase,
  MODE_ORDER,
  type SegmentMode,
  type ModeContext,
  type Point2D,
  type TangentInfo,
  type ClickResult,
} from './types';
import type { SnapType } from '../../../snapping/types';

export class PolylineTool extends SketchTool {
  readonly id = 'polyline' as const;
  readonly label = 'Polyline';
  readonly icon = ICON_POLYLINE;

  private phase: PolylinePhase = PolylinePhase.IDLE;
  private startPoint: Point2D | null = null;
  private currentModeIndex = 0;
  private tangent: TangentInfo | null = null;

  private modes: SegmentMode[];
  private expressionInput: ExpressionInput;
  private fetchVariables: FetchVariablesFn;
  private cachedVariables: VariableInfo[] = [];
  private modeIndicator: ModeIndicator;

  private sceneObjects: SceneObjectRender[] = [];
  private sketchId = '';
  private mousePoint: Point2D | null = null;
  private lastSnapType: SnapType = 'none';
  private lastSnapResult: { point2d: Point2D; worldPoint: import('three').Vector3; snapType: SnapType } | null = null;
  private lastClientX = 0;
  private lastClientY = 0;

  private ctrlHeld = false;

  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;
  private boundKeyDown: (e: KeyboardEvent) => void;
  private boundKeyUp: (e: KeyboardEvent) => void;
  private downX = 0;
  private downY = 0;

  constructor(
    ctx: SceneContext,
    plane: PlaneData,
    snapController: SnapController,
    insertGeometry: InsertGeometryFn,
    container: HTMLElement,
    fetchVariables: FetchVariablesFn,
  ) {
    super(ctx, plane, snapController, insertGeometry);
    this.expressionInput = new ExpressionInput(container);
    this.fetchVariables = fetchVariables;
    this.modeIndicator = new ModeIndicator(container);

    this.modes = [
      new LineMode(),
      new ConstrainedLineMode('h'),
      new ConstrainedLineMode('v'),
      new ALineMode(),
      new ArcMode(),
      new TArcMode(),
      new TLineMode(),
    ];

    this.boundMouseDown = this.handleMouseDown.bind(this);
    this.boundMouseUp = this.handleMouseUp.bind(this);
    this.boundMouseMove = this.handleMouseMove.bind(this);
    this.boundKeyDown = this.handleKeyDown.bind(this);
    this.boundKeyUp = this.handleKeyUp.bind(this);

    this.expressionInput.onSpaceOverride = () => {
      this.cycleMode(1);
    };
  }

  private get currentMode(): SegmentMode {
    return this.modes[this.currentModeIndex];
  }

  activate(): void {
    this.addPreviewToScene();
    this.canvas.addEventListener('mousedown', this.boundMouseDown);
    this.canvas.addEventListener('mouseup', this.boundMouseUp);
    this.canvas.addEventListener('mousemove', this.boundMouseMove);
    window.addEventListener('keydown', this.boundKeyDown);
    window.addEventListener('keyup', this.boundKeyUp);
    this.fetchVariables().then(vars => { this.cachedVariables = vars; });
    this.modeIndicator.show(this.currentMode.id);
  }

  deactivate(): void {
    this.canvas.removeEventListener('mousedown', this.boundMouseDown);
    this.canvas.removeEventListener('mouseup', this.boundMouseUp);
    this.canvas.removeEventListener('mousemove', this.boundMouseMove);
    window.removeEventListener('keydown', this.boundKeyDown);
    window.removeEventListener('keyup', this.boundKeyUp);
    this.expressionInput.hide();
    this.modeIndicator.dispose();
    this.phase = PolylinePhase.IDLE;
    this.startPoint = null;
    this.tangent = null;
    this.ctrlHeld = false;

    this.removePreviewFromScene();
  }

  onSceneUpdate(sceneObjects: SceneObjectRender[], sketchId: string): void {
    this.sceneObjects = sceneObjects;
    this.sketchId = sketchId;
    const snapManager = SnapManager.fromSceneObjects(sceneObjects, sketchId, this.plane, this.ctx);
    this.updateSnapManager(snapManager);
    this.fetchVariables().then(vars => { this.cachedVariables = vars; });

    if (this.phase === PolylinePhase.DRAWING && this.startPoint) {
      this.updateTangentFromScene();
    }
  }

  override handleEscape(): boolean {
    const ctx = this.buildModeContext();
    if (ctx && this.currentMode.handleEscape(ctx)) {
      this.rebuildPreview();
      return true;            // mode backed out one sub-step (e.g. arc through-point)
    }
    if (this.phase === PolylinePhase.DRAWING) {
      if (ctx) {
        this.currentMode.exit(ctx);
      }
      this.expressionInput.hide();
      this.phase = PolylinePhase.IDLE;
      this.startPoint = null;
      this.tangent = null;
      this.rebuildPreview();
      return true;            // chain ended; tool stays armed for a new chain
    }
    return false;             // idle -> let the toolbar disarm the tool
  }

  private buildModeContext(): ModeContext | null {
    if (!this.startPoint) {
      return null;
    }

    const planeNormal = new Vector3(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z);

    return {
      plane: this.plane,
      previewGroup: this.previewGroup,
      camera: this.ctx.camera,
      planeNormal,
      tangent: this.tangent,
      sceneObjects: this.sceneObjects,
      sketchId: this.sketchId,
      startPoint: this.startPoint,
      isAtCurrentPosition: (p) => this.isAtCurrentPosition(p),
      formatPoint: (p) => this.formatPoint(p),
      insertGeometry: (stmt, nv) => this.insertGeometry(stmt, nv),
      requestRender: () => this.requestRender(),
      isOrthoOverride: () => this.ctrlHeld,
      showExpressionInput: (opts) => {
        if (!this.expressionInput.isVisible) {
          this.expressionInput.show({
            ...opts,
            variables: this.cachedVariables,
          });
        }
      },
      updateExpressionValue: (v) => this.expressionInput.updateValue(v),
      updateExpressionPosition: (x, y) => this.expressionInput.updatePosition(x, y),
      hideExpressionInput: () => this.expressionInput.hide(),
      isExpressionVisible: () => this.expressionInput.isVisible,
      commitExpressionValue: () => this.expressionInput.commitCurrentValue(),
      onSegmentCommitted: (result) => this.handleModeCommit(result),
    };
  }

  private handleModeCommit(result: import('./types').SegmentCommitResult): void {
    const { endpoint, exitTangent } = result;

    this.startPoint = endpoint;
    this.tangent = exitTangent;

    if (this.currentMode.requiresTangent && !this.tangent) {
      this.advanceToNextValidMode();
      this.modeIndicator.update(this.currentMode.id);
    }

    const newCtx = this.buildModeContext()!;
    this.currentMode.enter(newCtx);
    this.rebuildPreview();
  }

  private handleMouseDown(e: MouseEvent): void {
    this.downX = e.clientX;
    this.downY = e.clientY;
    this.syncModifiers(e);
  }

  private handleMouseUp(e: MouseEvent): void {
    const dx = e.clientX - this.downX;
    const dy = e.clientY - this.downY;
    if (dx * dx + dy * dy > 64) {
      return;
    }

    const raw = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (!raw) {
      return;
    }

    const result = this.snapController.snap(raw);
    const point = roundPoint(result.point2d);

    if (this.phase === PolylinePhase.IDLE) {
      this.startPoint = point;
      this.phase = PolylinePhase.DRAWING;
      this.tangent = this.findTangentAtPoint(point);

      if (!this.isModeUsable(this.currentMode, this.buildModeContext())) {
        this.advanceToNextValidMode();
      }

      const modeCtx = this.buildModeContext()!;
      this.currentMode.enter(modeCtx);
      this.modeIndicator.update(this.currentMode.id);
      this.rebuildPreview();
      return;
    }

    const modeCtx = this.buildModeContext();
    if (!modeCtx) {
      return;
    }

    const clickResult: ClickResult = this.currentMode.handleClick(point, result, modeCtx);

    if (clickResult.kind === 'committed') {
      this.handleModeCommit(clickResult.result);
    } else {
      this.rebuildPreview();
    }
  }

  private handleMouseMove(e: MouseEvent): void {
    this.lastClientX = e.clientX;
    this.lastClientY = e.clientY;
    this.syncModifiers(e);

    const raw = projectToSketch(this.ctx, this.plane, e.clientX, e.clientY);
    if (!raw) {
      this.mousePoint = null;
      this.lastSnapType = 'none';
      this.rebuildPreview();
      return;
    }

    const result = this.snapController.snap(raw);
    this.mousePoint = result.point2d;
    this.lastSnapType = result.snapType;
    this.lastSnapResult = result;

    this.modeIndicator.updatePosition(e.clientX, e.clientY);

    if (this.phase === PolylinePhase.DRAWING) {
      const modeCtx = this.buildModeContext();
      if (modeCtx) {
        this.currentMode.handleMouseMove(result.point2d, result, e.clientX, e.clientY, modeCtx);
      }
    }

    this.rebuildPreview();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    this.syncModifiers(e);
    if (e.key === ' ') {
      e.preventDefault();
      this.cycleMode(e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === 'Control' || e.key === 'Meta') {
      this.refreshAfterModifierChange();
    }
  }

  private handleKeyUp(e: KeyboardEvent): void {
    this.syncModifiers(e);
    if (e.key === 'Control' || e.key === 'Meta') {
      this.refreshAfterModifierChange();
    }
  }

  private syncModifiers(e: MouseEvent | KeyboardEvent): void {
    this.ctrlHeld = e.ctrlKey || e.metaKey;
  }

  // A Ctrl/Meta transition changes the ortho classification mid-gesture, so the
  // current mode re-sees the last mouse position under the new modifier state.
  private refreshAfterModifierChange(): void {
    if (this.phase !== PolylinePhase.DRAWING) {
      return;
    }
    const modeCtx = this.buildModeContext();
    if (modeCtx && this.mousePoint && this.lastSnapResult) {
      this.currentMode.handleMouseMove(this.mousePoint, this.lastSnapResult, this.lastClientX, this.lastClientY, modeCtx);
    }
    this.rebuildPreview();
  }

  // A mode is usable when its tangent requirement is met and its optional
  // availability gate passes. Availability only matters once a chain is being
  // drawn: with no context (IDLE) every mode counts as available.
  private isModeUsable(mode: SegmentMode, modeCtx: ModeContext | null): boolean {
    if (mode.requiresTangent && !this.tangent) {
      return false;
    }
    if (!modeCtx) {
      return true;
    }
    return mode.isAvailable?.(modeCtx) ?? true;
  }

  private cycleMode(direction: number): void {
    const modeCtx = this.buildModeContext();
    if (modeCtx) {
      this.expressionInput.hide();
      this.currentMode.exit(modeCtx);
    }

    const startIndex = this.currentModeIndex;
    for (let i = 0; i < MODE_ORDER.length; i++) {
      this.currentModeIndex = (this.currentModeIndex + direction + MODE_ORDER.length) % MODE_ORDER.length;
      const candidate = this.modes[this.currentModeIndex];
      if (this.isModeUsable(candidate, modeCtx)) {
        break;
      }
      if (this.currentModeIndex === startIndex) {
        break;
      }
    }

    this.modeIndicator.update(this.currentMode.id);

    if (this.phase === PolylinePhase.DRAWING) {
      const newCtx = this.buildModeContext();
      if (newCtx) {
        this.currentMode.enter(newCtx);
        if (this.mousePoint && this.lastSnapResult) {
          this.currentMode.handleMouseMove(this.mousePoint, this.lastSnapResult, this.lastClientX, this.lastClientY, newCtx);
        }
      }
    }

    this.rebuildPreview();
  }

  private advanceToNextValidMode(): void {
    const modeCtx = this.buildModeContext();
    const startIndex = this.currentModeIndex;
    for (let i = 0; i < MODE_ORDER.length; i++) {
      this.currentModeIndex = (this.currentModeIndex + 1) % MODE_ORDER.length;
      if (this.isModeUsable(this.modes[this.currentModeIndex], modeCtx)) {
        return;
      }
      if (this.currentModeIndex === startIndex) {
        return;
      }
    }
  }

  private findTangentAtPoint(point: Point2D): TangentInfo | null {
    if (!this.isAtCurrentPosition(roundPoint(point))) {
      return null;
    }

    let lastGeom: SceneObjectRender | null = null;
    for (const child of this.sceneObjects) {
      if (child.parentId !== this.sketchId || !child.sourceLocation) {
        continue;
      }
      if (!CONNECTABLE_TYPES.has(child.uniqueType ?? '')) {
        continue;
      }
      lastGeom = child;
    }
    if (!lastGeom) {
      return null;
    }

    for (const part of lastGeom.sceneShapes) {
      if (part.isMetaShape) {
        continue;
      }
      for (const mesh of part.meshes) {
        const verts = meshToSketch2D(mesh.vertices, this.plane);
        if (verts.length < 2) {
          continue;
        }
        const dir = tangentFromVertices(verts, 'end');
        if (dir) {
          return { direction: dir, point };
        }
      }
    }
    return null;
  }

  private updateTangentFromScene(): void {
    if (!this.startPoint) {
      return;
    }
    if (this.tangent) {
      return;
    }
    const tangent = this.findTangentAtPoint(this.startPoint);
    if (tangent) {
      this.tangent = tangent;
    }
  }

  private rebuildPreview(): void {
    this.disposePreview();

    const planeNormal = new Vector3(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z);

    if (this.phase === PolylinePhase.DRAWING) {
      const modeCtx = this.buildModeContext();
      if (modeCtx) {
        this.currentMode.rebuildPreview(modeCtx);
      }
    } else if (this.mousePoint && this.lastSnapType !== 'none') {
      const snapColor = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
      addDot(this.previewGroup, this.mousePoint, snapColor, this.ctx.camera, planeNormal, this.plane, 0.6);
    }

    this.requestRender();
  }
}
