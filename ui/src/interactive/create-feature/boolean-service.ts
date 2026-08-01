import {
  applyBoolean, applyBooleanEdit, BooleanApplyOptions, BooleanEditOptions, BooleanEditTargetRef,
  FeatureEditTarget, ParsedFeatureStatement,
} from '../../api';
import { SceneObjectRender, SubSelection } from '../../types';
import { SelectedEntity, Viewer } from '../../viewer';
import { Navbar } from '../../ui/navbar';
import { EditSession, EditSessionInfo } from '../edit-session';
import { SolidPickSelection } from '../solid-pick';
import { BooleanPanel } from './boolean-panel';
import { FeatureButton } from './feature-button';
import { ApplyRunner } from './apply-runner';
import { SketchUISuspender } from './sketch-suspender';
import { collectSolidTargets, solidTargetForRow, solidTargetForShapeId, SolidTargetOption } from './solid-targets';
import { collectSketchProfiles, sourceChip } from './sketch-profiles';

/** What the seeding hook hands over when the dialog arms. */
export type BooleanEnterSeed = {
  /** The neutral-mode selection (faces/edges) at activation. */
  seed: SelectedEntity[];
};

/**
 * One chosen target: a whole-solid pick resolved to its statement, or —
 * edit mode only — a kept statement target by its position in the parsed
 * `targetTexts`, preserved verbatim. A keep whose expression resolved to a
 * statement carries that statement's location (`loc`): it converts into its
 * solid option at the rollback boundary, so the chip shows the statement's
 * own label and a re-pick toggles it like create mode.
 */
type BooleanTargetChoice =
  | { kind: 'option'; option: SolidTargetOption }
  | { kind: 'keep'; sourceIndex: number; label: string; loc?: { filePath: string; line: number; column: number } };

/**
 * The Boolean dialog on the create rails: combine solids with fuse,
 * subtract or common — one button, one dialog, the operation on tabs. The
 * solids are picked in the viewport — any face or edge click selects the
 * owning solid whole (the copy dialog's idiom, shared via
 * {@link SolidPickSelection}) — or by their timeline rows. Fuse and Common
 * toggle picks into one ordered list; Subtract addresses its Base and Tool
 * slots by the armed border. Arming with a selection already highlighted
 * seeds the dialog: the selected entities' solids open as target chips.
 * Apply writes `fuse(a, b)` / `subtract(base, tool)` / `common(a, b)` — the
 * re-render is the preview, editor undo the rollback.
 *
 * The target list is sparse only on the subtract tab (a tool picked before
 * its base leaves index 0 empty); fuse and common keep it dense.
 */
export class BooleanFeatureService {
  private panel: BooleanPanel;
  private button: FeatureButton;
  private armed = false;
  private available = false;
  private targetOptions: SolidTargetOption[] = [];
  /** The chosen targets, in argument order — [base, tool] on subtract. */
  private targets: (BooleanTargetChoice | null)[] = [];
  private sceneSketchActive = false;
  private sketchUI: SketchUISuspender;
  /** The shared whole-solid highlight (the target chips' viewport echo). */
  private solidPick: SolidPickSelection;
  /** Statement being edited in place (timeline double-click), or null. */
  private editTarget: FeatureEditTarget | null = null;
  /** The parsed statement the edit dialog opened over (keep-slot texts). */
  private editStatement: Extract<ParsedFeatureStatement, { feature: 'boolean' }> | null = null;
  /** View-state half of edit mode: pre-statement rollback + boundary. */
  private session = new EditSession();
  private runner: ApplyRunner<BooleanApplyOptions | BooleanEditOptions>;

