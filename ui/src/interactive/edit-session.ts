import { FeatureEditTarget, PauseAfterResult, SelectionBoundaryRef, continueBreakpoint, rollback } from '../api';
import { renderVersions } from '../render-versions';
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
  /**
   * The gesture's pause edit (the breakpoint placed after the statement),
   * when it was acknowledged: the session rolls the view back only once the
   * render that edit triggers has settled, so the two never race (see
   * {@link EditSession.begin}). Absent, the rollback goes out at once.
   */
  pause?: Promise<PauseAfterResult | null>;
};

/**
 * Where the session's view stands. `pending`: the gesture's pause edit is
 * still settling, no rollback has been asked for yet. `waiting`: a rollback
 * to the boundary is in flight. `boundary`: the view shows it.
 */
type EditSessionPhase = 'pending' | 'waiting' | 'boundary';

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
  private phase: EditSessionPhase = 'pending';

  get active(): boolean {
    return this.info !== null;
  }

  /**
   * Whether the view is where the dialog's previews belong: at the
   * boundary, or in create mode (no session). Previews and ghosts hold off
   * otherwise — a ghost drawn against a view a render is about to replace
   * only gets cleared with it, and drawn again after: the appear/vanish/
   * appear the gesture used to show on a slow rebuild.
   */
  get settled(): boolean {
    return this.info === null || this.phase === 'boundary';
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

  /**
   * Start the session: roll the view back to just before the statement.
   *
   * The gesture that opens the dialog also pauses the build after the
   * statement — a source edit whose render takes as long as the model does
   * to rebuild. Rolling back at once would race it: the rollback lands,
   * the dialog draws its ghost, the late render replaces the view, and the
   * session has to roll back and draw all over again. With the pause
   * acknowledged (`info.pause`), the rollback instead waits for the render
   * that edit triggers — the one newer than the version the ack was
   * answered against — and goes out once, after it. A pause that changed
   * nothing (a stop already there) or wasn't acknowledged rolls back at
   * once, as before.
   */
  begin(info: EditSessionInfo): void {
    this.info = info;
    this.phase = 'pending';
    if (!info.pause) {
      this.requestRollback();
      return;
    }
    void info.pause.then((outcome) => {
      if (this.info !== info || this.phase !== 'pending') {
        return;
      }
      if (!outcome || !outcome.changed) {
        this.requestRollback();
        return;
      }
      void renderVersions.after(outcome.renderVersion).then(() => {
        if (this.info === info && this.phase === 'pending') {
          this.requestRollback();
        }
      });
    });
  }

  /**
   * Classify an incoming render and keep the view on the boundary. Rollback
   * renders carry the full object list, so the row re-location works on both
   * kinds; a re-located row updates the boundary in place (drift healing).
   *
   * While the pause edit is still settling (`pending`) nothing here asks
   * for a rollback: the renders that land — the double-click's own row
   * rollback, the pause's full render — are what {@link begin} is waiting
   * out, and the one rollback goes out when it is done with them.
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
    if (this.phase === 'pending') {
      return 'waiting';
    }
    if (isRollback && stop === index - 1) {
      this.phase = 'boundary';
      return 'boundary';
    }
    this.requestRollback();
    return 'waiting';
  }

  /** Ask for the view just before the statement; the boundary render answers. */
  private requestRollback(): void {
    if (!this.info) {
      return;
    }
    this.phase = 'waiting';
    rollback(this.info.index - 1);
  }

  /**
   * End the session. The edit dialog opened by placing a breakpoint after the
   * feature; leaving it lifts that one breakpoint — and only it, a stop the
   * user set further down stays pending — so the model runs on (the full
   * render supersedes the pre-statement rollback):
   * - `cancel` (Exit): the UI lifts the breakpoint — nothing else is writing.
   * - `apply`: the apply transform lifts the breakpoint atomically with the
   *   rewrite, so a separate edit here could clobber it — skip it.
   * - `continue`: the breakpoint indicator's own handler lifts it.
   * - `gone`: a code change already dropped the statement; a full render is in
   *   flight, so forcing another would fight the user's editing.
   * - `handoff`: another edit gesture replaces this dialog, and its own pause
   *   edit lifts this stop in the same source edit as it places the new one
   *   (`liftActive` on `pauseAfterStatement`) — lifting it here too would be
   *   a second edit whose unpaused render lands after the new dialog's
   *   rollback and clears the ghost it just drew.
   */
  end(reason: 'apply' | 'cancel' | 'continue' | 'handoff' | 'gone'): void {
    const wasActive = this.info !== null;
    this.info = null;
    this.phase = 'pending';
    if (reason === 'cancel' && wasActive) {
      continueBreakpoint();
    }
  }
}
