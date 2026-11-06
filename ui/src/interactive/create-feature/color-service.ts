import {
  applyColor, applyColorEdit, ColorApplyOptions, ColorEditOptions, ColorEditTargetRef,
  expandBucket, fetchFeatureSources, FeatureEditTarget, FeatureExprValue, ParsedFeatureStatement, SelectionGroupKind,
} from '../../api';
import { SceneObjectRender, SubSelection } from '../../types';
import { SelectedEntity, Viewer } from '../../viewer';
import { Navbar } from '../../ui/navbar';
import { EditSession, EditSessionInfo } from '../edit-session';
import { PickSelection } from '../pick-selection';
import { SelectionContextMenu } from '../selection-menu';
import { SolidPickSelection } from '../solid-pick';
import { ColorPanel, ColorPaintMode } from './color-panel';
import { ColorValues } from './color-values';
import { FeatureButton } from './feature-button';
import { ApplyRunner } from './apply-runner';
import { refreshScopeVariables } from './option-relabeler';
import { SketchUISuspender } from './sketch-suspender';
import { collectSolidTargets, solidTargetForRow, solidTargetForShapeId, SolidTargetOption } from './solid-targets';
import { collectSketchProfiles, sourceChip } from './sketch-profiles';
import { mergeUniqueEntities } from '../../helpers/entities';
import { iconUrl } from '../../ui/icon-url';

/** What the seeding hook hands over when the dialog arms. */
export type ColorEnterSeed = {
  /** The neutral-mode selection (faces/edges) at activation. */
  seed: SelectedEntity[];
};

/**
 * One chosen solid: a whole-solid pick resolved to its statement, or —
 * edit mode only — a kept statement argument by its position in the parsed
 * `targetTexts`, preserved verbatim. A keep whose expression resolved to a
 * statement carries that statement's location (`loc`): it converts into its
 * solid option at the rollback boundary, so the chip shows the statement's
 * own label and a re-pick toggles it like create mode.
 */
type ColorTargetChoice =
  | { kind: 'option'; option: SolidTargetOption }
  | { kind: 'keep'; sourceIndex: number; label: string; loc?: { filePath: string; line: number; column: number } };

/**
 * The Color dialog on the create rails: paint whole solids or single faces
 * — one button, one dialog, the target kind on tabs. On the Solid tab any
 * face or edge click selects the owning solid whole (the boolean dialog's
 * idiom, shared via {@link SolidPickSelection}), timeline rows too; on the
 * Face tab faces toggle one by one, with the modify tools' right-click
 * groups and double-click bucket expansion. The picks wear the chosen
 * colour in the viewport — the paint previewed where it lands. Arming with
 * a selection already highlighted seeds the dialog: faces open on the Face
 * tab as picks, anything else resolves to its solids on the Solid tab.
 * Apply writes `color('<value>', e)` / `color('<value>', e.endFaces())` —
 * the re-render is the result, editor undo the rollback.
 */
export class ColorFeatureService {
  private panel: ColorPanel;
  private button: FeatureButton;
  private armed = false;
  private available = false;
  private targetOptions: SolidTargetOption[] = [];
  /** The Solid tab's chosen solids, in argument order. */
  private targets: ColorTargetChoice[] = [];
  /** The Face tab's picks (chains included, for `.withTangents()` selectors). */
  private faces = new PickSelection();
  /** The Face tab's chip rows, one per plain pick, a chain as one row. */
  private faceRows: { label: string; members: SelectedEntity[] }[] = [];
  private sceneSketchActive = false;
  private sketchUI: SketchUISuspender;
  /** The shared whole-solid highlight (the Solid tab's viewport echo). */
  private solidPick: SolidPickSelection;
  /** Right-click menu of the Face tab: multi-select groups + sibling buckets. */
  private selectionMenu: SelectionContextMenu;
  /** Statement being edited in place (timeline double-click), or null. */
  private editTarget: FeatureEditTarget | null = null;
  /** The parsed statement the edit dialog opened over (keep-slot texts). */
  private editStatement: Extract<ParsedFeatureStatement, { feature: 'color' }> | null = null;
  /** Edit mode: the Face tab's seeded picks, for dirty detection against re-picks. */
  private seededFaceSignature = '';
  /** View-state half of edit mode: pre-statement rollback + boundary. */
  private session = new EditSession();
  private runner: ApplyRunner<ColorApplyOptions | ColorEditOptions>;

