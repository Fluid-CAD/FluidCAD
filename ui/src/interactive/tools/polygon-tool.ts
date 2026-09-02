import { Vector3 } from 'three';
import { SketchTool, InsertGeometryFn, FetchVariablesFn, PickedPoint } from '../sketch-tool';
import { SceneContext } from '../../scene/scene-context';
import { PlaneData, SceneObjectRender } from '../../types';
import { SnapController } from '../../snapping/snap-controller';
import { SnapManager } from '../../snapping/snap-manager';
import { SnapType } from '../../snapping/types';
import {
  projectToSketch,
  roundPoint,
  dist2D,
  pixelToSketchThreshold,
} from '../sketch-plane-utils';
import { ICON_POLYGON } from '../../ui/icons';
import {
  coincident,
  dimMagnitude,
  inferred,
  newTarget,
  polygonEmission,
  refTarget,
  type PolygonMode,
} from './solved-emission';
import type { SolvedVertexRef } from '../../snapping/types';
import { ExpressionInput, CommitResult } from '../../ui/expression-input';
import {
  START_POINT_COLOR,
  SNAP_VERTEX_COLOR,
  SNAP_GRID_COLOR,
  addDot,
  addDashedCircle,
  addDashedPolygon,
} from './tool-preview-utils';

type ExpressionPhase = 'diameter' | 'sides';

const MIN_SIDES = 3;
const MAX_SIDES = 24;
const DEFAULT_SIDES = 6;
const PX_PER_SIDE = 25;

export class PolygonTool extends SketchTool {
  readonly id = 'polygon' as const;
  readonly label = 'Polygon';
  readonly icon = ICON_POLYGON;

  private centerPoint: [number, number] | null = null;
  /** The centre as picked: same position, plus any typed axis expressions. */
  private centerPick: PickedPoint | null = null;
  /** The centre click's snap provenance — becomes a coincident on the guide
   * circle's centre (the polygon's only centre-carrying entity). */
  private centerSnapRef: SolvedVertexRef | null = null;
  private mousePoint: [number, number] | null = null;
  private lastSnapType: SnapType = 'none';
  private expressionInput: ExpressionInput;
  private lastClientX = 0;
  private lastClientY = 0;

  private expressionPhase: ExpressionPhase = 'diameter';
  private diameterExpression: CommitResult | null = null;
  /** Whether the ⌀ was actually TYPED — typed sizes become explicit
   * dimensions in a solved sketch. */
  private diameterTyped = false;
  private lockedDiameter: number | null = null;
  private currentSides = DEFAULT_SIDES;

  private boundMouseDown: (e: MouseEvent) => void;
  private boundMouseUp: (e: MouseEvent) => void;
  private boundMouseMove: (e: MouseEvent) => void;
  private boundKeyDown: (e: KeyboardEvent) => void;
  private downX = 0;
  private downY = 0;

  constructor(
    ctx: SceneContext,
    plane: PlaneData,
    snapController: SnapController,
    insertGeometry: InsertGeometryFn,
    container: HTMLElement,
    fetchVariables: FetchVariablesFn,
    private readonly mode: PolygonMode,
  ) {
    super(ctx, plane, snapController, insertGeometry, container, fetchVariables);
    this.expressionInput = new ExpressionInput(container);
    this.boundMouseDown = this.handleMouseDown.bind(this);
    this.boundMouseUp = this.handleMouseUp.bind(this);
    this.boundMouseMove = this.handleMouseMove.bind(this);
    this.boundKeyDown = this.handleKeyDown.bind(this);
  }

  protected onActivate(): void {
    this.addPreviewToScene();
    this.canvas.addEventListener('mousedown', this.boundMouseDown);
    this.canvas.addEventListener('mouseup', this.boundMouseUp);
    this.canvas.addEventListener('mousemove', this.boundMouseMove);
    window.addEventListener('keydown', this.boundKeyDown);
  }

  protected onDeactivate(): void {
    this.canvas.removeEventListener('mousedown', this.boundMouseDown);
    this.canvas.removeEventListener('mouseup', this.boundMouseUp);
    this.canvas.removeEventListener('mousemove', this.boundMouseMove);
    window.removeEventListener('keydown', this.boundKeyDown);
    this.resetState();
    this.removePreviewFromScene();
  }

  onSceneUpdate(sceneObjects: SceneObjectRender[], sketchId: string): void {
    const snapManager = SnapManager.fromSceneObjects(sceneObjects, sketchId, this.plane, this.ctx);
    this.updateSnapManager(snapManager);
    this.refreshVariables();
  }

  /** The centre is the point that lands in the source; later clicks set the
   * side count and diameter, which the expression input already covers. */
  protected override awaitingPoint(): boolean {
    return this.centerPoint === null;
  }

