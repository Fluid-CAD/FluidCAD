/**
 * The Manage-configurations grid (`docs/assembly-configurations-plan.md`
 * §3.4, "Manage…"): the whole `configurations()` table at once, drawn as a
 * spreadsheet — rows are the configurations, columns the definition's
 * parameters, every cell a borderless control of the parameter's own type
 * (`param-controls.ts`), with row numbers, gridlines and an outlined
 * active cell.
 *
 * - A pinned first row, Default, shows the `param()` literals read-only.
 * - A blank cell inherits the literal: it shows the literal dimmed, and
 *   becomes a set cell as soon as it is edited. Its ↺ clears it back.
 * - A cell the source writes as an expression (`Width: base * 2`) is read
 *   only, showing its source text; ↺ still clears it.
 * - The name column is editable inline (renames) and sticky while the
 *   parameters scroll sideways; the toolbar adds, duplicates and deletes
 *   rows (delete asks first).
 * - Enter / ↓ and Shift+Enter / ↑ move between the rows of a column.
 * - A range copied from a spreadsheet pastes in (`configurations-paste.ts`):
 *   matched by its header row when it has one, else laid from the active
 *   cell. A paste that cannot land changes nothing and says why in the
 *   footer; ignored columns and kept expressions are a warning there.
 * - In a part file with several `part()` bodies the columns are every
 *   part's parameters, grouped under a header row naming the part
 *   (`GridColumns`): two parts may both declare `Width`, so columns, cells
 *   and the commit are keyed by part + label. A single part or an assembly
 *   has no part header.
 *
 * Nothing is written until Apply, which sends ONE commit — renames,
 * removals and only the cells that changed — so the table statement is
 * rewritten once (one undo step, one render). A refusal shows in the footer
 * and the dialog stays open. Everything the user typed is assigned through
 * `.value` / `.textContent`, never markup.
 */

import type {
  CatalogParamDef,
  CatalogParamExpr,
  CatalogParamValue,
  ConfigurationSourceTable,
  ConfigurationTableCommit,
  SourceLocation,
} from '../api';
import type { UIConfigurations, UIParamDefinition } from '../types';
import { ICON_CLOSE, ICON_COPY, ICON_PLUS, ICON_TRASH } from './icons';
import { configurationNameProblem } from './configuration-dialogs';
import { DEFAULT_CONFIGURATION, GridColumns, type Cell, type GridCellRef, type GridRow } from './configurations-grid-model';
import { ConfigurationsPaste } from './configurations-paste';
import { createParamControl, effectiveControlType, type ParamControl } from './param-controls';
import { SpreadsheetClipboard } from './spreadsheet-clipboard';

const OVERLAY_CLASS = 'fixed inset-0 z-[300] bg-black/50 flex items-center justify-center';
const CARD_CLASS = 'w-[min(1180px,94vw)] max-h-[84vh] bg-base-100 border border-base-content/10 rounded-lg p-5 '
  + 'shadow-[0_4px_24px_rgba(0,0,0,0.5)] flex flex-col min-h-0';
const TOOLBAR_BUTTON_CLASS = 'btn btn-ghost btn-xs gap-1 font-normal text-base-content/70 hover:text-base-content/90 [&_svg]:size-3.5';
/** The sheet's frame; its cells draw the inner gridlines, the last row and column leave the edge to it. */
const SHEET_CLASS = 'overflow-auto flex-1 min-h-0 border border-base-content/15 rounded-md '
  + '[&_tr>*:last-child]:border-r-0 [&_tbody>tr:last-child>*]:border-b-0';
const GRID_LINE = 'border-r border-b border-base-content/15';
const HEADER_CELL_CLASS = `h-8 px-2 bg-base-200 text-xs font-medium text-base-content/70 whitespace-nowrap ${GRID_LINE}`;
/** The row-number column — sticky, so it gets an opaque background like the name column. */
const GUTTER_CELL_CLASS = `sticky left-0 w-10 min-w-10 px-1 bg-base-200 text-center text-[11px] tabular-nums text-base-content/45 select-none ${GRID_LINE}`;
/** The sticky name column — each use gives it an opaque background, so the parameters scrolling under it stay hidden. */
const NAME_CELL_CLASS = `sticky left-10 w-48 min-w-48 p-0 ${GRID_LINE}`;
const VALUE_CELL_CLASS = `group/cell min-w-40 h-8 p-0 align-middle ${GRID_LINE}`;
/** The spreadsheet's active-cell frame, on whichever cell holds the focus. */
const ACTIVE_CELL_CLASS = 'focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-primary';
/** A selected row's tint: an inset shadow, so it also tints the opaque sticky cells. */
const SELECTED_TINT_CLASS = 'group-data-[selected]/row:shadow-[inset_0_0_0_9999px_color-mix(in_oklab,var(--color-primary)_7%,transparent)]';
const SELECTED_GUTTER_CLASS = 'group-data-[selected]/row:text-primary group-data-[selected]/row:font-semibold '
  + 'group-data-[selected]/row:shadow-[inset_0_0_0_9999px_color-mix(in_oklab,var(--color-primary)_16%,transparent)]';
