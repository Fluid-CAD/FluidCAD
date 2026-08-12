import {
  applyFillet2DEdit, applyOffsetEdit, applySketchOp, applySlotDrawEdit, applySlotEdit, clearBreakpoints,
  fetchFeatureGhost, fetchSketchFeatureSources, FeatureEditTarget, Fillet2DGhostRequest, GhostSolid,
  NewVariable, OffsetGhostRequest, OffsetOptionValues, ParsedFeatureStatement,
  SketchApplyEntity, SketchOpFeature, SlotOptionValues, ValueExpr,
} from '../api';
import { ExpressionRow } from './modify-pick/expression-row';
import { PickSlot, PickSlotChip } from './pick-slot';
import { FeatureGhostOverlay } from './create-feature/feature-ghost';
import { keepChip } from './create-feature/sketch-profiles';
import { ChoiceTabs, DIALOG_DOCK_CLASS, DIALOG_COLUMN_CLASS, DIALOG_BODY_CLASS } from './create-feature/panel-controls';
import { ExpressionField } from '../ui/expression-field';
import { VariableInfo } from '../ui/expression-core';
import { viewportChrome } from '../ui/viewport-chrome';

const PREVIEW_DEBOUNCE_MS = 250;

/** The statement options a 2D op carries beyond its picks. */
export type SketchOpToggleKey = 'removeOriginal' | 'close';

/**
 * A tabbed op dialog's mode: `draw` hands the viewport to the classic
 * drawing tool (the dialog shows only a hint), `pick` runs the regular
 * pick/value/apply body. Ops without tabs are always in `pick`.
 */
export type SketchOpMode = 'draw' | 'pick';

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
  readonly mode: SketchOpMode;
  enter(initialMode?: SketchOpMode): void;
  exit(): void;
  refresh(): void;
  noteSketchActive(): void;
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

/** The per-operation dressing of the shared 2D op dialog. */
export type SketchOpConfig = {
  feature: SketchOpFeature;
  title: string;
  pickHint: string;
  /**
   * The numeric parameter row (fillet radius, offset distance); the booleans
   * have none. 'positive' forbids ≤0, 'nonzero' allows negative (offset).
   */
  value?: { label: string; defaultValue: string; sign: 'positive' | 'nonzero' };
  /**
   * Slot-addressed picking (subtract): the dialog carries Base and Tool rows,
   * picks fill the armed row, and switching rows freezes the current picks
   * into the row being left.
   */
  slotted?: boolean;
  /**
   * Boolean statement options — offset's `removeOriginal` argument and its
   * `.close()` chain, or slot's `deleteSource`. Multiple toggles are mutually
   * exclusive: checking one clears the others, since a removed original
   * leaves a closed offset nothing to cap to (the kernel throws on the pair).
   */
  toggles?: { key: SketchOpToggleKey; label: string; title: string; defaultChecked?: boolean }[];
  /**
   * Two-mode dialog (slot): a first tab that keeps the classic drawing tool
   * armed — the dialog shows only that tab's hint — and a second tab running
   * the pick body. A fresh dialog opens on the draw tab; {@link enterEdit}
   * hides the tab row and stays in pick mode (there is nothing to re-draw).
   */
  tabs?: {
    draw: {
      label: string; title: string; hint: string;
      /** An option toggle shown in the draw pane (slot's Centered). */
      toggle?: { label: string; title: string };
    };
    pick: { label: string; title: string };
  };
};

/** An `offset()`, `slot()` or 2D `fillet()` statement as the parse route reads it. */
type ParsedSketchOp = Extract<ParsedFeatureStatement, { feature: 'offset' } | { feature: 'slot' } | { feature: 'fillet' }>;

const SLOT_ROW_BASE = 'flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 cursor-pointer transition-colors';
const SLOT_ROW_ARMED = `${SLOT_ROW_BASE} border-primary/60 bg-primary/10`;
const SLOT_ROW_IDLE = `${SLOT_ROW_BASE} border-base-300 hover:border-base-content/30`;

