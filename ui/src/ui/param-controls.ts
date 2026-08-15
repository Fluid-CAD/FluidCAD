import type { CatalogParamDef, CatalogParamExpr, CatalogParamValue, NewVariable } from '../api';
import type { VariableInfo } from './expression-core';
import { collectNewVariables, ExpressionField } from './expression-field';

type ControlHandle = {
  element: HTMLElement;
  /** Push a value INTO the control (reset-to-default rewrites the display). */
  setValue: (value: CatalogParamValue) => void;
};

/**
 * Expression mode (the Edit-parameters dialog): `seeds` carries the exact
 * source text of the insert()'s non-literal entries by label — those rows
 * render as expression fields showing the expression instead of its resolved
 * value, whatever their declared control — and every number-typed row
 * becomes an expression field too, with `variables` feeding the same
 * autocomplete dropdown the 3D dialogs' fields have.
 */
export type ParamFormExpressions = {
  seeds: Record<string, string>;
  variables: VariableInfo[];
};

type ExprRow = {
  field: ExpressionField;
  input: HTMLInputElement;
  /** The seeded text — source expression, or the resolved value's text. */
  baseline: string;
};

/**
 * A local-state parameter form: renders one control row per definition
 * (matching the params panel's control vocabulary and daisyUI styling),
 * holds the values in memory, and reports them back on demand. No server
 * round trips — the consumer reads the values when its dialog commits.
 *
 * With `resettable`, every row grows a ↺ button that puts the DECLARED
 * default back and marks the label reset — the edit dialog turns those into
 * `unset` entries, i.e. the insert() argument is removed rather than the
 * default value being baked in as a literal.
 *
 * This is the shared home for param control rows; the params panel still
 * renders its own copies (interwoven with its in-place value updates) and
 * migrating it here is a follow-up.
 */
export class ParamForm {
  readonly element: HTMLDivElement;
  /** Enter pressed in an expression field with no suggestion selected — the dialog applies. */
  onSubmit?: () => void;
  private readonly values = new Map<string, CatalogParamValue>();
  private readonly resets = new Set<string>();
  private readonly resettable: boolean;
  private readonly expressions: ParamFormExpressions | null;
  private readonly exprRows = new Map<string, ExprRow>();

  constructor(
    private readonly defs: CatalogParamDef[],
    opts: { resettable?: boolean; expressions?: ParamFormExpressions } = {},
  ) {
    this.resettable = opts.resettable === true;
    this.expressions = opts.expressions ?? null;
    this.element = document.createElement('div');
    this.element.className = 'flex flex-col gap-1.5';
    for (const def of defs) {
      this.values.set(def.label, def.currentValue);
      this.element.appendChild(this.buildRow(def));
    }
  }

  /** Release the expression fields' floating dropdowns/buttons. */
  destroy(): void {
    for (const row of this.exprRows.values()) {
      row.field.destroy();
    }
    this.exprRows.clear();
  }

  /** Every value, defaults included. */
  allValues(): Record<string, CatalogParamValue> {
    return Object.fromEntries(this.values);
  }

  /**
   * Only the values that differ from the definition's seeded baseline
   * (`currentValue` as passed in) — what a generated/edited `insert(def, {…})`
   * argument should carry.
   */
  nonDefaultValues(): Record<string, CatalogParamValue> {
    const out: Record<string, CatalogParamValue> = {};
    for (const def of this.defs) {
      if (this.exprRows.has(def.label)) {
        continue;
      }
      const value = this.values.get(def.label)!;
      if (!sameValue(value, def.currentValue)) {
        out[def.label] = value;
      }
    }
    return out;
  }