const NAME_INPUT_CLASS = 'w-full h-8 px-2 bg-transparent text-[13px] font-medium border-0 outline-none '
  + 'aria-[invalid=true]:text-error aria-[invalid=true]:bg-error/10';
const RESET_BUTTON_CLASS = 'btn btn-ghost btn-square btn-xs size-6 min-h-0 shrink-0 mr-0.5 text-base-content/40 hover:text-base-content/80 '
  + 'opacity-0 group-hover/cell:opacity-100 group-focus-within/cell:opacity-100';
/** A right-aligned header or Default value ends where a cell's number does: its padding plus the ↺ slot. */
const NUMERIC_TEXT_CLASS = 'text-right tabular-nums pr-[2.125rem]';
const MESSAGE_TONE_CLASS = { error: 'bg-error text-error-content', warning: 'bg-warning text-warning-content' } as const;
/** A part's name over its run of columns, in a grid whose columns come from several parts. */
const PART_HEADER_CLASS = 'sticky top-0 z-20 text-left text-base-content/85 font-semibold';
/** The divider before each part's run of columns after the first. */
const GROUP_EDGE_CLASS = 'border-l border-l-base-content/30';

export type ConfigurationsGridOptions = {
  /**
   * The columns: the parameters the file's tables can set (no project
   * globals) — every part's, in a part file with several; grouped by part
   * in the order given.
   */
  params: UIParamDefinition[];
  /** The tables as the last render carried them — the fallback when the source cannot be read. */
  configurations: UIConfigurations;
  /** The tables as the source writes them, which tells literal cells from expressions. */
  loadTable?: () => Promise<ConfigurationSourceTable[] | null>;
  /**
   * Where a row the grid adds with no cell set goes: the Add to part's
   * `part()` statement. Without it, the file's only body.
   */
  home?: SourceLocation | null;
  /** Write the commit. Resolves null when it landed — the dialog closes — or the refusal's text. */
  commit(commit: ConfigurationTableCommit): Promise<string | null>;
  /** Asks before a row is deleted from the grid; resolves true to delete. Without it, deletes at once. */
  confirmDelete?: (name: string) => Promise<boolean>;
  /** The document's length unit, for the header's note. */
  unit?: string;
};

/** A footer line the user can dismiss: what the last paste refused or warned about. */
type Notice = { tone: 'error' | 'warning'; text: string };

/** The grid's dialog; resolves once it closes — applied or cancelled. */
export function openConfigurationsGrid(host: HTMLElement, opts: ConfigurationsGridOptions): Promise<void> {
  return new Promise((resolve) => {
    new ConfigurationsGrid(host, opts, resolve);
  });
}

class ConfigurationsGrid {
  private readonly overlay: HTMLDivElement;
  private readonly body: HTMLElement;
  private readonly message: HTMLElement;
  private readonly messageText: HTMLElement;
  private readonly messageDismiss: HTMLButtonElement;
  private readonly apply: HTMLButtonElement;
  private readonly duplicateButton: HTMLButtonElement;
  private readonly deleteButton: HTMLButtonElement;
  private readonly columns: GridColumns;
  private readonly params: UIParamDefinition[];
  private rows: GridRow[] = [];
  /** Source rows the grid deleted — the commit's `removed`. */
  private removed: string[] = [];
  /** The row the toolbar's Duplicate / Delete act on. */
  private selected: GridRow | null = null;
  private loaded = false;
  private busy = false;
  /** While the delete confirm is open over the grid — it takes Escape and paste. */
  private confirming = false;
  private settled = false;
  /** The last Apply's refusal, shown in the footer until the next Apply. */
  private refusal: string | null = null;
  /** The last paste's refusal or warnings, shown in the footer until dismissed, the next paste or Apply. */
  private notice: Notice | null = null;
  private readonly onKey = (e: KeyboardEvent) => {
    if (this.detachedFromOutside()) {
      return;
    }
    if (e.key === 'Escape' && !this.busy && !this.confirming) {
      e.stopPropagation();
      this.close();
    }
  };
  /** Paste lands in the grid wherever the focus is in it — or nowhere, which pastes from the selected row. */
  private readonly onPaste = (e: ClipboardEvent) => {
    if (this.detachedFromOutside() || !this.loaded || this.busy || this.confirming) {
      return;
    }
    if (e.target instanceof Node && e.target !== document.body && !this.overlay.contains(e.target)) {
      return;
    }
    const text = e.clipboardData?.getData('text/plain') ?? '';
    const table = SpreadsheetClipboard.parse(text);
    if (!SpreadsheetClipboard.isRange(text, table)) {
      return; // plain text into the focused field: the browser's own paste
    }
    e.preventDefault();
    this.paste(table, this.pasteAnchor());
  };

