import {
  applyHole, applyHoleEdit, featureGhostScope, fetchFeatureGhostResult, fetchFeatureSources, FeatureEditTarget, GhostSolid,
  HoleApplyOptions, HoleEditOptions, HoleGhostRequest, ParsedFeatureStatement, SourceSlotRef,
} from '../../../api';
import { SceneObjectRender, SourceLocation, SubSelection } from '../../../types';
import { SelectedEntity, SelectionModifiers, Viewer } from '../../../viewer';
import { Navbar } from '../../../ui/navbar';
import { EditSession, EditSessionInfo } from '../../edit-session';
import { SolidPickSelection } from '../../solid-pick';
import { ConnectorPickMenu } from '../../assembly-mate/connector-pick-menu';
import { HolePanel } from './hole-panel';
import { builtHoleFrames, HolePlacements } from './hole-placements';
import { FeatureButton } from '../feature-button';
import { ApplyRunner } from '../apply-runner';
import { FeatureGhostOverlay } from '../feature-ghost';
import { ConnectorGhostOverlay } from '../connector-ghost';
import { AnchorSuggestions } from '../anchor-suggestions';
import { SketchUISuspender } from '../sketch-suspender';
import { refreshScopeVariables } from '../option-relabeler';
import { collectSolidTargets, SolidTargetOption } from '../solid-targets';
import { collectSketchProfiles } from '../sketch-profiles';
import { ConnectorOptions } from '../connector-options';
import { enclosingPartLocOf, ScopeTargetList, scopePartLocation } from '../scope-targets';
import { iconUrl } from '../../../ui/icon-url';

/**
 * The Hole dialog on the create rails: fastener holes cut at one or more
 * placements. While the Placements slot is armed the viewport offers three
 * kinds of pick at once — connector gizmos (an existing connector), sketch
 * vertex dots (a point exported from its sketch) and face/edge anchor
 * suggestions (a connector created on the spot inside a part, the bare
 * anchor expression outside one); timeline connector rows land there too.
 * The Scope slot takes whole-solid picks like the other boolean dialogs.
 * Applying writes `hole(<size>, <placements…>)` plus its chains; the
 * re-render is the preview and editor undo the rollback.
 */
export class HoleFeatureService {
  private panel: HolePanel;
  private button: FeatureButton;
  private armed = false;
  private available = false;
  /** Scene-wide solid count — the button's availability. */
  private targetOptions: SolidTargetOption[] = [];
  private placements = new HolePlacements();
  /** The `.scope(…)` targets, part-restricted whole-solid picks. */
  private scope = new ScopeTargetList();
  /** The edited statement's enclosing part — the scope picker's restriction. */
  private editPartLoc: SourceLocation | null = null;
  private sceneObjects: SceneObjectRender[] = [];
  private sceneSketchActive = false;
  /** Statement being edited in place (timeline double-click), or null. */
  private editTarget: FeatureEditTarget | null = null;
  /** View-state half of edit mode: pre-statement rollback + boundary. */
  private session = new EditSession();
  /** How many placement arguments the edited statement had — an untouched list keeps them. */
  private editPlacementCount = 0;
  /** The statement's current `.scope(…)` sources, for the keep chips' ghost. */
  private sourceScope: SourceSlotRef[] | null = null;
  /** The translucent tools the current values would cut, drawn in the view. */
  private ghost: FeatureGhostOverlay;
  private connectorGhost: ConnectorGhostOverlay;
  private suggestions: AnchorSuggestions;
  private pickMenu: ConnectorPickMenu;
  private sketchUI: SketchUISuspender;
  private solidPick: SolidPickSelection;
  private runner: ApplyRunner<HoleApplyOptions | HoleEditOptions>;

