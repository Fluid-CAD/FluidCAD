import {
  applyFillet2DEdit, applyOffsetEdit, applySketchOp, clearBreakpoints,
  fetchFeatureGhost, fetchSketchFeatureSources, gotoSource, FeatureEditTarget, Fillet2DGhostRequest, GhostSolid,
  NewVariable, OffsetGhostRequest, OffsetOptionValues, ParsedFeatureStatement,
  Rotate2DCenterRefParam, Rotate2DOptionValues,
  SketchApplyEntity, SketchOpFeature, ValueExpr,
} from '../api';
import type { SolvedSketchModel } from '../sketch-solver-client/model';
import type { SolvedPick } from './sketch-hover-select-handler';
import {
  buildFilletEmission, type FilletEmissionError, type FilletEmissionPlan,
} from './tools/fillet-emission';
import type { SolvedEmissionRequest, SolvedEmitResult } from './tools/solved-emission';
import { ExpressionRow } from './modify-pick/expression-row';
import { PickSlot, PickSlotChip } from './pick-slot';
import { FeatureGhostOverlay } from './create-feature/feature-ghost';
import { keepChip } from './create-feature/sketch-profiles';
import { DIALOG_DOCK_CLASS, DIALOG_COLUMN_CLASS, DIALOG_BODY_CLASS } from './create-feature/panel-controls';
import { ExpressionField } from '../ui/expression-field';
import { VariableInfo } from '../ui/expression-core';
import { viewportChrome } from '../ui/viewport-chrome';

const PREVIEW_DEBOUNCE_MS = 250;

/** The statement options a 2D op carries beyond its picks. */
export type SketchOpToggleKey = 'close' | 'copy'; // copy: rotate

/** What a picked sketch shape shows as a chip: its entity's name and line. */
export type SketchPickDescription = {
  label: string;
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
  /** True for a draw-options dialog: the classic drawing tool owns the
   * viewport while the dialog shows only its hint and options (slot). */
  readonly isDrawDialog: boolean;
  enter(): void;
  exit(): void;
  refresh(): void;
  noteSketchActive(): void;
};

/**
 * The fillet dialog's window onto the solved-sketch world (P8): the resolved
 * picks and read model the corner math consumes, and the atomic
 * insert-solved emission rail its Apply writes through. Only the FILLET
 * create path uses it — an edit dialog still rewrites its legacy `fillet()`
 * statement through the synthesis rail.
 */
export type SolvedFilletRail = {
  picks(): SolvedPick[];
  model(): SolvedSketchModel | null;
  emit(request: SolvedEmissionRequest): Promise<SolvedEmitResult>;
};

/**
 * The rotate dialog's window onto the solved picks (P8): the picked points
 * its Center slot consumes, and the eviction hook that keeps exactly one
 * of them selected in the viewport.
 */
export type SolvedCenterRail = {
  picks(): SolvedPick[];
  deselect(pick: SolvedPick): void;
};

/** Whether a solved pick can anchor a rotation center: a vertex click (a
 * point role, a point entity, an anchor point) or the origin datum — never
 * an edge pick, a reference output, or a copy duplicate. */
function isCenterCandidate(pick: SolvedPick): boolean {
  if (pick.datum !== undefined) {
    return pick.datum === 'origin';
  }
  if (pick.reference !== undefined || pick.copyInstance !== undefined) {
    return false;
  }
  return pick.role !== undefined;
}

/** Stable identity of a center candidate across renders. */
function centerPickKey(pick: SolvedPick): string {
  return pick.datum !== undefined ? `d:${pick.datum}` : `v:${pick.entityId}:${pick.role ?? 'point'}`;
}

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

/** The per-operation dressing of the shared 2D op dialog. */
export type SketchOpConfig = {
  /** 'slot' is draw-only: its dialog never sends an apply-feature request. */
  feature: SketchOpFeature | 'slot';
  title: string;
  pickHint: string;
  /**
   * The numeric parameter row (fillet radius, offset distance).
   * 'positive' forbids ≤0, 'nonzero' allows negative (offset).
   */
  value?: { label: string; defaultValue: string; sign: 'positive' | 'nonzero' };
  /**
   * A single-point pick slot (the rotate dialog's Center): vertex clicks —
   * endpoints, centers, points, anchors, the origin — land here while edge
   * clicks keep collecting targets. Needs a {@link SolvedCenterRail}.
   */
  centerSlot?: { label: string; prompt: string };
  /**
   * Boolean statement options — offset's `removeOriginal` argument and its
   * `.close()` chain, or slot's `deleteSource`. Multiple toggles are mutually
   * exclusive: checking one clears the others, since a removed original
   * leaves a closed offset nothing to cap to (the kernel throws on the pair).
   */
  toggles?: { key: SketchOpToggleKey; label: string; title: string; defaultChecked?: boolean }[];
  /**
   * Draw-options dialog (slot): the classic drawing tool owns the viewport
   * while the dialog shows only a hint and (optionally) one option toggle.
   * No pick body, no value row, no Apply — draw dialogs are create-only.
   */
  draw?: {
    hint: string;
    /** An option toggle shown in the draw pane (slot's Centered). */
    toggle?: { label: string; title: string };
  };
};

