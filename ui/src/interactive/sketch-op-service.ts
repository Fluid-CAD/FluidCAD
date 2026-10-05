import {
  applyFillet2DEdit, applyOffsetEdit, applySketchOp, clearBreakpoints,
  fetchFeatureGhost, fetchSketchFeatureSources, fetchSketchOffsetPlan, FeatureEditTarget, Fillet2DGhostRequest, GhostSolid,
  NewVariable, OffsetGhostRequest, OffsetOptionValues, ParsedFeatureStatement,
  SketchApplyEntity, SketchOffsetPlanChain, SketchOpFeature, sketchGhostScope, SketchSourceRef, ValueExpr,
} from '../api';
import type { SolvedSketchModel } from '../sketch-solver-client/model';
import type { SolvedPick } from './sketch-hover-select-handler';
import {
  buildFilletPlan, type FilletPlan, type FilletPlanError, type SketchFilletRequest,
} from './tools/fillet-plan';
import { buildOffsetEmission, offsetNeedsStatement, offsetSourcePicks } from './tools/offset-emission';
import type { SolvedEmissionRequest, SolvedEmitResult } from './tools/solved-emission';
import { ExpressionRow } from './modify-pick/expression-row';
import { PickSlot, PickSlotChip } from './pick-slot';
import { FeatureGhostOverlay } from './create-feature/feature-ghost';
import { keepChip } from './create-feature/sketch-profiles';
import { DIALOG_DOCK_CLASS, DIALOG_COLUMN_CLASS, PanelShell } from './create-feature/panel-controls';
import { ExpressionField } from '../ui/expression-field';
import { VariableInfo } from '../ui/expression-core';
import { viewportChrome } from '../ui/viewport-chrome';

const PREVIEW_DEBOUNCE_MS = 250;

/** The statement options a 2D op carries beyond its picks. */
export type SketchOpToggleKey = 'close';

/** What a picked sketch shape shows as a chip: its entity's name and line. */
export type SketchPickDescription = {
  label: string;
  /** The owning statement's unique type (`solved-line`, `bezier-4`, …). */
  uniqueType?: string;
  /** Source line of the pick's statement — the chip's jump badge. */
  line?: number;
  /** Navigate to the pick's statement (the line badge was clicked). */
  goTo?: () => void;
};

/**
 * The surface the sketch toolbar drives on every 2D op dialog — the shared
 * {@link SketchOpService} and the standalone dialogs (the in-sketch copy)
 * alike: arming, teardown, selection-change refresh, and the edit dialog's
 * sketch-arrival handshake.
 */
export type SketchOpDialog = {
  onVisibilityChange?: (visible: boolean) => void;
  readonly isActive: boolean;
  readonly isEditing: boolean;
  readonly isAwaitingSketch: boolean;
  enter(): void;
  exit(): void;
  refresh(): void;
  noteSketchActive(): void;
};

/**
 * A 2D op dialog's window onto the solved-sketch world: the resolved picks
 * and read model its client-side plan consumes, and the rails its Apply
 * writes through. The constraint-native CREATE paths use it (mirror:
 * reflected geometry + symmetric rows through the atomic insert-solved
 * emission; fillet: the corner plans through the fillet transform) — an
 * edit dialog still rewrites its legacy statement through the synthesis
 * rail.
 */
export type SolvedOpRail = {
  picks(): SolvedPick[];
  model(): SolvedSketchModel | null;
  emit(request: SolvedEmissionRequest): Promise<SolvedEmitResult>;
  /** Round the planned corners — the sketch settles on its solved
   * positions in the same edit. */
  fillet(request: SketchFilletRequest & { newVariables?: NewVariable[] }): Promise<SolvedEmitResult>;
};

/**
 * A dialog's window onto the solved picks the hover handler owns beyond
 * plain edge ids: the ordered picks (vertices, datums, references) and the
 * eviction hook that drops one of them from the viewport selection.
 */
export type SolvedPickRail = {
  picks(): SolvedPick[];
  deselect(pick: SolvedPick): void;
};

/** The dialog's window onto the sketch selection the hover handler owns. */
export type SketchOpSelection = {
  /** The picked shape ids, in pick order. */
  ids: () => string[];
  /** Chip content for one picked shape. */
  describe: (shapeId: string) => SketchPickDescription;
  /** Drop every pick. */
  clear: () => void;
  /** Drop one pick (a chip's ✕). */
  deselect: (shapeId: string) => void;
  /** Replace the picks (the edit dialog seeding the statement's targets). */
  select: (shapeIds: string[]) => void;
};

/**
 * Where a 2D op dialog's statement reads its names: the active sketch. The
 * value fields offer the variables visible there, and a created op's ghost
 * resolves them at the end of the sketch's body, where the statement lands.
 */
export type SketchOpScope = {
  /** The variables the value fields offer. */
  variables: () => Promise<VariableInfo[]>;
  /** The active sketch's statement, or null while no sketch is active. */
  sketch: () => SketchSourceRef | null;
};

