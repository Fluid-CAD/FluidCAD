import type { FeatureOpKind, FeaturePickerParam, FeatureScalarParam, FeatureScalarValue } from '../../../api';
import type { VariableInfo } from '../../../ui/expression-core';
import { FeaturePanel } from '../feature-panel';
import { ChoiceTabs } from '../panel-controls';
import { ScopeSlotControl } from '../scope-slot';
import { FeatureSchema, type SchemaBlock } from './feature-schema';
import { SchemaField } from './schema-fields';
import { SchemaPicker } from './schema-pickers';
import { RawOcctMarker } from './raw-occt-marker';

/** The slot the next viewport pick lands in: a picked value by name, or the `.scope(…)` row. */
export type ArmedSlot = string | 'scope' | null;

const GROUP_HEADING_CLASS = 'text-[10px] uppercase tracking-wide text-base-content/45';

/**
 * The dialog a custom feature's metadata describes, rendered from its
 * {@link FeatureSchema}: the operation tabs when the feature offers a choice
 * of operations, then every value in declaration order — typed-in rows
 * (expression fields, selects, toggles, text) and pick slots — under their
 * group headings, the tabbed ones on their tab's pane, and the framework's
 * `.scope(…)` row last, for any feature with operations.
 * Rows whose `visibleWhen` fails hide. Pure DOM and form state: the service
 * owns the scene, the picks' routing, the previews and the apply.
 */
export class SchemaFeaturePanel extends FeaturePanel {
  /** The armed slot changed — the service re-aims the viewer's pick channels. */
  onArmedSlotChange?: () => void;
  /** The operation tab changed. */
  onOperationChange?: () => void;
  /** A scope chip's ✕. */
  onScopeRemove?: (index: number) => void;
  /** The paused preview's "Show preview": build it once, however long it takes. */
  onShowPreview?: () => void;

  readonly fields = new Map<string, SchemaField>();
  readonly pickers = new Map<string, SchemaPicker>();
  readonly scopeSlot: ScopeSlotControl | null = null;

  private readonly opTabs: ChoiceTabs<FeatureOpKind> | null = null;
  private readonly tabs: ChoiceTabs<string> | null = null;
  private readonly panes = new Map<string, HTMLElement>();
  private readonly groupHosts: { host: HTMLElement; names: string[] }[] = [];
  private readonly pausedRow: HTMLElement;
  private readonly pausedText: HTMLElement;
  private armed: ArmedSlot = null;

  constructor(container: HTMLElement, readonly schema: FeatureSchema, iconSrc: string) {
    super(container, {
      id: `fluidcad-feature-${schema.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`,
      title: schema.label,
      icon: iconSrc,
      bodyHtml: '',
    });
    if (schema.usesOcct) {
      this.shell.addHeaderItem(RawOcctMarker.element('badge'));
    }

    const operations = schema.operations;
    if (schema.offersOperationChoice) {
      const host = this.append('op-tabs', 'join w-full');
      this.opTabs = new ChoiceTabs(host,
        operations.map(o => ({ key: o.op, label: o.label, title: o.title })),
        schema.defaultOperation!);
      this.opTabs.onChange = () => {
        this.syncVisibility();
        this.onOperationChange?.();
        this.onChange?.();
      };
    }

    const layout = schema.layout();
    this.renderBlocks(this.body, layout.top);
    if (layout.tabs.length > 0) {
      const tabHost = this.append('tabs', 'join w-full');
      this.tabs = new ChoiceTabs(tabHost, layout.tabs.map(t => ({ key: t.name, label: t.name, title: t.name })),
        layout.tabs[0].name, { compact: layout.tabs.length > 3 });
      for (const tab of layout.tabs) {
        const pane = this.append(`tab-${tab.name}`, 'flex flex-col gap-3.5');
        this.renderBlocks(pane, tab.blocks);
        this.panes.set(tab.name, pane);
      }
      this.tabs.onChange = () => this.showTab(this.tabs!.value);
      this.showTab(layout.tabs[0].name);
    }

    if (operations.length > 0) {
      this.scopeSlot = new ScopeSlotControl(this.append('scope-slot', ''));
      this.scopeSlot.onArm = () => this.armSlot('scope');
      this.scopeSlot.onRemove = (index) => this.onScopeRemove?.(index);
    }

    this.pausedRow = this.append('ghost-paused', 'hidden flex-col items-start gap-1.5 text-xs leading-snug text-base-content/70');
    this.pausedText = document.createElement('span');
    const showPreview = document.createElement('button');
    showPreview.type = 'button';
    showPreview.dataset.role = 'show-preview';
    showPreview.className = 'btn btn-xs btn-outline';
    showPreview.textContent = 'Show preview';
    showPreview.addEventListener('click', () => this.onShowPreview?.());
    this.pausedRow.append(this.pausedText, showPreview);
  }