  /**
   * The edit dialog's full commit read: control-row diffs (as
   * `nonDefaultValues`) plus each changed expression field's parse — plain
   * numbers post as numbers, anything else as a verbatim `{ expr }`, with
   * any declarations the fields introduced (`myVar = 120`) collected
   * alongside. An unreadable field aborts the whole apply.
   */
  commitChanges():
    | { set: Record<string, CatalogParamValue | CatalogParamExpr>; newVariables?: NewVariable[] }
    | { error: string } {
    const set: Record<string, CatalogParamValue | CatalogParamExpr> = this.nonDefaultValues();
    const reads: { newVariable?: NewVariable }[] = [];
    for (const [label, row] of this.exprRows) {
      if (this.resets.has(label)) {
        continue; // travels as `unset` — the entry is removed, not rewritten
      }
      const raw = row.input.value.trim();
      if (raw === row.baseline.trim()) {
        continue;
      }
      const read = row.field.read();
      if ('error' in read) {
        return { error: `${label}: ${read.error === 'empty' ? 'enter a value' : read.error}` };
      }
      if (typeof read.value === 'number') {
        // Retyping the same number ("540." → 540) is not a change.
        if (Number(row.baseline) === read.value) {
          continue;
        }
        set[label] = read.value;
      } else {
        set[label] = { expr: read.value };
      }
      reads.push(read);
    }
    const newVariables = collectNewVariables(reads);
    return newVariables ? { set, newVariables } : { set };
  }

  /** Labels whose ↺ was clicked and not overridden since — the dialog's `unset` list. */
  resetLabels(): string[] {
    return Array.from(this.resets);
  }

  /** Every user edit routes here — touching a value un-marks its reset. */
  private set(label: string, value: CatalogParamValue): void {
    this.values.set(label, value);
    this.resets.delete(label);
  }