/** The per-operation dressing of the shared 2D op dialog. */
export type SketchOpConfig = {
  feature: SketchOpFeature;
  title: string;
  pickHint: string;
  /**
   * The numeric parameter row (fillet radius, offset distance).
   * 'positive' forbids ≤0, 'nonzero' allows negative (offset).
   */
  value?: { label: string; defaultValue: string; sign: 'positive' | 'nonzero' };
  /**
   * Boolean statement options — offset's `removeOriginal` argument and its
   * `.close()` chain, or slot's `deleteSource`. Multiple toggles are mutually
   * exclusive: checking one clears the others, since a removed original
   * leaves a closed offset nothing to cap to (the kernel throws on the pair).
   */
  toggles?: { key: SketchOpToggleKey; label: string; title: string; defaultChecked?: boolean }[];
};

/** A constrained offset plan as the dialog keeps it between preview and Apply. */
type OffsetPlanOutcome =
  | { ok: true; chains: SketchOffsetPlanChain[]; sources: SolvedPick[]; solids: GhostSolid[]; distanceExpr: string }
  | { ok: false; reason: string };

/** An `offset()` or 2D `fillet()` statement as the parse route reads it. */
type ParsedSketchOp = Extract<ParsedFeatureStatement, { feature: 'offset' } | { feature: 'fillet' }>;

/**
 * The shared 2D operation dialog (fillet, offset): armed from the sketch
 * toolbar, it reads the hover handler's selected edges — mirrored into the
 * unified {@link PickSlot} chips every pick-driven dialog carries — previews
 * the synthesized statement through `api/apply-feature` (sketch branch),
 * and applies it — writing `fillet(4, r.edge('top'), l)` /
 * `offset(2, r.edge('top')).close()` into the sketch body. The expression
 * row is editable (expression transparency) with verified alternatives.
 *
 * The same dialog edits an existing statement in place ({@link enterEdit},
 * offset and fillet today): the timeline double-click's breakpoint pauses the build
 * just BEFORE that statement, so the sketch on screen is the one its
 * arguments see — the statement's own result absent, a removed original
 * visible again — its options seed the fields, its targets seed the
 * expression row, and picking edges re-targets it.
 */
export class SketchOpService {
  /**
   * Fired on enter/exit. The dialog docks in the sketch dialog's spot, so
   * main.ts wires this (via the sketch toolbar service) to suspend the sketch
   * dialog while this one is open and restore it after.
   */
  onVisibilityChange?: (visible: boolean) => void;

  private readonly panel: HTMLDivElement;
  private readonly valueInput: HTMLInputElement | null;
  private readonly valueField: ExpressionField | null;
  private readonly title: HTMLSpanElement;
  private readonly hint: HTMLDivElement;
  private readonly errorLine: HTMLDivElement;
  private readonly applyBtn: HTMLButtonElement;
  private readonly expression: ExpressionRow;
  /** The picked-edge chips. */
  private readonly pickSlot: PickSlot;
  private readonly toggles = new Map<SketchOpToggleKey, HTMLInputElement>();

  private active = false;
  private previewTimer: number | null = null;
  private previewAbort: AbortController | null = null;
  private applying = false;

  /** Statement being edited in place (timeline double-click), or null. */
  private editTarget: FeatureEditTarget | null = null;
  /** The statement's own target args — the override-detection baseline. */
  private editArgsText = '';
  /** Chain text at dialog-open; the transform refuses when it drifted. */
  private expectedStatement: string | undefined;
  /**
   * An edit dialog that has not yet seen its sketch. The double-click's
   * breakpoint render is still in flight, so the sketch-less scene it opened
   * over must not fold the dialog away.
   */
  private awaitingEditSketch = false;
  /** Signature of the seeded (statement-own) picks; dirty picks re-synthesize. */
  private seedSignature: string | null = null;
  /** A seed round-trip is in flight — don't start another. */
  private seedLoading = false;

  /** Scope variables from the last load — the fillet plan resolves a
   * variable-named radius to its numeric initializer for the guess. */
  private scopeVariables: VariableInfo[] = [];

  /**
   * The constrained offset's last server plan (OCCT, sharp corners) with
   * the picks it was made for and a key of everything it depends on — Apply
   * reuses it when nothing changed, else re-plans first.
   */
  private offsetPlan: { key: string; chains: SketchOffsetPlanChain[]; sources: SolvedPick[] } | null = null;