  constructor(
    container: HTMLElement,
    private viewer: Viewer,
    private navbar: Navbar,
    private hooks: {
      onEnter?: () => void;
      /** Armed or disarmed — lets the Sketch button owner re-check `isActive`. */
      onActiveChange?: () => void;
      /** An edit session armed while a sketch is edited — release the sketch UI. */
      onSuspendSketchUI?: () => void;
      /** The suspension ended without an apply — restore the sketch UI. */
      onResumeSketchUI?: () => void;
    } = {},
  ) {
    // Hole joins the create group as another contributor — constructed after
    // Rib in main.ts, so the button lands at the end of the row.
    const group = navbar.getGroup('create') ?? navbar.addGroup('create', { visible: false, immune: true });
    this.button = new FeatureButton(group, {
      icon: iconUrl('hole'),
      label: 'Hole',
      tip: 'Hole at connectors, sketch vertices or face centres',
      ariaLabel: 'Hole at connectors, sketch vertices or face centres',
    });
    this.button.onClick = () => {
      if (this.armed) {
        this.exit();
      } else {
        this.enter();
      }
    };
    this.sketchUI = new SketchUISuspender(viewer, hooks);
    this.solidPick = new SolidPickSelection(viewer, { multiple: true });
    this.ghost = new FeatureGhostOverlay(viewer);
    this.connectorGhost = new ConnectorGhostOverlay(viewer);
    this.pickMenu = new ConnectorPickMenu(container);
    this.suggestions = new AnchorSuggestions(viewer, this.connectorGhost, {
      isTaken: (key, index) => this.placements.hasAnchor(key, index),
      purpose: 'hole',
    });
    this.suggestions.onLock = (locked) => {
      this.placements.toggleAnchor(locked);
      this.panel.setMessage(null);
      this.refreshPlacements();
      this.runner.schedulePreview();
    };
    this.suggestions.onRefuse = (reason) => this.panel.setMessage(reason ?? 'A hole cannot start on that shape.');

    this.panel = new HolePanel(container);
    this.panel.onApply = () => void this.runner.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.runner.schedulePreview();
    };
    this.panel.onRemovePlacement = (index) => {
      this.placements.removeAt(index);
      this.panel.setMessage(null);
      this.refreshPlacements();
      this.suggestions.refresh();
      this.runner.schedulePreview();
    };
    this.panel.onRemoveScope = (index) => {
      this.scope.removeAt(index);
      this.panel.setMessage(null);
      this.refreshScope();
      this.runner.schedulePreview();
    };
    this.panel.onArmedSlotChange = () => this.syncViewport();

