import {
  ConversionTarget, convertSegment, fetchSegmentConversions,
} from '../../api';
import { SceneObjectRender } from '../../types';
import { SketchHoverSelectHandler } from '../sketch-hover-select-handler';
import { ConstraintToolbar } from './constraint-toolbar';

/** The api calls, injectable for tests. */
type ConversionApi = {
  fetchSegmentConversions: typeof fetchSegmentConversions;
  convertSegment: typeof convertSegment;
};

/**
 * Logic behind the constraint mini-toolbar: tracks the sketch selection,
 * fetches the legal conversions for a single selected chained segment, and
 * applies the clicked one. Owned by `SketchToolbarService`, which drives the
 * visibility and update lifecycle.
 */
export class ConstraintToolbarService {
  private view: ConstraintToolbar;
  private showMessage: (message: string) => void;
  private api: ConversionApi;

  /** The selected segment the current options belong to. */
  private currentShapeId: string | null = null;
  /** Drift guard for the apply, cached from the options fetch. */
  private expectedStatement: string | null = null;
  /** Statement line of the selected segment, for post-convert re-selection. */
  private sourceLine: number | null = null;
  /** Stale-response guard: only the latest fetch may apply its options. */
  private fetchSeq = 0;
  /** A conversion is in flight — block re-entrant clicks. */
  private busy = false;
  /**
   * One-shot: re-select the segment at this statement line on the next scene
   * update (ids change every render, so the shapeId can't be carried across).
   */
  private pendingReselectLine: number | null = null;

  constructor(
    container: HTMLElement,
    showMessage: (message: string) => void,
    api: ConversionApi = { fetchSegmentConversions, convertSegment },
  ) {
    this.showMessage = showMessage;
    this.api = api;
    this.view = new ConstraintToolbar(container);
    this.view.onConvert = (target) => void this.convert(target);
  }

  show(): void {
    this.view.show();
  }

  hide(): void {
    this.view.hide();
    this.pendingReselectLine = null;
    this.setSelection(null);
  }

  /**
   * A click mutated the hover handler's selection — refresh the options.
   * Also called on every scene update while a sketch is active, since a
   * re-render may have edited the statement or pruned the selection.
   */
  selectionChanged(handler: SketchHoverSelectHandler | null): void {
    const ids = handler ? [...handler.selectedIds] : [];
    this.setSelection(ids.length === 1 ? ids[0] : null);
  }

  /**
   * Hook into `SketchToolbarService.update` while a sketch is active. Replays
   * the post-convert re-selection (finding the converted statement's segment
   * among the new ids), then syncs the options to the surviving selection.
   * `handler` is null while a drawing tool is armed — no selection then.
   */
  sketchUpdated(
    sceneObjects: SceneObjectRender[],
    sketchId: string,
    handler: SketchHoverSelectHandler | null,
  ): void {
    if (this.pendingReselectLine !== null) {
      const line = this.pendingReselectLine;
      this.pendingReselectLine = null;
      const shapeId = handler ? findShapeAtLine(sceneObjects, sketchId, line) : null;
      if (shapeId) {
        // Fires the selection-change hook, which fans back into
        // selectionChanged() and fetches the fresh options.
        handler!.selectShape(shapeId);
        return;
      }
    }
    this.selectionChanged(handler);
  }

  private setSelection(shapeId: string | null): void {
    this.fetchSeq++;
    if (!shapeId) {
      if (this.currentShapeId !== null) {
        this.currentShapeId = null;
        this.expectedStatement = null;
        this.sourceLine = null;
        this.view.setOptions(null);
      }
      return;
    }
    this.currentShapeId = shapeId;
    void this.fetchOptions(shapeId);
  }

  private async fetchOptions(shapeId: string): Promise<void> {
    const seq = this.fetchSeq;
    const result = await this.api.fetchSegmentConversions(shapeId);
    if (seq !== this.fetchSeq) {
      return;
    }
    if (!result.ok) {
      this.expectedStatement = null;
      this.sourceLine = null;
      this.view.setOptions(null, capitalize(result.reason ?? 'This segment cannot be converted'));
      return;
    }
    this.expectedStatement = result.expectedStatement ?? null;
    this.sourceLine = result.sourceLocation?.line ?? null;
    this.view.setOptions(result.options ?? []);
  }

  private async convert(target: ConversionTarget): Promise<void> {
    if (this.busy || !this.currentShapeId || this.expectedStatement === null) {
      return;
    }
    this.busy = true;
    this.view.setBusy(true);
    // The rewrite's re-render (all-new ids) can beat this HTTP response —
    // arm the by-line re-selection before awaiting, disarm on refusal.
    this.pendingReselectLine = this.sourceLine;
    const result = await this.api.convertSegment(this.currentShapeId, target, this.expectedStatement);
    this.busy = false;
    this.view.setBusy(false);
    if (!result.success) {
      this.pendingReselectLine = null;
      this.showMessage(result.reason ?? 'Could not convert the segment');
    }
  }
}

/**
 * The first pickable shapeId of the sketch child whose statement sits at
 * `line` — the same owner walk the edge index uses.
 */
function findShapeAtLine(
  sceneObjects: SceneObjectRender[],
  sketchId: string,
  line: number,
): string | null {
  for (const obj of sceneObjects) {
    if (obj.parentId !== sketchId || obj.sourceLocation?.line !== line) {
      continue;
    }
    for (const shape of obj.sceneShapes) {
      if (shape.shapeId && !shape.isMetaShape) {
        return shape.shapeId;
      }
    }
  }
  return null;
}

/** Server reasons are mid-sentence fragments; tooltips read as sentences. */
function capitalize(text: string): string {
  return text.length > 0 ? text[0].toUpperCase() + text.slice(1) : text;
}