  constructor(
    container: HTMLElement,
    private readonly config: SketchOpConfig,
    private readonly selection: SketchOpSelection,
    private readonly scope: SketchOpScope,
    private onDone: () => void,
    /** The live viewport geometry overlay; offset and fillet draw into it. */
    private readonly ghost?: FeatureGhostOverlay,
    /** Constraint-native rail — the fillet and offset CREATE paths plan
     * against the solved picks + model and emit through insert-solved. */
    private readonly solved?: SolvedOpRail,
  ) {
    this.panel = document.createElement('div');
    this.panel.id = `fluidcad-sketch-${config.feature}-panel`;
    this.panel.className = `hidden ${DIALOG_DOCK_CLASS}`;
    const valueRow = config.value
      ? `
          <label class="flex flex-col gap-1.5">
            <span class="text-base-content/70">${config.value.label}</span>
            <input data-role="value" type="number" step="0.5" value="${config.value.defaultValue}"
              ${config.value.sign === 'positive' ? 'min="0"' : ''}
              class="input input-sm input-bordered w-full font-mono text-xs" />
          </label>`
      : '';
    const toggleRows = (config.toggles ?? []).map(toggle => `
          <label class="flex items-center justify-between cursor-pointer" title="${toggle.title}">
            <span class="text-base-content/70">${toggle.label}</span>
            <input data-role="toggle-${toggle.key}" type="checkbox" class="toggle toggle-sm toggle-primary" />
          </label>`).join('');
    // The unified pick slot's prompt asks for the picks, so the hint line
    // starts empty and only surfaces value errors.
    const pickSlotHost = `
          <div data-role="pick-slot"></div>`;
    const hintRow = `
          <div data-role="hint" class="hidden text-base-content/50"></div>`;
    this.panel.innerHTML = `
      <div data-role="column" class="${DIALOG_COLUMN_CLASS}">
        ${PanelShell.frameHtml({
          header: `<span data-role="title" class="font-medium text-sm">${config.title}</span>`,
          body: `
          <div data-role="pick-body" class="flex flex-col items-stretch gap-3.5">${pickSlotHost}${hintRow}${valueRow}${toggleRows}</div>`,
          footer: `
            <button data-role="apply" class="btn btn-primary btn-sm flex-1" disabled>Apply</button>
            <button data-role="cancel" class="btn btn-ghost btn-sm">Cancel</button>`,
        })}
      </div>
    `;
    container.appendChild(this.panel);
    PanelShell.watchScroll(this.panel.querySelector('[data-role="box"]')!);

    this.valueInput = this.panel.querySelector('[data-role="value"]');
    this.title = this.panel.querySelector('[data-role="title"]')!;
    this.hint = this.panel.querySelector('[data-role="hint"]')!;
    this.applyBtn = this.panel.querySelector('[data-role="apply"]')!;
    for (const toggle of config.toggles ?? []) {
      this.toggles.set(toggle.key, this.panel.querySelector(`[data-role="toggle-${toggle.key}"]`)!);
    }
    this.pickSlot = new PickSlot(this.panel.querySelector('[data-role="pick-slot"]')!, { label: 'Selection', multiple: true });
    // Picking is live the whole time the dialog is up — the slot always
    // wears the pick-target styling (matches ModifyPanel).
    this.pickSlot.setArmed(true);
    this.pickSlot.onRemove = (index) => {
      const shapeId = this.selection.ids()[index];
      if (shapeId !== undefined) {
        this.selection.deselect(shapeId);
      }
    };

    // The expression row and the error message dock under the dialog body,
    // matching the 3D dialogs (see ModifyPanel).
    const column = this.panel.querySelector<HTMLElement>('[data-role="column"]')!;
    this.expression = new ExpressionRow(column);
    this.errorLine = document.createElement('div');
    this.errorLine.className = 'hidden sm:max-w-[380px] bg-error text-error-content rounded-lg px-3 py-2 text-xs leading-snug shadow-md';
    column.appendChild(this.errorLine);

    this.expression.setSuffix(')');
    this.expression.onSubmit = () => this.apply();

    // The field owns the input's keyboard handling (variable dropdown,
    // Enter-to-apply) and flips it to type="text" for identifiers — the same
    // expression behavior as the 3D dialogs' value fields.
    this.valueField = this.valueInput ? new ExpressionField(this.valueInput) : null;
    if (this.valueField) {
      this.valueField.onSubmit = () => this.apply();
      this.valueInput!.addEventListener('input', () => this.schedulePreview());
    }
    for (const [key, input] of this.toggles) {
      input.addEventListener('change', () => {
        // Mutually exclusive: checking one clears the rest.
        if (input.checked) {
          for (const [other, box] of this.toggles) {
            box.checked = other === key;
          }
        }
        this.schedulePreview();
      });
    }
    this.applyBtn.addEventListener('click', () => this.apply());
    this.panel.querySelector('[data-role="cancel"]')!.addEventListener('click', () => {
      // An edit dialog may outlive its toolbar arming (the bar hides while
      // the breakpoint render is in flight), so close it here rather than
      // relying on the toolbar's own disarm to find it.
      this.exit();
      this.onDone();
    });
  }

  get isActive(): boolean {
    return this.active;
  }

  /** True while the dialog rewrites an existing statement instead of writing one. */
  get isEditing(): boolean {
    return this.editTarget !== null;
  }

  /**
   * True until the edit dialog's own sketch has rendered. The toolbar service
   * keeps the dialog (and the picking handlers) alive through that window.
   */
  get isAwaitingSketch(): boolean {
    return this.awaitingEditSketch;
  }

  /** The edit dialog's sketch has rendered — normal teardown rules resume. */
  noteSketchActive(): void {
    this.awaitingEditSketch = false;
    if (this.editTarget) {
      // Seed the statement's own targets as highlighted picks — deferred
      // past the toolbar's update() so the pick handlers are armed over the
      // just-arrived sketch before the seed selects into them.
      window.setTimeout(() => void this.seedEditSelection(), 0);
    }
  }

