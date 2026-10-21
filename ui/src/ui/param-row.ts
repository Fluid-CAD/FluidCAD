import { ICON_PENCIL } from './icons';

/**
 * One parameter row's markup and wiring, shared by the model's Parameters
 * section (ParamsPanel) and the project-wide Parameters column
 * (GlobalParamsPanel). Both draw the same controls off the same definition
 * shape; what differs — where a value goes, what sits beside the label — is
 * handed in through options, so a control looks and behaves the same in
 * either column.
 */

/**
 * What every control is drawn on. A field has to read as something you can
 * type into, and an outline with the scene showing through it does not.
 *
 * The tint is the panel's own ink rather than a value of its own, which
 * darkens the light theme and lightens the dark one — a recess in the sheet
 * either way, without the two themes needing separate colours.
 */
export const FIELD_SURFACE = 'bg-base-content/[0.06]';

/** The slice of a parameter definition a control is drawn from. */
export type ParamRowDefinition = {
  label: string;
  /**
   * The `part()` / `assembly()` body that declared it, by name — with the
   * label, the row's identity ({@link paramRowKey}). Absent for a project
   * parameter, which its label alone names.
   */
  body?: string;
  defaultValue: string | number | boolean | (string | number)[];
  currentValue: string | number | boolean | (string | number)[];
  controlType: 'auto' | 'text' | 'number' | 'slider' | 'select' | 'checkbox' | 'color';
  description?: string;
  group?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: { label: string; value: string | number }[];
  multi?: boolean;
  multiControlType?: 'select' | 'checkboxes' | 'chips';
};

export type ParamRowRenderOptions = {
  /** Whether the row carries the pencil that opens its declaration. */
  editable: boolean;
  /** Markup placed between the label and the control's trailing slot — a chip, a warning. */
  labelTrailing?: string;
  /** Draw the label bold — a value the active configuration row sets. */
  labelBold?: boolean;
  /**
   * The declaring part's name, drawn dimmed after the label — set when the
   * same label shows twice in one list, so the two rows read apart.
   */
  owner?: string;
};

/**
 * A row's identity under its root: the body + label pair a parameter is
 * (the encoding `ParamKey.id` uses in the engine), or the bare label for a
 * parameter no body declared. Every control, display and pencil of the row
 * carries it as `data-param-key`, and the handlers hand it back, so two
 * parts' `Width` rows never answer for each other.
 */
export function paramRowKey(p: Pick<ParamRowDefinition, 'label' | 'body'>): string {
  return p.body === undefined ? p.label : JSON.stringify([p.body, p.label]);
}

/**
 * Safe for both text and attribute positions. Labels are user-authored and
 * user-editable from the panels, so a quote in one has to stay inside the
 * `data-param-label="…"` it lands in rather than ending it.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Everything about a definition that decides what its control looks like.
 * A value-only change (dragging a slider) leaves this identical and takes
 * the cheap in-place path; a declaration edit that only moved a slider's
 * bounds changes it, so the redrawn control actually honours them.
 */
export function controlSignature(p: ParamRowDefinition): string {
  return JSON.stringify([
    paramRowKey(p), p.controlType, p.group ?? null, p.description ?? null,
    p.min ?? null, p.max ?? null, p.step ?? null,
    p.options ?? null, p.multi ?? false, p.multiControlType ?? null,
  ]);
}

/** The control a definition draws once `'auto'` is read off its default. */
export function effectiveControlType(p: ParamRowDefinition): Exclude<ParamRowDefinition['controlType'], 'auto'> {
  return p.controlType === 'auto'
    ? (typeof p.defaultValue === 'boolean' ? 'checkbox' : typeof p.defaultValue === 'number' ? 'number' : 'text')
    : p.controlType;
}

/**
 * Write new values into controls already on screen, under `root`. A field
 * being typed into keeps what the user has: the render that answers their
 * last keystroke must not overwrite the next one.
 */
export function updateParamValuesInPlace(root: ParentNode, params: ParamRowDefinition[]): void {
  for (const p of params) {
    const key = paramRowKey(p);
    const el = root.querySelector<HTMLElement>(`[data-param-key="${CSS.escape(key)}"]`);
    if (!el) {
      continue;
    }
    const type = el.dataset.paramType;
    if (type === 'slider') {
      (el as HTMLInputElement).value = String(p.currentValue);
      const display = root.querySelector(`[data-param-display="${CSS.escape(key)}"]`);
      if (display) {
        display.textContent = String(p.currentValue);
      }
    } else if (type === 'number' || type === 'text' || type === 'color') {
      if (document.activeElement !== el) {
        (el as HTMLInputElement).value = String(p.currentValue);
      }
    } else if (type === 'checkbox') {
      (el as HTMLInputElement).checked = !!p.currentValue;
    } else if (type === 'select') {
      (el as HTMLSelectElement).value = String(p.currentValue);
    }
  }
}

