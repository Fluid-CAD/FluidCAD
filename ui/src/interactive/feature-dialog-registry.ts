import type { FeatureEditTarget, ParsedFeatureStatement } from '../api';
import type { SceneObjectRender, SubSelection } from '../types';
import type { SelectionModifiers } from '../viewer';
import type { EditSessionInfo } from './edit-session';
import type { FeatureButton } from './create-feature/feature-button';

/** How a dialog closes — the options every create service's `exit()` takes. */
export type FeatureDialogExit = {
  resume?: 'immediate' | 'lazy';
  editEnd?: 'apply' | 'cancel' | 'continue' | 'gone';
};

/** The edit session's row facts, minus the target the dialog is handed separately. */
export type FeatureEditInfo = Omit<EditSessionInfo, 'target'>;

/** The `feature` of a parsed statement (`/feature/parse`), e.g. `'extrude'`. */
export type ParsedFeatureKind = ParsedFeatureStatement['feature'];

/** The parsed statement of one kind. */
export type ParsedFeatureOf<K extends ParsedFeatureKind> = Extract<ParsedFeatureStatement, { feature: K }>;

/** What a connector-gizmo pick carries beyond the connector's id. */
export type ConnectorPickDetail = Pick<SelectionModifiers, 'clientX' | 'clientY' | 'connectorCandidates'>;

/**
 * A part-mode feature dialog as the page sees it: the lifecycle, the state
 * the toolbar and the sketch UI read, the timeline rows it edits, and the
 * pick channels it takes. One dialog owns the viewport at a time — opening
 * one exits the others ({@link FeatureDialogRegistry.exitAll}) — so every
 * channel is claimed only while its dialog is armed for it.
 *
 * Each pick handler answers whether it consumed the pick; the registry hands
 * a pick to its dialogs in registration order and stops at the first taker.
 */
export interface FeatureDialogService {
  /** A stable name: the order test and diagnostics read it. */
  readonly id: string;
  readonly isActive: boolean;
  /** An edit session is open (the viewport shows the pre-statement rollback). */
  readonly isEditing: boolean;
  /** The dialog has the live sketch UI suspended. */
  readonly sketchUISuspended: boolean;
  /**
   * The dialog takes viewport picks right now — the neutral-mode multi-select
   * menu stands aside.
   */
  readonly isPicking: boolean;
  /**
   * The dialog can finish the active sketch (the Finish Sketch flow): while
   * it is armed with the sketch UI suspended, the sketch toolbar stays pinned.
   */
  readonly pinsSketchToolbar: boolean;
  /** While armed, the Sketch button disables. */
  readonly blocksSketchButton: boolean;
  /** The create-group button the Finish Sketch button takes off the bar, or null. */
  readonly toolbarButton: FeatureButton | null;
  /** Timeline row types whose double-click opens this dialog. */
  readonly editRowTypes: readonly string[];
  /** The parsed statement kinds this dialog edits. */
  readonly parsedFeatures: readonly ParsedFeatureKind[];

  enter?(): void;
  exit(opts?: FeatureDialogExit): void;
  /** Open over a parsed statement; `row` is the double-clicked timeline row. */
  enterEdit?(target: FeatureEditTarget, parsed: ParsedFeatureStatement, info: FeatureEditInfo, row: SceneObjectRender): void;
  /** Every scene render (and every active-part replay) lands here. */
  handleSceneRendered(sceneObjects: SceneObjectRender[], stop: number, isRollback: boolean): void;

  /** A face, edge or vertex click — or a click in empty space. */
  handleClick?(shapeId: string | null, sub: SubSelection): boolean;
  /** A timeline row clicked while the dialog is armed. */
  handleTimelinePick?(obj: SceneObjectRender): boolean;
  /** A sketch wire clicked in the 3D view. */
  handleSketchPick?(shapeId: string): boolean;
  /** A `plane()` quad clicked. */
  handlePlanePick?(shapeId: string): boolean;
  /** An `axis()` line clicked. */
  handleAxisPick?(shapeId: string | null, sub: SubSelection): boolean;
  /** A connector gizmo clicked. */
  handleConnectorPick?(connectorId: string | null, pick: ConnectorPickDetail): boolean;
  /** The cursor rests on (or moves along) a face or edge. */
  handleHover?(shapeId: string | null, sub: SubSelection, clientX: number, clientY: number): boolean;
  handleContextMenu?(shapeId: string | null, sub: SubSelection, clientX: number, clientY: number): boolean;
  handleDoubleClick?(shapeId: string | null, sub: SubSelection): boolean;
}

