/**
 * The Manage-configurations grid (`docs/assembly-configurations-plan.md`
 * §3.4, "Manage…"): the whole `configurations()` table at once — rows are
 * the configurations, columns the definition's parameters, every cell a
 * compact control of the parameter's own type (`param-controls.ts`).
 *
 * - A pinned first row, Default, shows the `param()` literals read-only.
 * - A blank cell inherits the literal: it shows the literal dimmed, and
 *   becomes a set cell as soon as it is edited. Its ↺ clears it back.
 * - A cell the source writes as an expression (`Width: base * 2`) is read
 *   only, showing its source text; ↺ still clears it.
 * - The name column is editable inline (renames) and sticky while the
 *   parameters scroll sideways; the toolbar adds, duplicates and deletes
 *   rows (delete asks first).
 *
 * Nothing is written until Apply, which sends ONE commit — renames,
 * removals and only the cells that changed — so the table statement is
 * rewritten once (one undo step, one render). A refusal shows in the footer
 * and the dialog stays open. Everything the user typed is assigned through
 * `.value` / `.textContent`, never markup.
 */

import type { CatalogParamDef, CatalogParamExpr, CatalogParamValue, ConfigurationSourceTable, ConfigurationTableCommit } from '../api';
import type { UIConfigurations, UIParamDefinition } from '../types';
import { ICON_CLOSE, ICON_COPY, ICON_PLUS, ICON_TRASH } from './icons';
import { configurationNameProblem } from './configuration-dialogs';
import { createParamControl, effectiveControlType, type ParamControl } from './param-controls';

/** The reserved row: the `param()` literals — shown pinned, never a row of the table. */
const DEFAULT_CONFIGURATION = 'Default';

const OVERLAY_CLASS = 'fixed inset-0 z-[300] bg-black/50 flex items-center justify-center';
const CARD_CLASS = 'w-[min(1100px,94vw)] max-h-[84vh] bg-base-100 border border-base-content/10 rounded-lg p-5 '
  + 'shadow-[0_4px_24px_rgba(0,0,0,0.5)] flex flex-col min-h-0';
const TOOLBAR_BUTTON_CLASS = 'btn btn-ghost btn-xs gap-1 font-normal text-base-content/70 hover:text-base-content/90 [&_svg]:size-3.5';
/** The sticky first column — each use gives it an opaque background, so the parameters scrolling under it stay hidden. */
const NAME_CELL_CLASS = 'sticky left-0 min-w-[11rem] w-[11rem] px-2 py-1 border-r border-base-content/10';
const VALUE_CELL_CLASS = 'min-w-[9rem] px-2 py-1 align-middle';
const RESET_BUTTON_CLASS = 'btn btn-ghost btn-square btn-xs shrink-0 text-base-content/40 hover:text-base-content/80';

export type ConfigurationsGridOptions = {
  /** The columns: the definition's own parameters (no project globals). */
  params: UIParamDefinition[];
  /** The table as the last render carried it — the fallback when the source cannot be read. */
  configurations: UIConfigurations;
  /** The table as the source writes it, which tells literal cells from expressions. */
  loadTable?: () => Promise<ConfigurationSourceTable | null>;
  /** Write the commit. Resolves null when it landed — the dialog closes — or the refusal's text. */
  commit(commit: ConfigurationTableCommit): Promise<string | null>;
  /** Asks before a row is deleted from the grid; resolves true to delete. Without it, deletes at once. */
  confirmDelete?: (name: string) => Promise<boolean>;
  /** The document's length unit, for the header's note. */
  unit?: string;
};

/** What a cell holds: nothing (inherits the literal), a literal, or an expression kept as its source text. */
type Cell =
  | { kind: 'inherit' }
  | { kind: 'literal'; value: CatalogParamValue }
  | { kind: 'expr'; text: string };