  protected override onTypedPoint(point: PickedPoint): void {
    this.consumeCenter(point);
  }

  /** Single writer for both halves of the anchor, so the position the preview
   * draws and the expressions the statement emits cannot drift. */
  private consumeCenter(center: PickedPoint): void {
    this.centerPick = center;
    this.centerPoint = center.value;
    this.syncPointInput();
    this.rebuildPreview();
  }

  private resetState(): void {
    this.centerPoint = null;
    this.centerPick = null;
    this.centerSnapRef = null;
    this.mousePoint = null;
    this.expressionPhase = 'diameter';
    this.diameterExpression = null;
    this.lockedDiameter = null;
    this.currentSides = DEFAULT_SIDES;
    this.expressionInput.hide();
  }

  private sidesFromDistance(dist: number): number {
    if (this.lockedDiameter !== null && this.lockedDiameter > 0) {
      const ratio = dist / (this.lockedDiameter / 2);
      return Math.max(MIN_SIDES, Math.min(MAX_SIDES, Math.round(ratio * DEFAULT_SIDES)));
    }
    const sketchUnitsPerSide = pixelToSketchThreshold(this.ctx, PX_PER_SIDE);
    if (sketchUnitsPerSide <= 0) {
      return DEFAULT_SIDES;
    }
    return Math.max(MIN_SIDES, Math.min(MAX_SIDES, Math.round(dist / sketchUnitsPerSide)));
  }

  private handleMouseDown(e: MouseEvent): void {
    this.downX = e.clientX;
    this.downY = e.clientY;
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

    if (!this.centerPoint) {
      // The pill contributes any axis the user typed; free axes come from the
      // cursor, so a plain click behaves exactly as it always did.
      const picked = this.applyPointInput(result.point2d);
      this.consumeCenter(picked);
      this.centerSnapRef = !picked.typed && !(e.ctrlKey || e.metaKey) ? result.ref ?? null : null;
      return;
    }

    if (this.expressionInput.isVisible) {
      this.expressionInput.commitCurrentValue();
      return;
    }

    if (this.expressionPhase === 'diameter') {
      const diameter = Math.round(dist2D(this.centerPoint, point) * 2 * 100) / 100;
      if (diameter <= 0) {
        return;
      }
      this.onDiameterCommit({ expression: String(diameter) });
    } else {
      this.onSidesCommit({ expression: String(this.currentSides) });
    }
  }

