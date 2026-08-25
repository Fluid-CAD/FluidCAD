import { Group, Vector3 } from 'three';
import { SceneContext } from '../scene/scene-context';
import { PlaneData, SceneObjectRender, Vec3Data } from '../types';
import { SnapController } from '../snapping/snap-controller';
import { SnapManager } from '../snapping/snap-manager';
import {
  worldToSketch2D, pixelToSketchThreshold, dist2D, projectToSketch, roundPoint,
} from './sketch-plane-utils';
import { PointInput, PointCommit } from '../ui/point-input';
import { resolveExpressionValue, VariableInfo } from '../ui/expression-core';
import { addDot, START_POINT_COLOR } from './tools/tool-preview-utils';
import type { SolvedToolContext } from './tools/solved-emission';

export type ToolId = 'line' | 'polyline' | 'circle' | 'polygon' | 'arc3' | 'arc2' | 'rect' | 'rounded-rect' | 'slot' | 'fillet' | 'offset' | 'rotate' | 'copy' | 'bezier' | 'text' | 'project';

export type ToolConfig = {
  id: ToolId;
  label: string;
  icon: string;
};

export type NewVariable = { name: string; initializer: string };

export type InsertGeometryFn = (
  statement: string,
  newVariable?: NewVariable | NewVariable[],
) => void;
export type FetchVariablesFn = () => Promise<{ name: string; initializer?: string }[]>;

/**
 * A point a tool is about to consume. Carries the resolved position for the
 * preview plus the per-axis source expression, so a coordinate typed as
 * `w / 2` reaches the emitted statement verbatim instead of as a number.
 */
export type PickedPoint = PointCommit;

export abstract class SketchTool {
  abstract readonly id: ToolId;
  abstract readonly label: string;
  abstract readonly icon: string;

  protected ctx: SceneContext;
  protected plane: PlaneData;
  protected snapController: SnapController;
  protected previewGroup: Group;
  protected insertGeometry: InsertGeometryFn;
  protected canvas: HTMLCanvasElement;
  protected container: HTMLElement;
  protected currentPosition: [number, number] | null = null;
  protected currentTangent: [number, number] | null = null;

  /** Non-null inside a solved sketch (sketch-rewrite P5): emissions go
   * through the atomic insert-solved rail as fully-specified primitives +
   * explicit constraints instead of `insertGeometry` pen statements. Set by
   * the toolbar service right after construction. */
  protected solvedCtx: SolvedToolContext | null = null;

  /** The coordinate pill. Shown while `awaitingPoint()` holds. */
  protected pointInput: PointInput;
  protected cachedVariables: VariableInfo[] = [];
  private fetchVariablesFn: FetchVariablesFn | null;
  /** The locked-point marker, kept out of `previewGroup` so tool rebuilds keep it. */
  private lockMarkerGroup: Group;
  private pointClientX = 0;
  private pointClientY = 0;
  private boundPointKeyDown: (e: KeyboardEvent) => void;
  private boundPointMouseMove: (e: MouseEvent) => void;

  constructor(
    ctx: SceneContext,
    plane: PlaneData,
    snapController: SnapController,
    insertGeometry: InsertGeometryFn,
    container: HTMLElement,
    fetchVariables?: FetchVariablesFn,
  ) {
    this.ctx = ctx;
    this.plane = plane;
    this.snapController = snapController;
    this.insertGeometry = insertGeometry;
    this.canvas = ctx.renderer.domElement;
    this.container = container;
    this.fetchVariablesFn = fetchVariables ?? null;

    this.previewGroup = new Group();
    this.previewGroup.userData.isMetaShape = true;
    this.previewGroup.renderOrder = 3;

    this.lockMarkerGroup = new Group();
    this.lockMarkerGroup.userData.isMetaShape = true;
    this.lockMarkerGroup.renderOrder = 2;

    this.pointInput = new PointInput(container);
    this.pointInput.onRelativeToggle = (relative) => {
      this.relativeMode = relative;
      this.onRelativeModeChange?.(relative);
    };
    this.boundPointKeyDown = this.handlePointKeyDown.bind(this);
    this.boundPointMouseMove = this.handlePointMouseMove.bind(this);
  }