/** An `offset()` or 2D `fillet()` statement as the parse route reads it. */
type ParsedSketchOp = Extract<ParsedFeatureStatement, { feature: 'offset' } | { feature: 'fillet' }>;

/**
 * The shared 2D operation dialog (fillet, offset): armed from the sketch
 * toolbar, it reads the hover handler's selected edges — mirrored into the
 * unified {@link PickSlot} chips every pick-driven dialog carries — previews
 * the synthesized statement through `/api/apply-feature` (sketch branch),
 * and applies it — writing `fillet(4, r.edge('top'), l)` /
 * `offset(2, r.edge('top')).close()` into the sketch body. The expression
 * row is editable (expression transparency) with verified alternatives.
 *
 * The same dialog edits an existing statement in place ({@link enterEdit},
 * offset and fillet today — slot lost its edit mode): the timeline double-click's breakpoint pauses the build
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

  /**
   * Fired when the draw pane's option toggle flips. The toolbar service
   * re-arms the drawing tool so the new option takes effect immediately.
   */
  onDrawToggleChange?: (checked: boolean) => void;

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
  /** The single-point center slot (config.centerSlot), or null. */
  private readonly centerSlot: PickSlot | null;
  /** The center slot's current pick, mirrored from the solved selection. */
  private centerPick: SolvedPick | null = null;
  /** The server-rendered center expression from the last preview
   * (`l.end()`, `[0, 0]`) — the expression row's prefix shows it. */
  private centerExpr: string | null = null;
  /** Re-entrancy guard: evicting stale center picks fires the selection
   * change hook, which refreshes this dialog again. */
  private syncingCenter = false;
  private readonly toggles = new Map<SketchOpToggleKey, HTMLInputElement>();
  /** The draw pane's option toggle (slot's Centered); null without one. */
  private readonly drawToggle: HTMLInputElement | null;

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

  constructor(
    container: HTMLElement,
    private readonly config: SketchOpConfig,
    private readonly selection: SketchOpSelection,
    private fetchVariables: () => Promise<VariableInfo[]>,
    private onDone: () => void,
    /** The live viewport geometry overlay; offset and fillet draw into it. */
    private readonly ghost?: FeatureGhostOverlay,
    /** Constraint-native fillet rail (P8) — fillet dialog only. */
    private readonly solvedFillet?: SolvedFilletRail,
    /** Solved point picks for the Center slot — rotate dialog only. */
    private readonly solvedCenter?: SolvedCenterRail,
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
    const centerSlotHost = config.centerSlot ? `
          <div data-role="center-slot"></div>` : '';
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
    // A draw dialog shows only its hint pane; it can carry one option
    // toggle of its own (slot's Centered) — it configures the armed drawing
    // tool, so it lives outside the pick-pane toggles map.
    const drawToggleRow = config.draw?.toggle ? `
          <label data-role="draw-toggle-row" class="flex items-center justify-between cursor-pointer" title="${config.draw.toggle.title}">
            <span class="text-base-content/70">${config.draw.toggle.label}</span>
            <input data-role="draw-toggle" type="checkbox" class="toggle toggle-sm toggle-primary" />
          </label>` : '';
    const drawRow = config.draw ? `
          <div data-role="draw-hint" class="text-base-content/50">${config.draw.hint}</div>${drawToggleRow}` : '';
    this.panel.innerHTML = `
      <div data-role="column" class="${DIALOG_COLUMN_CLASS}">
        <div class="${DIALOG_BODY_CLASS}">
          <div class="flex items-center gap-2.5">
            <span data-role="title" class="font-medium text-sm">${config.title}</span>
          </div>${drawRow}
          <div data-role="pick-body" class="flex flex-col items-stretch gap-3.5">${pickSlotHost}${centerSlotHost}${hintRow}${valueRow}${toggleRows}</div>
          <div class="flex items-center gap-2 pt-1">
            <button data-role="apply" class="btn btn-primary btn-sm flex-1" disabled>Apply</button>
            <button data-role="cancel" class="btn btn-ghost btn-sm">Cancel</button>
          </div>
        </div>
      </div>
    `;
    container.appendChild(this.panel);

    this.valueInput = this.panel.querySelector('[data-role="value"]');
    this.title = this.panel.querySelector('[data-role="title"]')!;
    this.hint = this.panel.querySelector('[data-role="hint"]')!;
    this.applyBtn = this.panel.querySelector('[data-role="apply"]')!;
    // A draw dialog has no pick body and no Apply — the drawing tool commits.
    if (config.draw) {
      this.panel.querySelector('[data-role="pick-body"]')?.classList.add('hidden');
      this.applyBtn.classList.add('hidden');
    }
    for (const toggle of config.toggles ?? []) {
      this.toggles.set(toggle.key, this.panel.querySelector(`[data-role="toggle-${toggle.key}"]`)!);
    }
    this.drawToggle = this.panel.querySelector('[data-role="draw-toggle"]');
    this.drawToggle?.addEventListener('change', () => this.onDrawToggleChange?.(this.drawToggle!.checked));
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

    const centerHost = this.panel.querySelector<HTMLElement>('[data-role="center-slot"]');
    this.centerSlot = config.centerSlot && centerHost
      ? new PickSlot(centerHost, { label: config.centerSlot.label, multiple: false })
      : null;
    if (this.centerSlot) {
      // Picking is type-directed, not slot-directed: point clicks land here
      // while edge clicks keep collecting targets — both slots stay armed.
      this.centerSlot.setArmed(true);
      this.centerSlot.onRemove = () => {
        const pick = this.centerPick;
        this.centerPick = null;
        this.centerExpr = null;
        if (pick && this.solvedCenter) {
          // Fires the selection-change hook, which refreshes this dialog.
          this.solvedCenter.deselect(pick);
        } else {
          this.refresh();
        }
      };
    }

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

  /** Whether this is a draw-options dialog (see {@link SketchOpConfig}). */
  get isDrawDialog(): boolean {
    return this.config.draw !== undefined;
  }

  /** The draw pane's option toggle state; false for dialogs without one. */
  get drawToggleChecked(): boolean {
    return this.drawToggle?.checked ?? false;
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
    this.syncCenterPick();
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

  /** Rotate's center + copy flag, or undefined until a center is picked.
   * The origin datum bakes a `[0, 0]` literal (the `origin()` handle is a
   * constraint target, not a point value); everything else travels as a
   * statement-addressed point reference the server renders as an accessor. */
  private rotateOptions(): Rotate2DOptionValues | undefined {
    if (this.config.feature !== 'rotate2d') {
      return undefined;
    }
    const pick = this.centerPick;
    if (!pick) {
      return undefined;
    }
    const copy = this.toggles.get('copy')?.checked === true;
    if (pick.datum === 'origin') {
      return { center: [0, 0], copy };
    }
    const line = pick.sourceLocation?.line;
    if (line === undefined) {
      return undefined;
    }
    const occurrence = pick.sourceLocation?.occurrence !== undefined
      ? { occurrence: pick.sourceLocation.occurrence }
      : {};
    if (pick.anchor !== undefined) {
      return {
        centerRef: {
          line,
          ...occurrence,
          featureType: pick.anchor.owner,
          ...(pick.anchor.owner === 'bezier' ? { pointIndex: pick.anchor.pointIndex } : {}),
        },
        copy,
      };
    }
    const centerRef: Rotate2DCenterRefParam = {
      line,
      ...occurrence,
      ...(pick.role !== null && pick.role !== undefined ? { role: pick.role } : {}),
      featureType: pick.kind as Rotate2DCenterRefParam['featureType'],
    };
    return { centerRef, copy };
  }

  /**
   * The static text around the editable args — `offset(2, ` … `).close()`
   * for the toggled form, `fillet(4, ` … `)` for the rest.
   */
  private syncExpressionPrefix(value: ValueExpr | undefined): void {
    if (this.config.feature === 'rotate2d') {
      const rt = this.rotateOptions();
      const center = this.centerExpr
        ?? (rt?.center ? `[${rt.center[0]}, ${rt.center[1]}]` : '…');
      this.expression.setPrefix(`rotate(${value}, ${center}${rt?.copy ? ', true' : ''}, `);
      this.expression.setSuffix(')');
      return;
    }
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
    const variables = await this.fetchVariables();
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
      && this.solvedFillet !== undefined
      && this.editTarget === null;
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
  private buildFilletPlan(): FilletEmissionPlan | FilletEmissionError | null {
    const read = this.readValue();
    if (!read || 'error' in read) {
      return null;
    }
    const model = this.solvedFillet!.model();
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
    return buildFilletEmission({
      picks: this.solvedFillet!.picks(),
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
    this.centerPick = null;
    this.centerExpr = null;
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
      this.syncCenterPick();
      this.syncPickSlot();
      this.schedulePreview();
    }
  }

  /**
   * Mirror the newest picked point into the Center slot — vertex clicks
   * (endpoints, centers, points, anchors) and the origin datum qualify;
   * edge clicks stay targets. Older point picks are evicted from the
   * viewport selection so exactly one center ring stands.
   */
  private syncCenterPick(): void {
    if (!this.centerSlot || !this.solvedCenter || this.syncingCenter) {
      return;
    }
    const candidates = this.solvedCenter.picks().filter(isCenterCandidate);
    const next = candidates.length > 0 ? candidates[candidates.length - 1] : null;
    if (candidates.length > 1) {
      this.syncingCenter = true;
      try {
        for (const pick of candidates) {
          if (pick !== next) {
            this.solvedCenter.deselect(pick);
          }
        }
      } finally {
        this.syncingCenter = false;
      }
    }
    const prevKey = this.centerPick ? centerPickKey(this.centerPick) : null;
    this.centerPick = next;
    if (next === null || centerPickKey(next) !== prevKey) {
      // The rendered accessor belongs to the old pick — the next preview
      // round trip supplies the new one.
      this.centerExpr = null;
    }
    if (next) {
      this.centerSlot.setChips([{
        label: this.centerPickLabel(next),
        removable: true,
        line: next.sourceLocation?.line,
        onGoto: next.sourceLocation ? () => gotoSource(next.sourceLocation!) : undefined,
      }]);
      this.centerSlot.setPrompt(null);
    } else {
      this.centerSlot.setChips([]);
      this.centerSlot.setPrompt(this.config.centerSlot!.prompt);
    }
  }

  /** The center chip's text: what point was picked, in sketch terms. */
  private centerPickLabel(pick: SolvedPick): string {
    if (pick.datum === 'origin') {
      return 'Origin';
    }
    if (pick.anchor !== undefined) {
      return pick.anchor.owner === 'ellipse' ? 'Ellipse center'
        : pick.anchor.owner === 'text' ? 'Text anchor'
          : `Bezier point ${pick.anchor.pointIndex}`;
    }
    const kind = pick.kind.charAt(0).toUpperCase() + pick.kind.slice(1);
    return pick.role ? `${kind} ${pick.role}` : kind;
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
    // The center slot's own prompt asks for the point, so this stays a
    // picks-kind gap (no hint line) — it just holds Apply and the preview.
    if (this.config.feature === 'rotate2d' && this.rotateOptions() === undefined) {
      return { kind: 'picks', message: this.config.centerSlot?.prompt ?? 'Pick the rotation center' };
    }
    const read = this.readValue();
    if (read && 'error' in read) {
      return { kind: 'value', message: read.error };
    }
    return null;
  }

  private schedulePreview(): void {
    if (!this.active || this.isDrawDialog) {
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
      const plan = this.buildFilletPlan();
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

    try {
      const result = await this.send({ value, preview: true, signal: abort.signal });
      if (abort.signal.aborted || !this.active) {
        return;
      }
      // An edit that re-picked nothing synthesizes no args — the statement's
      // own target list stands, and the row keeps showing it.
      const args = result.args ?? (this.editTarget ? this.editArgsText : undefined);
      if (result.success && args !== undefined) {
        if (result.centerExpr !== undefined) {
          this.centerExpr = result.centerExpr;
        }
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
      solids = await fetchFeatureGhost(request, signal);
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
    // Draw dialogs (slot) never reach send() — their Apply is hidden and
    // previews are suppressed — so the cast never lies at runtime.
    return applySketchOp(this.config.feature as SketchOpFeature, options.value, entities, {
      offset: this.offsetOptions(),
      rotate2d: this.rotateOptions(),
      selectorOverride: options.selectorOverride,
      newVariables: options.newVariables,
      preview: options.preview,
      signal: options.signal,
    });
  }

  private async apply(): Promise<void> {
    if (this.applying || !this.active || this.isDrawDialog || this.incompleteReason() !== null) {
      return;
    }
    const read = this.readValue();
    const value = read && !('error' in read) ? read.value : undefined;
    const newVariables = read && !('error' in read) && read.newVariable
      ? [read.newVariable]
      : undefined;

    // Constraint-native fillet (P8): Apply emits the arc + constraint
    // recipe (and the corner-coincident removals) through the atomic
    // insert-solved rail instead of writing a `fillet()` statement.
    if (this.isConstraintNativeFillet()) {
      const plan = this.buildFilletPlan();
      if (!plan || !plan.ok) {
        this.setError(plan && 'reason' in plan ? plan.reason : 'Enter a positive radius');
        return;
      }
      this.applying = true;
      this.applyBtn.disabled = true;
      try {
        const result = await this.solvedFillet!.emit({
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