    this.runner = new ApplyRunner({
      panel: this.panel,
      isArmed: () => this.armed,
      build: () => this.editTarget ? this.buildEditRequest() : this.buildRequest(),
      send: (request, extras) => this.editTarget
        ? applyHoleEdit(this.editTarget, { ...(request as HoleEditOptions), ...extras })
        : applyHole({ ...(request as HoleApplyOptions), ...extras }),
      onApplied: () => this.exit(this.editTarget ? { editEnd: 'apply' } : { resume: 'lazy' }),
      failMessage: () => this.editTarget ? 'Could not apply the edit.' : 'Could not apply the hole.',
      surfacePreviewReasons: () => this.editTarget !== null,
      ghost: {
        fetch: (_request, signal) => this.fetchGhost(signal),
        apply: (solids) => {
          if (solids) {
            this.ghost.set(solids, 'remove');
          } else {
            this.ghost.clear();
          }
        },
      },
    });
  }

  get isActive(): boolean {
    return this.armed;
  }

  /** The toolbar button, hidden by the Finish Sketch button during sketch mode. */
  get toolbarButton(): FeatureButton {
    return this.button;
  }

  /** An edit session is open (the viewport shows the pre-statement rollback). */
  get isEditing(): boolean {
    return this.editTarget !== null;
  }

  /** The armed dialog owns viewport clicks, hover included. */
  get isPicking(): boolean {
    return this.armed;
  }

  /** True while an edit session has suspended sketch editing. */
  get sketchUISuspended(): boolean {
    return this.sketchUI.suspended;
  }

  /**
   * Every render lands here. An open edit session owns the view: it keeps
   * the viewport rolled back to just before the edited statement, and at
   * that boundary the offered connectors and solids are the pre-statement
   * scene's — exactly what the hole's arguments can reference.
   */
  handleSceneRendered(sceneObjects: SceneObjectRender[], stop: number, isRollback: boolean): void {
    const state = this.session.onSceneRendered(sceneObjects, stop, isRollback);
    if (state === 'inactive') {
      this.update(isRollback ? [] : sceneObjects);
      return;
    }
    if (!this.armed) {
      this.session.end('gone');
      return;
    }
    if (state === 'gone') {
      this.exit({ editEnd: 'gone' });
      return;
    }
    if (state === 'waiting') {
      this.ghost.clear();
      if (!isRollback) {
        this.sourceScope = null;
      }
      return;
    }
    this.ghost.clear();
    this.sceneObjects = sceneObjects;
    this.targetOptions = collectSolidTargets(sceneObjects);
    // The edited hole's row sits past the stop, still carrying the frames its
    // build cut at — the kept arguments' ghost frames.
    const editedRow = sceneObjects[this.session.boundary?.index ?? -1];
    this.placements.setScene(sceneObjects, { resolveKeeps: true, builtFrames: builtHoleFrames(editedRow) });
    this.scope.setScene(sceneObjects, this.scopePartLoc(), { resolveKeeps: true });
    if (!this.sourceScope) {
      void this.loadEditSources();
    }
    this.syncViewport();
    this.refreshPlacements();
    this.refreshScope();
    this.runner.schedulePreview();
  }

  /**
   * Scene re-rendered: recompute the offered solids and button visibility.
   * The dialog stays open across re-renders; picked vertices and anchors
   * die with the old scene's shape ids and are dropped with a message.
   */
  update(sceneObjects: SceneObjectRender[]): void {
    this.sceneObjects = sceneObjects;
    this.targetOptions = collectSolidTargets(sceneObjects);
    this.sceneSketchActive = collectSketchProfiles(sceneObjects)[0]?.kind === 'active';
    // A hole needs a solid to cut — no solids, no button.
    this.available = this.targetOptions.length > 0;
    this.navbar.setGroupVisible('create', this.available, 'hole');
    this.syncButton();
    if (!this.armed) {
      return;
    }
    if (!this.available) {
      this.exit({ resume: 'lazy' });
      return;
    }
    this.ghost.clear();
    this.suggestions.clear();
    if (this.sceneSketchActive) {
      this.sketchUI.suspend();
    }
    const { dropped } = this.placements.setScene(sceneObjects);
    if (dropped > 0) {
      this.panel.setMessage('The model changed. Pick the dropped placements again.');
    }
    this.scope.setScene(sceneObjects, this.scopePartLoc());
    this.syncViewport();
    this.refreshPlacements();
    this.refreshScope();
    this.runner.schedulePreview();
  }

  /**
   * Open the dialog over an existing hole statement (timeline double-click).
   * The session rolls the viewport back to just before the statement; the
   * placements slot starts on one kept chip per argument (a connector
   * argument becomes its connector chip once the boundary scene offers
   * it), the scope slot on one kept chip per `.scope(…)` argument. Apply
   * rewrites the statement in place.
   */
  enterEdit(
    target: FeatureEditTarget,
    parsed: Extract<ParsedFeatureStatement, { feature: 'hole' }>,
    info: Omit<EditSessionInfo, 'target'>,
  ): void {
    if (this.armed) {
      this.exit();
    }
    this.hooks.onEnter?.();
    this.armed = true;
    this.editTarget = target;
    this.sourceScope = null;
    this.editPartLoc = enclosingPartLocOf(target, this.sceneObjects);
    this.editPlacementCount = parsed.placementTexts.length;
    this.placements.setScene(this.sceneObjects);
    this.placements.seedKeeps(parsed, target.filePath);
    this.scope.seedKeeps(parsed, target.filePath);
    this.scope.setScene(this.sceneObjects, this.scopePartLoc());
    this.syncButton();
    this.sketchUI.suspend();
    this.session.begin({ ...info, target });
    void this.loadEditSources();
    void this.refreshScopeVariables();
    this.panel.showEdit(parsed);
    this.syncViewport();
    this.refreshPlacements();
    this.refreshScope();
    this.runner.schedulePreview();
  }

  enter(): void {
    if (this.armed) {
      return;
    }
    this.session.end('continue');
    this.hooks.onEnter?.();
    this.armed = true;
    this.placements.clear();
    this.placements.setScene(this.sceneObjects);
    this.scope.clear();
    this.editPartLoc = null;
    this.editPlacementCount = 0;
    // The scope picker's pool for this scene — a timeline or face pick can
    // land before any render re-syncs it.
    this.scope.setScene(this.sceneObjects, this.scopePartLoc());
    // Placing holes means looking at the whole model, not down the active
    // sketch plane — leave sketch editing right away.
    if (this.sceneSketchActive) {
      this.sketchUI.suspend();
    }
    this.syncButton();
    void this.refreshScopeVariables();
    this.panel.show();
    this.syncViewport();
    this.refreshPlacements();
    this.refreshScope();
    this.runner.schedulePreview();
  }

  /**
   * `resume: 'lazy'` re-enables sketch editing without forcing the mode
   * transition — for apply-success and scene-driven exits, where a render
   * follows. User cancels default to `'immediate'`.
   */
  exit(opts: { resume?: 'immediate' | 'lazy'; editEnd?: 'apply' | 'cancel' | 'continue' | 'gone' } = {}): void {
    if (!this.armed) {
      return;
    }
    const hadSession = this.session.active;
    this.session.end(opts.editEnd ?? 'cancel');
    if (hadSession) {
      opts = { ...opts, resume: 'lazy' };
    }
    this.armed = false;
    this.editTarget = null;
    this.sourceScope = null;
    this.placements.clear();
    this.scope.clear();
    this.editPartLoc = null;
    this.pickMenu.close();
    this.suggestions.setEnabled(false);
    this.connectorGhost.clear();
    this.solidPick.set([]);
    this.viewer.pickVertices = false;
    this.viewer.setVertexPickScope(null);
    this.viewer.setConnectorPicking(false);
    this.viewer.clearHighlight();
    this.syncButton();
    this.runner.cancelPreview();
    this.ghost.clear();
    this.panel.hide();
    this.sketchUI.resume((opts.resume ?? 'immediate') === 'immediate');
  }

  /**
   * A timeline row was clicked while the dialog is armed: a connector row
   * toggles it in the placements, a solid row toggles it in the scope. Every
   * matching row is consumed so the timeline's default rollback can't close
   * the dialog mid-flow.
   */
  handleTimelinePick(obj: SceneObjectRender): boolean {
    if (!this.armed) {
      return false;
    }
    if (obj.type === 'connector') {
      if (obj.id != null) {
        this.pickConnector(obj.id);
      }
      return true;
    }
    const option = this.scope.optionForRow(obj);
    if (!option) {
      return false;
    }
    this.toggleScope(option);
    return true;
  }

  /**
   * A connector gizmo was clicked — several gizmos under the cursor open the
   * "which connector?" popover first. Lands in the placements whichever slot
   * is armed: a connector is only ever a placement.
   */
  handleConnectorPick(
    connectorId: string | null,
    pick?: Pick<SelectionModifiers, 'clientX' | 'clientY' | 'connectorCandidates'>,
  ): void {
    if (!this.armed || !connectorId) {
      return;
    }
    this.pickMenu.close();
    const candidates = pick?.connectorCandidates;
    if (candidates && candidates.length > 1 && pick?.clientX !== undefined && pick.clientY !== undefined) {
      const items = candidates.map(candidate => ({
        label: ConnectorOptions.forId(candidate.connectorId, this.placements.options)?.label ?? candidate.connectorId,
        onHover: () => this.viewer.setHoveredConnector(candidate.connectorId),
        onPick: () => this.pickConnector(candidate.connectorId),
      }));
      this.pickMenu.show(pick.clientX, pick.clientY, items, () => this.viewer.setHoveredConnector(null));
      return;
    }
    this.pickConnector(connectorId);
  }

  /**
   * Routes viewer clicks while the dialog is armed. Placements armed: a
   * vertex dot toggles as a sketch point, a face/edge locks its anchor
   * suggestion. Scope armed: any face or edge click toggles the owning
   * solid whole (the boolean dialogs' idiom).
   */
  handleClick(shapeId: string | null, sub: SubSelection): void {
    if (!this.armed || !shapeId || !sub) {
      return;
    }
    if (sub.type === 'vertex') {
      if (this.panel.armedSlot !== 'placements') {
        this.panel.armSlot('placements');
      }
      this.placements.toggleVertex({ shapeId, sub });
      this.panel.setMessage(null);
      this.refreshPlacements();
      this.runner.schedulePreview();
      return;
    }
    if (sub.type !== 'face' && sub.type !== 'edge') {
      return;
    }
    if (this.panel.armedSlot === 'placements') {
      this.suggestions.handleClick(shapeId, sub);
      return;
    }
    const option = this.scope.optionForShapeId(shapeId);
    if (!option) {
      this.panel.setMessage('That shape cannot scope the hole — pick a solid in the same part.');
      return;
    }
    this.toggleScope(option);
  }

  /** Viewer hover: the anchor suggestion rail floats a face/edge's anchor while placements are armed. */
  handleHover(shapeId: string | null, sub: SubSelection, clientX: number, clientY: number): void {
    if (!this.armed || this.panel.armedSlot !== 'placements') {
      return;
    }
    this.suggestions.handleHover(shapeId, sub, clientX, clientY);
  }

  private pickConnector(connectorId: string): void {
    const option = ConnectorOptions.forId(connectorId, this.placements.options);
    if (!option) {
      this.panel.setMessage('That connector cannot be referenced — only connector() features and their copies can be picked.');
      return;
    }
    if (this.panel.armedSlot !== 'placements') {
      this.panel.armSlot('placements');
    }
    this.placements.toggleConnector(option);
    this.panel.setMessage(null);
    this.refreshPlacements();
    this.runner.schedulePreview();
  }

  private toggleScope(option: SolidTargetOption): void {
    this.scope.toggle(option);
    this.panel.setMessage(null);
    this.refreshScope();
    this.runner.schedulePreview();
  }

  /**
   * The part the scope picker is restricted to: the edited statement's own
   * enclosing part, or — create mode — the part the first placement lives
   * in, else the timeline's active part.
   */
  private scopePartLoc(): SourceLocation | null {
    if (this.editTarget) {
      return this.editPartLoc;
    }
    const first = this.placements.entries.find(item => item.kind === 'connector');
    const primary = first && first.kind === 'connector'
      ? { filePath: first.option.filePath, line: first.option.line }
      : null;
    return scopePartLocation(primary, this.sceneObjects);
  }

  private async refreshScopeVariables(): Promise<void> {
    const line = this.editTarget?.line ?? null;
    await refreshScopeVariables(line, this.panel,
      () => this.armed && (this.editTarget?.line ?? null) === line);
  }

  /** The statement's current sources: connector placements become chips, the scope keeps its ghost. */
  private async loadEditSources(): Promise<void> {
    const boundary = this.session.boundary;
    if (!boundary) {
      return;
    }
    const result = await fetchFeatureSources(boundary);
    if (!this.editTarget || this.session.boundary?.index !== boundary.index) {
      return;
    }
    if (result.ok && result.feature === 'hole') {
      this.placements.resolveSources(result.placements);
      this.sourceScope = result.scope;
    } else {
      this.sourceScope = [];
    }
    this.refreshPlacements();
    this.runner.schedulePreview();
  }

  /**
   * The viewport channels follow the armed slot. Placements: connector
   * gizmos revealed and pickable, every visible vertex dot offered, and
   * faces/edges hovered for anchor suggestions — all live at once. Scope:
   * plain face/edge picks that select the owning solid.
   */
  private syncViewport(): void {
    if (!this.armed) {
      return;
    }
    const placementsArmed = this.panel.armedSlot === 'placements';
    this.viewer.pickFilter = 'all';
    this.viewer.pickSketchWires = false;
    this.viewer.setConnectorPicking(placementsArmed);
    this.viewer.setVertexPickScope(null);
    this.viewer.pickVertices = placementsArmed;
    this.suggestions.setEnabled(placementsArmed);
    if (!placementsArmed) {
      this.connectorGhost.clear();
    }
    this.refreshHighlight();
  }

  /** Repaint the placement chips and their viewport echo. */
  private refreshPlacements(): void {
    if (!this.armed) {
      return;
    }
    const count = this.placements.entries.length;
    const prompt = count === 0
      ? 'Click a connector, a sketch vertex, or a face or round edge in 3D'
      : `Click more places, or Apply now to cut ${count} hole${count === 1 ? '' : 's'}`;
    this.panel.setPlacements(this.placements.chips(), prompt);
    this.refreshHighlight();
  }

  private refreshScope(): void {
    if (!this.armed) {
      return;
    }
    this.panel.setScope(this.scope.chips());
    this.refreshHighlight();
  }

  /** Picked connectors enlarged, picked vertex dots and anchor faces lit, scope solids whole. */
  private refreshHighlight(): void {
    if (!this.armed) {
      return;
    }
    this.viewer.setPickedConnectors(this.placements.connectorIds());
    const entities: SelectedEntity[] = [...this.placements.vertexEntities(), ...this.placements.anchorEntities()];
    this.solidPick.set(this.scope.shapeIds());
    this.solidPick.refreshHighlight({ entities });
  }

  private syncButton(): void {
    this.button.setActive(this.armed);
    this.button.setVisible(this.available);
    this.hooks.onActiveChange?.();
  }

  /**
   * The live geometry for the current form state: the tools the values
   * describe, drawn at the placements' frames the dialog already knows. A
   * kept argument the dialog cannot place means no ghost.
   */
  private async fetchGhost(signal: AbortSignal): Promise<GhostSolid[] | null> {
    const values = this.panel.values();
    if ('error' in values) {
      return null;
    }
    const frames = this.placements.frames();
    if (!frames || frames.length === 0) {
      return null;
    }
    const numbers = this.panel.ghostNumbers();
    if (!numbers) {
      return null;
    }
    const scope = this.ghostScope();
    if (!scope) {
      return null;
    }
    const request: HoleGhostRequest = {
      feature: 'hole',
      frames: frames.map(frame => ({
        origin: [frame.origin.x, frame.origin.y, frame.origin.z],
        normal: [frame.normal.x, frame.normal.y, frame.normal.z],
      })),
      diameter: numbers.diameter,
      depth: values.depth,
      tipAngle: values.tipAngle,
      counterbore: numbers.counterbore,
      countersink: numbers.countersink,
      scope,
      exclude: this.editTarget
        ? { filePath: this.editTarget.filePath, line: this.editTarget.line }
        : undefined,
    };
    return (await fetchFeatureGhostResult(request, featureGhostScope(this.editTarget), signal)).solids;
  }

  /** The scope solids by call site (a kept argument the sources query could not place means no ghost). */
  private ghostScope(): { filePath: string; line: number }[] | null {
    const refs: { filePath: string; line: number }[] = [];
    for (const target of this.scope.entries) {
      if (target.kind === 'option') {
        refs.push({ filePath: target.option.filePath, line: target.option.line });
        continue;
      }
      if (target.loc) {
        refs.push({ filePath: target.loc.filePath, line: target.loc.line });
        continue;
      }
      const resolved = this.sourceScope?.[target.sourceIndex];
      if (resolved?.kind !== 'sketch') {
        return null;
      }
      refs.push({ filePath: resolved.filePath, line: resolved.line });
    }
    return refs;
  }

  /** The create request for the current form state, or the blocking message. */
  private buildRequest(): HoleApplyOptions | { error: string } {
    const values = this.panel.values();
    if ('error' in values) {
      return values;
    }
    const placements = this.placements.createRefs();
    if (placements.length === 0) {
      return { error: 'Pick where the holes go: a connector, a sketch vertex, or a face or round edge.' };
    }
    return { ...values, placements, scope: this.scope.createRefs() };
  }

  /**
   * The edit-mode apply payload: the form values plus the session fields,
   * the full placement list when it moved off the statement's own arguments,
   * and the full scope list. An emptied placement list is refused (a hole
   * needs somewhere to be).
   */
  private buildEditRequest(): HoleEditOptions | { error: string } {
    const values = this.panel.values();
    if ('error' in values) {
      return values;
    }
    if (this.placements.isEmpty) {
      return { error: 'Keep or pick at least one placement.' };
    }
    const placements = this.placements.unchangedKeeps(this.editPlacementCount)
      ? undefined
      : this.placements.editRefs();
    return {
      ...values,
      expectedStatement: this.session.expectedStatement,
      before: this.session.boundary ?? undefined,
      placements,
      scope: this.scope.editRefs(),
    };
  }
}