/**
 * The shared 2D operation dialog (fillet, offset, fuse, subtract, common):
 * armed from the sketch toolbar, it reads the hover handler's selected edges
 * — mirrored into the unified {@link PickSlot} chips every pick-driven dialog
 * carries — previews the synthesized statement through `/api/apply-feature`
 * (sketch branch), and applies it — writing `fillet(4, r.edge('top'), l)` /
 * `offset(2, true, r.edge('top')).close()` / `subtract(r, c)` into the sketch
 * body. The expression row is editable (expression transparency) with
 * verified alternatives.
 *
 * The same dialog edits an existing statement in place ({@link enterEdit},
 * offset, slot and fillet today): the timeline double-click's breakpoint pauses the build
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
   * Fired when the user switches tabs on a tabbed dialog. The toolbar
   * service swaps the viewport ownership: draw arms the classic drawing
   * tool, pick brings back the drag/hover pick handlers.
   */
  onModeChange?: (mode: SketchOpMode) => void;

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
  /** The picked-edge chips (non-slotted ops); subtract keeps its slot rows. */
  private readonly pickSlot: PickSlot | null;
  private readonly slotRows: { base: HTMLDivElement; tool: HTMLDivElement } | null;
  private readonly toggles = new Map<SketchOpToggleKey, HTMLInputElement>();
  /** The tab row and its content panes; null for ops without tabs. */
  private readonly tabsControl: ChoiceTabs<SketchOpMode> | null;
  private readonly tabsRow: HTMLDivElement | null;
  private readonly drawHint: HTMLDivElement | null;
  private readonly pickBody: HTMLDivElement | null;
  /** The draw pane's option toggle (slot's Centered); null without one. */
  private readonly drawToggle: HTMLInputElement | null;
  private readonly drawToggleRow: HTMLLabelElement | null;

  private currentMode: SketchOpMode;
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

  // Slotted picking state: the armed slot's entities ARE the live selection;
  // the other slot holds what was frozen when the user switched away.
  private armedSlot: 'base' | 'tool' = 'base';
  private frozen: { base: string[]; tool: string[] } = { base: [], tool: [] };

  constructor(
    container: HTMLElement,
    private readonly config: SketchOpConfig,
    private readonly selection: SketchOpSelection,
    private fetchVariables: () => Promise<VariableInfo[]>,
    private onDone: () => void,
    /** The live viewport geometry overlay; offset and fillet draw into it. */
    private readonly ghost?: FeatureGhostOverlay,
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
    const slotRows = config.slotted
      ? `
          <div class="flex flex-col gap-1.5">
            <div data-role="slot-base" class="${SLOT_ROW_ARMED}">
              <span class="text-base-content/70">Base</span>
              <span data-role="slot-base-count" class="font-mono text-base-content/50">pick edges</span>
            </div>
            <div data-role="slot-tool" class="${SLOT_ROW_IDLE}">
              <span class="text-base-content/70">Tool</span>
              <span data-role="slot-tool-count" class="font-mono text-base-content/50">pick edges</span>
            </div>
          </div>`
      : '';
    // Non-slotted ops carry the unified pick slot; its prompt asks for the
    // picks, so their hint line starts empty and only surfaces value errors.
    const pickSlotHost = config.slotted ? '' : `
          <div data-role="pick-slot"></div>`;
    const hintRow = config.slotted
      ? `
          <div data-role="hint" class="text-base-content/50">${config.pickHint}</div>`
      : `
          <div data-role="hint" class="hidden text-base-content/50"></div>`;
    // A tabbed dialog wraps the pick UI in one pane and adds a draw-hint
    // pane; the tab row switches between them. The draw pane can carry one
    // option toggle of its own (slot's Centered) — it configures the armed
    // drawing tool, so it lives outside the pick-pane toggles map.
    const drawToggleRow = config.tabs?.draw.toggle ? `
          <label data-role="draw-toggle-row" class="flex items-center justify-between cursor-pointer" title="${config.tabs.draw.toggle.title}">
            <span class="text-base-content/70">${config.tabs.draw.toggle.label}</span>
            <input data-role="draw-toggle" type="checkbox" class="toggle toggle-sm toggle-primary" />
          </label>` : '';
    const tabsRow = config.tabs ? `
          <div data-role="tabs" class="join w-full"></div>
          <div data-role="draw-hint" class="text-base-content/50">${config.tabs.draw.hint}</div>${drawToggleRow}` : '';
    this.panel.innerHTML = `
      <div data-role="column" class="${DIALOG_COLUMN_CLASS}">
        <div class="${DIALOG_BODY_CLASS}">
          <div class="flex items-center gap-2.5">
            <span data-role="title" class="font-medium text-sm">${config.title}</span>
          </div>${tabsRow}
          <div data-role="pick-body" class="flex flex-col items-stretch gap-3.5">${pickSlotHost}${hintRow}${slotRows}${valueRow}${toggleRows}</div>
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
    this.tabsRow = this.panel.querySelector('[data-role="tabs"]');
    this.drawHint = this.panel.querySelector('[data-role="draw-hint"]');
    this.pickBody = this.panel.querySelector('[data-role="pick-body"]');
    this.currentMode = config.tabs ? 'draw' : 'pick';
    if (config.tabs && this.tabsRow) {
      this.tabsControl = new ChoiceTabs<SketchOpMode>(this.tabsRow, [
        { key: 'draw', label: config.tabs.draw.label, title: config.tabs.draw.title },
        { key: 'pick', label: config.tabs.pick.label, title: config.tabs.pick.title },
      ], this.currentMode);
      this.tabsControl.onChange = () => this.setMode(this.tabsControl!.value);
    } else {
      this.tabsControl = null;
    }
    for (const toggle of config.toggles ?? []) {
      this.toggles.set(toggle.key, this.panel.querySelector(`[data-role="toggle-${toggle.key}"]`)!);
    }
    this.drawToggle = this.panel.querySelector('[data-role="draw-toggle"]');
    this.drawToggleRow = this.panel.querySelector('[data-role="draw-toggle-row"]');
    this.drawToggle?.addEventListener('change', () => this.onDrawToggleChange?.(this.drawToggle!.checked));
    this.slotRows = config.slotted
      ? {
        base: this.panel.querySelector('[data-role="slot-base"]')!,
        tool: this.panel.querySelector('[data-role="slot-tool"]')!,
      }
      : null;
    this.pickSlot = config.slotted
      ? null
      : new PickSlot(this.panel.querySelector('[data-role="pick-slot"]')!, { label: 'Selection', multiple: true });
    if (this.pickSlot) {
      // Picking is live the whole time the dialog is up — the slot always
      // wears the pick-target styling (matches ModifyPanel).
      this.pickSlot.setArmed(true);
      this.pickSlot.onRemove = (index) => {
        const shapeId = this.selection.ids()[index];
        if (shapeId !== undefined) {
          this.selection.deselect(shapeId);
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
    if (this.slotRows) {
      this.slotRows.base.addEventListener('click', () => this.armSlot('base'));
      this.slotRows.tool.addEventListener('click', () => this.armSlot('tool'));
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

  /** The tab the dialog is on; always `pick` for ops without tabs. */
  get mode(): SketchOpMode {
    return this.currentMode;
  }

  /** The draw pane's option toggle state; false for dialogs without one. */
  get drawToggleChecked(): boolean {
    return this.drawToggle?.checked ?? false;
  }

  /** Tab switch: swap the panes, then hand the viewport over via onModeChange. */
  private setMode(mode: SketchOpMode): void {
    if (this.currentMode === mode) {
      return;
    }
    this.currentMode = mode;
    this.syncModeUI();
    if (mode === 'draw') {
      this.cancelPreview();
      this.ghost?.clear();
      this.expression.hide();
      this.setError(null);
    } else {
      this.schedulePreview();
    }
    this.onModeChange?.(mode);
  }

  /** Show the pane of the current mode (a no-op for ops without tabs). */
  private syncModeUI(): void {
    if (!this.config.tabs) {
      return;
    }
    const draw = this.currentMode === 'draw';
    this.drawHint?.classList.toggle('hidden', !draw);
    this.drawToggleRow?.classList.toggle('hidden', !draw);
    this.pickBody?.classList.toggle('hidden', draw);
    this.applyBtn.classList.toggle('hidden', draw);
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

  enter(initialMode?: SketchOpMode): void {
    if (this.active && !this.editTarget) {
      return;
    }
    // Re-arming the tool over an open edit dialog abandons that edit — it
    // becomes a fresh statement, so the breakpoint it opened with goes too.
    this.exit();
    this.active = true;
    this.armedSlot = 'base';
    this.frozen = { base: [], tool: [] };
    this.syncSlotRows();
    this.syncPickSlot();
    this.title.textContent = this.config.title;
    this.setToggles(this.defaultToggleValues());
    // A fresh sketch-toolbar arming is always inside a sketch — every toggle applies.
    this.setHiddenToggles([]);
    // A fresh tabbed dialog opens on the draw tab — unless the caller asks
    // for pick (an edge was already selected when the tool was armed). The
    // caller reads `mode` after entering and arms the viewport itself (no
    // onModeChange here).
    this.currentMode = this.config.tabs ? (initialMode ?? 'draw') : 'pick';
    this.tabsControl?.setValue(this.currentMode);
    if (this.drawHint && this.config.tabs) {
      this.drawHint.textContent = this.config.tabs.draw.hint;
    }
    this.syncModeUI();
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
    this.armedSlot = 'base';
    this.frozen = { base: [], tool: [] };
    this.selection.clear();
    this.syncPickSlot();
    this.title.textContent = `Edit ${this.config.title.toLowerCase()}`;
    this.valueField?.setValue(parsed.value);
    this.setToggles(parsed.feature === 'offset'
      ? { removeOriginal: parsed.removeOriginal, close: parsed.close }
      : parsed.feature === 'slot'
        ? { removeOriginal: parsed.removeOriginal }
        : {});
    // Options the edited statement's context makes invalid (a face offset
    // outside a sketch takes neither removeOriginal nor close) hide their
    // rows; a hidden toggle also unchecks, so an apply writes the valid form.
    this.setHiddenToggles(opts.hideToggles ?? []);
    // An edit opens on the pick tab; switching to Draw stays available —
    // drawing there replaces the statement with the drawn form (see
    // {@link applyDrawnStatement}).
    this.currentMode = 'pick';
    this.tabsControl?.setValue('pick');
    if (this.drawHint && this.config.tabs) {
      this.drawHint.textContent = `${this.config.tabs.draw.hint} The drawn slot replaces this statement.`;
    }
    this.syncModeUI();
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

  /** Offset's toggle pair as the statement carries it, or undefined for the rest. */
  private offsetOptions(): OffsetOptionValues | undefined {
    if (this.config.feature !== 'offset' || this.toggles.size === 0) {
      return undefined;
    }
    return {
      removeOriginal: this.toggles.get('removeOriginal')?.checked === true,
      close: this.toggles.get('close')?.checked === true,
    };
  }

  /** Slot's toggle as the statement carries it, or undefined for the rest. */
  private slotOptions(): SlotOptionValues | undefined {
    if (this.config.feature !== 'slot') {
      return undefined;
    }
    return { removeOriginal: this.toggles.get('removeOriginal')?.checked === true };
  }

  /**
   * The static text around the editable args — `offset(2, true, ` … `).close()`
   * for the toggled forms, `fillet(4, ` … `)` for the rest. Slot inverts the
   * order: the source args come first, the radius and flag trail —
   * `slot(` … `, 4)` / `slot(` … `, 4, false)`.
   */
  private syncExpressionPrefix(value: ValueExpr | undefined): void {
    if (this.config.feature === 'slot') {
      const keepSource = this.slotOptions()?.removeOriginal === false ? ', false' : '';
      this.expression.setPrefix('slot(');
      this.expression.setSuffix(`, ${value}${keepSource})`);
      return;
    }
    const offset = this.offsetOptions();
    this.expression.setPrefix(value === undefined
      ? `${this.config.feature}(`
      : `${this.config.feature}(${offset?.removeOriginal ? `${value}, true` : value}, `);
    this.expression.setSuffix(offset?.close ? ').close()' : ')');
  }

  /** Feed the sketch scope's variables to the value field's dropdown. */
  private async loadVariables(): Promise<void> {
    if (!this.valueField) {
      return;
    }
    const variables = await this.fetchVariables();
    if (this.active) {
      this.valueField.setVariables(variables);
    }
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
      this.syncSlotRows();
      this.syncPickSlot();
      this.schedulePreview();
    }
  }

  /** Switch the armed slot, freezing the picks of the slot being left. */
  private armSlot(slot: 'base' | 'tool'): void {
    if (!this.slotRows || this.armedSlot === slot) {
      return;
    }
    this.frozen[this.armedSlot] = this.selection.ids();
    this.armedSlot = slot;
    // The freeze keeps the leaving slot's picks; the arriving slot re-picks
    // from scratch (its previous content is discarded with the selection).
    this.frozen[slot] = [];
    this.selection.clear();
    this.syncSlotRows();
    this.schedulePreview();
  }

  /** The entities of one slot: live selection when armed, else the frozen set. */
  private slotIds(slot: 'base' | 'tool'): string[] {
    return this.armedSlot === slot ? this.selection.ids() : this.frozen[slot];
  }

  /**
   * Mirror the picked edges into the slot as numbered chips; an edit with no
   * re-picks shows its statement's own targets as the keep chip instead (they
   * stand until edges are picked, and again when every pick is removed).
   */
  private syncPickSlot(): void {
    if (!this.pickSlot) {
      return;
    }
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

  private syncSlotRows(): void {
    if (!this.slotRows) {
      return;
    }
    for (const slot of ['base', 'tool'] as const) {
      const row = this.slotRows[slot];
      row.className = this.armedSlot === slot ? SLOT_ROW_ARMED : SLOT_ROW_IDLE;
      const count = this.slotIds(slot).length;
      const label = row.querySelector(`[data-role="slot-${slot}-count"]`)!;
      label.textContent = count === 0 ? 'pick edges' : `${count} edge${count === 1 ? '' : 's'}`;
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
    if (this.config.slotted) {
      if (this.slotIds('base').length === 0) {
        return { kind: 'picks', message: 'Pick the base geometry’s edges' };
      }
      if (this.slotIds('tool').length === 0) {
        return { kind: 'picks', message: 'Arm the Tool row and pick the geometry to subtract' };
      }
      // An edit keeps the statement's own targets until edges are picked, so
      // an empty selection is complete — it just changes nothing about them.
    } else if (!this.editTarget && this.selection.ids().length === 0) {
      return { kind: 'picks', message: this.config.pickHint };
    }
    const read = this.readValue();
    if (read && 'error' in read) {
      return { kind: 'value', message: read.error };
    }
    return null;
  }

  private schedulePreview(): void {
    if (!this.active || this.currentMode === 'draw') {
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
    const selection = this.config.slotted ? this.slotIds('base') : this.selection.ids();
    const entities = this.toEntities(selection);
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
      if (this.config.feature === 'slot') {
        return applySlotEdit(this.editTarget, { ...this.slotOptions()!, ...editOptions });
      }
      if (this.config.feature === 'fillet') {
        return applyFillet2DEdit(this.editTarget, editOptions);
      }
      return applyOffsetEdit(this.editTarget, { ...this.offsetOptions()!, ...editOptions });
    }
    return applySketchOp(this.config.feature, options.value, entities, {
      toolEntities: this.config.slotted ? this.toEntities(this.slotIds('tool')) : undefined,
      offset: this.offsetOptions(),
      slot: this.slotOptions(),
      selectorOverride: options.selectorOverride,
      newVariables: options.newVariables,
      preview: options.preview,
      signal: options.signal,
    });
  }

  private async apply(): Promise<void> {
    if (this.applying || !this.active || this.currentMode === 'draw' || this.incompleteReason() !== null) {
      return;
    }
    const read = this.readValue();
    const value = read && !('error' in read) ? read.value : undefined;
    const newVariables = read && !('error' in read) && read.newVariable
      ? [read.newVariable]
      : undefined;

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

  /**
   * The Draw tab's commit while editing: the toolbar service routes the
   * drawing tool's insert here, and the drawn from-dimensions statement
   * replaces the edited one wholesale (converting a from-edge slot back to a
   * drawn one). Success closes the dialog exactly like Apply.
   */
  async applyDrawnStatement(
    statement: string,
    newVariable?: NewVariable | NewVariable[],
  ): Promise<void> {
    if (!this.editTarget || this.applying) {
      return;
    }
    const newVariables = newVariable === undefined
      ? undefined
      : Array.isArray(newVariable) ? newVariable : [newVariable];
    this.applying = true;
    try {
      const result = await applySlotDrawEdit(this.editTarget, {
        statement,
        expectedStatement: this.expectedStatement,
        newVariables,
      });
      if (result.success) {
        // The rewrite strips the double-click's breakpoint atomically with
        // the edit, like Apply's own path.
        this.exit('apply');
        this.onDone();
      } else {
        this.setError(result.reason ?? 'Could not apply the drawn slot');
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
