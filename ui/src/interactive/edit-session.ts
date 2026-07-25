import { FeatureEditTarget, SelectionBoundaryRef, clearBreakpoints, rollback } from '../api';
import { SceneObjectRender } from '../types';

/** What starts an edit session: the statement, its row, and its exact text. */
export type EditSessionInfo = {
  target: FeatureEditTarget;
  /** Timeline row of the edited feature — the rollback/selection boundary. */
  index: number;
  /** Scene object type at that row (`cut`, `extrude`, …). */
  type: string;
  /** Chain text at dialog-open; the transform refuses when it drifted. */
  expectedStatement: string;
};

/** What an incoming render means for the session — see {@link EditSession.onSceneRendered}. */
export type EditSessionRenderState =
  | 'inactive'
  /** The edited statement's row is gone — end the session with a toast. */
  | 'gone'
  /** The view sits at the pre-statement boundary — refresh options/seeds/highlights. */
  | 'boundary'
  /** The view moved off the boundary; a re-asserting rollback was issued. */
  | 'waiting';

/**
 * The view-state half of an edit dialog: while a statement is being edited,
 * the viewport shows the model rolled back to just BEFORE it — the world its
 * arguments see at build time, where consumed sketches and removed faces are
 * visible and pickable. The session re-asserts that rollback across incoming
 * renders (the breakpoint render racing dialog-open, live-updates) and heals
 * index drift by re-locating the statement's row by call site.
 */
export class EditSession {
  private info: EditSessionInfo | null = null;

  get active(): boolean {
    return this.info !== null;
  }

  get target(): FeatureEditTarget | null {
    return this.info?.target ?? null;
  }

  get expectedStatement(): string | undefined {
    return this.info?.expectedStatement;
  }

  /** The `before` payload for selection queries and edit applies. */
  get boundary(): SelectionBoundaryRef | null {
    if (!this.info) {
      return null;
    }
    return {
      index: this.info.index,
      type: this.info.type,
      line: this.info.target.line,
      column: this.info.target.column,
    };
  }

  /** Start the session: roll the view back to just before the statement. */
  begin(info: EditSessionInfo): void {
    this.info = info;
    rollback(info.index - 1);
  }

  /**
   * Classify an incoming render and keep the view on the boundary. Rollback
   * renders carry the full object list, so the row re-location works on both
   * kinds; a re-located row updates the boundary in place (drift healing).
   */
  onSceneRendered(result: SceneObjectRender[], stop: number, isRollback: boolean): EditSessionRenderState {
    if (!this.info) {
      return 'inactive';
    }
    const target = this.info.target;
    const index = result.findIndex(o => o.type === this.info!.type
      && o.sourceLocation?.line === target.line
      && o.sourceLocation?.column === target.column
      && o.sourceLocation?.filePath === target.filePath);
    if (index < 0) {
      return 'gone';
    }
    this.info.index = index;
    if (isRollback && stop === index - 1) {
      return 'boundary';
    }
    rollback(index - 1);
    return 'waiting';
  }

  /**
   * End the session. The edit dialog opened by placing a breakpoint after the
   * feature; leaving it clears that breakpoint so the model rebuilds to its
   * tip (the full render supersedes the pre-statement rollback):
   * - `cancel` (Exit): the UI clears the breakpoint — nothing else is writing.
   * - `apply`: the apply transform strips the breakpoint atomically with the
   *   rewrite, so a separate clear here could clobber the edit — skip it.
   * - `continue`: the breakpoint indicator's own handler clears.
   * - `gone`: a code change already dropped the statement; a full render is in
   *   flight, so forcing another would fight the user's editing.
   */
  end(reason: 'apply' | 'cancel' | 'continue' | 'gone'): void {
    const wasActive = this.info !== null;
    this.info = null;
    if (reason === 'cancel' && wasActive) {
      clearBreakpoints();
    }
  }
}