type GridRow = {
  /** The row's name in the source table, or null for a row added in the grid. */
  original: string | null;
  name: string;
  /** Label → cell, for the grid's columns; a column the row does not set is absent (inherit). */
  cells: Map<string, Cell>;
  /** The cells as opened — what a commit diffs against. Empty for a new row. */
  initial: Map<string, Cell>;
};

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
  private readonly apply: HTMLButtonElement;
  private readonly duplicateButton: HTMLButtonElement;
  private readonly deleteButton: HTMLButtonElement;
  private readonly params: UIParamDefinition[];
  private rows: GridRow[] = [];
  /** Source rows the grid deleted — the commit's `removed`. */
  private removed: string[] = [];
  /** The row the toolbar's Duplicate / Delete act on. */
  private selected: GridRow | null = null;
  private loaded = false;
  private busy = false;
  /** While the delete confirm is open over the grid — it takes Escape. */
  private confirming = false;
  private settled = false;
  /** The last Apply's refusal, shown in the footer until the next Apply. */
  private refusal: string | null = null;
  private readonly onKey = (e: KeyboardEvent) => {
    if (!this.overlay.isConnected) {
      // Taken out of the document from outside: it keeps no hold on the keyboard.
      document.removeEventListener('keydown', this.onKey, true);
      return;
    }
    if (e.key === 'Escape' && !this.busy && !this.confirming) {
      e.stopPropagation();
      this.close();
    }
  };

  constructor(
    host: HTMLElement,
    private readonly opts: ConfigurationsGridOptions,
    private readonly resolve: () => void,
  ) {
    this.params = opts.params;
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
        <div data-ref="body" class="overflow-auto flex-1 min-h-0 border border-base-content/10 rounded-md">
          <div class="p-4 text-xs text-base-content/50">Loading…</div>
        </div>
        <div class="flex items-center justify-end gap-2 mt-4">
          <div data-ref="message" class="hidden mr-auto bg-error text-error-content rounded-md px-3 py-1.5 text-xs leading-snug"></div>
          <button data-ref="cancel" class="btn btn-ghost btn-sm">Cancel</button>
          <button data-ref="apply" class="btn btn-primary btn-sm" disabled>Apply</button>
        </div>
      </div>
    `;
    const ref = <T extends HTMLElement>(name: string): T => this.overlay.querySelector<T>(`[data-ref="${name}"]`)!;
    this.body = ref('body');
    this.message = ref('message');
    this.apply = ref<HTMLButtonElement>('apply');
    this.duplicateButton = ref<HTMLButtonElement>('duplicate');
    this.deleteButton = ref<HTMLButtonElement>('delete');
    const unitNote = opts.unit ? ` Lengths in ${opts.unit}.` : '';
    ref('subtitle').textContent = 'A blank cell inherits the parameter\'s own value (dimmed); edit it to set it, ↺ to clear it.'
      + unitNote;

    ref('close').addEventListener('click', () => this.close());
    ref('cancel').addEventListener('click', () => this.close());
    ref('add').addEventListener('click', () => this.addRow());
    this.duplicateButton.addEventListener('click', () => this.duplicateRow());
    this.deleteButton.addEventListener('click', () => void this.deleteRow());
    this.apply.addEventListener('click', () => void this.commit());
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay && !this.busy) {
        this.close();
      }
    });
    document.addEventListener('keydown', this.onKey, true);
    host.appendChild(this.overlay);
    this.syncToolbar();
    void this.load();
  }

  private async load(): Promise<void> {
    let source: ConfigurationSourceTable | null = null;
    try {
      source = (await this.opts.loadTable?.()) ?? null;
    } catch {
      source = null;
    }
    if (this.settled) {
      return;
    }
    this.rows = source ? rowsFromSource(source, this.params) : rowsFromRender(this.opts.configurations, this.params);
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
    document.removeEventListener('keydown', this.onKey, true);
    this.overlay.remove();
    this.resolve();
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

  private addRow(): void {
    const row: GridRow = { original: null, name: this.uniqueName('Configuration'), cells: new Map(), initial: new Map() };
    this.rows.push(row);
    this.selected = row;
    this.render();
    this.focusName(row);
  }

  private duplicateRow(): void {
    const from = this.selected;
    if (!from) {
      return;
    }
    const row: GridRow = {
      original: null,
      name: this.uniqueName(`${from.name.trim()} copy`),
      cells: new Map(from.cells),
      initial: new Map(),
    };
    this.rows.splice(this.rows.indexOf(from) + 1, 0, row);
    this.selected = row;
    this.render();
    this.focusName(row);
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

  private focusName(row: GridRow): void {
    const index = this.rows.indexOf(row);
    const input = this.body.querySelectorAll<HTMLInputElement>('[data-row-name]')[index];
    input?.focus();
    input?.select();
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  private render(): void {
    const table = document.createElement('table');
    table.className = 'text-xs border-separate border-spacing-0 w-max min-w-full';
    table.dataset.grid = '';

    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    const corner = document.createElement('th');
    corner.className = `${NAME_CELL_CLASS} top-0 z-20 bg-base-100 text-left font-medium text-base-content/60 border-b`;
    corner.textContent = 'Configuration';
    headRow.appendChild(corner);
    for (const param of this.params) {
      const th = document.createElement('th');
      th.className = `${VALUE_CELL_CLASS} sticky top-0 z-[5] bg-base-100 text-left font-medium text-base-content/70 border-b border-base-content/10 whitespace-nowrap`;
      th.dataset.column = param.label;
      th.textContent = param.label;
      if (param.description) {
        th.title = param.description;
      }
      headRow.appendChild(th);
    }
    head.appendChild(headRow);
    table.appendChild(head);

    const tbody = document.createElement('tbody');
    tbody.appendChild(this.defaultRow());
    for (const row of this.rows) {
      tbody.appendChild(this.gridRow(row));
    }
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

  /** The pinned Default row: the literals, read-only. */
  private defaultRow(): HTMLTableRowElement {
    const tr = document.createElement('tr');
    tr.dataset.defaultRow = '';
    tr.className = 'bg-base-content/[0.03]';
    const name = document.createElement('td');
    name.className = `${NAME_CELL_CLASS} z-10 bg-base-200 text-base-content/60 italic border-b border-base-content/10`;
    name.textContent = DEFAULT_CONFIGURATION;
    name.title = 'The parameters\' own values — the pencil in the Parameters panel edits them';
    tr.appendChild(name);
    for (const param of this.params) {
      const td = document.createElement('td');
      td.className = `${VALUE_CELL_CLASS} text-base-content/60 border-b border-base-content/10`;
      td.dataset.cell = param.label;
      td.textContent = displayValue(param, param.defaultValue);
      tr.appendChild(td);
    }
    return tr;
  }

  private gridRow(row: GridRow): HTMLTableRowElement {
    const tr = document.createElement('tr');
    tr.dataset.row = row.name;
    const selected = row === this.selected;
    tr.className = selected ? 'bg-primary/10' : '';
    if (selected) {
      tr.dataset.selected = '';
    }
    tr.addEventListener('focusin', () => this.select(row, tr));
    tr.addEventListener('mousedown', () => this.select(row, tr));

    const nameCell = document.createElement('td');
    nameCell.className = `${NAME_CELL_CLASS} z-10 ${selected ? 'bg-base-200' : 'bg-base-100'}`;
    const name = document.createElement('input');
    name.type = 'text';
    name.spellcheck = false;
    name.dataset.rowName = '';
    name.className = 'input input-xs input-bordered w-full text-xs font-medium';
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
    tr.appendChild(nameCell);

    for (const param of this.params) {
      tr.appendChild(this.valueCell(row, param));
    }
    return tr;
  }

  private select(row: GridRow, tr: HTMLTableRowElement): void {
    if (this.selected === row) {
      return;
    }
    this.selected = row;
    for (const other of Array.from(this.body.querySelectorAll<HTMLElement>('tr[data-selected]'))) {
      delete other.dataset.selected;
      other.classList.remove('bg-primary/10');
      other.querySelector('td')?.classList.replace('bg-base-200', 'bg-base-100');
    }
    tr.dataset.selected = '';
    tr.classList.add('bg-primary/10');
    tr.querySelector('td')?.classList.replace('bg-base-100', 'bg-base-200');
    this.syncToolbar();
  }

  /**
   * One cell: the parameter's compact control (the literal, dimmed, while
   * it inherits), or an expression's source text; ↺ once it sets anything.
   */
  private valueCell(row: GridRow, param: UIParamDefinition): HTMLTableCellElement {
    const td = document.createElement('td');
    td.className = VALUE_CELL_CLASS;
    td.dataset.cell = param.label;
    const wrap = document.createElement('div');
    wrap.className = 'flex items-center gap-1';
    td.appendChild(wrap);

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = RESET_BUTTON_CLASS;
    reset.textContent = '↺';
    reset.title = 'Clear — inherit the parameter\'s own value';
    reset.dataset.cellReset = '';

    const draw = () => {
      const cell = row.cells.get(param.label) ?? { kind: 'inherit' as const };
      td.dataset.state = cell.kind;
      if (cell.kind === 'expr') {
        const code = document.createElement('code');
        code.className = 'flex-1 min-w-0 truncate font-mono text-[11px] text-base-content/70 px-1.5 py-0.5 rounded bg-base-content/5';
        code.dataset.cellExpr = '';
        code.textContent = cell.text;
        code.title = `An expression — edit it in the code: ${cell.text}`;
        wrap.replaceChildren(code, reset);
        return;
      }
      const host = document.createElement('div');
      host.className = 'flex-1 min-w-0';
      const control = this.control(param, cell.kind === 'literal' ? cell.value : param.defaultValue, (value) => {
        row.cells.set(param.label, { kind: 'literal', value });
        if (td.dataset.state !== 'literal') {
          td.dataset.state = 'literal';
          host.classList.remove('opacity-45');
          wrap.appendChild(reset);
        }
        this.syncApply();
      });
      host.appendChild(control.element);
      if (cell.kind === 'inherit') {
        host.classList.add('opacity-45');
        host.title = 'Inherits the parameter\'s own value — edit to set it';
        wrap.replaceChildren(host);
      } else {
        wrap.replaceChildren(host, reset);
      }
    };
    reset.addEventListener('click', (e) => {
      e.preventDefault();
      row.cells.delete(param.label);
      draw();
      this.syncApply();
    });
    draw();
    return td;
  }

  /** A grid-sized control: a slider becomes its number field, everything else keeps its type. */
  private control(param: UIParamDefinition, value: CatalogParamValue, onChange: (value: CatalogParamValue) => void): ParamControl {
    const def: CatalogParamDef = { ...param, currentValue: value };
    if (effectiveControlType(def) === 'slider') {
      def.controlType = 'number';
    }
    return createParamControl(def, onChange, { compact: true });
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

  /** Mark bad names, show the footer's message (a name problem, else the last refusal), gate Apply. */
  private syncApply(): void {
    const problem = this.loaded ? this.nameProblem() : null;
    const inputs = this.body.querySelectorAll<HTMLInputElement>('[data-row-name]');
    this.rows.forEach((row, index) => {
      const bad = configurationNameProblem(row.name.trim(), this.takenNames(row)) !== null;
      inputs[index]?.classList.toggle('input-error', bad);
    });
    const text = problem ?? this.refusal;
    this.message.textContent = text ?? '';
    this.message.classList.toggle('hidden', text === null);
    this.apply.disabled = this.busy || !this.loaded || problem !== null || !this.isDirty();
  }

  private isDirty(): boolean {
    const commit = this.build();
    return Object.keys(commit.rows).length > 0 || commit.renames !== undefined || commit.removed !== undefined;
  }

  /** The commit: renames, removals, and only the cells that changed. */
  build(): ConfigurationTableCommit {
    const rows: ConfigurationTableCommit['rows'] = {};
    const renames: Record<string, string> = {};
    for (const row of this.rows) {
      const name = row.name.trim();
      if (row.original === null) {
        const cells: Record<string, CatalogParamValue | CatalogParamExpr> = {};
        for (const [label, cell] of row.cells) {
          if (cell.kind === 'literal') {
            cells[label] = cell.value;
          } else if (cell.kind === 'expr') {
            cells[label] = { expr: cell.text };
          }
        }
        rows[name] = cells;
        continue;
      }
      if (name !== row.original) {
        renames[row.original] = name;
      }
      const changed: Record<string, CatalogParamValue | CatalogParamExpr | null> = {};
      for (const label of new Set([...row.initial.keys(), ...row.cells.keys()])) {
        const before = row.initial.get(label);
        const after = row.cells.get(label);
        if (sameCell(before, after)) {
          continue;
        }
        if (!after) {
          changed[label] = null;
        } else if (after.kind === 'literal') {
          changed[label] = after.value;
        } else if (after.kind === 'expr') {
          changed[label] = { expr: after.text };
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

  private async commit(): Promise<void> {
    if (this.busy || this.apply.disabled) {
      return;
    }
    const commit = this.build();
    this.busy = true;
    this.refusal = null;
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
}

/**
 * The grid's rows from the source table: a literal cell is a value, any
 * other an expression. Cells for labels that are no column stay out of the
 * grid — and out of every commit, so the source keeps them.
 */
function rowsFromSource(source: ConfigurationSourceTable, params: UIParamDefinition[]): GridRow[] {
  const labels = new Set(params.map((p) => p.label));
  return Object.entries(source.rows).map(([name, cells]) => {
    const initial = new Map<string, Cell>();
    for (const [label, cell] of Object.entries(cells)) {
      if (!labels.has(label)) {
        continue;
      }
      initial.set(label, cell.literal !== undefined ? { kind: 'literal', value: cell.literal } : { kind: 'expr', text: cell.text });
    }
    return { original: name, name, cells: new Map(initial), initial };
  });
}

/** Without the source: the render's rows, every cell taken as the literal it resolved to. */
function rowsFromRender(configurations: UIConfigurations, params: UIParamDefinition[]): GridRow[] {
  const labels = new Set(params.map((p) => p.label));
  return configurations.names.map((name) => {
    const initial = new Map<string, Cell>();
    for (const [label, value] of Object.entries(configurations.rows[name] ?? {})) {
      if (labels.has(label)) {
        initial.set(label, { kind: 'literal', value });
      }
    }
    return { original: name, name, cells: new Map(initial), initial };
  });
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