/**
 * A parameter's name plus the pencil that opens its declaration. The pencil
 * only fades in on hover — the panel is a value surface first, and every row
 * carrying a permanent button would read as a toolbar.
 */
function renderLabelRow(p: ParamRowDefinition, trailing: string, options: ParamRowRenderOptions): string {
  const escapedLabel = escapeHtml(p.label);
  const editButton = !options.editable ? '' : `
        <button class="btn btn-ghost btn-xs btn-square h-4 min-h-0 w-4 opacity-0 group-hover:opacity-100 focus:opacity-100 text-base-content/40 hover:text-base-content/70"
          data-param-edit="${escapeHtml(paramRowKey(p))}" title="Edit parameter">
          <span class="[&>svg]:size-3">${ICON_PENCIL}</span>
        </button>`;
  const labelClass = options.labelBold ? 'text-sm font-semibold text-base-content/90' : 'text-sm text-base-content/80';
  // The owner sits inside the label so the two share its truncation: the
  // name the row is told apart by is the first thing to go, never the label.
  const owner = options.owner === undefined
    ? ''
    : ` <span class="text-xs font-normal text-base-content/50" data-param-owner>${escapeHtml(options.owner)}</span>`;
  return `
      <div class="flex items-center gap-1">
        <label class="${labelClass} flex-1 truncate">${escapedLabel}${owner}</label>
        ${options.labelTrailing ?? ''}${trailing}${editButton}
      </div>
    `;
}

