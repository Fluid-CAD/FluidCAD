import type {
  FeatureLayoutImage, FeatureLayoutItem, FeatureLayoutNote, FeatureLayoutRow, FeatureLayoutSection, FeatureLayoutTabs,
  FeatureListValue, FeatureOpKind, FeaturePickerParam, FeatureScalarParam, FeatureScalarValue, FeatureStaticItem,
  FeatureVisibleWhen,
} from '../../../api';
import { FoldingSection } from '../../../ui/controls';
import type { VariableInfo } from '../../../ui/expression-core';
import { FeaturePanel } from '../feature-panel';
import { ChoiceTabs } from '../panel-controls';
import { ScopeSlotControl } from '../scope-slot';
import { FeatureSchema } from './feature-schema';
import { SchemaField } from './schema-fields';
import { SchemaPicker } from './schema-pickers';

/** The slot the next viewport pick lands in: a picked value by name, or the `.scope(…)` row. */
export type ArmedSlot = string | 'scope' | null;

const GROUP_HEADING_CLASS = 'text-[10px] uppercase tracking-wide text-base-content/45';
const COLUMN_CLASS = 'flex flex-col gap-3.5';

type Scalars = Readonly<Record<string, FeatureScalarValue | undefined>>;

/**
 * One rendered item of the layout, as visibility walks it: a value's row
 * (`name`), or the element an item hides (`el`) with what it holds.
 */
interface LayoutNode {
  item: FeatureLayoutItem;
  name?: string;
  el?: HTMLElement;
  /** A row's cell holding this item: it leaves the row while the item hides. */
  cell?: HTMLElement;
  children: LayoutNode[];
}

/** Where a value's row sits: its tab's pane, the section that may fold over it, and every `visibleWhen` above it. */
interface RowPlace {
  tab: string | null;
  fold: FoldingSection | null;
  when: FeatureVisibleWhen[];
}

/**
 * The dialog a custom feature's metadata describes, rendered from its
 * {@link FeatureSchema}: the operation tabs when the feature offers a choice
 * of operations, then the feature's layout tree — typed-in rows
 * (expression fields, selects, toggles, text) and pick slots, side by side
 * in a row's grid, under a section's heading (which may fold), on a tab's
 * pane, with notes, images and dividers between them — and the framework's
 * `.scope(…)` row last, for any feature with operations. An `aside` shows
 * on the card beside the dialog, and at the top of the body where the card
 * has no room. Rows and items whose `visibleWhen` fails hide, and a
 * container with nothing left to show. Pure DOM and form state: the service
 * owns the scene, the picks' routing, the previews and the apply.
 */
export class SchemaFeaturePanel extends FeaturePanel {
  /** The armed slot changed — the service re-aims the viewer's pick channels. */
  onArmedSlotChange?: () => void;
  /** The operation tab changed. */
  onOperationChange?: () => void;
  /** A scope chip's ✕. */
  onScopeRemove?: (index: number) => void;
  /** The Preview toggle flipped. */
  onPreviewToggle?: (on: boolean) => void;

  readonly fields = new Map<string, SchemaField>();
  readonly pickers = new Map<string, SchemaPicker>();
  readonly scopeSlot: ScopeSlotControl | null = null;

  private readonly opTabs: ChoiceTabs<FeatureOpKind> | null = null;
  private tabs: ChoiceTabs<string> | null = null;
  private readonly panes = new Map<string, HTMLElement>();
  private readonly nodes: LayoutNode[];
  /** The aside at the top of the body, where the dialog is a sheet and the card has no room. */
  private readonly asides: { host: HTMLElement; nodes: LayoutNode[] }[] = [];
  /**
   * The card beside the dialog and what it can show, one at a time: the
   * feature's aside (under null) and each value's own, by name.
   */
  private readonly card: HTMLElement | null = null;
  private readonly cardGroups = new Map<string | null, { el: HTMLElement; nodes: LayoutNode[]; shows: boolean }>();
  /** The value whose row holds the focus, and the one with an aside under the pointer. */
  private focusedValue: string | null = null;
  private hoveredValue: string | null = null;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly places = new Map<string, RowPlace>();
  private readonly folds: { fold: FoldingSection; collapsed: boolean }[] = [];
  private readonly images: { img: HTMLImageElement; path: string }[] = [];
  private readonly pausedRow: HTMLElement;
  /** The Preview toggle; null for a feature whose metadata draws no preview (`ghost: false`). */
  private readonly previewToggle: HTMLInputElement | null = null;
  private armed: ArmedSlot = null;

