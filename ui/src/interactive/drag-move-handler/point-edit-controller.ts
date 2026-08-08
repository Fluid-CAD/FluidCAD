import { PointInput, PointCommit } from '../../ui/point-input';
import { VariableInfo } from '../../ui/expression-core';
import { getPointExpression, updatePointExpression, getScopeVariables } from '../../api';
import { DragHitResult, GetSketchSourceLineFn } from './types';
import { pointTargetFor, PointTarget } from './point-target';

/**
 * Editing an already-drawn point by double-clicking it: the same coordinate
 * pill the drawing tools use, seeded with the point's *source* expression, so
 * a circle authored as `circle([cx, cy], 20)` opens showing `cx`/`cy` rather
 * than the numbers they evaluate to.
 *
 * Claims only zones `pointTargetFor` recognises; anything else falls through
 * to the dimension editor, which owns the shapes' scalar dimensions.
 */
export class PointEditController {
  private pointInput: PointInput;
  private getSketchSourceLine: GetSketchSourceLineFn;
  private variables: VariableInfo[] = [];
  /** Guards the async seed against a pill the user has already replaced. */
  private openToken = 0;

  constructor(container: HTMLElement, getSketchSourceLine: GetSketchSourceLineFn) {
    this.pointInput = new PointInput(container);
    this.getSketchSourceLine = getSketchSourceLine;
  }

  get isVisible(): boolean {
    return this.pointInput.isVisible;
  }

  hide(): void {
    this.pointInput.hide();
  }

  containsElement(el: EventTarget | null): boolean {
    return this.pointInput.containsElement(el);
  }

  handleEscape(): boolean {
    if (!this.pointInput.isVisible) {
      return false;
    }
    this.pointInput.hide();
    return true;
  }

  /**
   * Open the pill for a double-clicked point zone. Returns false when the hit
   * is not a point — the caller then tries the dimension editor.
   */
  showForDoubleClick(hit: DragHitResult): boolean {
    const target = pointTargetFor(hit);
    if (!target) {
      return false;
    }
    const seed = this.seedPosition(hit);
    if (!seed) {
      return false;
    }

    const token = ++this.openToken;
    void getScopeVariables(this.getSketchSourceLine() ?? hit.sourceLocation.line)
      .then((vars) => { this.variables = vars; });

    this.pointInput.show({
      value: seed,
      variables: this.variables,
      // Relative-to-the-pen has no meaning when editing an existing point.
      origin: null,
      // A double-click is an explicit "edit this", so the field takes focus
      // immediately — unlike the drawing tools' always-on readout.
      autoFocus: true,
      onCommit: (result) => this.commit(hit, target, result),
    });

    void getPointExpression(hit.sourceLocation.line, target.pointIndex)
      .then((point) => {
        if (point && token === this.openToken) {
          this.pointInput.seedExpressions(point.x, point.y);
        }
      })
      .catch(() => { /* seeding is best-effort; the numbers still work */ });

    return true;
  }

  /** The position the pill opens showing. */
  private seedPosition(hit: DragHitResult): [number, number] | null {
    return hit.draggedVertices?.[0] ?? hit.anchorPoint ?? null;
  }

  private commit(hit: DragHitResult, target: PointTarget, result: PointCommit): void {
    // The zone's current position: for a chained statement (no point
    // argument in the source) the server folds the reposition delta into the
    // preceding relative move() instead of promoting the call to absolute.
    const oldPosition = this.seedPosition(hit);
    updatePointExpression(
      result.xExpr,
      result.yExpr,
      hit.sourceLocation,
      this.getSketchSourceLine(),
      result.newVariables,
      target.pointIndex,
      oldPosition ?? undefined,
    );
  }
}