  /**
   * Seed the pick set with the statement's own target edges, resolved by the
   * server against the paused sketch — the highlighted, removable chips the
   * edit opens with. Unresolvable args (exotic expressions) leave the set
   * empty and the keep chip standing. A re-picked (dirty) selection is never
   * clobbered; seeded ids that died with a re-render re-seed against the new
   * scene.
   */
  private async seedEditSelection(): Promise<void> {
    const target = this.editTarget;
    if (!target || this.seedLoading) {
      return;
    }
    if (this.selection.ids().length === 0) {
      // Empty means unseeded, pruned by a re-render, or user-cleared — in
      // all of them the statement's own targets are what an apply keeps, so
      // (re-)seeding shows the truth.
      this.seedSignature = null;
    }
    if (this.picksDirty()) {
      return;
    }
    this.seedLoading = true;
    try {
      const result = await fetchSketchFeatureSources(target, this.expectedStatement);
      if (this.editTarget !== target || this.picksDirty()) {
        return;
      }
      if (result.ok && result.shapeIds.length > 0) {
        this.selection.select(result.shapeIds);
        this.seedSignature = this.selectionSignature();
      }
    } finally {
      this.seedLoading = false;
    }
  }

  /** Sorted signature of the current picks, for seed-dirty detection. */
  private selectionSignature(): string {
    return [...this.selection.ids()].sort().join('|');
  }

  /**
   * True when the selection no longer matches the seeded one — the apply
   * then sends the picks for synthesis instead of keeping the args verbatim.
   */
  private picksDirty(): boolean {
    if (!this.editTarget) {
      return false;
    }
    if (this.seedSignature === null) {
      return this.selection.ids().length > 0;
    }
    return this.selectionSignature() !== this.seedSignature;
  }

  enter(): void {
    if (this.active && !this.editTarget) {
      return;
    }
    // Re-arming the tool over an open edit dialog abandons that edit — it
    // becomes a fresh statement, so the breakpoint it opened with goes too.
    this.exit();
    this.active = true;
    this.syncPickSlot();
    this.title.textContent = this.config.title;
    this.setToggles(this.defaultToggleValues());
    // A fresh sketch-toolbar arming is always inside a sketch — every toggle applies.
    this.setHiddenToggles([]);
    this.panel.classList.remove('hidden');
    viewportChrome.setDialogOpen(this.panel.id, true);
    this.onVisibilityChange?.(true);
    void this.loadVariables();
    this.schedulePreview();
  }

  /**
   * Open the dialog over the `offset()` statement at `target`, prefilled from
   * its parsed options. The double-click that got here left a breakpoint just
   * before the statement, so the build is paused inside its sketch at the
   * state the statement's arguments see: the fields seed from the statement,
   * the expression row seeds with its own target args (kept verbatim unless
   * edited), and picking edges re-targets it.
   */
  enterEdit(
    target: FeatureEditTarget,
    parsed: ParsedSketchOp,
    expectedStatement: string,
    opts: { hideToggles?: SketchOpToggleKey[] } = {},
  ): void {
    this.exit('reopen');
    this.active = true;
    this.editTarget = target;
    this.editArgsText = parsed.argsText;
    this.expectedStatement = expectedStatement;
    this.awaitingEditSketch = true;
    this.selection.clear();
    this.syncPickSlot();
    this.title.textContent = `Edit ${this.config.title.toLowerCase()}`;
    this.valueField?.setValue(parsed.value);
    this.setToggles(parsed.feature === 'offset'
      ? { close: parsed.close }
      : {});
    // Options the edited statement's context makes invalid (a face offset
    // outside a sketch takes no close chain) hide their rows; a hidden
    // toggle also unchecks, so an apply writes the valid form.
    this.setHiddenToggles(opts.hideToggles ?? []);
    this.panel.classList.remove('hidden');
    viewportChrome.setDialogOpen(this.panel.id, true);
    this.onVisibilityChange?.(true);
    void this.loadVariables();
    this.expression.show(parsed.argsText, []);
    this.syncExpressionPrefix(parsed.value);
    this.applyBtn.disabled = false;
    this.schedulePreview();
  }

  /** Seed (or reset) the toggle boxes; a no-op for ops without any. */
  private setToggles(values: Partial<Record<SketchOpToggleKey, boolean>>): void {
    for (const [key, input] of this.toggles) {
      input.checked = values[key] === true;
    }
  }

  /**
   * Hide (and uncheck) the given toggle rows for this dialog opening —
   * options the edited statement's context makes invalid. Openings that
   * pass none restore every row.
   */
  private setHiddenToggles(keys: SketchOpToggleKey[]): void {
    const hidden = new Set(keys);
    for (const [key, input] of this.toggles) {
      const row = input.closest('label');
      row?.classList.toggle('hidden', hidden.has(key));
      if (hidden.has(key)) {
        input.checked = false;
      }
    }
  }

  /** Each toggle's configured resting state (slot's Remove-original starts on). */
  private defaultToggleValues(): Partial<Record<SketchOpToggleKey, boolean>> {
    const values: Partial<Record<SketchOpToggleKey, boolean>> = {};
    for (const toggle of this.config.toggles ?? []) {
      values[toggle.key] = toggle.defaultChecked === true;
    }
    return values;
  }

  /** Offset's toggle as the statement carries it, or undefined for the rest. */
  private offsetOptions(): OffsetOptionValues | undefined {
    if (this.config.feature !== 'offset' || this.toggles.size === 0) {
      return undefined;
    }
    return {
      close: this.toggles.get('close')?.checked === true,
    };
  }