/** One row: the label line, the description, then the control. */
export function renderParamControl(p: ParamRowDefinition, options: ParamRowRenderOptions): string {
  const effectiveType = effectiveControlType(p);

  // /65 rather than the /40 a dimmed note would take: at 12px this is body
  // text on a surface, and /40 measures 2.3:1 against the light sheet.
  const descHtml = p.description
    ? `<div class="text-xs text-base-content/65 mt-0.5">${escapeHtml(p.description)}</div>`
    : '';

  const escapedLabel = escapeHtml(p.label);
  // Every control carries the row's identity beside its label: handlers and
  // in-place updates find the row by `data-param-key`.
  const identity = `data-param-label="${escapedLabel}" data-param-key="${escapeHtml(paramRowKey(p))}"`;
  let controlHtml = '';

  switch (effectiveType) {
    case 'slider': {
      const min = p.min ?? 0;
      const max = p.max ?? 100;
      const step = p.step ?? 1;
      controlHtml = `
          <div class="flex items-center gap-2 mt-1">
            <input type="range" class="range range-sm range-primary flex-1"
              min="${min}" max="${max}" step="${step}"
              value="${p.currentValue}"
              ${identity} data-param-type="slider" />
            <span class="text-sm text-base-content/80 tabular-nums w-10 text-right" data-param-display="${escapeHtml(paramRowKey(p))}">${p.currentValue}</span>
          </div>
        `;
      break;
    }
    case 'number': {
      const attrs: string[] = [];
      if (p.min != null) { attrs.push(`min="${p.min}"`); }
      if (p.max != null) { attrs.push(`max="${p.max}"`); }
      if (p.step != null) { attrs.push(`step="${p.step}"`); }
      controlHtml = `
          <div class="mt-1">
            <input type="number" class="input input-sm input-bordered w-full ${FIELD_SURFACE}"
              value="${p.currentValue}" ${attrs.join(' ')}
              ${identity} data-param-type="number" />
          </div>
        `;
      break;
    }
    case 'text':
      controlHtml = `
          <div class="mt-1">
            <input type="text" class="input input-sm input-bordered w-full ${FIELD_SURFACE}"
              value="${escapeHtml(String(p.currentValue))}"
              ${identity} data-param-type="text" />
          </div>
        `;
      break;
    case 'checkbox': {
      const checked = p.currentValue ? ' checked' : '';
      const toggle = `
          <input type="checkbox" class="toggle toggle-sm toggle-primary"
            ${checked}
            ${identity} data-param-type="checkbox" />`;
      return `
          <div class="px-3 py-1.5 group">
            ${renderLabelRow(p, toggle, options)}
            ${descHtml}
          </div>
        `;
    }
    case 'select': {
      const opts = p.options ?? [];
      if (p.multi) {
        const selected = new Set(
          (Array.isArray(p.currentValue) ? p.currentValue : [p.currentValue]).map(String)
        );
        const variant = p.multiControlType ?? 'select';
        if (variant === 'checkboxes') {
          const items = opts.map(o => {
            const checked = selected.has(String(o.value)) ? ' checked' : '';
            return `
                <label class="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" class="checkbox checkbox-sm checkbox-primary"
                    value="${escapeHtml(String(o.value))}"${checked} />
                  <span class="text-sm text-base-content/80">${escapeHtml(o.label)}</span>
                </label>`;
          }).join('');
          controlHtml = `
              <div class="mt-1 flex flex-col gap-1"
                ${identity} data-param-type="multi-checkboxes">
                ${items}
              </div>
            `;
        } else if (variant === 'chips') {
          const chips = opts.map(o => {
            const active = selected.has(String(o.value));
            const cls = active ? 'badge-primary' : 'badge-outline';
            return `<button class="badge badge-sm ${cls} cursor-pointer" data-chip-value="${escapeHtml(String(o.value))}">${escapeHtml(o.label)}</button>`;
          }).join('');
          controlHtml = `
              <div class="mt-1 flex flex-wrap gap-1"
                ${identity} data-param-type="multi-chips">
                ${chips}
              </div>
            `;
        } else {
          const optionHtml = opts.map(o => {
            const sel = selected.has(String(o.value)) ? ' selected' : '';
            return `<option value="${escapeHtml(String(o.value))}"${sel}>${escapeHtml(o.label)}</option>`;
          }).join('');
          controlHtml = `
              <div class="mt-1">
                <select multiple class="select select-sm select-bordered w-full ${FIELD_SURFACE}"
                  size="${Math.min(opts.length, 5)}"
                  ${identity} data-param-type="multi-select">
                  ${optionHtml}
                </select>
              </div>
            `;
        }
      } else {
        const optionHtml = opts.map(o => {
          const sel = String(o.value) === String(p.currentValue) ? ' selected' : '';
          return `<option value="${escapeHtml(String(o.value))}"${sel}>${escapeHtml(o.label)}</option>`;
        }).join('');
        controlHtml = `
            <div class="mt-1">
              <select class="select select-sm select-bordered w-full ${FIELD_SURFACE}"
                ${identity} data-param-type="select">
                ${optionHtml}
              </select>
            </div>
          `;
      }
      break;
    }
    case 'color':
      controlHtml = `
          <div class="mt-1">
            <input type="color" class="w-full h-8 cursor-pointer bg-transparent border border-base-content/20 rounded"
              value="${escapeHtml(String(p.currentValue))}"
              ${identity} data-param-type="color" />
          </div>
        `;
      break;
  }

  return `
      <div class="px-3 py-1.5 group">
        ${renderLabelRow(p, '', options)}
        ${descHtml}
        ${controlHtml}
      </div>
    `;
}

/**
 * Per-field typing timers: a number or text field sends its value 500 ms
 * after the last keystroke, or on blur, whichever comes first.
 */
export class ParamDebouncer {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  debounce(key: string, fn: () => void): void {
    const existing = this.timers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      fn();
    }, 500));
  }

  /** Run the pending send now, if there is one — a blur must not wait out the timer. */
  flush(key: string, fn: () => void): void {
    const existing = this.timers.get(key);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(key);
      fn();
    }
  }
}

/**
 * Where a row's events go. Each callback is handed the row's
 * {@link paramRowKey} — the label itself for a row no body declared.
 */
export type ParamRowHandlers = {
  /** The definition a row key names — what decides whether a typed value is a number. */
  lookup: (key: string) => ParamRowDefinition | undefined;
  /** A control's new value, typed the way the definition's default is. */
  setValue: (key: string, value: unknown) => void;
  /** The pencil — absent when rows were drawn without one. */
  onEdit?: (key: string) => void;
  debouncer: ParamDebouncer;
  /** The debouncer's key for a row key; the row key itself when rows are unique under `root`. */
  debounceKey?: (key: string) => string;
};