  constructor(
    host: HTMLElement,
    private readonly opts: ConfigurationsGridOptions,
    private readonly resolve: () => void,
  ) {
    this.columns = new GridColumns(opts.params);
    this.params = this.columns.params;
    this.overlay = document.createElement('div');
    this.overlay.className = OVERLAY_CLASS;
    this.overlay.dataset.configurationsGrid = '';
    this.overlay.innerHTML = `
      <div class="${CARD_CLASS}" role="dialog" aria-label="Manage configurations">
        <div class="flex items-center justify-between mb-1">
          <h3 class="text-sm font-medium text-base-content/90">Manage configurations</h3>
          <button data-ref="close" class="btn btn-ghost btn-square btn-xs text-base-content/60" title="Close">
            <span class="[&>svg]:size-4">${ICON_CLOSE}</span>
          </button>
        </div>
        <p data-ref="subtitle" class="text-[11px] text-base-content/50 mb-3"></p>
        <div class="flex items-center gap-1 mb-2">
          <button data-ref="add" class="${TOOLBAR_BUTTON_CLASS}" title="A new configuration — every cell inherits the parameters' values">${ICON_PLUS}<span>Add row</span></button>
          <button data-ref="duplicate" class="${TOOLBAR_BUTTON_CLASS}" title="A copy of the selected configuration">${ICON_COPY}<span>Duplicate row</span></button>
          <button data-ref="delete" class="${TOOLBAR_BUTTON_CLASS} hover:text-error" title="Delete the selected configuration">${ICON_TRASH}<span>Delete row</span></button>
        </div>
        <div data-ref="body" class="${SHEET_CLASS}">
          <div class="p-4 text-xs text-base-content/50">Loading…</div>
        </div>
        <div class="flex items-center justify-end gap-2 mt-4">
          <div data-ref="message" class="hidden mr-auto flex items-start gap-2 rounded-md px-3 py-1.5 text-xs leading-snug"><span
            data-ref="message-text"></span><button data-ref="message-dismiss" type="button"
            class="hidden shrink-0 opacity-70 hover:opacity-100 [&>svg]:size-3.5" title="Dismiss">${ICON_CLOSE}</button></div>
          <button data-ref="cancel" class="btn btn-ghost btn-sm">Cancel</button>
          <button data-ref="apply" class="btn btn-primary btn-sm" disabled>Apply</button>
        </div>
      </div>
    `;
    const ref = <T extends HTMLElement>(name: string): T => this.overlay.querySelector<T>(`[data-ref="${name}"]`)!;
    this.body = ref('body');
    this.message = ref('message');
    this.messageText = ref('message-text');
    this.messageDismiss = ref<HTMLButtonElement>('message-dismiss');
    this.apply = ref<HTMLButtonElement>('apply');
    this.duplicateButton = ref<HTMLButtonElement>('duplicate');
    this.deleteButton = ref<HTMLButtonElement>('delete');
    const unitNote = opts.unit ? ` Lengths in ${opts.unit}.` : '';
    ref('subtitle').textContent = 'A blank cell inherits the parameter\'s own value (dimmed); edit it to set it, ↺ to clear it. '
      + 'Paste a range from a spreadsheet — with a header row, its columns match the parameters by name'
      + (this.columns.grouped ? ' (a part\'s parameter as “Part · Label”).' : '.')
      + unitNote;

    ref('close').addEventListener('click', () => this.close());
    ref('cancel').addEventListener('click', () => this.close());
    ref('add').addEventListener('click', () => this.addRow());
    this.duplicateButton.addEventListener('click', () => this.duplicateRow());
    this.deleteButton.addEventListener('click', () => void this.deleteRow());
    this.apply.addEventListener('click', () => void this.commit());
    this.messageDismiss.addEventListener('click', () => {
      this.notice = null;
      this.syncApply();
    });
    this.body.addEventListener('keydown', (e) => this.navigate(e));
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay && !this.busy) {
        this.close();
      }
    });
    document.addEventListener('keydown', this.onKey, true);
    document.addEventListener('paste', this.onPaste);
    host.appendChild(this.overlay);
    this.syncToolbar();
    void this.load();
  }

  private async load(): Promise<void> {
    let source: ConfigurationSourceTable[] | null = null;
    try {
      source = (await this.opts.loadTable?.()) ?? null;
    } catch {
      source = null;
    }
    if (this.settled) {
      return;
    }
    this.rows = source
      ? ConfigurationsGrid.rowsFromSource(source, this.columns)
      : ConfigurationsGrid.rowsFromRender(this.opts.configurations, this.columns);
    const active = this.opts.configurations.active;
    this.selected = this.rows.find((row) => row.name === active) ?? this.rows[0] ?? null;
    this.loaded = true;
    this.render();
  }

  private close(): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.removeDocumentListeners();
    this.overlay.remove();
    this.resolve();
  }

  /** Taken out of the document from outside: it keeps no hold on the keyboard or the clipboard. */
  private detachedFromOutside(): boolean {
    if (this.overlay.isConnected) {
      return false;
    }
    this.removeDocumentListeners();
    return true;
  }

  private removeDocumentListeners(): void {
    document.removeEventListener('keydown', this.onKey, true);
    document.removeEventListener('paste', this.onPaste);
  }

  // -------------------------------------------------------------------------
  // Rows
  // -------------------------------------------------------------------------

  private takenNames(except: GridRow): string[] {
    return this.rows.filter((row) => row !== except).map((row) => row.name.trim());
  }

  private uniqueName(base: string): string {
    const names = new Set(this.rows.map((row) => row.name.trim()));
    if (!names.has(base) && base !== DEFAULT_CONFIGURATION) {
      return base;
    }
    for (let n = 2; ; n++) {
      const candidate = `${base} ${n}`;
      if (!names.has(candidate)) {
        return candidate;
      }
    }
  }

  private newRow(name: string, cells = new Map<string, Cell>()): GridRow {
    return { original: null, name, cells, initial: new Map() };
  }

  private addRow(): void {
    const row = this.newRow(this.uniqueName('Configuration'));
    this.rows.push(row);
    this.selected = row;
    this.render();
    this.focusCell({ row: this.rows.indexOf(row), column: 0 });
  }

  private duplicateRow(): void {
    const from = this.selected;
    if (!from) {
      return;
    }
    const row = this.newRow(this.uniqueName(`${from.name.trim()} copy`), new Map(from.cells));
    this.rows.splice(this.rows.indexOf(from) + 1, 0, row);
    this.selected = row;
    this.render();
    this.focusCell({ row: this.rows.indexOf(row), column: 0 });
  }

  private async deleteRow(): Promise<void> {
    const row = this.selected;
    if (!row) {
      return;
    }
    if (this.opts.confirmDelete) {
      this.confirming = true;
      let confirmed: boolean;
      try {
        confirmed = await this.opts.confirmDelete(row.name.trim() || row.original || 'this row');
      } finally {
        this.confirming = false;
      }
      if (!confirmed || this.settled) {
        return;
      }
    }
    const index = this.rows.indexOf(row);
    if (index === -1) {
      return;
    }
    this.rows.splice(index, 1);
    if (row.original !== null) {
      this.removed.push(row.original);
    }
    this.selected = this.rows[Math.min(index, this.rows.length - 1)] ?? null;
    this.render();
  }

  // -------------------------------------------------------------------------
  // Paste
  // -------------------------------------------------------------------------

  /** The focused cell, else the selected row's name. */
  private pasteAnchor(): GridCellRef {
    const focused = document.activeElement ? this.cellOf(document.activeElement) : null;
    return focused ?? { row: Math.max(0, this.selected ? this.rows.indexOf(this.selected) : 0), column: 0 };
  }

  /** Lay a pasted range into the grid — all of it, or, when it cannot land, none of it. */
  private paste(table: string[][], anchor: GridCellRef): void {
    const plan = new ConfigurationsPaste(this.params, this.rows).plan(table, anchor);
    if ('error' in plan) {
      this.notice = { tone: 'error', text: plan.error };
      this.syncApply();
      return;
    }
    const unnamed: GridRow[] = [];
    let first: GridRow | null = null;
    for (const pasted of plan.rows) {
      let row = pasted.target;
      if (row === null) {
        row = this.newRow(pasted.name ?? '');
        this.rows.push(row);
        if (pasted.name === undefined) {
          unnamed.push(row);
        }
      } else if (pasted.name !== undefined) {
        row.name = pasted.name;
      }
      for (const [label, value] of pasted.cells) {
        if (value === null) {
          row.cells.delete(label);
        } else {
          row.cells.set(label, { kind: 'literal', value });
        }
      }
      first ??= row;
    }
    for (const row of unnamed) {
      row.name = this.uniqueName('Configuration');
    }
    this.selected = first ?? this.selected;
    this.notice = plan.warnings.length > 0 ? { tone: 'warning', text: plan.warnings.join(' ') } : null;
    this.render();
    this.focusCell(anchor);
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  /** Enter / ↓ moves down a column, Shift+Enter / ↑ up — from a typed field; a select keeps its arrows. */
  private navigate(e: KeyboardEvent): void {
    const field = e.target;
    if (!(field instanceof HTMLInputElement) || (field.type !== 'text' && field.type !== 'number')) {
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) {
      return;
    }
    let step = 0;
    if (e.key === 'Enter') {
      step = e.shiftKey ? -1 : 1;
    } else if (e.key === 'ArrowDown') {
      step = 1;
    } else if (e.key === 'ArrowUp') {
      step = -1;
    }
    const at = this.cellOf(field);
    if (step === 0 || !at) {
      return;
    }
    e.preventDefault();
    this.focusCell({ row: at.row + step, column: at.column });
  }

  /** The grid cell an element sits in, or null outside the configurations' cells. */
  private cellOf(element: Element): GridCellRef | null {
    const td = element.closest<HTMLElement>('td[data-col]');
    const tr = td?.closest<HTMLElement>('tr[data-row-index]');
    if (!td || !tr || !this.body.contains(tr)) {
      return null;
    }
    return { row: Number(tr.dataset.rowIndex), column: Number(td.dataset.col) };
  }

  /** Focus a cell's field, its text selected so typing replaces it; a cell off the grid is left alone. */
  private focusCell(at: GridCellRef): void {
    const td = this.body.querySelector(`tr[data-row-index="${at.row}"] > td[data-col="${at.column}"]`);
    const field = td?.querySelector<HTMLInputElement | HTMLSelectElement>('input, select');
    field?.focus();
    if (field instanceof HTMLInputElement && (field.type === 'text' || field.type === 'number')) {
      field.select();
    }
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  private render(): void {
    const table = document.createElement('table');
    table.className = 'text-[13px] border-separate border-spacing-0 w-max min-w-full';
    table.dataset.grid = '';
    table.appendChild(this.headRow());
    const tbody = document.createElement('tbody');
    tbody.appendChild(this.defaultRow());
    this.rows.forEach((row, index) => tbody.appendChild(this.gridRow(row, index)));
    table.appendChild(tbody);
    this.body.replaceChildren(table);
    if (this.params.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'p-3 text-xs text-base-content/50';
      empty.textContent = 'This file declares no parameters — the configurations have nothing to set.';
      this.body.appendChild(empty);
    }
    this.syncToolbar();
    this.syncApply();
  }

  /**
   * The header: one row of parameter labels — under a row of part names,
   * each spanning its part's columns, when the columns come from several
   * parts. The gutter and the name corner span both rows.
   */
  private headRow(): HTMLTableSectionElement {
    const head = document.createElement('thead');
    const grouped = this.columns.grouped;
    const labels = document.createElement('tr');
    const gutter = document.createElement('th');
    gutter.className = `${GUTTER_CELL_CLASS} top-0 z-30`;
    gutter.setAttribute('aria-label', 'Row');
    const corner = document.createElement('th');
    corner.className = `${HEADER_CELL_CLASS} ${NAME_CELL_CLASS} px-2 top-0 z-30 text-left`;
    corner.textContent = 'Configuration';
    if (grouped) {
      gutter.rowSpan = 2;
      corner.rowSpan = 2;
      const parts = document.createElement('tr');
      parts.dataset.partHeader = '';
      parts.append(gutter, corner);
      for (const group of this.columns.groups) {
        const th = document.createElement('th');
        th.className = `${HEADER_CELL_CLASS} ${PART_HEADER_CLASS}`;
        th.colSpan = group.params.length;
        th.dataset.part = group.body ?? '';
        th.textContent = group.body ?? '';
        parts.appendChild(th);
      }
      head.appendChild(parts);
    } else {
      labels.append(gutter, corner);
    }
    for (const param of this.params) {
      const th = document.createElement('th');
      th.className = `${HEADER_CELL_CLASS} sticky ${grouped ? 'top-8' : 'top-0'} z-20 `
        + `${ConfigurationsGrid.isNumeric(param) ? NUMERIC_TEXT_CLASS : 'text-left'} ${this.groupEdge(param)}`;
      th.dataset.column = param.label;
      th.dataset.key = GridColumns.keyOf(param);
      th.textContent = param.label;
      if (param.description) {
        th.title = param.description;
      }
      labels.appendChild(th);
    }
    head.appendChild(labels);
    return head;
  }

  /** The divider before a part's first column, past the first part's — so the groups read apart. */
  private groupEdge(param: UIParamDefinition): string {
    if (!this.columns.grouped) {
      return '';
    }
    const first = this.columns.groups.slice(1).some((group) => group.params[0] === param);
    return first ? GROUP_EDGE_CLASS : '';
  }

  /** The pinned Default row: the literals, read-only. */
  private defaultRow(): HTMLTableRowElement {
    const tr = document.createElement('tr');
    tr.dataset.defaultRow = '';
    const gutter = document.createElement('th');
    gutter.className = `${GUTTER_CELL_CLASS} z-10`;
    gutter.scope = 'row';
    const name = document.createElement('td');
    name.className = `${NAME_CELL_CLASS} z-10 px-2 bg-base-200 text-base-content/60 italic`;
    name.textContent = DEFAULT_CONFIGURATION;
    name.title = 'The parameters\' own values — the pencil in the Parameters panel edits them';
    tr.append(gutter, name);
    for (const param of this.params) {
      const td = document.createElement('td');
      td.className = `${VALUE_CELL_CLASS} px-2 bg-base-200 text-base-content/60 ${ConfigurationsGrid.isNumeric(param) ? NUMERIC_TEXT_CLASS : ''} ${this.groupEdge(param)}`;
      td.dataset.cell = param.label;
      td.dataset.key = GridColumns.keyOf(param);
      td.textContent = displayValue(param, param.defaultValue);
      tr.appendChild(td);
    }
    return tr;
  }

  private gridRow(row: GridRow, index: number): HTMLTableRowElement {
    const tr = document.createElement('tr');
    tr.className = 'group/row';
    tr.dataset.row = row.name;
    tr.dataset.rowIndex = String(index);
    if (row === this.selected) {
      tr.dataset.selected = '';
    }
    tr.addEventListener('focusin', () => this.select(row, tr));
    tr.addEventListener('mousedown', () => this.select(row, tr));

    const gutter = document.createElement('th');
    gutter.className = `${GUTTER_CELL_CLASS} z-10 ${SELECTED_GUTTER_CLASS}`;
    gutter.scope = 'row';
    gutter.textContent = String(index + 1);

    const nameCell = document.createElement('td');
    nameCell.className = `${NAME_CELL_CLASS} z-10 bg-base-100 ${SELECTED_TINT_CLASS} ${ACTIVE_CELL_CLASS}`;
    nameCell.dataset.col = '0';
    const name = document.createElement('input');
    name.type = 'text';
    name.spellcheck = false;
    name.dataset.rowName = '';
    name.className = NAME_INPUT_CLASS;
    name.value = row.name;
    name.setAttribute('aria-label', 'Configuration name');
    if (row.original === this.opts.configurations.active) {
      name.title = 'The configuration on screen';
    }
    name.addEventListener('input', () => {
      row.name = name.value;
      tr.dataset.row = name.value;
      this.syncApply();
    });
    nameCell.appendChild(name);
    tr.append(gutter, nameCell);

    this.params.forEach((param, j) => tr.appendChild(this.valueCell(row, param, j + 1)));
    return tr;
  }

  private select(row: GridRow, tr: HTMLTableRowElement): void {
    if (this.selected === row) {
      return;
    }
    this.selected = row;
    for (const other of Array.from(this.body.querySelectorAll<HTMLElement>('tr[data-selected]'))) {
      delete other.dataset.selected;
    }
    tr.dataset.selected = '';
    this.syncToolbar();
  }

  /**
   * One cell: the parameter's borderless control (the literal, dimmed, while
   * it inherits), or an expression's source text; ↺ once it sets anything.
   */
  private valueCell(row: GridRow, param: UIParamDefinition, column: number): HTMLTableCellElement {
    const key = GridColumns.keyOf(param);
    const td = document.createElement('td');
    td.className = `${VALUE_CELL_CLASS} ${SELECTED_TINT_CLASS} ${ACTIVE_CELL_CLASS} ${this.groupEdge(param)}`;
    td.dataset.cell = param.label;
    td.dataset.key = key;
    td.dataset.col = String(column);
    const wrap = document.createElement('div');
    wrap.className = 'flex items-center h-8';
    td.appendChild(wrap);

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.tabIndex = -1; // Tab walks the cells, as in a spreadsheet
    reset.className = RESET_BUTTON_CLASS;
    reset.textContent = '↺';
    reset.title = 'Clear — inherit the parameter\'s own value';
    reset.dataset.cellReset = '';
    /** Where ↺ goes — kept while the cell inherits, so set and inherited values line up. */
    const resetSlot = document.createElement('span');
    resetSlot.className = 'flex size-6 shrink-0 mr-0.5';

    const draw = () => {
      const cell = row.cells.get(key) ?? { kind: 'inherit' as const };
      td.dataset.state = cell.kind;
      if (cell.kind === 'expr') {
        const expr = document.createElement('div');
        expr.className = 'flex flex-1 min-w-0 items-center gap-1.5 h-full px-2 bg-base-content/[0.03]';
        const fx = document.createElement('span');
        fx.className = 'shrink-0 text-[10px] font-semibold italic text-base-content/40';
        fx.textContent = 'fx';
        const code = document.createElement('code');
        code.className = 'min-w-0 truncate font-mono text-[12px] text-base-content/70';
        code.dataset.cellExpr = '';
        code.textContent = cell.text;
        expr.title = `An expression — edit it in the code: ${cell.text}`;
        expr.append(fx, code);
        wrap.replaceChildren(expr, reset);
        return;
      }
      const host = document.createElement('div');
      host.className = 'flex flex-1 min-w-0 items-center';
      const control = this.control(param, cell.kind === 'literal' ? cell.value : param.defaultValue, (value) => {
        row.cells.set(key, { kind: 'literal', value });
        if (td.dataset.state !== 'literal') {
          td.dataset.state = 'literal';
          host.classList.remove('opacity-45');
          host.removeAttribute('title');
          resetSlot.replaceWith(reset);
        }
        this.syncApply();
      });
      host.appendChild(control.element);
      if (cell.kind === 'inherit') {
        host.classList.add('opacity-45');
        host.title = 'Inherits the parameter\'s own value — edit to set it';
        wrap.replaceChildren(host, resetSlot);
      } else {
        wrap.replaceChildren(host, reset);
      }
    };
    reset.addEventListener('click', (e) => {
      e.preventDefault();
      row.cells.delete(key);
      draw();
      this.syncApply();
    });
    draw();
    return td;
  }

  /** A cell's control: a slider becomes its number field, everything else keeps its type. */
  private control(param: UIParamDefinition, value: CatalogParamValue, onChange: (value: CatalogParamValue) => void): ParamControl {
    const def: CatalogParamDef = { ...param, currentValue: value };
    if (effectiveControlType(def) === 'slider') {
      def.controlType = 'number';
    }
    return createParamControl(def, onChange, { variant: 'cell' });
  }

  /** Number columns align right, as in a spreadsheet. */
  private static isNumeric(param: UIParamDefinition): boolean {
    const type = effectiveControlType(param);
    return type === 'number' || type === 'slider';
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  private syncToolbar(): void {
    const none = !this.loaded || this.selected === null;
    this.duplicateButton.disabled = none;
    this.deleteButton.disabled = none;
  }

  /** The first bad row name, or null. */
  private nameProblem(): string | null {
    for (const row of this.rows) {
      const problem = configurationNameProblem(row.name.trim(), this.takenNames(row));
      if (problem) {
        return problem;
      }
    }
    return null;
  }

  /** Mark bad names, show the footer's message, gate Apply. */
  private syncApply(): void {
    const problem = this.loaded ? this.nameProblem() : null;
    const inputs = this.body.querySelectorAll<HTMLInputElement>('[data-row-name]');
    this.rows.forEach((row, index) => {
      const bad = configurationNameProblem(row.name.trim(), this.takenNames(row)) !== null;
      inputs[index]?.setAttribute('aria-invalid', String(bad));
    });
    this.showMessage(problem);
    this.apply.disabled = this.busy || !this.loaded || problem !== null || !this.isDirty();
  }

  /** The footer: a name problem, else the last refusal, else the last paste's notice — which alone can be dismissed. */
  private showMessage(problem: string | null): void {
    const error = problem ?? this.refusal;
    const message: Notice | null = error !== null ? { tone: 'error', text: error } : this.notice;
    this.messageText.textContent = message?.text ?? '';
    this.message.classList.toggle('hidden', message === null);
    this.message.classList.remove(...MESSAGE_TONE_CLASS.error.split(' '), ...MESSAGE_TONE_CLASS.warning.split(' '));
    if (message) {
      this.message.classList.add(...MESSAGE_TONE_CLASS[message.tone].split(' '));
      this.message.dataset.tone = message.tone;
    }
    this.messageDismiss.classList.toggle('hidden', message === null || message !== this.notice);
  }

  private isDirty(): boolean {
    const commit = this.build();
    return Object.keys(commit.rows).length > 0 || commit.renames !== undefined || commit.removed !== undefined;
  }

  /** The commit: renames, removals, and only the cells that changed — keyed by column (part + label). */
  build(): ConfigurationTableCommit {
    const rows: ConfigurationTableCommit['rows'] = {};
    const renames: Record<string, string> = {};
    for (const row of this.rows) {
      const name = row.name.trim();
      if (row.original === null) {
        const cells: Record<string, CatalogParamValue | CatalogParamExpr> = {};
        for (const [key, cell] of row.cells) {
          if (cell.kind === 'literal') {
            cells[key] = cell.value;
          } else if (cell.kind === 'expr') {
            cells[key] = { expr: cell.text };
          }
        }
        rows[name] = cells;
        continue;
      }
      if (name !== row.original) {
        renames[row.original] = name;
      }
      const changed: Record<string, CatalogParamValue | CatalogParamExpr | null> = {};
      for (const key of new Set([...row.initial.keys(), ...row.cells.keys()])) {
        const before = row.initial.get(key);
        const after = row.cells.get(key);
        if (sameCell(before, after)) {
          continue;
        }
        if (!after) {
          changed[key] = null;
        } else if (after.kind === 'literal') {
          changed[key] = after.value;
        } else if (after.kind === 'expr') {
          changed[key] = { expr: after.text };
        }
      }
      if (Object.keys(changed).length > 0) {
        rows[name] = changed;
      }
    }
    return {
      rows,
      ...(Object.keys(renames).length > 0 ? { renames } : {}),
      ...(this.removed.length > 0 ? { removed: [...this.removed] } : {}),
    };
  }

  /** The commit as Apply sends it: {@link build} plus the home of a row added with no cell. */
  private request(): ConfigurationTableCommit {
    const commit = this.build();
    return this.opts.home ? { ...commit, part: this.opts.home } : commit;
  }

  private async commit(): Promise<void> {
    if (this.busy || this.apply.disabled) {
      return;
    }
    const commit = this.request();
    this.busy = true;
    this.refusal = null;
    this.notice = null;
    this.syncApply();
    let refused: string | null;
    try {
      refused = await this.opts.commit(commit);
    } catch (err) {
      refused = err instanceof Error ? err.message : String(err);
    }
    this.busy = false;
    if (refused !== null) {
      this.refusal = refused;
      this.syncApply();
      return;
    }
    this.close();
  }

  /**
   * The grid's rows from the source tables, a row name once however many
   * tables have it (first table first, as the dropdown lists them): a
   * literal cell is a value, any other an expression. Each cell lands in its
   * own part's column; a cell no column takes stays out of the grid — and
   * out of every commit, so the source keeps it.
   */
  private static rowsFromSource(tables: ConfigurationSourceTable[], columns: GridColumns): GridRow[] {
    const byName = new Map<string, Map<string, Cell>>();
    for (const table of tables) {
      for (const [name, cells] of Object.entries(table.rows)) {
        const initial = byName.get(name) ?? new Map<string, Cell>();
        byName.set(name, initial);
        for (const [label, cell] of Object.entries(cells)) {
          const key = columns.keyFor(table.body, label);
          if (key === undefined) {
            continue;
          }
          initial.set(key, cell.literal !== undefined ? { kind: 'literal', value: cell.literal } : { kind: 'expr', text: cell.text });
        }
      }
    }
    return Array.from(byName, ([name, initial]) => ({ original: name, name, cells: new Map(initial), initial }));
  }

  /**
   * Without the source: the render's rows, every cell taken as the literal
   * it resolved to — per table when the render lists them, else the merged
   * rows (a host that predates per-body tables).
   */
  private static rowsFromRender(configurations: UIConfigurations, columns: GridColumns): GridRow[] {
    const tables = configurations.tables
      ?? [{ body: null, names: configurations.names, rows: configurations.rows }];
    return configurations.names.map((name) => {
      const initial = new Map<string, Cell>();
      for (const table of tables) {
        for (const [label, value] of Object.entries(table.rows[name] ?? {})) {
          const key = columns.keyFor(table.body, label);
          if (key !== undefined) {
            initial.set(key, { kind: 'literal', value });
          }
        }
      }
      return { original: name, name, cells: new Map(initial), initial };
    });
  }
}

/** A literal as the Default row prints it: an option's label, yes/no, a list joined. */
function displayValue(param: UIParamDefinition, value: CatalogParamValue): string {
  const option = (v: string | number) => param.options?.find((o) => String(o.value) === String(v))?.label ?? String(v);
  if (Array.isArray(value)) {
    return value.map(option).join(', ');
  }
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }
  return param.options ? option(value) : String(value);
}

function sameCell(a: Cell | undefined, b: Cell | undefined): boolean {
  if (!a || !b) {
    return !a && !b;
  }
  if (a.kind === 'expr' || b.kind === 'expr') {
    return a.kind === b.kind && (a as { text: string }).text === (b as { text: string }).text;
  }
  if (a.kind === 'inherit' || b.kind === 'inherit') {
    return a.kind === b.kind;
  }
  return sameValue(a.value, b.value);
}

function sameValue(a: CatalogParamValue, b: CatalogParamValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}