/**
 * The part-mode feature dialogs, in priority order. Registration order is
 * the order every fan-out runs in (scene renders, exits) and the order a
 * pick is offered in. Since one dialog is armed at a time and every channel
 * is gated on its dialog being armed, the order decides nothing between
 * dialogs today — it is pinned so it stays that way on purpose.
 */
export class FeatureDialogRegistry {
  private readonly dialogs: FeatureDialogService[] = [];
  private readonly byId = new Map<string, FeatureDialogService>();

  register(dialog: FeatureDialogService): void {
    if (this.byId.has(dialog.id)) {
      throw new Error(`feature dialog '${dialog.id}' is already registered`);
    }
    this.byId.set(dialog.id, dialog);
    this.dialogs.push(dialog);
  }

  /**
   * Take a dialog out of every chain — one built from data that changed (a
   * custom feature its catalog no longer offers, or offers differently). It
   * is closed first, so it never leaves the viewport armed behind it.
   */
  unregister(id: string): void {
    const dialog = this.byId.get(id);
    if (!dialog) {
      return;
    }
    dialog.exit();
    this.byId.delete(id);
    this.dialogs.splice(this.dialogs.indexOf(dialog), 1);
  }

  get all(): readonly FeatureDialogService[] {
    return this.dialogs;
  }

  get ids(): string[] {
    return this.dialogs.map(d => d.id);
  }