  /**
   * The static text around the editable args — `offset(2, ` … `).close()`
   * for the toggled form, `fillet(4, ` … `)` for the rest.
   */
  private syncExpressionPrefix(value: ValueExpr | undefined): void {
    const offset = this.offsetOptions();
    this.expression.setPrefix(value === undefined
      ? `${this.config.feature}(`
      : `${this.config.feature}(${value}, `);
    this.expression.setSuffix(offset?.close ? ').close()' : ')');
  }

  /** Feed the sketch scope's variables to the value field's dropdown. */
  private async loadVariables(): Promise<void> {
    if (!this.valueField) {
      return;
    }
    const variables = await this.scope.variables();
    if (this.active) {
      this.scopeVariables = variables;
      this.valueField.setVariables(variables);
    }
  }

  /** Whether this dialog opening emits a constraint-native fillet (P8):
   * the fillet CREATE path in a solved sketch. Edits keep rewriting their
   * legacy `fillet()` statement through the synthesis rail. */
  private isConstraintNativeFillet(): boolean {
    return this.config.feature === 'fillet'
      && this.solved !== undefined
      && this.editTarget === null;
  }

  /** Whether this dialog opening emits a constraint-native offset: the
   * offset CREATE path in a solved sketch, for a selection the offsetFrom
   * tie can hold (lines, arcs, circles). A selection with a bezier or an
   * ellipse in it is written as an `offset()` statement through the
   * synthesis rail, like edits, which keep rewriting their `offset()`
   * statement there. Re-read on every preview and apply: a pick added or
   * dropped mid-dialog moves the selection between the two rails. */
  private isConstraintNativeOffset(): boolean {
    return this.config.feature === 'offset'
      && this.solved !== undefined
      && this.editTarget === null
      && !offsetNeedsStatement(this.selection.ids().map(id => this.selection.describe(id).uniqueType));
  }

  /** The signed numeric distance behind the committed value (the OCCT plan
   * needs a number; its sign picks the side), or null when it is not one. */
  private numericDistance(value: ValueExpr, newVariable?: NewVariable): number | null {
    if (typeof value === 'number') {
      return value !== 0 ? value : null;
    }
    const initializer = newVariable?.name === value
      ? newVariable.initializer
      : this.scopeVariables.find(v => v.name === value)?.initializer;
    const n = initializer !== undefined ? parseFloat(initializer) : NaN;
    return isFinite(n) && n !== 0 ? n : null;
  }

  /**
   * Plan the constrained offset for the current picks + value: the server
   * offsets the chain (OCCT, sharp corners) and hands back the primitives
   * and their ghost. The plan is kept for Apply under a key of its inputs.
   */
  private async planConstrainedOffset(signal: AbortSignal): Promise<OffsetPlanOutcome | null> {
    const read = this.readValue();
    if (!read || 'error' in read) {
      return null;
    }
    const distance = this.numericDistance(read.value, read.newVariable);
    if (distance === null) {
      return {
        ok: false,
        reason: 'enter a numeric distance or a numeric variable — the offset dimension can be edited to any expression afterwards',
      };
    }
    // The statement's value is the positive distance; the side is the
    // guesses'. A negative literal flips to its magnitude; a negative
    // variable would write a statement that refuses at build.
    let distanceExpr: string;
    if (typeof read.value === 'number') {
      distanceExpr = String(Math.abs(read.value));
    } else if (distance < 0) {
      return { ok: false, reason: `${read.value} is negative — offsetFrom takes a positive distance; type the number with a sign to pick the side, or use a positive variable` };
    } else {
      distanceExpr = read.value;
    }
    const picked = offsetSourcePicks(this.solved!.picks());
    if ('reason' in picked) {
      return { ok: false, reason: picked.reason };
    }
    const entities = picked.picks.map(p => ({ shapeId: p.shapeId! }));
    const close = this.offsetOptions()?.close === true;
    const key = JSON.stringify([entities, distance, close]);
    const result = await fetchSketchOffsetPlan({ entities, distance, close }, signal);
    if ('reason' in result) {
      this.offsetPlan = null;
      return { ok: false, reason: result.reason };
    }
    this.offsetPlan = { key, chains: result.chains, sources: picked.picks };
    return { ok: true, chains: result.chains, sources: picked.picks, solids: result.solids, distanceExpr };
  }

  /** The numeric radius behind the committed value — the guess geometry
   * needs a number even when the dimension rides an expression. */
  private numericRadius(value: ValueExpr, newVariable?: NewVariable): number | null {
    if (typeof value === 'number') {
      return value > 0 ? value : null;
    }
    const initializer = newVariable?.name === value
      ? newVariable.initializer
      : this.scopeVariables.find(v => v.name === value)?.initializer;
    const n = initializer !== undefined ? parseFloat(initializer) : NaN;
    return isFinite(n) && n > 0 ? n : null;
  }

  /** The constraint-native fillet plan for the current picks + radius, or
   * null while the value field is invalid (incompleteReason covers that). */
  private planFillet(): FilletPlan | FilletPlanError | null {
    const read = this.readValue();
    if (!read || 'error' in read) {
      return null;
    }
    const model = this.solved!.model();
    if (!model) {
      return { ok: false, reason: 'the sketch has not rendered yet' };
    }
    const radius = this.numericRadius(read.value, read.newVariable);
    if (radius === null) {
      return {
        ok: false,
        reason: 'enter a numeric radius or a numeric variable — the radius dimension can be edited to any expression afterwards',
      };
    }
    return buildFilletPlan({
      picks: this.solved!.picks(),
      model,
      radius,
      radiusExpr: typeof read.value === 'number' ? String(read.value) : read.value,
    });
  }