/** Wire every control under `root` that {@link renderParamControl} drew. */
export function bindParamHandlers(root: ParentNode, handlers: ParamRowHandlers): void {
  root.querySelectorAll<HTMLElement>('[data-param-edit]').forEach((el) => {
    el.addEventListener('click', () => {
      handlers.onEdit?.(el.dataset.paramEdit!);
    });
  });

  root.querySelectorAll<HTMLElement>('[data-param-key]').forEach((el) => {
    const rowKey = el.dataset.paramKey!;
    const type = el.dataset.paramType!;
    const key = handlers.debounceKey ? handlers.debounceKey(rowKey) : rowKey;

    const sendChange = (rawValue: string) => {
      const def = handlers.lookup(rowKey);
      const value: string | number = def && typeof def.defaultValue === 'number'
        ? Number(rawValue)
        : rawValue;
      handlers.setValue(rowKey, value);
    };

    const sendMultiChange = (rawValues: string[]) => {
      const def = handlers.lookup(rowKey);
      const numericOptions = def?.options?.[0] && typeof def.options[0].value === 'number';
      const value = numericOptions ? rawValues.map(Number) : rawValues;
      handlers.setValue(rowKey, value);
    };

    if (type === 'slider') {
      el.addEventListener('input', () => {
        const display = root.querySelector(`[data-param-display="${CSS.escape(rowKey)}"]`);
        if (display) {
          display.textContent = (el as HTMLInputElement).value;
        }
      });
      el.addEventListener('change', () => {
        sendChange((el as HTMLInputElement).value);
      });
    } else if (type === 'number' || type === 'text') {
      el.addEventListener('input', () => {
        handlers.debouncer.debounce(key, () => sendChange((el as HTMLInputElement).value));
      });
      el.addEventListener('blur', () => {
        handlers.debouncer.flush(key, () => sendChange((el as HTMLInputElement).value));
      });
    } else if (type === 'checkbox') {
      el.addEventListener('change', () => {
        handlers.setValue(rowKey, (el as HTMLInputElement).checked);
      });
    } else if (type === 'select') {
      el.addEventListener('change', () => {
        sendChange((el as HTMLSelectElement).value);
      });
    } else if (type === 'multi-select') {
      el.addEventListener('change', () => {
        const selected = Array.from((el as HTMLSelectElement).selectedOptions, o => o.value);
        sendMultiChange(selected);
      });
    } else if (type === 'multi-checkboxes') {
      el.addEventListener('change', () => {
        const checked = Array.from(
          el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked'),
          cb => cb.value
        );
        sendMultiChange(checked);
      });
    } else if (type === 'color') {
      el.addEventListener('input', () => {
        sendChange((el as HTMLInputElement).value);
      });
    } else if (type === 'multi-chips') {
      el.addEventListener('click', (e) => {
        const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-chip-value]');
        if (!chip) { return; }
        chip.classList.toggle('badge-primary');
        chip.classList.toggle('badge-outline');
        const active = Array.from(
          el.querySelectorAll<HTMLElement>('.badge-primary[data-chip-value]'),
          c => c.dataset.chipValue!
        );
        sendMultiChange(active);
      });
    }
  });
}

/**
 * Rows folded under a `group` caption: a daisyUI collapse card. The card
 * takes its inset from a wrapper rather than its own margin — `.collapse`
 * is width:100%, so a margin would shift it past the column's right edge
 * instead of narrowing it.
 */
export function renderParamGroup(groupName: string, controlsHtml: string, collapsed: boolean): string {
  const checked = collapsed ? '' : ' checked';
  return `
        <div class="px-3">
          <div class="collapse collapse-arrow border border-base-content/10 rounded-md mt-1.5" data-param-group="${escapeHtml(groupName)}">
            <input type="checkbox"${checked} class="!min-h-0 !p-0 !h-8" />
            <div class="collapse-title !min-h-0 !py-2 !px-3 !pr-8 text-xs font-medium text-base-content/65 uppercase tracking-wider">${escapeHtml(groupName)}</div>
            <div class="collapse-content px-0 pb-0">${controlsHtml}</div>
          </div>
        </div>
      `;
}

/** Remember which group cards under `root` the user folded, in `collapsed`, keyed by `keyOf(group)`. */
export function bindParamGroups(root: ParentNode, collapsed: Set<string>, keyOf: (group: string) => string = (g) => g): void {
  root.querySelectorAll<HTMLElement>('[data-param-group]').forEach((el) => {
    const checkbox = el.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    checkbox.addEventListener('change', () => {
      const key = keyOf(el.dataset.paramGroup!);
      if (checkbox.checked) {
        collapsed.delete(key);
      } else {
        collapsed.add(key);
      }
    });
  });
}