  /**
   * The live preview paused — it took longer to build than a keystroke may
   * wait — and why; null when it runs again. While paused the row offers
   * to build the preview once.
   */
  setPreviewPaused(reason: string | null): void {
    this.pausedText.textContent = reason ? `Preview paused. ${reason}` : '';
    this.pausedRow.classList.toggle('hidden', reason === null);
    this.pausedRow.classList.toggle('flex', reason !== null);
  }

  /**
   * The operation the dialog writes: the tab chosen, or a feature's one
   * operation when it offers no choice; null for a feature without operations.
   */
  get operation(): FeatureOpKind | null {
    return this.opTabs?.value ?? this.schema.defaultOperation;
  }

  get armedSlot(): ArmedSlot {
    return this.armed;
  }

  /** The armed picked value, or null (nothing armed, or the scope row). */
  get armedPicker(): SchemaPicker | null {
    return this.armed && this.armed !== 'scope' ? this.pickers.get(this.armed) ?? null : null;
  }

  /** The typed-in values as the rows hold them — what `visibleWhen` compares. */
  scalars(): Record<string, FeatureScalarValue | undefined> {
    const values: Record<string, FeatureScalarValue | undefined> = {};
    for (const [name, field] of this.fields) {
      values[name] = field.current();
    }
    return values;
  }

  /** A fresh create: defaults in every row, empty picks, the default operation, nothing scoped. */
  show(): void {
    this.shell.setTitle(null);
    for (const [name, field] of this.fields) {
      field.seed(this.schema.defaultOf(name));
    }
    for (const picker of this.pickers.values()) {
      picker.reset();
    }
    if (this.schema.defaultOperation) {
      this.opTabs?.setValue(this.schema.defaultOperation);
    }
    this.syncVisibility();
    this.armFirstPicker();
    this.shell.show();
  }

  /**
   * Open over an existing statement: its typed-in values in their rows (a
   * value it leaves out shows the default), its picks as kept chips, its
   * operation on the tabs. Nothing counts as changed until the user changes it.
   */
  showEdit(state: {
    values: Record<string, FeatureScalarValue>;
    operation: FeatureOpKind;
    seedPicks: (picker: SchemaPicker) => void;
  }): void {
    this.shell.setTitle(`Edit ${this.schema.label.toLowerCase()}`);
    for (const [name, field] of this.fields) {
      field.seed(name in state.values ? state.values[name] : this.schema.defaultOf(name));
    }
    for (const picker of this.pickers.values()) {
      state.seedPicks(picker);
    }
    this.opTabs?.setValue(state.operation);
    this.syncVisibility();
    this.armFirstPicker({ preferEmpty: false });
    this.shell.show();
  }

  /**
   * Move the armed state onto one slot. A hidden value, or one on a tab out
   * of view, can't be armed; null disarms every slot.
   */
  armSlot(slot: ArmedSlot): void {
    const picker = slot && slot !== 'scope' ? this.pickers.get(slot) : undefined;
    if (picker && (!picker.visible || !this.onShownTab(picker))) {
      return;
    }
    if (slot === 'scope' && !this.scopeSlot?.visible) {
      return;
    }
    const changed = this.armed !== slot;
    this.armed = slot;
    for (const [name, each] of this.pickers) {
      each.setArmed(name === slot);
    }
    this.scopeSlot?.setArmed(slot === 'scope');
    if (changed) {
      this.onArmedSlotChange?.();
    }
  }

  /**
   * Arm the first visible value the dialog can pick — the first still
   * empty one when `preferEmpty` (a fresh dialog).
   */
  armFirstPicker(opts: { preferEmpty?: boolean } = {}): void {
    const candidates = this.pickableValues();
    const next = (opts.preferEmpty ?? true) ? candidates.find(p => p.isEmpty) ?? candidates[0] : candidates[0];
    this.armSlot(next?.name ?? null);
  }