  /**
   * Template method: owns the coordinate pill's lifecycle, then hands off to
   * the tool. Tools implement `onActivate`/`onDeactivate` rather than these,
   * because none of them called `super.activate()` when these were abstract.
   */
  activate(): void {
    this.ctx.scene.add(this.lockMarkerGroup);
    // Bubble phase, so a focused field (the text tool's panel) keeps its keys.
    window.addEventListener('keydown', this.boundPointKeyDown);
    this.canvas.addEventListener('mousemove', this.boundPointMouseMove);
    this.refreshVariables();
    this.onActivate();
  }

  deactivate(): void {
    this.onDeactivate();
    window.removeEventListener('keydown', this.boundPointKeyDown);
    this.canvas.removeEventListener('mousemove', this.boundPointMouseMove);
    this.pointInput.hide();
    this.clearLockMarker();
    this.ctx.scene.remove(this.lockMarkerGroup);
  }

  protected abstract onActivate(): void;
  protected abstract onDeactivate(): void;
  abstract onSceneUpdate(sceneObjects: SceneObjectRender[], sketchId: string): void;

  handleEscape?(): boolean;

  // ------------------------------------------------------- coordinate pill

  /**
   * Whether the tool is waiting for a point that lands in the source as an
   * `[x, y]`, with no dimension input competing for the same keystrokes.
   * Tools override; the default keeps the pill off.
   */
  protected awaitingPoint(): boolean {
    return false;
  }

  /** Absolute vs offsets-from-the-cursor, owned by the viewport's Δ button. */
  private relativeMode = false;

  /** Switch the coordinate pill between absolute and relative entry. */
  setRelativeMode(relative: boolean): void {
    this.relativeMode = relative;
    this.pointInput.setRelative(relative);
  }

  /** Fired when the pill's Δ button is clicked, so the host can remember the
   * mode across tool changes. */
  onRelativeModeChange: ((relative: boolean) => void) | null = null;

  /**
   * True while the coordinate pill is showing: it claims the next printable
   * key to open itself, so the toolbar's letter shortcuts stand down.
   */
  wantsPrintableKeys(): boolean {
    return this.pointInput.isVisible;
  }

  /** Numbers only — for tools with no in-scope variable list. */
  protected pointInputNumericOnly(): boolean {
    return false;
  }

  /** Consumes a point typed into the pill, as if it had been clicked. */
  protected onTypedPoint(_point: PickedPoint): void {}

  protected refreshVariables(): void {
    this.fetchVariablesFn?.().then((vars) => { this.cachedVariables = vars; });
  }

  /**
   * Merge the pill's pinned axes into a clicked point: a locked axis
   * contributes its typed expression, a free one the cursor value. Tools call
   * this in place of using the snapped point directly.
   */
  protected applyPointInput(point: [number, number]): PickedPoint {
    if (this.pointInput.isVisible) {
      return this.pointInput.resolvePick(point);
    }
    const rounded = roundPoint(point);
    return {
      value: rounded,
      xExpr: String(rounded[0]),
      yExpr: String(rounded[1]),
      newVariables: [],
      typed: false,
    };
  }

  /** A point straight off the cursor, for tools consuming a non-anchor click. */
  protected plainPoint(point: [number, number]): PickedPoint {
    const rounded = roundPoint(point);
    return {
      value: rounded,
      xExpr: String(rounded[0]),
      yExpr: String(rounded[1]),
      newVariables: [],
      typed: false,
    };
  }

  /**
   * Escape while the pill holds typed input clears it rather than cancelling
   * the tool. Tools call this first from their own Escape handling.
   */
  protected handlePointInputEscape(): boolean {
    const consumed = this.pointInput.handleEscape();
    if (consumed) {
      this.clearLockMarker();
      this.ctx.requestRender();
    }
    return consumed;
  }

  /** Refresh the pill after a state change that flips `awaitingPoint()`. */
  protected syncPointInput(): void {
    this.updatePointInput(this.pointClientX, this.pointClientY);
  }

  private handlePointKeyDown(e: KeyboardEvent): void {
    if (this.pointInput.handleTriggerKey(e)) {
      this.renderLockMarker(this.snapAt(this.pointClientX, this.pointClientY));
    }
  }

  private handlePointMouseMove(e: MouseEvent): void {
    this.pointClientX = e.clientX;
    this.pointClientY = e.clientY;
    this.updatePointInput(e.clientX, e.clientY);
  }