  get(id: string): FeatureDialogService | null {
    return this.byId.get(id) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Close every dialog but `except` — what a dialog opening does, so one
   * dialog owns the viewport at a time. A dialog's own `onEnter` runs before
   * it arms, so it may name itself or not.
   */
  exitAll(opts: { except?: string } = {}): void {
    for (const dialog of this.dialogs) {
      if (dialog.id !== opts.except) {
        dialog.exit();
      }
    }
  }

  /**
   * Continue left the paused build: open edit sessions end without their
   * cancel-restore rollback, since the full render Continue triggers
   * supersedes it.
   */
  continueEdits(): void {
    for (const dialog of this.dialogs) {
      if (dialog.isEditing) {
        dialog.exit({ editEnd: 'continue' });
      }
    }
  }

  handleSceneRendered(sceneObjects: SceneObjectRender[], stop: number, isRollback: boolean): void {
    for (const dialog of this.dialogs) {
      dialog.handleSceneRendered(sceneObjects, stop, isRollback);
    }
  }

  // ---------------------------------------------------------------------------
  // State the toolbar and the sketch UI read
  // ---------------------------------------------------------------------------

  /** A dialog that disables the Sketch button is open. */
  get blocksSketchButton(): boolean {
    return this.dialogs.some(d => d.blocksSketchButton && d.isActive);
  }

  /**
   * A sketch-finishing dialog is armed with the sketch UI suspended. An edit
   * session suspends unconditionally — its rollback owns the view, no sketch
   * is being finished — so it never pins.
   */
  get pinsSketchToolbar(): boolean {
    return this.dialogs.some(d => d.pinsSketchToolbar && d.isActive && !d.isEditing && d.sketchUISuspended);
  }

  /** Some dialog has an edit session open. */
  get isEditing(): boolean {
    return this.dialogs.some(d => d.isEditing);
  }

  get sketchUISuspended(): boolean {
    return this.dialogs.some(d => d.sketchUISuspended);
  }

  get isPicking(): boolean {
    return this.dialogs.some(d => d.isPicking);
  }

  /** The create-group buttons, in registration order. */
  get toolbarButtons(): FeatureButton[] {
    return this.dialogs.flatMap(d => (d.toolbarButton ? [d.toolbarButton] : []));
  }

  // ---------------------------------------------------------------------------
  // Timeline edits
  // ---------------------------------------------------------------------------

  /** Some dialog edits rows of this type. */
  editsRowType(type: string): boolean {
    return this.dialogs.some(d => d.editRowTypes.includes(type));
  }

  /** The dialog that edits statements parsed as `feature`, or null. */
  forParsedFeature(feature: ParsedFeatureKind): FeatureDialogService | null {
    return this.dialogs.find(d => d.parsedFeatures.includes(feature) && d.enterEdit) ?? null;
  }

  /**
   * The dialog that edits this parsed statement, or null. A built-in kind
   * names its dialog; every custom feature parses as `'custom'`, so one is
   * matched by its id too — a custom feature's id is the type its timeline
   * row carries, which is the row type its dialog edits.
   */
  forStatement(parsed: ParsedFeatureStatement): FeatureDialogService | null {
    if (parsed.feature !== 'custom') {
      return this.forParsedFeature(parsed.feature);
    }
    return this.dialogs.find(d => d.parsedFeatures.includes('custom') && d.editRowTypes.includes(parsed.id)
      && d.enterEdit) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Pick routing: the first dialog that consumes the pick wins.
  // ---------------------------------------------------------------------------

  routeClick(shapeId: string | null, sub: SubSelection): boolean {
    return this.dialogs.some(d => d.handleClick?.(shapeId, sub) === true);
  }

  routeTimelinePick(obj: SceneObjectRender): boolean {
    return this.dialogs.some(d => d.handleTimelinePick?.(obj) === true);
  }

  routeSketchPick(shapeId: string): boolean {
    return this.dialogs.some(d => d.handleSketchPick?.(shapeId) === true);
  }

  routePlanePick(shapeId: string): boolean {
    return this.dialogs.some(d => d.handlePlanePick?.(shapeId) === true);
  }

  routeAxisPick(shapeId: string | null, sub: SubSelection): boolean {
    return this.dialogs.some(d => d.handleAxisPick?.(shapeId, sub) === true);
  }

  routeConnectorPick(connectorId: string | null, pick: ConnectorPickDetail): boolean {
    return this.dialogs.some(d => d.handleConnectorPick?.(connectorId, pick) === true);
  }

  routeHover(shapeId: string | null, sub: SubSelection, clientX: number, clientY: number): boolean {
    return this.dialogs.some(d => d.handleHover?.(shapeId, sub, clientX, clientY) === true);
  }

  routeContextMenu(shapeId: string | null, sub: SubSelection, clientX: number, clientY: number): boolean {
    return this.dialogs.some(d => d.handleContextMenu?.(shapeId, sub, clientX, clientY) === true);
  }

  routeDoubleClick(shapeId: string | null, sub: SubSelection): boolean {
    return this.dialogs.some(d => d.handleDoubleClick?.(shapeId, sub) === true);
  }
}

/** The members every wrapped create-feature service already has. */
export type DialogServiceCore = {
  readonly isActive: boolean;
  readonly isEditing: boolean;
  readonly sketchUISuspended: boolean;
  enter?(): void;
  exit(opts?: FeatureDialogExit): void;
  handleSceneRendered(sceneObjects: SceneObjectRender[], stop: number, isRollback: boolean): void;
  handleClick?(shapeId: string | null, sub: SubSelection): void;
  handleTimelinePick?(obj: SceneObjectRender): boolean;
  handleSketchPick?(shapeId: string): boolean;
  handlePlanePick?(shapeId: string): void;
  handleConnectorPick?(connectorId: string | null, pick?: ConnectorPickDetail): void;
  handleHover?(shapeId: string | null, sub: SubSelection, clientX: number, clientY: number): void;
  handleContextMenu?(shapeId: string | null, sub: SubSelection, clientX: number, clientY: number): void;
  handleDoubleClick?(shapeId: string | null, sub: SubSelection): void | Promise<void>;
};

/** A claim reads the service's own state: is this channel armed right now? */
export type DialogClaim<S> = (service: S) => boolean;

export type ServiceDialogOptions<S extends DialogServiceCore, K extends ParsedFeatureKind> = {
  /** The timeline rows this dialog edits, and how a parsed statement opens it. */
  edit?: {
    rowTypes: readonly string[];
    kind: K;
    open: (target: FeatureEditTarget, parsed: ParsedFeatureOf<K>, info: FeatureEditInfo, row: SceneObjectRender) => void;
  };
  /** The create-group button the Finish Sketch button hides. */
  toolbarButton?: FeatureButton;
  /** See {@link FeatureDialogService.pinsSketchToolbar}. */
  pinsSketchToolbar?: boolean;
  /** See {@link FeatureDialogService.isPicking}. */
  picking: DialogClaim<S>;
  /**
   * The viewport channels the service takes, each with the state that arms
   * it; a claimed pick runs the service's own handler. An axis-line pick
   * goes to the service's `handleClick`, as it always has.
   */
  claims?: {
    click?: DialogClaim<S>;
    axis?: DialogClaim<S>;
    plane?: DialogClaim<S>;
    connector?: DialogClaim<S>;
    hover?: DialogClaim<S>;
    contextMenu?: DialogClaim<S>;
    doubleClick?: DialogClaim<S>;
  };
  /** The service answers timeline picks itself (`handleTimelinePick`). */
  timelinePicks?: boolean;
  /** The service answers sketch-wire picks itself (`handleSketchPick`). */
  sketchPicks?: boolean;
};

/**
 * The thin adapter that registers an existing create-feature service: it
 * reads the service's own state and calls its own handlers, and adds only
 * what the service never had to say — which channels arm it and which rows
 * it edits.
 */
export class ServiceDialog<S extends DialogServiceCore, K extends ParsedFeatureKind = ParsedFeatureKind>
implements FeatureDialogService {
  readonly editRowTypes: readonly string[];
  readonly parsedFeatures: readonly ParsedFeatureKind[];
  readonly toolbarButton: FeatureButton | null;
  readonly pinsSketchToolbar: boolean;
  readonly blocksSketchButton = true;

  constructor(
    readonly id: string,
    private readonly service: S,
    private readonly options: ServiceDialogOptions<S, K>,
  ) {
    this.editRowTypes = options.edit?.rowTypes ?? [];
    this.parsedFeatures = options.edit ? [options.edit.kind] : [];
    this.toolbarButton = options.toolbarButton ?? null;
    this.pinsSketchToolbar = options.pinsSketchToolbar === true;
  }

  get isActive(): boolean {
    return this.service.isActive;
  }

  get isEditing(): boolean {
    return this.service.isEditing;
  }

  get sketchUISuspended(): boolean {
    return this.service.sketchUISuspended;
  }

  get isPicking(): boolean {
    return this.options.picking(this.service);
  }

  enter(): void {
    this.service.enter?.();
  }

  exit(opts?: FeatureDialogExit): void {
    this.service.exit(opts);
  }

  enterEdit(target: FeatureEditTarget, parsed: ParsedFeatureStatement, info: FeatureEditInfo, row: SceneObjectRender): void {
    const edit = this.options.edit;
    if (!edit || parsed.feature !== edit.kind) {
      return;
    }
    edit.open(target, parsed as ParsedFeatureOf<K>, info, row);
  }

  handleSceneRendered(sceneObjects: SceneObjectRender[], stop: number, isRollback: boolean): void {
    this.service.handleSceneRendered(sceneObjects, stop, isRollback);
  }

  handleClick(shapeId: string | null, sub: SubSelection): boolean {
    if (!this.claims('click')) {
      return false;
    }
    this.service.handleClick?.(shapeId, sub);
    return true;
  }

  handleAxisPick(shapeId: string | null, sub: SubSelection): boolean {
    if (!this.claims('axis')) {
      return false;
    }
    this.service.handleClick?.(shapeId, sub);
    return true;
  }

  handlePlanePick(shapeId: string): boolean {
    if (!this.claims('plane')) {
      return false;
    }
    this.service.handlePlanePick?.(shapeId);
    return true;
  }

  handleConnectorPick(connectorId: string | null, pick: ConnectorPickDetail): boolean {
    if (!this.claims('connector')) {
      return false;
    }
    this.service.handleConnectorPick?.(connectorId, pick);
    return true;
  }

  handleHover(shapeId: string | null, sub: SubSelection, clientX: number, clientY: number): boolean {
    if (!this.claims('hover')) {
      return false;
    }
    this.service.handleHover?.(shapeId, sub, clientX, clientY);
    return true;
  }

  handleContextMenu(shapeId: string | null, sub: SubSelection, clientX: number, clientY: number): boolean {
    if (!this.claims('contextMenu')) {
      return false;
    }
    this.service.handleContextMenu?.(shapeId, sub, clientX, clientY);
    return true;
  }

  handleDoubleClick(shapeId: string | null, sub: SubSelection): boolean {
    if (!this.claims('doubleClick')) {
      return false;
    }
    void this.service.handleDoubleClick?.(shapeId, sub);
    return true;
  }

  handleTimelinePick(obj: SceneObjectRender): boolean {
    return this.options.timelinePicks === true && this.service.handleTimelinePick?.(obj) === true;
  }

  handleSketchPick(shapeId: string): boolean {
    return this.options.sketchPicks === true && this.service.handleSketchPick?.(shapeId) === true;
  }

  private claims(channel: keyof NonNullable<ServiceDialogOptions<S, K>['claims']>): boolean {
    return this.options.claims?.[channel]?.(this.service) === true;
  }
}