  /**
   * Close the dialog. A cancelled edit clears the breakpoint its double-click
   * placed, so the model rebuilds to its tip. The other two reasons leave the
   * breakpoints alone: `apply`'s own transform strips them atomically with
   * the rewrite (clearing again here could clobber that write), and `reopen`
   * hands over to a fresh edit whose breakpoint is already in the file.
   */
  exit(reason: 'cancel' | 'apply' | 'reopen' = 'cancel'): void {
    if (!this.active) {
      return;
    }
    const wasEditing = this.editTarget !== null;
    this.active = false;
    this.editTarget = null;
    this.editArgsText = '';
    this.expectedStatement = undefined;
    this.awaitingEditSketch = false;
    this.seedSignature = null;
    this.offsetPlan = null;
    this.panel.classList.add('hidden');
    viewportChrome.setDialogOpen(this.panel.id, false);
    this.cancelPreview();
    this.ghost?.clear();
    this.expression.hide();
    this.expression.setSuffix(')');
    this.setError(null);
    this.setHint(this.pickSlot ? null : this.config.pickHint);
    this.applyBtn.disabled = true;
    this.onVisibilityChange?.(false);
    if (wasEditing && reason === 'cancel') {
      clearBreakpoints();
    }
  }

  /** The selected set or the scene changed — refresh the chips and preview. */
  refresh(): void {
    if (this.active) {
      this.syncPickSlot();
      this.schedulePreview();
    }
  }

  /**
   * Mirror the picked edges into the slot as numbered chips; an edit with no
   * re-picks shows its statement's own targets as the keep chip instead (they
   * stand until edges are picked, and again when every pick is removed).
   */
  private syncPickSlot(): void {
    const chips: PickSlotChip[] = this.selection.ids().map((shapeId, index) => {
      const pick = this.selection.describe(shapeId);
      return {
        label: pick.label,
        badge: String(index + 1),
        removable: true,
        line: pick.line,
        onGoto: pick.goTo,
      };
    });
    if (chips.length === 0 && this.editTarget) {
      this.pickSlot.setChips([keepChip(this.editArgsText)]);
      this.pickSlot.setPrompt('Pick edges to re-target');
    } else {
      this.pickSlot.setChips(chips);
      this.pickSlot.setPrompt(chips.length === 0 ? this.config.pickHint : null);
    }
  }

  private toEntities(ids: string[]): SketchApplyEntity[] {
    return ids.map(shapeId => ({ shapeId }));
  }

  /**
   * Read the value field: null for valueless ops; a plain number gets the
   * feature's sign check; anything else commits as an expression (with the
   * optional `name = value` declaration to write alongside the statement).
   */
  private readValue(): { value: ValueExpr; newVariable?: NewVariable } | { error: string } | null {
    if (!this.config.value || !this.valueField) {
      return null;
    }
    const read = this.valueField.read();
    if ('error' in read) {
      return { error: read.error === 'empty' ? this.valueHint() : read.error };
    }
    if (typeof read.value === 'number'
      && (this.config.value.sign === 'positive' ? read.value <= 0 : read.value === 0)) {
      return { error: this.valueHint() };
    }
    return read;
  }

  private valueHint(): string {
    const value = this.config.value!;
    return value.sign === 'positive'
      ? `Enter a positive ${value.label.toLowerCase()}`
      : `Enter a nonzero ${value.label.toLowerCase()} (negative offsets inward)`;
  }

  /** What the current picks and value are missing, or null when previewable. */
  private incompleteReason(): { kind: 'picks' | 'value'; message: string } | null {
    // An edit keeps the statement's own targets until edges are picked, so
    // an empty selection is complete — it just changes nothing about them.
    if (!this.editTarget && this.selection.ids().length === 0) {
      return { kind: 'picks', message: this.config.pickHint };
    }
    const read = this.readValue();
    if (read && 'error' in read) {
      return { kind: 'value', message: read.error };
    }
    return null;
  }