  constructor(
    container: HTMLElement,
    private viewer: Viewer,
    private navbar: Navbar,
    private hooks: {
      /** May return the current selection state — it seeds the dialog. */
      onEnter?: () => BooleanEnterSeed | void;
      /** Armed or disarmed — lets the Sketch button owner re-check `isActive`. */
      onActiveChange?: () => void;
      onSuspendSketchUI?: () => void;
      onResumeSketchUI?: () => void;
    } = {},
  ) {
    // Boolean sits in its own group right after the repeat/copy pair, so the
    // navbar draws its managed divider between the replay buttons and the
    // combine button. Like repeat the group is *not* `immune`: it hides while
    // the exclusive sketch toolbar owns the bar.
    const group = navbar.addGroup('boolean', { visible: false });
    this.button = new FeatureButton(group, {
      icon: '/icons/fuse.png',
      label: 'Boolean',
      tip: 'Boolean operations',
      ariaLabel: 'Combine solids — fuse, subtract or common',
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

    this.panel = new BooleanPanel(container);
    this.panel.onApply = () => void this.runner.apply();
    this.panel.onExit = () => this.exit();
    this.panel.onChange = () => {
      this.panel.setMessage(null);
      this.runner.schedulePreview();
    };
    this.panel.onKindChange = () => this.reshapeTargets();
    this.panel.onRemoveTarget = (index) => {
      if (this.panel.kind === 'subtract') {
        this.targets[index] = null;
      } else {
        this.targets.splice(index, 1);
      }
      this.panel.setMessage(null);
      this.refresh();
      this.runner.schedulePreview();
    };

    this.runner = new ApplyRunner({
      panel: this.panel,
      isArmed: () => this.armed,
      build: () => this.editTarget ? this.buildEditRequest() : this.buildRequest(),
      send: (request, extras) => this.editTarget
        ? applyBooleanEdit(this.editTarget, { ...(request as BooleanEditOptions), ...extras })
        : applyBoolean({ ...(request as BooleanApplyOptions), ...extras }),
      onApplied: () => this.exit(this.editTarget ? { editEnd: 'apply' } : { resume: 'lazy' }),
      failMessage: () => this.editTarget ? 'Could not apply the edit.' : 'Could not apply the boolean operation.',
    });
  }

  get isActive(): boolean {
    return this.armed;
  }

  /** An edit session is open (the viewport shows the pre-statement rollback). */
  get isEditing(): boolean {
    return this.editTarget !== null;
  }

  /** The armed dialog owns viewport clicks — every pick is a whole solid. */
  get isPicking(): boolean {
    return this.armed;
  }

  /** True while armed picking has suspended sketch editing. */
  get sketchUISuspended(): boolean {
    return this.sketchUI.suspended;
  }

  /**
   * Every render lands here. An open edit session owns the view: it keeps
   * the viewport rolled back to just before the edited statement, and at
   * that boundary the target options rebuild from the pre-statement scene —
   * exactly the solids the boolean's arguments can reference.
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
    // targets re-match by source line; a keep that resolved to a solid
    // statement becomes that statement's option — proper label, create-mode
    // toggling; unresolved keeps stay text-addressed verbatim.
    this.targetOptions = collectSolidTargets(sceneObjects);
    this.targets = this.targets.map((target): BooleanTargetChoice | null => {
      if (target === null) {
        return null;
      }
      if (target.kind === 'keep') {
        const match = target.loc && this.targetOptions.find(o =>
          o.filePath === target.loc!.filePath && o.line === target.loc!.line);
        return match ? { kind: 'option', option: match } : target;
      }
      const match = this.targetOptions.find(o =>
        o.filePath === target.option.filePath && o.line === target.option.line);
      return match ? { kind: 'option', option: match } : null;
    });
    this.compactUnlessSubtract();
    this.syncViewport();
    this.refresh();
    this.runner.schedulePreview();
  }

  update(sceneObjects: SceneObjectRender[]): void {
    this.targetOptions = collectSolidTargets(sceneObjects);
    this.sceneSketchActive = collectSketchProfiles(sceneObjects)[0]?.kind === 'active';
    // Visible from the first solid, like Repeat/Copy — a boolean needs two,
    // but hiding at one made the button vanish right after an applied
    // boolean consumed its operands; the dialog explains when solids are
    // missing instead — which is also what a blank document gets (see
    // {@link Viewer.sceneIsEmpty}).
    this.available = this.targetOptions.length >= 1 || this.viewer.sceneIsEmpty;
    this.navbar.setGroupVisible('boolean', this.available);
    this.button.setVisible(this.available);
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
    // Chosen targets re-match against the fresh options by source line;
    // shape ids changed with the render.
    this.targets = this.targets.map((target): BooleanTargetChoice | null => {
      if (target === null || target.kind === 'keep') {
        return target;
      }
      const match = this.targetOptions.find(o =>
        o.filePath === target.option.filePath && o.line === target.option.line);
      return match ? { kind: 'option', option: match } : null;
    });
    this.compactUnlessSubtract();
    this.syncViewport();
    this.refresh();
    this.runner.schedulePreview();
  }

  /**
   * Open the dialog over an existing fuse/subtract/common statement
   * (timeline double-click). The session rolls the viewport back to just
   * before the statement — the world its arguments see, where the solids it
   * references are visible and pickable. The tab is the statement's own
   * callee; the targets seed as one kept chip per statement argument,
   * toggled and re-picked like create mode. Apply rewrites the statement in
   * place.
   */
  enterEdit(
    target: FeatureEditTarget,
    parsed: Extract<ParsedFeatureStatement, { feature: 'boolean' }>,
    info: Omit<EditSessionInfo, 'target'>,
  ): void {
    if (this.armed) {
      this.exit();
    }
    this.hooks.onEnter?.();
    this.armed = true;
    this.editTarget = target;
    this.editStatement = parsed;
    this.targets = parsed.targetTexts.map((label, sourceIndex) => {
      const ref = parsed.targetRefs[sourceIndex];
      return {
        kind: 'keep' as const,
        sourceIndex,
        label,
        loc: ref ? { filePath: target.filePath, line: ref.line, column: ref.column } : undefined,
      };
    });
    this.syncButton();
    this.sketchUI.suspend();
    this.session.begin({ ...info, target });
    this.panel.showEdit(parsed.kind);
    this.syncViewport();
    this.refresh();
    this.runner.schedulePreview();
  }

  enter(): void {
    if (this.armed) {
      return;
    }
    this.session.end('continue');
    const seeded = this.hooks.onEnter?.();
    this.armed = true;
    this.targets = [];
    // Composing a boolean means looking at the whole scene, not down the
    // active sketch plane — leave sketch editing right away (resumed on
    // cancel; an apply's re-render takes over).
    if (this.sceneSketchActive) {
      this.sketchUI.suspend();
    }
    this.syncButton();
    this.panel.show();
    if (seeded) {
      this.seedFromSelection(seeded);
    }
    this.syncViewport();
    this.refresh();
    this.runner.schedulePreview();
  }

  /**
   * Arm the dialog around whatever was already selected: every selected
   * face/edge resolves to its owning solid, and the distinct solids open as
   * the initial target chips (the fuse tab's list).
   */
  private seedFromSelection({ seed }: BooleanEnterSeed): void {
    for (const entity of seed) {
      const option = solidTargetForShapeId(entity.shapeId, this.targetOptions);
      if (option && !this.targets.some(t => t?.kind === 'option'
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
    this.editStatement = null;
    this.targets = [];
    this.solidPick.set([]);
    this.runner.cancelPreview();
    this.viewer.clearHighlight();
    this.viewer.pickFilter = 'all';
    this.viewer.pickAxes = false;
    this.syncButton();
    this.panel.hide();
    this.sketchUI.resume((opts.resume ?? 'immediate') === 'immediate');
  }

  /**
   * Routes viewer clicks while the dialog is armed: any face or edge click
   * selects the owning solid whole and lands in the armed slot. Empty-space
   * clicks keep the selection.
   */
  handleClick(shapeId: string | null, sub: SubSelection): void {
    if (!this.armed || !shapeId || !sub || (sub.type !== 'face' && sub.type !== 'edge')) {
      return;
    }
    const option = solidTargetForShapeId(shapeId, this.targetOptions);
    if (!option) {
      this.panel.setMessage('That shape cannot be combined — pick a solid.');
      return;
    }
    this.pickTarget(option);
  }

  /**
   * A timeline row was clicked while the dialog is armed: a solid row lands
   * in the armed slot. Every row is consumed so the default rollback can't
   * close the dialog mid-flow.
   */
  handleTimelinePick(obj: SceneObjectRender): boolean {
    if (!this.armed) {
      return false;
    }
    const option = solidTargetForRow(obj, this.targetOptions);
    if (!option) {
      this.panel.setMessage('That row has no solid to combine — pick a solid-producing feature.');
      return true;
    }
    this.pickTarget(option);
    return true;
  }

  /**
   * A whole-solid pick (viewport or timeline). Fuse/Common toggle it in the
   * ordered list; Subtract routes it to the armed Base/Tool slot — picking
   * a solid already in either slot toggles it off instead, and a filled
   * Base hands the armed border to an empty Tool.
   */
  private pickTarget(option: SolidTargetOption): void {
    // A kept target that resolved to this statement counts as the same chip
    // — the pick toggles it off instead of duplicating the solid.
    const existing = this.targets.findIndex(t => t !== null && (t.kind === 'option'
      ? t.option.filePath === option.filePath && t.option.line === option.line
      : t.loc !== undefined && t.loc.filePath === option.filePath && t.loc.line === option.line));
    if (this.panel.kind === 'subtract') {
      if (existing >= 0) {
        this.targets[existing] = null;
      } else {
        const index = this.panel.armedSlot === 'tool' ? 1 : 0;
        this.targets[index] = { kind: 'option', option };
        this.panel.armSlot(index === 0 && !this.targets[1] ? 'tool' : index === 0 ? 'base' : 'tool');
      }
    } else {
      if (existing >= 0) {
        this.targets.splice(existing, 1);
      } else {
        this.targets.push({ kind: 'option', option });
      }
      this.panel.armSlot('targets');
    }
    this.panel.setMessage(null);
    this.refresh();
    this.runner.schedulePreview();
  }

  /**
   * The operation tab changed. Entering Subtract keeps the first two picks
   * as Base and Tool (extra picks drop — a subtract takes exactly two);
   * leaving it compacts any hole out of the list.
   */
  private reshapeTargets(): void {
    const dense = this.targets.filter((t): t is BooleanTargetChoice => t !== null);
    if (this.panel.kind === 'subtract') {
      if (dense.length > 2) {
        this.panel.setMessage('A subtract takes exactly two solids — the first two picks were kept.');
      }
      this.targets = dense.slice(0, 2);
    } else {
      this.targets = dense;
    }
    this.refresh();
    this.runner.schedulePreview();
  }

  /** One target's request ref (create mode never carries keeps). */
  private targetRef(choice: BooleanTargetChoice): BooleanEditTargetRef {
    return choice.kind === 'keep'
      ? { kind: 'verbatim', sourceIndex: choice.sourceIndex }
      : {
        kind: 'feature',
        filePath: choice.option.filePath,
        line: choice.option.line,
        column: choice.option.column,
      };
  }

  private buildRequest(): BooleanApplyOptions | { error: string } {
    const kind = this.panel.kind;
    if (kind === 'subtract') {
      const base = this.targets[0];
      const tool = this.targets[1];
      if (!base) {
        return { error: 'Pick the base solid in the viewport first.' };
      }
      if (!tool) {
        return { error: 'Pick the solid to subtract first.' };
      }
      return { kind, targets: [base, tool].flatMap(t => t.kind === 'option'
        ? [{ filePath: t.option.filePath, line: t.option.line, column: t.option.column }]
        : []) };
    }
    const dense = this.targets.filter((t): t is BooleanTargetChoice => t !== null);
    if (dense.length < 2) {
      return { error: `Pick at least two solids to ${kind === 'common' ? 'intersect' : 'fuse'} first.` };
    }
    // Create mode never carries keep entries — every chip is a picked solid.
    return { kind, targets: dense.flatMap(t => t.kind === 'option'
      ? [{ filePath: t.option.filePath, line: t.option.line, column: t.option.column }]
      : []) };
  }

  /**
   * The edit-mode apply payload. Untouched chips ship as verbatim keeps —
   * the transform preserves the statement's expressions byte for byte; the
   * target list mixes kept statement targets with re-picked solids. An
   * untouched implicit fuse/common (no statement arguments, nothing picked)
   * stays implicit.
   */
  private buildEditRequest(): BooleanEditOptions | { error: string } {
    const kind = this.panel.kind;
    const sessionFields = { expectedStatement: this.session.expectedStatement };
    if (kind === 'subtract') {
      const base = this.targets[0];
      const tool = this.targets[1];
      if (!base) {
        return { error: 'Pick the base solid in the viewport first.' };
      }
      if (!tool) {
        return { error: 'Pick the solid to subtract first.' };
      }
      return { kind, targets: [this.targetRef(base), this.targetRef(tool)], ...sessionFields };
    }
    const dense = this.targets.filter((t): t is BooleanTargetChoice => t !== null);
    if (dense.length === 0) {
      if ((this.editStatement?.targetTexts.length ?? 0) > 0) {
        return { error: 'Pick the solids to combine in the viewport first.' };
      }
      // An originally implicit statement stays implicit while untouched.
      return { kind, ...sessionFields };
    }
    if (dense.length < 2) {
      return { error: `Pick at least two solids to ${kind === 'common' ? 'intersect' : 'fuse'} first.` };
    }
    return { kind, targets: dense.map(t => this.targetRef(t)), ...sessionFields };
  }

  // -------------------------------------------------------------------------
  // Viewport reflection + sketch-editing suspension
  // -------------------------------------------------------------------------

  /** Every pick is a whole solid — any face or edge click selects it. */
  private syncViewport(): void {
    if (!this.armed) {
      return;
    }
    this.viewer.pickSketchWires = false;
    this.viewer.pickAxes = false;
    this.viewer.pickFilter = 'all';
  }

  /** Holes exist only on the subtract tab; the list tabs keep it dense. */
  private compactUnlessSubtract(): void {
    if (this.panel.kind !== 'subtract') {
      this.targets = this.targets.filter(t => t !== null);
    }
  }

  /** Repaint the target chips and the whole-solid highlight. */
  private refresh(): void {
    if (!this.armed) {
      return;
    }
    this.panel.setTargets(this.targets.map(target => target === null
      ? null
      : target.kind === 'keep'
        ? { label: `Current: ${target.label}`, removable: true }
        : sourceChip(target.option, { removable: true })));
    this.solidPick.set(this.targets.flatMap(t => t?.kind === 'option' ? t.option.shapeIds : []));
    this.solidPick.refreshHighlight();
  }

  private syncButton(): void {
    this.button.setActive(this.armed);
    // Every armed flip lands here — the Sketch button disables while a
    // create dialog is up.
    this.hooks.onActiveChange?.();
  }
}
