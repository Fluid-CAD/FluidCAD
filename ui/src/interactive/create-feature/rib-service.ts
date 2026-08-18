import {
  applyRib, applyRibEdit, fetchFeatureGhost, fetchFeatureSources, FeatureEditTarget, GhostSolid,
  ParsedFeatureStatement, RibApplyOptions, RibEditOptions, SourceSlotRef,
} from '../../api';
import { SceneObjectRender, SourceLocation, SubSelection } from '../../types';
import { Viewer } from '../../viewer';
import { Navbar } from '../../ui/navbar';
import { EditSession, EditSessionInfo } from '../edit-session';
import { SolidPickSelection } from '../solid-pick';
import { RibPanel } from './rib-panel';
import { FeatureButton } from './feature-button';
import { ApplyRunner } from './apply-runner';
import { FeatureGhostOverlay, GhostKind } from './feature-ghost';
import { SketchUISuspender } from './sketch-suspender';
import { OptionRelabeler, refreshScopeVariables } from './option-relabeler';
import { collectSolidTargets, SolidTargetOption } from './solid-targets';
import { enclosingPartLocOf, ScopeTargetList, scopePartLocation } from './scope-targets';
import {
  collectSketchProfiles, labelWithSketchNames, optionsSignature, resolveSketchByShapeId, resolveSketchRow,
  SketchProfileOption, sketchWireShapeIds,
} from './sketch-profiles';

/**
 * The Rib dialog on the create rails: extrude a wall from an open sketch
 * spine until it meets the surrounding solids. The spine is picked like an
 * extrude profile (the dropdown chip, a timeline sketch row, or its wires in
 * 3D); the scope solids — the bodies the rib conforms to and fuses with —
 * are picked whole in the viewport (any face or edge click selects the
 * owning solid, the copy dialog's idiom) or by their timeline rows, with an
 * empty slot meaning the whole scene. Applying writes `rib(<thickness>)`
 * plus the `.parallel()` / `.extend()` / `.draft(…)` / `.remove()` /
 * `.new()` / `.scope(…)` chains — the re-render is the preview and editor
 * undo is the rollback, as on the modify rails.
 */
export class RibFeatureService {
  private panel: RibPanel;
  private button: FeatureButton;
  private armed = false;
  private available = false;
  private options: SketchProfileOption[] = [];
  /** Scene-wide solid count — the button's availability, not the picker's pool. */
  private targetOptions: SolidTargetOption[] = [];
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
  /** The statement's current spine source, for highlighting the keep slot. */
  private sourceSpine: SourceSlotRef | null = null;
  /**
   * The statement's current `.scope(…)` sources, for the keep chips' ghost —
   * what a kept argument the parse couldn't address actually names. Null
   * until the query lands (or when it can't answer).
   */
  private sourceScope: SourceSlotRef[] | null = null;
  /** The translucent wall the current values would build, drawn in the view. */
  private ghost: FeatureGhostOverlay;
  private sketchUI: SketchUISuspender;
  /** The shared whole-solid highlight (the scope chips' viewport echo). */
  private solidPick: SolidPickSelection;
  private runner: ApplyRunner<RibApplyOptions | RibEditOptions>;
  private relabeler: OptionRelabeler<SketchProfileOption[]>;

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
    // Rib joins the create group as another contributor — constructed after
    // Extrude in main.ts, so the group exists and the button lands beside it.
    const group = navbar.getGroup('create') ?? navbar.addGroup('create', { visible: false, immune: true });
    this.button = new FeatureButton(group, {
      icon: '/icons/rib.png',
      label: 'Rib',
      tip: 'Rib from a sketch spine',
      ariaLabel: 'Rib from a sketch spine',
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

    this.panel = new RibPanel(container);
    this.panel.onApply = () => void this.runner.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.refreshHighlight();
      this.runner.schedulePreview();
    };
    this.panel.onRemoveScope = (index) => {
      this.scope.removeAt(index);
      this.panel.setMessage(null);
      this.refreshScope();
      this.runner.schedulePreview();
    };

    this.runner = new ApplyRunner({
      panel: this.panel,
      isArmed: () => this.armed,
      build: () => this.editTarget ? this.buildEditRequest() : this.buildRequest(),
      send: (request, extras) => this.editTarget
        ? applyRibEdit(this.editTarget, { ...(request as RibEditOptions), ...extras })
        : applyRib({ ...(request as RibApplyOptions), ...extras }),
      onApplied: () => this.exit(this.editTarget ? { editEnd: 'apply' } : { resume: 'lazy' }),
      failMessage: () => this.editTarget ? 'Could not apply the edit.' : 'Could not apply the rib.',
      // An empty sketch blocks Apply but not the preview — the would-be
      // statement still shows with nothing in the spine yet.
      validateApply: () => {
        const option = this.editTarget ? null : this.panel.selectedOption();
        return option && !option.hasGeometry ? { error: 'Draw the rib spine in the sketch first.' } : null;
      },
      // Create-mode previews stay quiet — transient failures would flash
      // while sketching; edit-mode drift surfaces before Apply.
      surfacePreviewReasons: () => this.editTarget !== null,
      // The statement preview's geometric twin: the conformed wall the values
      // describe, drawn translucent in the viewport. Same debounce, same
      // abort scope.
      ghost: {
        fetch: (_request, signal) => this.fetchGhost(signal),
        apply: (solids) => {
          if (solids) {
            this.ghost.set(solids, this.ghostKind());
          } else {
            this.ghost.clear();
          }
        },
      },
    });
    this.relabeler = new OptionRelabeler({
      sign: optionsSignature,
      load: labelWithSketchNames,
      isArmed: () => this.armed,
      apply: (options) => {
        this.options = options;
        this.panel.setOptions(options);
      },
    });
  }