  private updatePointInput(clientX: number, clientY: number): void {
    if (!this.awaitingPoint()) {
      if (this.pointInput.isVisible) {
        this.pointInput.hide();
        this.clearLockMarker();
      }
      return;
    }

    const point = this.snapAt(clientX, clientY);
    if (!point) {
      return;
    }

    if (!this.pointInput.isVisible) {
      this.pointInput.show({
        value: point,
        variables: this.cachedVariables,
        origin: this.currentPosition,
        numericOnly: this.pointInputNumericOnly(),
        relative: this.relativeMode,
        onCommit: (result) => {
          this.pointInput.hide();
          this.clearLockMarker();
          this.onTypedPoint(result);
        },
      });
    } else {
      this.pointInput.setOrigin(this.currentPosition);
      this.pointInput.updateValue(point);
    }
    this.renderLockMarker(point);
  }

  /** The snapped sketch-space point under a screen position. */
  protected snapAt(clientX: number, clientY: number): [number, number] | null {
    const raw = projectToSketch(this.ctx, this.plane, clientX, clientY);
    if (!raw) {
      return null;
    }
    return this.snapController.snap(raw).point2d;
  }

  private clearLockMarker(): void {
    while (this.lockMarkerGroup.children.length > 0) {
      const child = this.lockMarkerGroup.children[0];
      this.lockMarkerGroup.remove(child);
      const obj = child as any;
      obj.geometry?.dispose();
      obj.material?.dispose();
    }
  }

  /**
   * A dot at the point a click would land on once an axis is pinned: the
   * locked coordinate plus the cursor's free one. The cursor itself is off
   * that point, so without a marker there is nothing showing where the
   * geometry actually goes.
   */
  private renderLockMarker(live: [number, number] | null): void {
    this.clearLockMarker();
    if (this.pointInput.isVisible && live) {
      const locks = this.pointInput.getLocks();
      if (locks.x !== null || locks.y !== null) {
        const resolved: [number, number] = [locks.x ?? live[0], locks.y ?? live[1]];
        const normal = new Vector3(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z);
        addDot(
          this.lockMarkerGroup, resolved, START_POINT_COLOR,
          this.ctx.camera, normal, this.plane, 0.7,
        );
      }
    }
    this.ctx.requestRender();
  }

  updatePlane(plane: PlaneData): void {
    this.plane = plane;
  }

  setSolvedContext(ctx: SolvedToolContext | null): void {
    this.solvedCtx = ctx;
  }

  protected isSolvedMode(): boolean {
    return this.solvedCtx !== null;
  }

  /** The sketch dialog's Auto-constraints toggle — whether snap/ortho
   * constraint inference is on. Legacy sketches (no solved context) have no
   * constraints to infer, so the answer there is moot. */
  protected autoConstraintsEnabled(): boolean {
    return this.solvedCtx?.autoConstraints() ?? true;
  }

  /** True once the pill holds a typed axis — the point is an address, not a
   * click, so the emitted statement must carry it explicitly. */
  protected hasTypedPoint(): boolean {
    return this.pointInput.isVisible && this.pointInput.hasInput;
  }

  updateSnapManager(snapManager: SnapManager): void {
    this.snapController.updateSnapManager(snapManager);
  }

  updateCurrentPosition(worldPos: Vec3Data | null): void {
    if (worldPos) {
      this.currentPosition = worldToSketch2D(worldPos, this.plane);
    } else {
      this.currentPosition = null;
    }
  }

  /**
   * The kernel's exact chain tangent at the current position. The payload
   * encodes it as `localToWorld(tangentDir)`, so projecting it back through
   * the plane recovers the 2D direction exactly — unlike deriving it from
   * mesh tessellation, which is chord-approximate.
   */
  updateCurrentTangent(worldTangent: Vec3Data | null): void {
    if (worldTangent) {
      const t = worldToSketch2D(worldTangent, this.plane);
      const len = Math.hypot(t[0], t[1]);
      this.currentTangent = len > 1e-9 ? [t[0] / len, t[1] / len] : null;
    } else {
      this.currentTangent = null;
    }
  }