  private schedulePreview(): void {
    if (!this.active) {
      return;
    }
    if (this.previewTimer !== null) {
      window.clearTimeout(this.previewTimer);
    }
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = null;
      void this.runPreview();
    }, PREVIEW_DEBOUNCE_MS);
  }

  private cancelPreview(): void {
    if (this.previewTimer !== null) {
      window.clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    this.previewAbort?.abort();
    this.previewAbort = null;
  }

  private async runPreview(): Promise<void> {
    this.previewAbort?.abort();

    const incomplete = this.incompleteReason();
    if (incomplete) {
      this.expression.hide();
      this.applyBtn.disabled = true;
      // The pick slot's own prompt already asks for the picks — the hint line
      // only carries what the slot can't say (value errors).
      this.setHint(this.pickSlot && incomplete.kind === 'picks' ? null : incomplete.message);
      this.setError(null);
      this.ghost?.clear();
      return;
    }

    const read = this.readValue();
    const value = read && !('error' in read) ? read.value : undefined;

    const abort = new AbortController();
    this.previewAbort = abort;

    // Constraint-native fillet (P8): the plan is computed client-side from
    // the solved model — no synthesis round trip. The corner-count hint
    // stands in for the statement expression row, and the OCCT ghost still
    // previews the resulting arcs.
    if (this.isConstraintNativeFillet()) {
      const plan = this.planFillet();
      this.expression.hide();
      if (plan?.ok) {
        this.setHint(plan.corners === 1
          ? '1 corner will be filleted'
          : `${plan.corners} corners will be filleted`);
        this.setError(null);
        this.applyBtn.disabled = false;
        await this.runGhost(value, abort.signal);
      } else {
        this.applyBtn.disabled = true;
        this.setHint(null);
        this.setError(plan && 'reason' in plan ? plan.reason : 'Enter a positive radius');
        this.ghost?.clear();
      }
      return;
    }

    // Constraint-native offset: the server plans the chain (OCCT, sharp
    // corners) and the plan's own meshed wires are the ghost — no statement
    // synthesis, no separate ghost round trip.
    if (this.isConstraintNativeOffset()) {
      this.expression.hide();
      let plan: Awaited<ReturnType<typeof this.planConstrainedOffset>>;
      try {
        plan = await this.planConstrainedOffset(abort.signal);
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          this.setError('Could not reach the FluidCAD server');
          this.ghost?.clear();
        }
        return;
      }
      if (abort.signal.aborted || !this.active) {
        return;
      }
      if (plan !== null && !('reason' in plan)) {
        const edges = plan.chains.reduce((n, chain) => n + chain.edges.length, 0);
        this.setHint(`${edges} ${edges === 1 ? 'edge' : 'edges'} will be offset as constrained geometry`);
        this.setError(null);
        this.applyBtn.disabled = false;
        this.ghost?.set(plan.solids, 'wire');
      } else {
        this.applyBtn.disabled = true;
        this.setHint(null);
        this.setError(plan !== null && 'reason' in plan ? plan.reason : 'Enter a nonzero distance');
        this.ghost?.clear();
      }
      return;
    }

    try {
      const result = await this.send({ value, preview: true, signal: abort.signal });
      if (abort.signal.aborted || !this.active) {
        return;
      }
      // An edit that re-picked nothing synthesizes no args — the statement's
      // own target list stands, and the row keeps showing it.
      const args = result.args ?? (this.editTarget ? this.editArgsText : undefined);
      if (result.success && args !== undefined) {
        this.setHint(null);
        this.setError(null);
        this.syncExpressionPrefix(value);
        this.expression.show(args, result.alternatives ?? []);
        this.applyBtn.disabled = false;
        // The statement preview's geometric twin, chained under the same
        // abort scope — the way ApplyRunner chains its ghost hook.
        await this.runGhost(value, abort.signal);
      } else {
        this.expression.hide();
        this.applyBtn.disabled = true;
        this.setError(result.reason ?? 'Could not synthesize a selector for this selection');
        // A statement the apply would refuse must not keep its geometry up.
        this.ghost?.clear();
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        this.setError('Could not reach the FluidCAD server');
        this.ghost?.clear();
      }
    }
  }

  /**
   * Draw the live ghost curves (offset wires, fillet arcs) for the
   * just-previewed values, or clear the overlay when the request can't be
   * addressed. Runs on the statement preview's own abort signal, so a
   * superseded preview also supersedes its ghost; a stale answer is dropped
   * rather than drawn.
   */
  private async runGhost(value: ValueExpr | undefined, signal: AbortSignal): Promise<void> {
    if (!this.ghost) {
      return;
    }
    const request = this.ghostRequest(value);
    if (!request) {
      this.ghost.clear();
      return;
    }
    let solids: GhostSolid[] | null;
    try {
      solids = await fetchFeatureGhost(request, sketchGhostScope(this.editTarget, this.scope.sketch()), signal);
    } catch {
      return; // aborted
    }
    if (signal.aborted || !this.active) {
      return;
    }
    if (solids) {
      this.ghost.set(solids, 'wire');
    } else {
      this.ghost.clear();
    }
  }

  /**
   * The live geometry request for the current dialog state, or null when this
   * op has none (offset and fillet ghost today) or the targets can't be
   * addressed. The picks travel as they are; with none picked, an edit whose
   * keep chip stands over an EMPTY argument list is the whole-sketch
   * `offset(d)` / `fillet(r)` form (entities: []), while one standing over
   * real target args has nothing addressable to preview — its seed either
   * failed or was cleared.
   */
  private ghostRequest(value: ValueExpr | undefined): OffsetGhostRequest | Fillet2DGhostRequest | null {
    if ((this.config.feature !== 'offset' && this.config.feature !== 'fillet')
      || value === undefined) {
      return null;
    }
    const ids = this.selection.ids();
    if (ids.length === 0 && (!this.editTarget || this.editArgsText.trim() !== '')) {
      return null;
    }
    const entities = ids.map(shapeId => ({ shapeId }));
    if (this.config.feature === 'fillet') {
      // `fillet2d` on the wire — plain `fillet` names the 3D band ghost.
      return { feature: 'fillet2d', radius: value, entities };
    }
    return {
      feature: 'offset',
      distance: value,
      close: this.offsetOptions()?.close === true,
      entities,
    };
  }

  /**
   * One request for both modes: an armed dialog synthesizes a new statement
   * for the picked edges; an edit rewrites the statement at `editTarget`,
   * sending its picks only once they differ from what it opened with.
   */
  private send(options: {
    value: ValueExpr | undefined;
    selectorOverride?: string;
    newVariables?: NewVariable[];
    preview?: boolean;
    signal?: AbortSignal;
  }): ReturnType<typeof applySketchOp> {
    const entities = this.toEntities(this.selection.ids());
    if (this.editTarget) {
      // A seeded selection the user hasn't touched keeps the statement's own
      // argument text verbatim — only a re-picked (dirty) set re-synthesizes.
      const repicked = this.picksDirty() && entities.length > 0;
      const editOptions = {
        value: options.value!,
        expectedStatement: this.expectedStatement,
        entities: repicked ? entities : undefined,
        selectorOverride: options.selectorOverride,
        newVariables: options.newVariables,
        preview: options.preview,
        signal: options.signal,
      };
      if (this.config.feature === 'fillet') {
        return applyFillet2DEdit(this.editTarget, editOptions);
      }
      return applyOffsetEdit(this.editTarget, { ...this.offsetOptions()!, ...editOptions });
    }
    return applySketchOp(this.config.feature, options.value, entities, {
      offset: this.offsetOptions(),
      selectorOverride: options.selectorOverride,
      newVariables: options.newVariables,
      preview: options.preview,
      signal: options.signal,
    });
  }

  private async apply(): Promise<void> {
    if (this.applying || !this.active || this.incompleteReason() !== null) {
      return;
    }
    const read = this.readValue();
    const value = read && !('error' in read) ? read.value : undefined;
    const newVariables = read && !('error' in read) && read.newVariable
      ? [read.newVariable]
      : undefined;

    // Constraint-native fillet (P8): Apply sends the corner plans to the
    // fillet transform (arc + constraint recipe, trimmed edges, virtual
    // sharps) instead of writing a `fillet()` statement.
    if (this.isConstraintNativeFillet()) {
      const plan = this.planFillet();
      if (!plan || !plan.ok) {
        this.setError(plan && 'reason' in plan ? plan.reason : 'Enter a positive radius');
        return;
      }
      this.applying = true;
      this.applyBtn.disabled = true;
      try {
        const result = await this.solved!.fillet({
          ...plan.request,
          ...(newVariables ? { newVariables } : {}),
        });
        if (result.success) {
          this.onDone();
        } else {
          this.setError(result.reason ?? 'Could not apply the fillet');
          this.applyBtn.disabled = false;
        }
      } finally {
        this.applying = false;
      }
      return;
    }

    // Constraint-native offset: emit the plan's primitives + one offsetFrom
    // statement (+ corner coincidents, caps) through the insert-solved rail.
    if (this.isConstraintNativeOffset()) {
      this.applying = true;
      this.applyBtn.disabled = true;
      try {
        // Apply re-plans unless the kept plan was made for exactly these
        // picks, distance and toggles.
        this.cancelPreview();
        const plan = await this.planConstrainedOffset(new AbortController().signal);
        if (plan === null) {
          this.setError('Enter a nonzero distance');
          this.applyBtn.disabled = false;
          return;
        }
        if ('reason' in plan) {
          this.setError(plan.reason);
          this.applyBtn.disabled = false;
          return;
        }
        const model = this.solved!.model();
        if (!model) {
          this.setError('the sketch has not rendered yet');
          this.applyBtn.disabled = false;
          return;
        }
        const emission = buildOffsetEmission({
          sources: plan.sources, chains: plan.chains, model, distanceExpr: plan.distanceExpr,
        });
        if (emission.ok === false) {
          this.setError(emission.reason);
          this.applyBtn.disabled = false;
          return;
        }
        const result = await this.solved!.emit({
          ...emission.request,
          ...(newVariables ? { newVariables } : {}),
        });
        if (result.success) {
          this.onDone();
        } else {
          this.setError(result.reason ?? 'Could not apply the offset');
          this.applyBtn.disabled = false;
        }
      } catch {
        this.setError('Could not reach the FluidCAD server');
        this.applyBtn.disabled = false;
      } finally {
        this.applying = false;
      }
      return;
    }

    const edited = this.expression.value;
    const synthesized = this.expression.synthesizedArgs;
    const selectorOverride = edited !== '' && synthesized !== null && edited !== synthesized
      ? edited
      : undefined;

    this.applying = true;
    this.applyBtn.disabled = true;
    try {
      const result = await this.send({ value, selectorOverride, newVariables });
      if (result.success) {
        if (this.editTarget) {
          // The rewrite strips the double-click's breakpoint atomically with
          // the edit — clearing it again here could clobber that write.
          this.exit('apply');
        }
        this.onDone();
      } else {
        this.setError(result.reason ?? `Could not apply the ${this.config.feature}`);
        this.applyBtn.disabled = false;
      }
    } finally {
      this.applying = false;
    }
  }

  private setHint(message: string | null): void {
    if (message) {
      this.hint.textContent = message;
      this.hint.classList.remove('hidden');
    } else {
      this.hint.textContent = '';
      this.hint.classList.add('hidden');
    }
  }

  private setError(message: string | null): void {
    if (message) {
      this.errorLine.textContent = message;
      this.errorLine.classList.remove('hidden');
    } else {
      this.errorLine.textContent = '';
      this.errorLine.classList.add('hidden');
    }
  }
}