  get isActive(): boolean {
    return this.armed;
  }

  /** The toolbar button, mirrored into the Finish Sketch grid during sketch mode. */
  get toolbarButton(): FeatureButton {
    return this.button;
  }

  /** An edit session is open (the viewport shows the pre-statement rollback). */
  get isEditing(): boolean {
    return this.editTarget !== null;
  }

  /** The armed dialog owns viewport clicks (solid picks land in the scope slot). */
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
   * that boundary the slot options rebuild from the pre-statement scene —
   * exactly the sketches and solids the rib's arguments can reference.
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
      // Mid-flight to the boundary — whatever the ghost was drawn against is
      // already gone from the view.
      this.ghost.clear();
      if (!isRollback) {
        this.sourceSpine = null;
        this.sourceScope = null;
      }
      return;
    }
    // At the boundary: rebuild options from the pre-statement scene. A keep
    // chip whose argument named a statement becomes that statement's option.
    this.ghost.clear();
    this.sceneObjects = sceneObjects;
    this.options = collectSketchProfiles(sceneObjects);
    this.targetOptions = collectSolidTargets(sceneObjects);
    this.scope.setScene(sceneObjects, this.scopePartLoc(), { resolveKeeps: true });
    this.viewer.pickSketchWires = true;
    this.panel.setOptions(this.options);
    if (!this.sourceSpine) {
      void this.loadEditSources();
    }
    void this.relabeler.refresh(this.options);
    this.refreshScope();
    this.runner.schedulePreview();
  }

  /**
   * Scene re-rendered: recompute the offered sketches/solids and button
   * visibility. The dialog stays open across re-renders.
   */
  update(sceneObjects: SceneObjectRender[]): void {
    this.sceneObjects = sceneObjects;
    this.options = collectSketchProfiles(sceneObjects);
    this.targetOptions = collectSolidTargets(sceneObjects);
    this.sceneSketchActive = this.options[0]?.kind === 'active';
    // A rib needs surrounding solids to conform to — no solids, no button.
    this.available = this.targetOptions.length > 0;
    // The group is shared with Extrude and the Sketch button — vote via our
    // own slot; the group shows while any contributor needs it.
    this.navbar.setGroupVisible('create', this.available, 'rib');
    this.syncButton();
    if (!this.armed) {
      return;
    }
    if (!this.available) {
      this.exit({ resume: 'lazy' });
      return;
    }
    // The geometry under the ghost just changed — drop it now and let the
    // debounce redraw it. Correctness over the flicker.
    this.ghost.clear();
    // A render can put a sketch back in front (live editing) — the armed
    // dialog keeps the free 3D view.
    if (this.sceneSketchActive) {
      this.sketchUI.suspend();
    }
    // Chosen scope targets re-match against the fresh options by source
    // line; keeps survive (they are text-addressed).
    this.scope.setScene(sceneObjects, this.scopePartLoc());
    this.viewer.pickSketchWires = true;
    this.panel.setOptions(this.options);
    void this.relabeler.refresh(this.options);
    this.refreshScope();
    this.runner.schedulePreview();
  }

  /**
   * Open the dialog over an existing rib statement (timeline double-click).
   * The session rolls the viewport back to just before the statement; the
   * spine slot starts on a "Current: …" chip keeping the statement's own
   * spine, the scope slot on one kept chip per `.scope(…)` argument — both
   * re-picked like create mode. Apply rewrites the statement in place.
   */
  enterEdit(
    target: FeatureEditTarget,
    parsed: Extract<ParsedFeatureStatement, { feature: 'rib' }>,
    info: Omit<EditSessionInfo, 'target'>,
  ): void {
    if (this.armed) {
      this.exit();
    }
    this.hooks.onEnter?.();
    this.armed = true;
    this.editTarget = target;
    this.sourceSpine = null;
    this.sourceScope = null;
    // The statement's enclosing part restricts the scope picker — derived
    // from the pre-rollback scene, where the edited row still renders.
    this.editPartLoc = enclosingPartLocOf(target, this.sceneObjects);
    this.scope.seedKeeps(parsed, target.filePath);
    this.syncButton();
    this.sketchUI.suspend();
    this.viewer.pickSketchWires = true;
    this.session.begin({ ...info, target });
    void this.loadEditSources();
    void this.refreshScopeVariables();
    this.panel.showEdit({
      op: parsed.op,
      thickness: parsed.thickness,
      parallel: parsed.parallel,
      extend: parsed.extend,
      draft: parsed.draft,
      spineLabel: parsed.spineText,
    });
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
    this.scope.clear();
    this.editPartLoc = null;
    // Composing the rib means looking at the whole scene, not down the
    // active sketch plane — leave sketch editing right away (resumed on
    // cancel; an apply's re-render takes over).
    if (this.sceneSketchActive) {
      this.sketchUI.suspend();
    }
    // Clicking a sketch's wires in the 3D view selects it as the spine.
    this.viewer.pickSketchWires = true;
    this.syncButton();
    void this.refreshScopeVariables();
    this.panel.show(this.options);
    void this.relabeler.refresh(this.options);
    this.refreshScope();
    this.runner.schedulePreview();
  }

  /**
   * `resume: 'lazy'` re-enables sketch editing without forcing the mode
   * transition — for apply-success and scene-driven exits, where a render
   * follows. User cancels default to `'immediate'`; ending an edit session
   * always resumes lazily (a render follows every session end).
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
    this.sourceSpine = null;
    this.sourceScope = null;
    this.scope.clear();
    this.editPartLoc = null;
    this.solidPick.set([]);
    this.viewer.pickSketchWires = false;
    this.viewer.clearHighlight();
    this.syncButton();
    this.runner.cancelPreview();
    // The overlay is a compiledMesh sibling, so no render tears it down —
    // every way out of the dialog (apply, cancel, scene-driven) lands here.
    this.ghost.clear();
    this.panel.hide();
    this.sketchUI.resume((opts.resume ?? 'immediate') === 'immediate');
  }

  /**
   * A timeline row was clicked while the dialog is armed. A sketch row (or a
   * child entity of one) selects that sketch as the spine; a solid row
   * toggles it in the scope list. Every row is consumed so the timeline's
   * default rollback can't close the dialog mid-flow.
   */
  handleTimelinePick(obj: SceneObjectRender): boolean {
    if (!this.armed) {
      return false;
    }
    const sketch = resolveSketchRow(obj, this.sceneObjects);
    if (sketch?.sourceLocation) {
      this.pickSketch(sketch);
      return true;
    }
    const option = this.scope.optionForRow(obj);
    if (!option) {
      return false;
    }
    this.toggleScope(option);
    return true;
  }

  /** A sketch wire was clicked in the 3D view: selects it as the spine. */
  handleSketchPick(shapeId: string): boolean {
    if (!this.armed) {
      return false;
    }
    const sketch = resolveSketchByShapeId(shapeId, this.sceneObjects);
    if (!sketch?.sourceLocation) {
      return false;
    }
    this.pickSketch(sketch);
    return true;
  }

  /**
   * Routes viewer clicks while the dialog is armed: any face or edge click
   * selects the owning solid whole and toggles it in the scope list (the
   * copy dialog's idiom); empty-space clicks keep the selection.
   */
  handleClick(shapeId: string | null, sub: SubSelection): void {
    if (!this.armed || !shapeId || !sub || (sub.type !== 'face' && sub.type !== 'edge')) {
      return;
    }
    const option = this.scope.optionForShapeId(shapeId);
    if (!option) {
      this.panel.setMessage('That shape cannot scope the rib — pick a solid in the same part.');
      return;
    }
    this.toggleScope(option);
  }

  private pickSketch(sketch: SceneObjectRender): void {
    const loc = sketch.sourceLocation!;
    const index = this.options.findIndex(o => o.filePath === loc.filePath && o.line === loc.line);
    if (index < 0) {
      this.panel.setMessage('That sketch was already consumed — only sketches still rendered in the scene can spine a rib.');
      return;
    }
    this.panel.selectSpine(index);
    this.panel.setMessage(null);
    this.refreshHighlight();
    this.runner.schedulePreview();
  }

  /** Toggle a solid scope chip (viewport or timeline pick). */
  private toggleScope(option: SolidTargetOption): void {
    this.scope.toggle(option);
    this.panel.setMessage(null);
    this.refreshScope();
    this.runner.schedulePreview();
  }

  /**
   * The part the scope picker is restricted to: the edited statement's own
   * enclosing part, or — create mode — the chosen spine's (producers win:
   * the statement inserts in the spine's scope), falling back to the
   * timeline's active part.
   */
  private scopePartLoc(): SourceLocation | null {
    if (this.editTarget) {
      return this.editPartLoc;
    }
    const option = this.panel.selectedOption();
    return scopePartLocation(option ? { filePath: option.filePath, line: option.line } : null, this.sceneObjects);
  }

  private async refreshScopeVariables(): Promise<void> {
    const line = this.editTarget?.line ?? null;
    await refreshScopeVariables(line, this.panel,
      () => this.armed && (this.editTarget?.line ?? null) === line);
  }

  /** The statement's current spine source, for highlighting the keep slot. */
  private async loadEditSources(): Promise<void> {
    const boundary = this.session.boundary;
    if (!boundary) {
      return;
    }
    const result = await fetchFeatureSources(boundary);
    if (!this.editTarget || this.session.boundary?.index !== boundary.index) {
      return;
    }
    if (result.ok && result.feature === 'rib') {
      this.sourceSpine = result.spine;
      this.sourceScope = result.scope;
    } else {
      this.sourceSpine = { kind: 'opaque' };
      this.sourceScope = [];
    }
    this.refreshHighlight();
    // The ghost's keep slots read the resolved sources, which land after
    // `enterEdit` already scheduled its preview — re-kick so the ghost
    // appears now that the statement's own inputs are known.
    this.runner.schedulePreview();
  }

  /**
   * Highlight the selected spine's wires and the chosen scope solids whole.
   * The active sketch is skipped in create mode (the shared create-dialog
   * behavior): it is the default selection, drawn front and center already.
   * An edit session's keep entry lights up the statement's own spine via the
   * resolved current source.
   */
  private refreshHighlight(): void {
    if (!this.armed) {
      return;
    }
    let option = this.panel.selectedOption();
    if (!option && this.editTarget && this.panel.spineSelection()?.kind === 'keep'
      && this.sourceSpine?.kind === 'sketch') {
      const slot = this.sourceSpine;
      option = this.options.find(o => o.filePath === slot.filePath && o.line === slot.line) ?? null;
    }
    const wireIds = option && (option.kind === 'other' || this.editTarget)
      ? sketchWireShapeIds(option, this.sceneObjects)
      : [];
    this.solidPick.set(this.scope.shapeIds());
    this.solidPick.refreshHighlight({ wireIds });
  }

  /** Repaint the scope chips and the picked-solid highlights. */
  private refreshScope(): void {
    if (!this.armed) {
      return;
    }
    this.panel.setScope(this.scope.chips());
    this.refreshHighlight();
  }

  private syncButton(): void {
    this.button.setActive(this.armed);
    this.button.setVisible(this.available);
    // Every armed flip lands here — the Sketch button disables while a
    // create dialog is up.
    this.hooks.onActiveChange?.();
  }

  /** Green while the rib adds material, red while it cuts. */
  private ghostKind(): GhostKind {
    const values = this.panel.values();
    return !('error' in values) && values.op === 'remove' ? 'remove' : 'add';
  }

  /**
   * The live geometry for the current form state: the conformed wall the
   * values describe. Runs off the values the statement preview just
   * validated, so all that is left is to resolve the slots — and that is
   * where the create and edit dialogs converge: both hand the server explicit
   * `{filePath, line}` refs, so the endpoint never has to know which mode
   * asked. A slot the ghost can't address (no spine yet, a keep chip over an
   * expression) means no ghost.
   */
  private async fetchGhost(signal: AbortSignal): Promise<GhostSolid[] | null> {
    const values = this.panel.values();
    if ('error' in values) {
      return null;
    }
    const spine = this.ghostSpine();
    if (!spine) {
      return null;
    }
    const scope = this.ghostScope();
    if (!scope) {
      return null;
    }
    return fetchFeatureGhost({
      feature: 'rib',
      op: values.op,
      thickness: values.thickness,
      parallel: values.parallel,
      extend: values.extend,
      draft: values.draft,
      spine,
      scope,
      // The scene holds the applied rib mid-edit — the kernel unwinds its
      // fusion so the ghost conforms against the pre-statement bodies.
      exclude: this.editTarget
        ? { filePath: this.editTarget.filePath, line: this.editTarget.line }
        : undefined,
    }, signal);
  }

  /** The sketch the ghost ribs from, or null while there is nothing to build. */
  private ghostSpine(): { filePath: string; line: number } | null {
    if (this.editTarget) {
      const selection = this.panel.spineSelection();
      if (selection?.kind === 'sketch') {
        return { filePath: selection.option.filePath, line: selection.option.line };
      }
      // The keep chip: the statement's own spine, once `loadEditSources` has
      // resolved it. Null while that is still in flight (the load re-kicks
      // the preview) or when the argument is an expression the sources query
      // couldn't address.
      return this.sourceSpine?.kind === 'sketch'
        ? { filePath: this.sourceSpine.filePath, line: this.sourceSpine.line }
        : null;
    }
    const option = this.panel.selectedOption();
    // An empty sketch blocks Apply but not the statement preview — and it has
    // no spine to wall up, so it has no ghost either.
    if (!option || !option.hasGeometry) {
      return null;
    }
    return { filePath: option.filePath, line: option.line };
  }

  /**
   * The scope solids by call site. A kept chip travels as the statement its
   * expression named, or — for one the parse couldn't address — as whatever
   * the sources query resolved that argument to. A target neither could
   * place means no ghost at all: a rib conforming to part of its scope is a
   * different rib, not a partial one. An empty list is the whole scene — the
   * kernel's own default.
   */
  private ghostScope(): { filePath: string; line: number }[] | null {
    const refs: { filePath: string; line: number }[] = [];
    for (const target of this.scope.entries) {
      if (target.kind === 'option') {
        refs.push({ filePath: target.option.filePath, line: target.option.line });
        continue;
      }
      const slot = target.loc ?? null;
      if (slot) {
        refs.push({ filePath: slot.filePath, line: slot.line });
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
  private buildRequest(): RibApplyOptions | { error: string } {
    const values = this.panel.values();
    if ('error' in values) {
      return values;
    }
    const option = this.panel.selectedOption();
    if (!option) {
      return { error: 'No sketch for the rib spine.' };
    }
    return {
      ...values,
      spine: {
        mode: option.kind === 'active' ? 'active' : 'bound',
        filePath: option.filePath,
        line: option.line,
        column: option.column,
      },
      // Create mode never carries keep entries — every chip is a picked solid.
      scope: this.scope.createRefs(),
    };
  }

  /**
   * The edit-mode apply payload: the form values plus the session fields,
   * the re-sourced spine when the slot moved off its "Current: …" entry,
   * and the full scope list — kept `.scope(…)` arguments by position mixed
   * with re-picked solids. An emptied slot drops the chain outright; a
   * statement that never had one stays chain-less the same way.
   */
  private buildEditRequest(): RibEditOptions | { error: string } {
    const values = this.panel.values();
    if ('error' in values) {
      return values;
    }
    const selection = this.panel.spineSelection();
    const spine = selection?.kind === 'sketch'
      ? {
        mode: 'bound' as const,
        filePath: selection.option.filePath,
        line: selection.option.line,
        column: selection.option.column,
      }
      : undefined;
    return {
      ...values,
      expectedStatement: this.session.expectedStatement,
      spine,
      scope: this.scope.editRefs(),
    };
  }
}