  private buildRow(def: CatalogParamDef): HTMLElement {
    const row = document.createElement('label');
    row.className = 'flex flex-col gap-1';

    const captionRow = document.createElement('span');
    captionRow.className = 'flex items-center justify-between gap-2';
    const caption = document.createElement('span');
    caption.className = 'text-xs text-base-content/70';
    caption.textContent = def.label;
    captionRow.appendChild(caption);

    const control = this.buildControl(def);

    if (this.resettable) {
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'btn btn-ghost btn-square btn-xs text-base-content/40 hover:text-base-content/80';
      reset.textContent = '↺';
      reset.title = 'Reset to default';
      reset.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.values.set(def.label, def.defaultValue);
        this.resets.add(def.label);
        control.setValue(def.defaultValue);
      });
      captionRow.appendChild(reset);
    }

    row.appendChild(captionRow);
    row.appendChild(control.element);

    if (def.description) {
      const desc = document.createElement('span');
      desc.className = 'text-[11px] text-base-content/40';
      desc.textContent = def.description;
      row.appendChild(desc);
    }
    return row;
  }

  private buildControl(def: CatalogParamDef): ControlHandle {
    const type = effectiveControlType(def);
    if (this.expressions) {
      const seed = this.expressions.seeds[def.label];
      if (seed !== undefined) {
        // A source expression wins the slot, whatever the declared control.
        return this.buildExpressionControl(def, seed);
      }
      if (type === 'number') {
        return this.buildExpressionControl(def, String(def.currentValue));
      }
    }
    switch (type) {
      case 'slider': {
        const wrap = document.createElement('div');
        wrap.className = 'flex items-center gap-2';
        const input = document.createElement('input');
        input.type = 'range';
        input.className = 'range range-xs range-primary flex-1';
        input.min = String(def.min ?? 0);
        input.max = String(def.max ?? 100);
        input.step = String(def.step ?? 1);
        input.value = String(def.currentValue);
        const display = document.createElement('span');
        display.className = 'text-xs text-base-content/50 tabular-nums w-10 text-right';
        display.textContent = String(def.currentValue);
        input.addEventListener('input', () => {
          display.textContent = input.value;
          this.set(def.label, Number(input.value));
        });
        wrap.appendChild(input);
        wrap.appendChild(display);
        return {
          element: wrap,
          setValue: (v) => {
            input.value = String(v);
            display.textContent = String(v);
          },
        };
      }
      case 'number': {
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'input input-sm input-bordered w-full text-xs bg-transparent';
        input.step = def.step != null ? String(def.step) : 'any';
        if (def.min != null) { input.min = String(def.min); }
        if (def.max != null) { input.max = String(def.max); }
        input.value = String(def.currentValue);
        input.addEventListener('input', () => {
          const num = Number(input.value);
          if (Number.isFinite(num)) {
            this.set(def.label, num);
          }
        });
        return { element: input, setValue: (v) => { input.value = String(v); } };
      }
      case 'checkbox': {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.className = 'toggle toggle-sm toggle-primary';
        input.checked = def.currentValue === true;
        input.addEventListener('change', () => this.set(def.label, input.checked));
        return { element: input, setValue: (v) => { input.checked = v === true; } };
      }
      case 'select': {
        if (def.multi) {
          return this.buildMultiSelect(def);
        }
        const select = document.createElement('select');
        select.className = 'select select-sm select-bordered w-full text-xs';
        for (const opt of def.options ?? []) {
          const el = document.createElement('option');
          el.value = String(opt.value);
          el.textContent = opt.label;
          el.selected = String(opt.value) === String(def.currentValue);
          select.appendChild(el);
        }
        select.addEventListener('change', () => {
          this.set(def.label, optionValue(def, select.value));
        });
        return { element: select, setValue: (v) => { select.value = String(v); } };
      }
      case 'color': {
        const input = document.createElement('input');
        input.type = 'color';
        input.className = 'w-full h-8 cursor-pointer bg-transparent border border-base-content/20 rounded';
        input.value = String(def.currentValue);
        input.addEventListener('input', () => this.set(def.label, input.value));
        return { element: input, setValue: (v) => { input.value = String(v); } };
      }
      default: {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'input input-sm input-bordered w-full text-xs bg-transparent';
        input.value = String(def.currentValue);
        input.addEventListener('input', () => this.set(def.label, input.value));
        return { element: input, setValue: (v) => { input.value = String(v); } };
      }
    }
  }

  /**
   * A text input with the 3D dialogs' expression-field behavior — variable
   * autocomplete, `myVar = 120` declarations — seeded with the entry's exact
   * source text (or the resolved value's text when the source holds none).
   * Reads happen at commit via `commitChanges`, not per keystroke.
   */
  private buildExpressionControl(def: CatalogParamDef, seedText: string): ControlHandle {
    const input = document.createElement('input');
    input.className = 'input input-sm input-bordered w-full text-xs bg-transparent';
    input.value = seedText;
    const field = new ExpressionField(input);
    field.setVariables(this.expressions!.variables);
    field.onSubmit = () => this.onSubmit?.();
    // Typing un-marks a pending reset, like set() does for plain rows.
    input.addEventListener('input', () => {
      this.resets.delete(def.label);
    });
    this.exprRows.set(def.label, { field, input, baseline: seedText });
    return {
      element: input,
      setValue: (v) => {
        field.setValue(typeof v === 'string' || typeof v === 'number' ? v : String(v));
      },
    };
  }

  private buildMultiSelect(def: CatalogParamDef): ControlHandle {
    const select = document.createElement('select');
    select.multiple = true;
    const opts = def.options ?? [];
    select.size = Math.min(opts.length, 5);
    select.className = 'select select-sm select-bordered w-full text-xs';
    const applySelection = (value: CatalogParamValue) => {
      const selected = new Set((Array.isArray(value) ? value : [value]).map(String));
      for (const el of Array.from(select.options)) {
        el.selected = selected.has(el.value);
      }
    };
    for (const opt of opts) {
      const el = document.createElement('option');
      el.value = String(opt.value);
      el.textContent = opt.label;
      select.appendChild(el);
    }
    applySelection(def.currentValue);
    select.addEventListener('change', () => {
      const chosen = Array.from(select.selectedOptions).map(o => optionValue(def, o.value));
      this.set(def.label, chosen as (string | number)[]);
    });
    return { element: select, setValue: applySelection };
  }
}

function effectiveControlType(def: CatalogParamDef): string {
  if (def.controlType !== 'auto') {
    return def.controlType;
  }
  if (typeof def.defaultValue === 'boolean') {
    return 'checkbox';
  }
  return typeof def.defaultValue === 'number' ? 'number' : 'text';
}

/** Select option values keep their declared type — numeric options post numbers. */
function optionValue(def: CatalogParamDef, raw: string): string | number {
  const match = (def.options ?? []).find(o => String(o.value) === raw);
  return match ? match.value : raw;
}

function sameValue(a: CatalogParamValue, b: CatalogParamValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((v, i) => v === b[i]);
  }
  return a === b;
}