  constructor(
    container: HTMLElement,
    private viewer: Viewer,
    private navbar: Navbar,
    private hooks: {
      /** May return the current selection state — it seeds the dialog. */
      onEnter?: () => ColorEnterSeed | void;
      /** Armed or disarmed — lets the Sketch button owner re-check `isActive`. */
      onActiveChange?: () => void;
      onSuspendSketchUI?: () => void;
      onResumeSketchUI?: () => void;
    } = {},
  ) {
    // Color sits in its own group right after Boolean — appearance follows
    // the shape tools. Like Boolean the group is *not* `immune`: it hides
    // while the exclusive sketch toolbar owns the bar.
    const group = navbar.addGroup('color', { visible: false });
    this.button = new FeatureButton(group, {
      icon: iconUrl('color'),
      label: 'Color',
      tip: 'Colour solids or faces',
      ariaLabel: 'Colour whole solids or single faces',
      hidden: true,
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

    this.panel = new ColorPanel(container);
    this.panel.onApply = () => void this.runner.apply();
    this.panel.onExit = () => this.exit();
    // The colour field changed: the picks wear the new colour, the Face
    // tab's prefix spells it, and the statement preview re-renders.
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.syncHighlight();
      this.syncExpressionPrefix();
      this.runner.schedulePreview();
    };
    this.panel.onModeChange = () => {
      this.selectionMenu.hide();
      this.syncViewport();
      this.refresh();
    };
    this.panel.onRemoveTarget = (index) => {
      this.targets.splice(index, 1);
      this.panel.setMessage(null);
      this.refresh();
    };
    this.panel.onRemoveFace = (index) => {
      const row = this.faceRows[index];
      if (row) {
        this.toggleFace(row.members[0]);
      }
    };
    // Hovering a chip shows just that chip's picks so the row can be told
    // apart from its siblings; leaving restores the full selection.
    this.panel.onChipHover = (index) => {
      if (index === null) {
        this.syncHighlight();
        return;
      }
      if (this.panel.mode === 'faces') {
        const members = this.faceRows[index]?.members;
        if (members) {
          this.viewer.highlightEntities(members, [], [], [], null, { tint: this.tint() });
        }
      } else {
        const target = this.targets[index];
        if (target?.kind === 'option') {
          this.viewer.highlightEntities([], [], target.option.shapeIds, [], null, { tint: this.tint() });
        }
      }
    };

    this.selectionMenu = new SelectionContextMenu(container, 'fluidcad-color-selection-menu', {
      kinds: ['tangent', 'classified', 'same-type', 'equal', 'sibling'],
      onSelectGroup: (kind, seed, members) => this.applyGroup(kind, seed, members),
      onPreview: (members) => this.previewFaces(members),
      boundary: () => this.session.boundary ?? undefined,
    });

    this.runner = new ApplyRunner({
      panel: this.panel,
      session: this.session,
      isArmed: () => this.armed,
      build: (purpose) => this.editTarget ? this.buildEditRequest(purpose) : this.buildRequest(purpose),
      send: (request, extras) => this.editTarget
        ? applyColorEdit(this.editTarget, { ...(request as ColorEditOptions), ...extras })
        : applyColor({ ...(request as ColorApplyOptions), ...extras }),
      onApplied: () => {
        this.panel.rememberColor();
        this.exit(this.editTarget ? { editEnd: 'apply' } : { resume: 'lazy' });
      },
      failMessage: () => this.editTarget ? 'Could not apply the edit.' : 'Could not apply the colour.',
      // A face preview carries the synthesized selectors — the expression
      // row shows them, editable, with their verified alternatives.
      onPreviewSuccess: (result) => {
        if (this.panel.mode === 'faces' && typeof result.args === 'string') {
          this.panel.expression.show(result.args, result.alternatives ?? []);
          this.syncExpressionPrefix();
        }
      },
    });
  }

  get isActive(): boolean {
    return this.armed;
  }

  /** An edit session is open (the viewport shows the pre-statement rollback). */
  get isEditing(): boolean {
    return this.editTarget !== null;
  }

  /** The armed dialog owns viewport clicks — a whole solid or a face, by tab. */
  get isPicking(): boolean {
    return this.armed;
  }

  /** The Face tab is up: single faces, with the multi-select menu and bucket expansion. */
  get isFacePicking(): boolean {
    return this.armed && this.panel.mode === 'faces';
  }

  /** True while armed picking has suspended sketch editing. */
  get sketchUISuspended(): boolean {
    return this.sketchUI.suspended;
  }

  /**
   * Every render lands here. An open edit session owns the view: it keeps
   * the viewport rolled back to just before the edited statement, and at
   * that boundary the solid options rebuild from the pre-statement scene
   * and the statement's own faces re-seed — exactly what its arguments see.
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
      return;
    }
    // At the boundary: rebuild options from the pre-statement scene. Picked
    // solids re-match by source line; a keep that resolved to a solid
    // statement becomes that statement's option — proper label, create-mode
    // toggling; unresolved keeps stay text-addressed verbatim.
    this.targetOptions = collectSolidTargets(sceneObjects);
    this.targets = this.targets.flatMap((target): ColorTargetChoice[] => {
      if (target.kind === 'keep') {
        const match = target.loc && this.targetOptions.find(o =>
          o.filePath === target.loc!.filePath && o.line === target.loc!.line);
        return [match ? { kind: 'option', option: match } : target];
      }
      const match = this.targetOptions.find(o =>
        o.filePath === target.option.filePath && o.line === target.option.line);
      return match ? [{ kind: 'option', option: match }] : [];
    });
    this.syncViewport();
    this.refresh();
    void this.loadEditSources();
  }

  update(sceneObjects: SceneObjectRender[]): void {
    this.targetOptions = collectSolidTargets(sceneObjects);
    this.sceneSketchActive = collectSketchProfiles(sceneObjects)[0]?.kind === 'active';
    // Visible from the first solid, like Boolean — which is also what a
    // blank document gets (see {@link Viewer.sceneIsEmpty}).
    this.available = this.targetOptions.length >= 1 || this.viewer.sceneIsEmpty;
    this.navbar.setGroupVisible('color', this.available);
    this.button.setVisible(this.available);
    this.selectionMenu.hide();
    this.syncButton();
    if (!this.armed) {
      return;
    }
    if (!this.available) {
      this.exit({ resume: 'lazy' });
      return;
    }
    // A render can put a sketch back in front (live editing) — the armed
    // dialog keeps the free 3D view.
    if (this.sceneSketchActive) {
      this.sketchUI.suspend();
    }
    // Chosen solids re-match against the fresh options by source line, and
    // the face picks go: shape ids changed with the render.
    this.targets = this.targets.flatMap((target): ColorTargetChoice[] => {
      if (target.kind === 'keep') {
        return [target];
      }
      const match = this.targetOptions.find(o =>
        o.filePath === target.option.filePath && o.line === target.option.line);
      return match ? [{ kind: 'option', option: match }] : [];
    });
    this.faces.clear();
    this.panel.expression.hide();
    this.syncViewport();
    this.refresh();
  }

  /**
   * Open the dialog over an existing colour statement (timeline
   * double-click). The session rolls the viewport back to just before the
   * statement — the world its arguments see, where the solids and faces it
   * paints are visible and pickable. The tab is read off the statement: an
   * argument-less paint or arguments naming solid statements open the Solid
   * tab with one kept chip per argument; anything else opens the Face tab
   * with the argument text in the expression row, and the kernel's reading
   * of the statement's faces seeds the picks once the view is rolled back.
   * Apply rewrites the statement in place.
   */
  enterEdit(
    target: FeatureEditTarget,
    parsed: Extract<ParsedFeatureStatement, { feature: 'color' }>,
    info: Omit<EditSessionInfo, 'target'>,
  ): void {
    if (this.armed) {
      this.exit();
    }
    this.hooks.onEnter?.();
    this.armed = true;
    this.editTarget = target;
    this.editStatement = parsed;
    const mode: ColorPaintMode = parsed.targetTexts.length === 0 || parsed.targetRefs.every(ref => ref !== null)
      ? 'solids'
      : 'faces';
    this.targets = parsed.targetTexts.map((label, sourceIndex) => {
      const ref = parsed.targetRefs[sourceIndex];
      return {
        kind: 'keep' as const,
        sourceIndex,
        label,
        loc: ref ? { filePath: target.filePath, line: ref.line, column: ref.column } : undefined,
      };
    });
    this.faces.clear();
    this.seededFaceSignature = '';
    this.syncButton();
    this.sketchUI.suspend();
    this.session.begin({ ...info, target });
    this.panel.showEdit(mode, parsed.value);
    if (mode === 'faces') {
      this.showEditArgs();
    }
    void this.refreshScopeVariables();
    this.syncViewport();
    this.refresh();
  }

  enter(): void {
    if (this.armed) {
      return;
    }
    this.session.end('continue');
    const seeded = this.hooks.onEnter?.();
    this.armed = true;
    this.targets = [];
    this.faces.clear();
    // Painting means looking at the whole scene, not down the active sketch
    // plane — leave sketch editing right away (resumed on cancel; an apply's
    // re-render takes over).
    if (this.sceneSketchActive) {
      this.sketchUI.suspend();
    }
    this.syncButton();
    this.panel.show();
    void this.refreshScopeVariables();
    if (seeded) {
      this.seedFromSelection(seeded);
    }
    this.syncViewport();
    this.refresh();
  }

  /** The variables in scope for the colour field's expression; the picks re-tint by what it then comes to. */
  private async refreshScopeVariables(): Promise<void> {
    const line = this.editTarget?.line ?? null;
    await refreshScopeVariables(line, this.panel,
      () => this.armed && (this.editTarget?.line ?? null) === line);
    if (this.armed && (this.editTarget?.line ?? null) === line) {
      this.syncHighlight();
      this.syncExpressionPrefix();
    }
  }

  /**
   * Arm the dialog around whatever was already selected: a selection of
   * faces alone opens the Face tab with those faces picked — the paint the
   * selection asked for; anything else resolves each face/edge to its
   * owning solid, and the distinct solids open as the Solid tab's chips.
   */
  private seedFromSelection({ seed }: ColorEnterSeed): void {
    if (seed.length === 0) {
      return;
    }
    if (seed.every(entity => entity.sub.type === 'face')) {
      this.panel.setMode('faces');
      this.faces.merge(seed);
      return;
    }
    for (const entity of seed) {
      const option = solidTargetForShapeId(entity.shapeId, this.targetOptions);
      if (option && !this.targets.some(t => t.kind === 'option'
        && t.option.filePath === option.filePath && t.option.line === option.line)) {
        this.targets.push({ kind: 'option', option });
      }
    }
  }

  /**
   * `resume: 'lazy'` re-enables sketch editing without forcing the mode
   * transition — for apply-success and scene-driven exits. User cancels
   * default to `'immediate'`; ending an edit session always resumes lazily
   * (a render follows every session end).
   */
  exit(opts: { resume?: 'immediate' | 'lazy'; editEnd?: 'apply' | 'cancel' | 'continue' | 'handoff' | 'gone' } = {}): void {
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
    this.editStatement = null;
    this.targets = [];
    this.faces.clear();
    this.faceRows = [];
    this.solidPick.set([]);
    this.selectionMenu.hide();
    this.runner.cancelPreview();
    this.viewer.clearHighlight();
    this.viewer.pickFilter = 'all';
    this.viewer.pickAxes = false;
    this.syncButton();
    this.panel.expression.hide();
    this.panel.hide();
    this.sketchUI.resume((opts.resume ?? 'immediate') === 'immediate');
  }

  /**
   * Routes viewer clicks while the dialog is armed: on the Solid tab any
   * face or edge click selects the owning solid whole; on the Face tab a
   * face click toggles that face. Empty-space clicks keep the selection.
   */
  handleClick(shapeId: string | null, sub: SubSelection): void {
    if (!this.armed || !shapeId || !sub || (sub.type !== 'face' && sub.type !== 'edge')) {
      return;
    }
    this.selectionMenu.hide();
    if (this.panel.mode === 'faces') {
      if (sub.type !== 'face') {
        this.panel.setMessage('Pick a face — the Face tab paints single faces.');
        return;
      }
      this.panel.setMessage(null);
      this.toggleFace({ shapeId, sub });
      return;
    }
    const option = solidTargetForShapeId(shapeId, this.targetOptions);
    if (!option) {
      this.panel.setMessage('That shape cannot be coloured — pick a solid.');
      return;
    }
    this.pickTarget(option);
  }

  /**
   * A timeline row was clicked while the dialog is armed: on the Solid tab
   * a solid row toggles as a target. Every row is consumed so the default
   * rollback can't close the dialog mid-flow.
   */
  handleTimelinePick(obj: SceneObjectRender): boolean {
    if (!this.armed) {
      return false;
    }
    if (this.panel.mode === 'faces') {
      this.panel.setMessage('Pick faces in the viewport — a timeline row colours a whole solid on the Solid tab.');
      return true;
    }
    const option = solidTargetForRow(obj, this.targetOptions);
    if (!option) {
      this.panel.setMessage('That row has no solid to colour — pick a solid-producing feature.');
      return true;
    }
    this.pickTarget(option);
    return true;
  }

  /**
   * Double-click on the Face tab: expand the pick to its whole classified
   * bucket ("every end face"). The gesture's own two single clicks have
   * already toggled the face; the expansion merges every surviving bucket
   * member as a plain pick, so the seed ends up selected either way.
   */
  async handleDoubleClick(shapeId: string | null, sub: SubSelection): Promise<void> {
    if (!this.isFacePicking || !shapeId || !sub || sub.type !== 'face') {
      return;
    }
    this.selectionMenu.hide();
    const entity: SelectedEntity = { shapeId, sub };
    const result = await expandBucket(entity, this.session.boundary ?? undefined);
    if (!this.isFacePicking) {
      return;
    }
    if ('error' in result) {
      this.panel.setMessage(result.error);
      return;
    }
    this.panel.setMessage(null);
    this.mergeFaces(result.members.map(m => ({ shapeId: m.shapeId, sub: m.sub })));
  }

  /** Right-click on a face (Face tab): the multi-select menu for that pick. */
  handleContextMenu(shapeId: string | null, sub: SubSelection, clientX: number, clientY: number): void {
    if (!this.isFacePicking) {
      return;
    }
    this.selectionMenu.hide();
    if (!shapeId || !sub || sub.type !== 'face') {
      return;
    }
    // The hover tint would otherwise be stashed as an "original" color by the
    // preview highlight and stick around after the preview restores it.
    this.viewer.clearHover();
    void this.selectionMenu.open({ shapeId, sub }, clientX, clientY);
  }

  // -------------------------------------------------------------------------
  // Picks
  // -------------------------------------------------------------------------

  /** A whole-solid pick (viewport or timeline) toggles in the ordered list. */
  private pickTarget(option: SolidTargetOption): void {
    // A kept target that resolved to this statement counts as the same chip
    // — the pick toggles it off instead of duplicating the solid.
    const existing = this.targets.findIndex(t => t.kind === 'option'
      ? t.option.filePath === option.filePath && t.option.line === option.line
      : t.loc !== undefined && t.loc.filePath === option.filePath && t.loc.line === option.line);
    if (existing >= 0) {
      this.targets.splice(existing, 1);
    } else {
      this.targets.push({ kind: 'option', option });
    }
    this.panel.setMessage(null);
    this.refresh();
  }

  /** Toggle a face pick; a chain member toggles its whole chain off. */
  private toggleFace(entity: SelectedEntity): void {
    this.faces.toggle(entity);
    this.refresh();
  }

  /** Merge group members into the face picks as plain picks. */
  private mergeFaces(members: SelectedEntity[]): void {
    if (!this.faces.merge(members)) {
      return;
    }
    this.refresh();
  }

  /** A multi-select menu group was clicked. */
  private applyGroup(kind: SelectionGroupKind, seed: SelectedEntity, members: SelectedEntity[]): void {
    if (!this.isFacePicking) {
      return;
    }
    this.panel.setMessage(null);
    if (kind === 'tangent') {
      // Tangent chains stay chains — they synthesize to `.withTangents()`.
      this.faces.addChain(seed, members);
      this.refresh();
    } else {
      this.mergeFaces(members);
    }
  }

  /** Menu-hover preview: show the face picks as the hovered click would leave them. */
  private previewFaces(members: SelectedEntity[] | null): void {
    if (!this.isFacePicking) {
      return;
    }
    if (members === null) {
      this.syncHighlight();
      return;
    }
    const shown = mergeUniqueEntities(this.faces.entities, members);
    this.viewer.highlightEntities(shown, [], [], [], null, { tint: this.tint() });
  }

  // -------------------------------------------------------------------------
  // Edit seeding
  // -------------------------------------------------------------------------

  /**
   * At the rollback boundary, read the statement's own paint off the
   * kernel: faces it paints become the Face tab's picks (the tab switches
   * there if the parse guessed otherwise — a `select()` variable reads as
   * a solid reference but paints faces); whole objects keep the Solid tab
   * with the chips the parse seeded; a paint of faces the viewport cannot
   * name keeps the Face tab with the argument text alone.
   */
  private async loadEditSources(): Promise<void> {
    const boundary = this.session.boundary;
    const statement = this.editStatement;
    if (!boundary || !statement) {
      return;
    }
    const result = await fetchFeatureSources(boundary);
    if (!this.armed || this.editStatement !== statement || this.session.boundary?.index !== boundary.index) {
      return;
    }
    if (result.ok && result.feature === 'color') {
      if (result.selection.kind === 'entities' && result.selection.entities.length > 0) {
        this.panel.setMode('faces');
        this.targets = [];
        this.faces.clear();
        this.faces.entities = result.selection.entities.map(e => ({ shapeId: e.shapeId, sub: e.sub }));
        this.seededFaceSignature = this.faces.signature();
        this.showEditArgs();
      } else if (result.targets.length > 0 || statement.targetTexts.length === 0) {
        this.panel.setMode('solids');
        this.panel.expression.hide();
      } else {
        this.panel.setMode('faces');
        this.targets = [];
        this.showEditArgs();
      }
    }
    this.syncViewport();
    this.refresh();
    this.runner.schedulePreview();
  }

  /** The Face tab's expression row seeded with the statement's own argument text. */
  private showEditArgs(): void {
    const argsText = this.editStatement?.argsText ?? '';
    if (argsText) {
      this.panel.expression.show(argsText, []);
      this.syncExpressionPrefix();
    } else {
      this.panel.expression.hide();
    }
  }

  /** Whether the Face tab's picks differ from what the edited statement seeded. */
  private facesDirty(): boolean {
    return this.faces.signature() !== this.seededFaceSignature;
  }

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------

  /**
   * The colour field's value as the statement writes it, or the message
   * blocking the request: a literal must be a colour; an expression rides as
   * it is — what it comes to is the build's to check.
   */
  private readValue(): { value: string | FeatureExprValue } | { error: string } {
    const read = this.panel.readColor();
    if ('error' in read || typeof read.value !== 'string') {
      return read;
    }
    const value = ColorValues.normalize(read.value);
    return value === null
      ? { error: 'Enter a colour — a hex value like #3498db, a name like steelblue, or rgb(…).' }
      : { value };
  }

  /**
   * The expression row's text when it was edited away from `baseline` (the
   * synthesized selectors, or an edited statement's own text); the apply
   * sends it as the selector override, previews re-synthesize instead.
   */
  private selectorOverride(baseline: string | null): string | undefined {
    const edited = this.panel.expression.value;
    return baseline !== null && edited !== '' && edited !== baseline ? edited : undefined;
  }

  private buildRequest(purpose: 'apply' | 'preview'): ColorApplyOptions | { error: string } {
    const read = this.readValue();
    if ('error' in read) {
      return read;
    }
    if (this.panel.mode === 'solids') {
      const targets = this.targets.flatMap(t => t.kind === 'option'
        ? [{ filePath: t.option.filePath, line: t.option.line, column: t.option.column }]
        : []);
      if (targets.length === 0) {
        return { error: 'Pick a solid in the viewport first.' };
      }
      return { value: read.value, paint: { kind: 'solids', targets } };
    }
    if (this.faces.isEmpty) {
      return { error: 'Pick a face first.' };
    }
    return {
      value: read.value,
      paint: {
        kind: 'faces',
        entities: this.faces.entities,
        chains: this.faces.apiChains(),
        selectorOverride: purpose === 'apply' ? this.selectorOverride(this.panel.expression.synthesizedArgs) : undefined,
      },
    };
  }

  /**
   * The edit-mode apply payload. The Solid tab ships its full list —
   * untouched chips as verbatim keeps, re-picked solids by call site — and
   * an argument-less statement left empty stays implicit. The Face tab
   * ships re-picked faces for synthesis against the pre-statement boundary
   * and/or the expression row edited away from its baseline; untouched, the
   * statement's own arguments stand.
   */
  private buildEditRequest(purpose: 'apply' | 'preview'): ColorEditOptions | { error: string } {
    const read = this.readValue();
    if ('error' in read) {
      return read;
    }
    const sessionFields = {
      expectedStatement: this.session.expectedStatement,
      before: this.session.boundary ?? undefined,
    };
    if (this.panel.mode === 'solids') {
      if (this.targets.length === 0) {
        if ((this.editStatement?.targetTexts.length ?? 0) > 0) {
          return { error: 'Pick the solids to colour first.' };
        }
        // An originally implicit statement stays implicit while untouched.
        return { value: read.value, ...sessionFields };
      }
      return {
        value: read.value,
        paint: { kind: 'solids', targets: this.targets.map(t => this.targetRef(t)) },
        ...sessionFields,
      };
    }
    const dirty = this.facesDirty();
    const baseline = dirty ? this.panel.expression.synthesizedArgs : (this.editStatement?.argsText || null);
    const override = purpose === 'apply' ? this.selectorOverride(baseline) : undefined;
    if (dirty && !this.faces.isEmpty) {
      return {
        value: read.value,
        paint: { kind: 'faces', entities: this.faces.entities, chains: this.faces.apiChains(), selectorOverride: override },
        ...sessionFields,
      };
    }
    if (override !== undefined) {
      return { value: read.value, paint: { kind: 'faces', selectorOverride: override }, ...sessionFields };
    }
    if (dirty) {
      return { error: 'Pick a face first.' };
    }
    return { value: read.value, ...sessionFields };
  }

  /** One Solid tab chip's edit ref (create mode never carries keeps). */
  private targetRef(choice: ColorTargetChoice): ColorEditTargetRef {
    return choice.kind === 'keep'
      ? { kind: 'verbatim', sourceIndex: choice.sourceIndex }
      : { kind: 'feature', filePath: choice.option.filePath, line: choice.option.line, column: choice.option.column };
  }

  // -------------------------------------------------------------------------
  // Viewport reflection + sketch-editing suspension
  // -------------------------------------------------------------------------

  /** The Solid tab takes any face or edge (its whole solid); the Face tab faces only. */
  private syncViewport(): void {
    if (!this.armed) {
      return;
    }
    this.viewer.pickSketchWires = false;
    this.viewer.pickAxes = false;
    this.viewer.pickFilter = this.panel.mode === 'faces' ? 'face' : 'all';
  }

  /** The chosen colour as the viewport tints with it; a value that is no colour yet keeps the plain highlight. */
  private tint(): string | undefined {
    return ColorValues.tint(this.panel.colorValue) ?? undefined;
  }

  /** Paint the picks in the chosen colour — the shown tab's picks only. */
  private syncHighlight(): void {
    if (!this.armed) {
      return;
    }
    const tint = this.tint();
    if (this.panel.mode === 'faces') {
      this.solidPick.set([]);
      if (this.faces.isEmpty) {
        this.viewer.clearHighlight();
      } else {
        this.viewer.highlightEntities(this.faces.entities, [], [], [], null, { tint });
      }
      return;
    }
    const ids = this.targets.flatMap(t => t.kind === 'option' ? t.option.shapeIds : []);
    this.solidPick.set(ids);
    if (ids.length === 0) {
      this.viewer.clearHighlight();
    } else {
      this.viewer.highlightEntities([], [], ids, [], null, { tint });
    }
  }

  /** The Face tab's expression row leads with the colour the statement will quote — or the expression it will write bare. */
  private syncExpressionPrefix(): void {
    const read = this.readValue();
    if (!('error' in read)) {
      this.panel.setExpressionPrefix(read.value);
    }
  }

  private faceLabel(shapeId: string): string {
    const owner = this.viewer.currentSceneObjects.find(o =>
      o.sceneShapes?.some(s => s.shapeId === shapeId));
    return owner?.name ? `Face — ${owner.name}` : 'Face';
  }

  /** Repaint the shown tab's chips and the viewport tint, then re-preview the statement. */
  private refresh(): void {
    if (!this.armed) {
      return;
    }
    if (this.panel.mode === 'faces') {
      // Every pick is a removable chip: one per plain pick, a whole tangent
      // chain as a single chip — its ✕ removes the chain like a viewport
      // click on a member would.
      this.faceRows = this.faces.chipRows();
      this.panel.setFaces(this.faceRows.map(row => ({
        label: row.members.length === 1 ? this.faceLabel(row.members[0].shapeId) : row.label,
        removable: true,
      })));
      if (this.faces.isEmpty && !this.editTarget) {
        this.panel.expression.hide();
      }
    } else {
      this.panel.setTargets(this.targets.map(target => target.kind === 'keep'
        ? { label: `Current: ${target.label}`, removable: true }
        : sourceChip(target.option, { removable: true })));
    }
    this.syncHighlight();
    this.syncExpressionPrefix();
    this.runner.schedulePreview();
  }

  private syncButton(): void {
    this.button.setActive(this.armed);
    // Every armed flip lands here — the Sketch button disables while a
    // create dialog is up.
    this.hooks.onActiveChange?.();
  }
}