  private handleMouseMove(e: MouseEvent): void {
    this.lastClientX = e.clientX;
    this.lastClientY = e.clientY;

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

    if (this.centerPoint && this.expressionPhase === 'sides') {
      const dist = dist2D(this.centerPoint, this.mousePoint);
      this.currentSides = this.sidesFromDistance(dist);
    }

    this.rebuildPreview();
    this.updateDimensionInput();
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      // Typed coordinates clear first; only a clean pill lets Escape
      // fall through to cancelling the in-progress shape.
      if (this.handlePointInputEscape()) {
        return;
      }
      if (this.centerPoint) {
        this.resetState();
        this.rebuildPreview();
      }
    }
  }

  private updateDimensionInput(): void {
    if (!this.centerPoint || !this.mousePoint) {
      return;
    }

    if (this.expressionPhase === 'diameter') {
      const diameter = Math.round(dist2D(this.centerPoint, this.mousePoint) * 2 * 100) / 100;
      if (diameter <= 0) {
        return;
      }

      if (!this.expressionInput.isVisible) {
        this.expressionInput.show({
          label: '⌀',
          value: String(diameter),
          clientX: this.lastClientX,
          clientY: this.lastClientY,
          variables: this.cachedVariables,
          onCommit: (result) => this.onDiameterCommit(result),
        });
      } else {
        this.expressionInput.updateValue(diameter);
        this.expressionInput.updatePosition(this.lastClientX, this.lastClientY);
      }
    } else {
      if (!this.expressionInput.isVisible) {
        this.expressionInput.show({
          label: 'N',
          value: String(this.currentSides),
          clientX: this.lastClientX,
          clientY: this.lastClientY,
          variables: this.cachedVariables,
          onCommit: (result) => this.onSidesCommit(result),
        });
      } else {
        this.expressionInput.updateValue(this.currentSides);
        this.expressionInput.updatePosition(this.lastClientX, this.lastClientY);
      }
    }
  }

  private onDiameterCommit(result: CommitResult): void {
    const num = parseFloat(result.expression);
    const isNumeric = !isNaN(num) && String(num) === result.expression;

    this.diameterTyped = this.expressionInput.isTyping;
    this.diameterExpression = result;
    this.lockedDiameter = isNumeric ? num : this.previewDiameter(result);
    this.expressionPhase = 'sides';

    queueMicrotask(() => {
      if (this.mousePoint && this.centerPoint) {
        const dist = dist2D(this.centerPoint, this.mousePoint);
        this.currentSides = this.sidesFromDistance(dist);
      }

      this.expressionInput.show({
        label: 'N',
        value: String(this.currentSides),
        clientX: this.lastClientX,
        clientY: this.lastClientY,
        variables: this.cachedVariables,
        onCommit: (r) => this.onSidesCommit(r),
      });
      this.rebuildPreview();
    });
  }

  // Preview diameter for a dimension committed as a variable/expression: the
  // variable's own value when statically resolvable, else the mouse-derived
  // diameter at commit time. The final statement still uses the expression.
  private previewDiameter(result: CommitResult): number | null {
    const fromVariable = SketchTool.resolveCommittedMagnitude(result, this.cachedVariables);
    if (fromVariable !== null) {
      return fromVariable;
    }
    if (this.centerPoint && this.mousePoint) {
      return Math.round(dist2D(this.centerPoint, this.mousePoint) * 2 * 100) / 100;
    }
    return null;
  }

  private onSidesCommit(result: CommitResult): void {
    if (!this.centerPoint || !this.diameterExpression) {
      return;
    }

    this.commitPolygon(this.centerPick!, this.diameterExpression, result);
    this.resetState();
    this.rebuildPreview();
  }

  private commitPolygon(
    center: PickedPoint,
    diameterResult: CommitResult,
    sidesResult: CommitResult,
  ): void {
    const newVariables = [sidesResult.newVariable, diameterResult.newVariable]
      .filter((v): v is NonNullable<typeof v> => v !== undefined);

    if (this.solvedCtx) {
      const sides = parseInt(sidesResult.expression, 10);
      const diameter = (() => {
        const num = parseFloat(diameterResult.expression);
        if (!isNaN(num) && String(num) === diameterResult.expression) {
          return num;
        }
        return SketchTool.resolveCommittedValue(diameterResult, this.cachedVariables);
      })();
      if (isNaN(sides) || sides < 3 || diameter === null || diameter <= 0) {
        return;
      }
      const emission = polygonEmission({
        center: center.value,
        diameter,
        sides,
        mode: this.mode,
        ...(this.diameterTyped ? { diameterDim: dimMagnitude(diameterResult.expression) } : {}),
      });
      const constraints = [...emission.constraints];
      if (this.centerSnapRef && this.autoConstraintsEnabled()) {
        // The guide circle (last geometry entry) carries the polygon's centre.
        constraints.push(inferred(coincident(
          newTarget(emission.geometry.length - 1, 'center'),
          refTarget(this.centerSnapRef),
        )));
      }
      const variables = [...center.newVariables, ...newVariables];
      void this.solvedCtx.emit({
        geometry: emission.geometry,
        constraints,
        ...(variables.length > 0 ? { newVariables: variables } : {}),
      });
      this.diameterTyped = false;
    }
  }

  private rebuildPreview(): void {
    this.disposePreview();

    const camera = this.ctx.camera;
    const planeNormal = new Vector3(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z);

    if (this.centerPoint) {
      addDot(this.previewGroup, this.centerPoint, START_POINT_COLOR, camera, planeNormal, this.plane);

      if (this.mousePoint) {
        if (this.expressionPhase === 'diameter') {
          const radius = dist2D(this.centerPoint, this.mousePoint);
          if (radius > 0) {
            addDashedCircle(this.previewGroup, this.centerPoint, radius, this.plane);
          }
        } else {
          const guideRadius = this.lockedDiameter !== null
            ? this.lockedDiameter / 2
            : dist2D(this.centerPoint, this.mousePoint);

          if (guideRadius > 0 && this.currentSides >= MIN_SIDES) {
            // The dragged circle is the guide circle: sides tangent to it when
            // circumscribed, vertices on it when inscribed.
            const vertexRadius = this.mode === 'circumscribed'
              ? guideRadius / Math.cos(Math.PI / this.currentSides)
              : guideRadius;
            addDashedCircle(this.previewGroup, this.centerPoint, guideRadius, this.plane);
            addDashedPolygon(this.previewGroup, this.centerPoint, vertexRadius, this.currentSides, this.plane);
          }
        }
      }
    } else if (this.mousePoint && this.lastSnapType !== 'none') {
      const snapColor = this.lastSnapType === 'vertex' ? SNAP_VERTEX_COLOR : SNAP_GRID_COLOR;
      addDot(this.previewGroup, this.mousePoint, snapColor, camera, planeNormal, this.plane, 0.6);
    }

    this.requestRender();
  }
}