  /**
   * A pick just filled the single value `name`: the armed state moves on to
   * the next value still waiting for one, if any — the order the dialog
   * reads in.
   */
  advanceFrom(name: string): void {
    const candidates = this.pickableValues();
    const at = candidates.findIndex(p => p.name === name);
    const next = candidates.slice(at + 1).find(p => p.isEmpty);
    if (next) {
      this.armSlot(next.name);
    }
  }

  /** The picked values the dialog can arm right now — shown, on the shown tab — in the order they read. */
  private pickableValues(): SchemaPicker[] {
    return [...this.pickers.values()].filter(p => p.visible && this.onShownTab(p));
  }

  private onShownTab(picker: SchemaPicker): boolean {
    return !picker.spec.tab || !this.tabs || picker.spec.tab === this.tabs.value;
  }

  /**
   * Show each row whose `visibleWhen` holds, its group heading while any of
   * its rows shows, and the scope row unless the operation is New. An armed
   * slot that just hid hands the armed state on.
   */
  syncVisibility(): void {
    const scalars = this.scalars();
    for (const [name, field] of this.fields) {
      field.setVisible(this.schema.isVisible(name, scalars));
    }
    for (const [name, picker] of this.pickers) {
      picker.setVisible(this.schema.isVisible(name, scalars));
    }
    for (const { host, names } of this.groupHosts) {
      const anyShown = names.some(name => this.fields.get(name)?.visible ?? this.pickers.get(name)?.visible);
      host.classList.toggle('hidden', !anyShown);
    }
    this.scopeSlot?.setVisible(this.operation !== 'new');
    const armedPicker = this.armedPicker;
    if ((armedPicker && !armedPicker.visible) || (this.armed === 'scope' && !this.scopeSlot?.visible)) {
      this.armFirstPicker();
    }
    // A pick slot that just showed takes the armed state when none holds it.
    if (this.armed === null && this.pickableValues().length > 0) {
      this.armFirstPicker();
    }
  }

  setOperation(op: FeatureOpKind): void {
    this.opTabs?.setValue(op);
    this.syncVisibility();
  }

  /** The variables the number rows' dropdowns offer. */
  setScopeVariables(variables: VariableInfo[]): void {
    for (const field of this.fields.values()) {
      field.setVariables(variables);
    }
  }

  destroy(): void {
    for (const field of this.fields.values()) {
      field.destroy();
    }
    super.destroy();
  }

  private showTab(name: string): void {
    for (const [tab, pane] of this.panes) {
      pane.classList.toggle('hidden', tab !== name);
      pane.classList.toggle('flex', tab === name);
    }
    // A slot on the pane just hidden hands the armed state on.
    const armed = this.armedPicker;
    if (armed && !this.onShownTab(armed)) {
      this.armFirstPicker();
    }
  }

  private append(role: string, className: string): HTMLElement {
    const el = document.createElement('div');
    el.dataset.role = role;
    el.className = className;
    this.body.appendChild(el);
    return el;
  }

  private renderBlocks(host: HTMLElement, blocks: SchemaBlock[]): void {
    for (const block of blocks) {
      let target = host;
      if (block.group !== null) {
        const group = document.createElement('div');
        group.dataset.group = block.group;
        group.className = 'flex flex-col gap-3.5';
        const heading = document.createElement('div');
        heading.className = GROUP_HEADING_CLASS;
        heading.textContent = block.group;
        group.appendChild(heading);
        host.appendChild(group);
        this.groupHosts.push({ host: group, names: block.names });
        target = group;
      }
      for (const name of block.names) {
        target.appendChild(this.renderRow(name));
      }
    }
  }

  private renderRow(name: string): HTMLElement {
    const spec = this.schema.param(name);
    if (FeatureSchema.isPicker(spec)) {
      const picker = new SchemaPicker(name, spec as FeaturePickerParam);
      picker.onArm = () => this.armSlot(name);
      picker.onChange = () => this.onChange?.();
      this.pickers.set(name, picker);
      return picker.row;
    }
    const field = SchemaField.create(name, spec as FeatureScalarParam);
    field.onChange = () => {
      this.syncVisibility();
      this.onChange?.();
    };
    field.onSubmit = () => this.onApply?.();
    this.fields.set(name, field);
    return field.row;
  }
}