  constructor(container: HTMLElement, readonly schema: FeatureSchema, iconSrc: string) {
    super(container, {
      id: `fluidcad-feature-${schema.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`,
      title: schema.label,
      icon: iconSrc,
      bodyHtml: '',
      width: schema.meta.width,
    });

    const aside = schema.meta.aside;
    const valueAsides = Object.entries(schema.meta.params)
      .filter(([, spec]) => spec.aside !== undefined && spec.aside.length > 0)
      .map(([name, spec]) => [name, spec.aside!] as const);
    if ((aside && aside.length > 0) || valueAsides.length > 0) {
      // The card hides where the dialog is a sheet: the body keeps its own copy of the feature's aside for there.
      const card = this.card = this.shell.addSideCard();
      for (const [key, items] of [[null, aside ?? []] as const, ...valueAsides]) {
        if (items.length === 0) {
          continue;
        }
        const el = document.createElement('div');
        el.dataset.role = key === null ? 'aside-feature' : `aside-${key}`;
        el.className = COLUMN_CLASS;
        card.appendChild(el);
        this.cardGroups.set(key, { el, nodes: items.map(item => this.renderStatic(el, item)), shows: true });
      }
      if (aside && aside.length > 0) {
        const host = this.append('aside', `sm:hidden [&_img]:max-h-40 ${COLUMN_CLASS}`);
        this.asides.push({ host, nodes: aside.map(item => this.renderStatic(host, item)) });
      }
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

    this.nodes = this.renderItems(this.body, schema.layout(), { tab: null, fold: null, when: [] });
    if (this.tabs) {
      this.tabs.onChange = () => this.showTab(this.tabs!.value);
      this.showTab(this.tabs.value);
    }

    if (operations.length > 0) {
      this.scopeSlot = new ScopeSlotControl(this.append('scope-slot', ''));
      this.scopeSlot.onArm = () => this.armSlot('scope');
      this.scopeSlot.onRemove = (index) => this.onScopeRemove?.(index);
    }

    if (schema.meta.ghost) {
      const row = this.append('preview-row', 'text-xs');
      const label = document.createElement('label');
      label.className = 'flex items-center justify-between w-full cursor-pointer';
      label.title = 'Draw what the feature builds while you edit it — runs its code on every change';
      const text = document.createElement('span');
      text.className = 'text-base-content/70';
      text.textContent = 'Preview';
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.dataset.role = 'preview-toggle';
      toggle.className = 'toggle toggle-sm toggle-primary';
      toggle.addEventListener('change', () => this.onPreviewToggle?.(toggle.checked));
      label.append(text, toggle);
      row.append(label);
      this.previewToggle = toggle;
    }

    this.pausedRow = this.append('ghost-paused', 'hidden text-xs leading-snug text-base-content/70');
  }

  /** Whether the Preview toggle is on; false for a feature without one. */
  get previewOn(): boolean {
    return this.previewToggle?.checked ?? false;
  }

  /** Set the Preview toggle without firing its change. */
  setPreviewOn(on: boolean): void {
    if (this.previewToggle) {
      this.previewToggle.checked = on;
    }
  }

  /**
   * The preview timed out — it took longer to build than a preview may — and
   * why; null when it runs again. Turning the toggle off and on asks again.
   */
  setPreviewPaused(reason: string | null): void {
    this.pausedRow.textContent = reason ? `Preview timed out. ${reason} Turn it off and on to try again.` : '';
    this.pausedRow.classList.toggle('hidden', reason === null);
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
    this.refold();
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
    values: Record<string, FeatureScalarValue | FeatureListValue>;
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
    this.refold();
    // An edit shows what the statement says: a section opens over a value it writes.
    for (const name of Object.keys(state.values)) {
      this.places.get(name)?.fold?.setFolded(false);
    }
    for (const picker of this.pickers.values()) {
      if (!picker.isEmpty) {
        this.places.get(picker.name)?.fold?.setFolded(false);
      }
    }
    this.syncVisibility();
    this.armFirstPicker({ preferEmpty: false });
    this.shell.show();
  }

  /**
   * Move the armed state onto one slot. A hidden value, one on a tab out of
   * view or one under a folded section can't be armed; null disarms every slot.
   */
  armSlot(slot: ArmedSlot): void {
    const picker = slot && slot !== 'scope' ? this.pickers.get(slot) : undefined;
    if (picker && !this.reachable(picker)) {
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

  /** The picked values the dialog can arm right now, in the order they read. */
  private pickableValues(): SchemaPicker[] {
    return [...this.pickers.values()].filter(p => this.reachable(p));
  }

  /** A pick can land in this value: its row shows, on the shown tab, under no folded section. */
  private reachable(picker: SchemaPicker): boolean {
    const place = this.places.get(picker.name);
    const onShownTab = !place?.tab || !this.tabs || place.tab === this.tabs.value;
    return picker.visible && onShownTab && place?.fold?.folded !== true;
  }

  /**
   * Bring a value's row into view: switch to its tab and unfold its section
   * — what Apply does for the value that blocks it.
   */
  reveal(name: string): void {
    const place = this.places.get(name);
    if (!place) {
      return;
    }
    if (place.tab && this.tabs && this.tabs.value !== place.tab) {
      this.tabs.setValue(place.tab);
      this.showTab(place.tab);
    }
    if (place.fold?.folded) {
      place.fold.setFolded(false);
      this.onFold(false);
    }
  }

  /**
   * Show each row whose `visibleWhen` holds and every one above it in the
   * layout, each item whose own holds, a container (a row, a section) while
   * anything in it shows, and the scope row unless the operation is New. An
   * armed slot that just hid hands the armed state on.
   */
  syncVisibility(): void {
    const scalars = this.settleOffered();
    for (const [name, field] of this.fields) {
      field.setVisible(this.rowShows(name, scalars));
    }
    for (const [name, picker] of this.pickers) {
      picker.setVisible(this.rowShows(name, scalars));
    }
    this.syncNodes(this.nodes, scalars);
    for (const { host, nodes } of this.asides) {
      const anyShown = this.syncNodes(nodes, scalars);
      host.classList.toggle('hidden', !anyShown);
    }
    for (const group of this.cardGroups.values()) {
      group.shows = this.syncNodes(group.nodes, scalars);
    }
    this.showCard();
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

  /**
   * Narrows every options row to what the typed-in values offer now, and
   * gives those values back as they stand afterwards. A row whose choice
   * fell away moves, which may narrow a row that waits on it: the pass runs
   * again until nothing moves — a row per pass at most, a feature's options
   * never waiting on each other in a circle.
   */
  private settleOffered(): Record<string, FeatureScalarValue | undefined> {
    let scalars = this.scalars();
    for (let pass = 0; pass < this.fields.size; pass++) {
      let moved = false;
      for (const field of this.fields.values()) {
        moved = field.setOffered(scalars) || moved;
      }
      if (!moved) {
        break;
      }
      scalars = this.scalars();
    }
    return scalars;
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

  /** A file the feature declares was saved: every row showing one asks for it again, and the layout's and the aside's pictures. */
  refreshImages(): void {
    for (const field of this.fields.values()) {
      field.refreshImages();
    }
    for (const { img, path } of this.images) {
      img.src = this.schema.assetUrl(path);
    }
  }

  /**
   * The card shows the aside of the value under the pointer, else of the
   * value whose row holds the focus, else the feature's own: a value with
   * no aside of its own — or one whose items all hide — shows the
   * feature's. The card hides when what it would show is nothing.
   */
  private showCard(): void {
    if (!this.card) {
      return;
    }
    const own = (name: string | null) => {
      const group = name === null ? undefined : this.cardGroups.get(name);
      const visible = name !== null && (this.fields.get(name)?.visible ?? this.pickers.get(name)?.visible) === true;
      return group?.shows && visible ? name : undefined;
    };
    const key = own(this.hoveredValue) ?? own(this.focusedValue) ?? null;
    const shown = this.cardGroups.get(key);
    for (const [each, group] of this.cardGroups) {
      group.el.classList.toggle('hidden', each !== key);
    }
    this.card.classList.toggle('hidden', !shown?.shows);
    this.card.dataset.showing = key ?? '';
  }

  /**
   * A value's row takes part in what the card shows: focus anywhere in it
   * makes it the focused value (a row without an aside of its own so brings
   * the feature's back); resting the pointer on a row with an aside shows
   * that one while the pointer stays.
   */
  private watchRow(name: string, row: HTMLElement): void {
    if (!this.card) {
      return;
    }
    row.addEventListener('focusin', () => {
      this.focusedValue = name;
      this.showCard();
    });
    row.addEventListener('focusout', (e) => {
      if (this.focusedValue === name && !row.contains(e.relatedTarget as Node | null)) {
        this.focusedValue = null;
        this.showCard();
      }
    });
    if (!this.cardGroups.has(name)) {
      return;
    }
    // A pointer crossing the dialog on its way somewhere swaps nothing: it has to rest first.
    row.addEventListener('pointerenter', () => {
      this.clearHoverTimer();
      this.hoverTimer = setTimeout(() => {
        this.hoverTimer = null;
        this.hoveredValue = name;
        this.showCard();
      }, SchemaFeaturePanel.HOVER_MS);
    });
    row.addEventListener('pointerleave', () => {
      this.clearHoverTimer();
      if (this.hoveredValue === name) {
        this.hoveredValue = null;
        this.showCard();
      }
    });
  }

  private clearHoverTimer(): void {
    if (this.hoverTimer !== null) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
  }

  /** How long the pointer rests on a row before the card shows its aside. */
  static readonly HOVER_MS = 150;

  /** A popover a row opened hangs off the page, not the dialog: it goes when the dialog does. */
  hide(): void {
    this.clearHoverTimer();
    this.focusedValue = this.hoveredValue = null;
    for (const field of this.fields.values()) {
      field.dismiss();
    }
    super.hide();
  }

  destroy(): void {
    this.clearHoverTimer();
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
    if (armed && !this.reachable(armed)) {
      this.armFirstPicker();
    }
  }

  /** Every folding section back to how it was declared: the dialog opens with 'collapsed' folded, whatever the last one left — an edit then opens those its statement writes into. */
  private refold(): void {
    for (const { fold, collapsed } of this.folds) {
      fold.setFolded(collapsed);
    }
  }

  /**
   * A section folded or unfolded: a slot it just folded over hands the armed
   * state on, and one it just uncovered takes it when none holds it.
   */
  private onFold(folded: boolean): void {
    const armed = this.armedPicker;
    if (folded && armed && !this.reachable(armed)) {
      this.armFirstPicker();
    }
    if (!folded && this.armed === null && this.pickableValues().length > 0) {
      this.armFirstPicker();
    }
  }

  /** A value's row shows: its own `visibleWhen` holds, and that of every item it sits in. */
  private rowShows(name: string, scalars: Scalars): boolean {
    const above = this.places.get(name)?.when ?? [];
    return this.schema.isVisible(name, scalars) && above.every(when => FeatureSchema.holds(when, scalars));
  }

  /**
   * Hide each item whose `visibleWhen` fails and each container left with
   * nothing to show; whether anything among `nodes` shows. A divider shows
   * but is nothing to keep a container for.
   */
  private syncNodes(nodes: LayoutNode[], scalars: Scalars): boolean {
    let anyShown = false;
    for (const node of nodes) {
      anyShown = this.syncNode(node, scalars) || anyShown;
    }
    return anyShown;
  }

  private syncNode(node: LayoutNode, scalars: Scalars): boolean {
    const shows = this.nodeShows(node, scalars);
    // A cell whose item hides leaves the row: the cells still showing share its width.
    node.cell?.classList.toggle('hidden', !shows);
    return shows;
  }

  private nodeShows(node: LayoutNode, scalars: Scalars): boolean {
    const { item } = node;
    if (node.name !== undefined) {
      return (this.fields.get(node.name)?.visible ?? this.pickers.get(node.name)?.visible) === true;
    }
    if (typeof item === 'string' || 'divider' in item) {
      return false;
    }
    if ('tabs' in item) {
      // A tab stays on the row even when its pane has nothing to show.
      this.syncNodes(node.children, scalars);
      return true;
    }
    const inside = 'row' in item || 'section' in item ? this.syncNodes(node.children, scalars) : true;
    const shows = inside && FeatureSchema.itemShows(item, scalars);
    node.el?.classList.toggle('hidden', !shows);
    return shows;
  }

  private append(role: string, className: string): HTMLElement {
    return this.appendTo(this.body, role, className);
  }

  private appendTo(host: HTMLElement, role: string, className: string): HTMLElement {
    const el = document.createElement('div');
    el.dataset.role = role;
    el.className = className;
    host.appendChild(el);
    return el;
  }

  private renderItems(host: HTMLElement, items: readonly FeatureLayoutItem[], place: RowPlace): LayoutNode[] {
    return items.map(item => this.renderItem(host, item, place));
  }

  /** One item of the layout into `host`: a value's row, a row of cells, a section, the tabs, or a static item. */
  private renderItem(host: HTMLElement, item: FeatureLayoutItem, place: RowPlace): LayoutNode {
    if (typeof item === 'string') {
      this.places.set(item, place);
      host.appendChild(this.renderRow(item));
      return { item, name: item, children: [] };
    }
    if ('row' in item) {
      return this.renderCells(host, item, place);
    }
    if ('section' in item) {
      return this.renderSection(host, item, place);
    }
    if ('tabs' in item) {
      return this.renderTabs(host, item, place);
    }
    return this.renderStatic(host, item);
  }

  /**
   * A row's cells side by side, `widths` as their shares of the line, level
   * along the top — a hint hangs under its own cell without lifting it. A
   * cell is never narrower than its content can be without cutting a label
   * short (a choice's labels stay whole, a select is as wide as its longest
   * option): one that doesn't fit beside the others wraps onto a line of its
   * own, and a cell whose item hides leaves the row to the cells that show.
   */
  private renderCells(host: HTMLElement, item: FeatureLayoutRow, place: RowPlace): LayoutNode {
    const el = document.createElement('div');
    el.dataset.role = 'layout-row';
    el.className = 'flex flex-wrap gap-x-2 gap-y-3.5 items-start';
    const inside = SchemaFeaturePanel.under(place, item.visibleWhen);
    const children = item.row.map((cell, i) => {
      const slot = document.createElement('div');
      slot.dataset.role = 'layout-cell';
      // Grows by its share from nothing; its content's narrowest is its floor, the row's width its ceiling.
      slot.className = 'max-w-full';
      slot.style.flex = `${item.widths?.[i] ?? 1} 1 0%`;
      el.appendChild(slot);
      return { ...this.renderItem(slot, cell, inside), cell: slot };
    });
    host.appendChild(el);
    return { item, el, children };
  }

  /**
   * A heading over its items. One that folds wears the heading as a button
   * and keeps its items in the body it folds; one that doesn't is the plain
   * group it always was.
   */
  private renderSection(host: HTMLElement, item: FeatureLayoutSection, place: RowPlace): LayoutNode {
    const inside = SchemaFeaturePanel.under(place, item.visibleWhen);
    if (FeatureSchema.folds(item)) {
      const fold = new FoldingSection({
        title: item.section, folded: item.collapsed === true, headingClass: GROUP_HEADING_CLASS, columnClass: COLUMN_CLASS,
      });
      fold.root.dataset.group = item.section;
      fold.onToggle = folded => this.onFold(folded);
      this.folds.push({ fold, collapsed: item.collapsed === true });
      host.appendChild(fold.root);
      return { item, el: fold.root, children: this.renderItems(fold.body, item.items, { ...inside, fold }) };
    }
    const group = document.createElement('div');
    group.dataset.group = item.section;
    group.className = COLUMN_CLASS;
    const heading = document.createElement('div');
    heading.className = GROUP_HEADING_CLASS;
    heading.textContent = item.section;
    group.appendChild(heading);
    host.appendChild(group);
    return { item, el: group, children: this.renderItems(group, item.items, inside) };
  }

  /** The tab row, then a pane per tab; more than three tabs wear the compact look. */
  private renderTabs(host: HTMLElement, item: FeatureLayoutTabs, place: RowPlace): LayoutNode {
    const children: LayoutNode[] = [];
    if (this.tabs || item.tabs.length === 0) {
      return { item, children };
    }
    const tabHost = this.appendTo(host, 'tabs', 'join w-full');
    this.tabs = new ChoiceTabs(tabHost, item.tabs.map(t => ({ key: t.label, label: t.label, title: t.label })),
      item.tabs[0].label, { compact: item.tabs.length > 3 });
    for (const tab of item.tabs) {
      const pane = this.appendTo(host, `tab-${tab.label}`, COLUMN_CLASS);
      children.push(...this.renderItems(pane, tab.items, { ...place, tab: tab.label }));
      this.panes.set(tab.label, pane);
    }
    return { item, children };
  }

  /** A note, an image or a divider — in the layout, a row's cell or the aside. */
  private renderStatic(host: HTMLElement, item: FeatureStaticItem): LayoutNode {
    let el: HTMLElement;
    if ('note' in item) {
      el = this.renderNote(item);
    } else if ('image' in item) {
      el = this.renderImage(item);
    } else {
      el = document.createElement('div');
      el.dataset.role = 'divider';
      el.className = 'border-t border-base-content/10';
    }
    host.appendChild(el);
    return { item, el, children: [] };
  }

  private renderNote(item: FeatureLayoutNote): HTMLElement {
    const el = document.createElement('div');
    el.dataset.role = 'note';
    el.dataset.tone = item.tone ?? 'info';
    el.className = `text-xs leading-snug ${item.tone === 'warning' ? 'text-warning' : 'text-base-content/70'}`;
    el.textContent = item.note;
    return el;
  }

  /** The picture a layout or an aside names, served as of the module's latest save. */
  private renderImage(item: FeatureLayoutImage): HTMLElement {
    const img = document.createElement('img');
    img.dataset.role = 'image';
    img.className = 'block max-w-full mx-auto object-contain';
    img.alt = item.alt ?? '';
    img.src = this.schema.assetUrl(item.image);
    if (item.height !== undefined) {
      img.style.height = `${item.height}px`;
    }
    this.images.push({ img, path: item.image });
    return img;
  }

  /** `place` with one more `visibleWhen` above it. */
  private static under(place: RowPlace, when: FeatureVisibleWhen | undefined): RowPlace {
    return when ? { ...place, when: [...place.when, when] } : place;
  }

  private renderRow(name: string): HTMLElement {
    const spec = this.schema.param(name);
    if (FeatureSchema.isPicker(spec)) {
      const picker = new SchemaPicker(name, spec as FeaturePickerParam);
      picker.onArm = () => this.armSlot(name);
      picker.onChange = () => this.onChange?.();
      this.pickers.set(name, picker);
      this.watchRow(name, picker.row);
      return picker.row;
    }
    const field = SchemaField.create(name, spec as FeatureScalarParam, { assetUrl: path => this.schema.assetUrl(path) });
    field.onChange = () => {
      this.syncVisibility();
      this.onChange?.();
    };
    field.onSubmit = () => this.onApply?.();
    this.fields.set(name, field);
    this.watchRow(name, field.row);
    return field.row;
  }
}