  protected isAtCurrentPosition(point2d: [number, number]): boolean {
    if (!this.currentPosition) {
      return false;
    }
    const threshold = pixelToSketchThreshold(this.ctx, 15);
    return dist2D(point2d, this.currentPosition) <= threshold;
  }

  protected disposePreview(): void {
    while (this.previewGroup.children.length > 0) {
      const child = this.previewGroup.children[0];
      this.previewGroup.remove(child);
      const obj = child as any;
      if (obj.geometry) {
        obj.geometry.dispose();
      }
      if (obj.material) {
        obj.material.dispose();
      }
    }
  }

  protected addPreviewToScene(): void {
    this.ctx.scene.add(this.previewGroup);
  }

  protected removePreviewFromScene(): void {
    this.ctx.scene.remove(this.previewGroup);
    this.disposePreview();
    this.ctx.requestRender();
  }

  protected requestRender(): void {
    this.ctx.requestRender();
  }

  /**
   * A point argument's source text. Accepts a bare position (the long-standing
   * form, also what `ModeContext` exposes) or a picked point, whose typed
   * axes carry expressions rather than numbers.
   */
  protected formatPoint(p: [number, number] | PickedPoint): string {
    if (Array.isArray(p)) {
      return `[${p[0]}, ${p[1]}]`;
    }
    return `[${p.xExpr}, ${p.yExpr}]`;
  }

  /**
   * A leading `move(dx, dy)` for a relative pick, or null when the point is
   * absolute or already at the cursor.
   */
  protected relativeMovePrefix(p: PickedPoint): string | null {
    if (!p.relative) {
      return null;
    }
    if (Number(p.relative.dx) === 0 && Number(p.relative.dy) === 0) {
      return null;
    }
    return `move(${p.relative.dx}, ${p.relative.dy})`;
  }

  /**
   * Emit geometry placed at a picked point. `positioned` builds the call with
   * an explicit point argument, `chained` the form that starts at the cursor.
   *
   * A relative pick becomes a leading `move(dx, dy)` plus the chained form. An
   * absolute pick takes the positioned form unless it merely landed on the
   * cursor — a *typed* point is an address the author asked for, so it stays
   * explicit even when it coincides with where the pen already is.
   */
  protected insertAtPoint(
    point: PickedPoint,
    positioned: (pointText: string) => string,
    chained: () => string,
    extraVariables: NewVariable[] = [],
  ): void {
    const variables = [...point.newVariables, ...extraVariables];
    const declared = variables.length > 0 ? variables : undefined;

    if (point.relative) {
      const prefix = this.relativeMovePrefix(point);
      this.insertGeometry(prefix ? `${prefix}\n${chained()}` : chained(), declared);
      return;
    }

    const atCurrent = !point.typed && this.isAtCurrentPosition(point.value);
    this.insertGeometry(atCurrent ? chained() : positioned(this.formatPoint(point)), declared);
  }

  static negateExpression(expression: string): string {
    const isIdentifier = /^[a-zA-Z_$][\w$]*$/.test(expression);
    return isIdentifier ? `-${expression}` : `-(${expression})`;
  }

  // Best-effort numeric value of a committed dimension, for preview purposes
  // only: arithmetic over the in-scope variables, resolved recursively through
  // their initializers. Null when the value can't be resolved statically.
  static resolveCommittedValue(
    result: { expression: string; newVariable?: { name: string; initializer: string } },
    variables: { name: string; initializer?: string }[],
  ): number | null {
    return resolveExpressionValue(result.expression, variables, result.newVariable ?? null);
  }

  static resolveCommittedMagnitude(
    result: { expression: string; newVariable?: { name: string; initializer: string } },
    variables: { name: string; initializer?: string }[],
  ): number | null {
    const value = SketchTool.resolveCommittedValue(result, variables);
    return value === null ? null : Math.abs(value);
  }

  // Re-applies the drag direction to a committed dimension: numeric input has
  // the sign baked into the value, a variable/expression is negated at the
  // use site so the variable itself stays a positive magnitude.
  static applySignedDimension(expression: string, sign: number): string {
    const num = parseFloat(expression);
    if (!isNaN(num) && String(num) === expression) {
      return String(Math.round(sign * num * 100) / 100);
    }
    if (sign < 0) {
      return SketchTool.negateExpression(expression);
    }
    return expression;
  }
}
