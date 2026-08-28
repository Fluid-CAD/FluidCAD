import type { UIParamDefinition } from '../types';
import type { ParamEditorDialog } from './param-editor-dialog';
import type { EngineClient } from '../engine-client';
import { ICON_PENCIL } from './icons';
import { AccordionSection } from './accordion-section';

/**
 * What every control is drawn on. This section is the one whose rows are
 * controls rather than names, so it is the one that takes a sheet body
 * (`sheet: true` below): a field has to read as something you can type into,
 * and an outline with the scene showing through it does not.
 *
 * The tint is the panel's own ink rather than a value of its own, which
 * darkens the light theme and lightens the dark one — a recess in the sheet
 * either way, without the two themes needing separate colours.
 */
const FIELD_SURFACE = 'bg-base-content/[0.06]';

/**
 * Add and reset sit in the header card rather than above the first row, so
 * the section reads as one row of chrome like the History's menu does. Both
 * stop the click short of the header, which would otherwise collapse the
 * section out from under the dialog the button just opened.
 */
const HEADER_BUTTONS = `
  <span class="ml-auto flex items-center">
    <button class="btn btn-ghost btn-xs btn-circle text-base-content/40 hover:text-base-content/70" title="Add parameter" data-add-param>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5">
        <path d="M10 4.25a.75.75 0 01.75.75v4.25H15a.75.75 0 010 1.5h-4.25V15a.75.75 0 01-1.5 0v-4.25H5a.75.75 0 010-1.5h4.25V5a.75.75 0 01.75-.75z" />
      </svg>
    </button>
    <button class="btn btn-ghost btn-xs btn-circle text-base-content/40 hover:text-base-content/70" title="Reset all to defaults" data-reset-params>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5">
        <path fill-rule="evenodd" d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H4.598a.75.75 0 00-.75.75v3.634a.75.75 0 001.5 0v-2.09l.312.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm-10.624-2.85a5.5 5.5 0 019.201-2.465l.312.31H11.77a.75.75 0 000 1.5h3.634a.75.75 0 00.75-.75V3.535a.75.75 0 00-1.5 0v2.09l-.312-.31A7 7 0 002.63 8.453a.75.75 0 001.449.39z" clip-rule="evenodd" />
      </svg>
    </button>
  </span>
`;

/**
 * The model's parameters, as one section of a docked panel column.
 *
 * `container` is optional: a host that already knows where the section goes
 * passes it and is done, while the part rail builds the panel before the
 * column that will hold it exists and mounts it later ({@link mount}). Its
 * values and its open/closed state then survive a rail rebuild, because the
 * panel outlives the column its elements happen to be parented to.
 */
export class ParamsPanel extends AccordionSection {
  private currentParams: UIParamDefinition[] = [];
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private collapsedGroups = new Set<string>();

  constructor(container: HTMLElement | null, private client: EngineClient, private editor?: ParamEditorDialog) {
    // Hidden until a host shows it — the floating hosts toggle it from a
    // button, and the docked column turns it on for good when it mounts it.
    super('Parameters', {
      visible: false,
      trailing: HEADER_BUTTONS,
      sheet: true,
    });

    const resetButton = this.header.querySelector('[data-reset-params]')!;
    resetButton.addEventListener('click', (e) => {
      e.stopPropagation();
      this.client.resetParams();
    });
    // Declaration edits rewrite source; without an editor-backed host the
    // panel is a pure value surface.
    const addButton = this.header.querySelector('[data-add-param]')!;
    if (this.editor) {
      addButton.addEventListener('click', (e) => {
        e.stopPropagation();
        this.editor!.openForCreate();
      });
    } else {
      addButton.remove();
    }

    // The empty state is part of the section, not something the first render
    // brings: a model with no parameters at all never sends an update.
    this.renderParams();

    if (container) {
      this.mount(container);
    }
  }

  update(params: UIParamDefinition[]): void {
    const prev = this.currentParams;
    this.currentParams = params;
    if (this.canUpdateInPlace(prev, params)) {
      this.updateValuesInPlace(params);
    } else {
      this.renderParams();
    }
  }

  /** Show the section if it is hidden, hide it if it is not. */
  toggle(): void {
    this.setVisible(!this.isVisible);
  }

  private canUpdateInPlace(prev: UIParamDefinition[], next: UIParamDefinition[]): boolean {
    if (prev.length !== next.length || prev.length === 0) {
      return false;
    }
    for (let i = 0; i < prev.length; i++) {
      if (ParamsPanel.controlSignature(prev[i]) !== ParamsPanel.controlSignature(next[i])) {
        return false;
      }
    }
    return true;
  }

  /**
   * Everything about a definition that decides what its control looks like.
   * A value-only change (dragging a slider) leaves this identical and takes
   * the cheap in-place path; a declaration edit that only moved a slider's
   * bounds changes it, so the redrawn control actually honours them.
   */
  private static controlSignature(p: UIParamDefinition): string {
    return JSON.stringify([
      p.label, p.controlType, p.group ?? null, p.description ?? null,
      p.min ?? null, p.max ?? null, p.step ?? null,
      p.options ?? null, p.multi ?? false, p.multiControlType ?? null,
    ]);
  }

  private updateValuesInPlace(params: UIParamDefinition[]): void {
    for (const p of params) {
      const el = this.body.querySelector<HTMLElement>(`[data-param-label="${CSS.escape(p.label)}"]`);
      if (!el) {
        continue;
      }
      const type = el.dataset.paramType;
      if (type === 'slider') {
        (el as HTMLInputElement).value = String(p.currentValue);
        const display = this.body.querySelector(`[data-param-display="${CSS.escape(p.label)}"]`);
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

  private renderParams(): void {
    const params = this.currentParams;

    // The panel is reachable with nothing in it — adding the model's first
    // parameter is one of the things it is for.
    if (params.length === 0) {
      this.body.innerHTML = AccordionSection.emptyState(
        this.editor
          ? 'No parameters yet — use + above, or <code>param(...)</code> in the file.'
          : 'No parameters yet — declare one with <code>param(...)</code>.',
      );
      return;
    }

    const ungrouped: UIParamDefinition[] = [];
    const groups = new Map<string, UIParamDefinition[]>();
    for (const p of params) {
      if (p.group) {
        if (!groups.has(p.group)) {
          groups.set(p.group, []);
        }
        groups.get(p.group)!.push(p);
      } else {
        ungrouped.push(p);
      }
    }

    let html = '';
    for (const p of ungrouped) {
      html += this.renderParamControl(p);
    }
    for (const [groupName, groupParams] of groups) {
      const isCollapsed = this.collapsedGroups.has(groupName);
      const checked = isCollapsed ? '' : ' checked';
      let controlsHtml = '';
      for (const p of groupParams) {
        controlsHtml += this.renderParamControl(p);
      }
      // The card takes its inset from a wrapper rather than its own margin:
      // daisyUI's .collapse is width:100%, so a margin would shift it past
      // the column's right edge instead of narrowing it.
      html += `
        <div class="px-3">
          <div class="collapse collapse-arrow border border-base-content/10 rounded-md mt-1.5" data-param-group="${this.escapeHtml(groupName)}">
            <input type="checkbox"${checked} class="!min-h-0 !p-0 !h-8" />
            <div class="collapse-title !min-h-0 !py-2 !px-3 !pr-8 text-xs font-medium text-base-content/65 uppercase tracking-wider">${this.escapeHtml(groupName)}</div>
            <div class="collapse-content px-0 pb-0">${controlsHtml}</div>
          </div>
        </div>
      `;
    }

    this.body.innerHTML = html;
    this.bindParamHandlers();

    this.body.querySelectorAll<HTMLElement>('[data-param-group]').forEach((el) => {
      const checkbox = el.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      checkbox.addEventListener('change', () => {
        const name = el.dataset.paramGroup!;
        if (checkbox.checked) {
          this.collapsedGroups.delete(name);
        } else {
          this.collapsedGroups.add(name);
        }
      });
    });
  }

  private renderParamControl(p: UIParamDefinition): string {
    const effectiveType = p.controlType === 'auto'
      ? (typeof p.defaultValue === 'boolean' ? 'checkbox' : typeof p.defaultValue === 'number' ? 'number' : 'text')
      : p.controlType;

    // /65 rather than the /40 a dimmed note would take: at 11px this is body
    // text on a surface, and /40 measures 2.3:1 against the light sheet.
    const descHtml = p.description
      ? `<div class="text-[11px] text-base-content/65 mt-0.5">${this.escapeHtml(p.description)}</div>`
      : '';

    const escapedLabel = this.escapeHtml(p.label);
    let controlHtml = '';

    switch (effectiveType) {
      case 'slider': {
        const min = p.min ?? 0;
        const max = p.max ?? 100;
        const step = p.step ?? 1;
        controlHtml = `
          <div class="flex items-center gap-2 mt-1">
            <input type="range" class="range range-xs range-primary flex-1"
              min="${min}" max="${max}" step="${step}"
              value="${p.currentValue}"
              data-param-label="${escapedLabel}" data-param-type="slider" />
            <span class="text-xs text-base-content/80 tabular-nums w-8 text-right" data-param-display="${escapedLabel}">${p.currentValue}</span>
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
            <input type="number" class="input input-xs input-bordered w-full ${FIELD_SURFACE}"
              value="${p.currentValue}" ${attrs.join(' ')}
              data-param-label="${escapedLabel}" data-param-type="number" />
          </div>
        `;
        break;
      }
      case 'text':
        controlHtml = `
          <div class="mt-1">
            <input type="text" class="input input-xs input-bordered w-full ${FIELD_SURFACE}"
              value="${this.escapeHtml(String(p.currentValue))}"
              data-param-label="${escapedLabel}" data-param-type="text" />
          </div>
        `;
        break;
      case 'checkbox': {
        const checked = p.currentValue ? ' checked' : '';
        const toggle = `
          <input type="checkbox" class="toggle toggle-xs toggle-primary"
            ${checked}
            data-param-label="${escapedLabel}" data-param-type="checkbox" />`;
        return `
          <div class="px-3 py-1.5 group">
            ${this.renderLabelRow(p, toggle)}
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
                  <input type="checkbox" class="checkbox checkbox-xs checkbox-primary"
                    value="${this.escapeHtml(String(o.value))}"${checked} />
                  <span class="text-xs text-base-content/80">${this.escapeHtml(o.label)}</span>
                </label>`;
            }).join('');
            controlHtml = `
              <div class="mt-1 flex flex-col gap-1"
                data-param-label="${escapedLabel}" data-param-type="multi-checkboxes">
                ${items}
              </div>
            `;
          } else if (variant === 'chips') {
            const chips = opts.map(o => {
              const active = selected.has(String(o.value));
              const cls = active ? 'badge-primary' : 'badge-outline';
              return `<button class="badge badge-sm ${cls} cursor-pointer" data-chip-value="${this.escapeHtml(String(o.value))}">${this.escapeHtml(o.label)}</button>`;
            }).join('');
            controlHtml = `
              <div class="mt-1 flex flex-wrap gap-1"
                data-param-label="${escapedLabel}" data-param-type="multi-chips">
                ${chips}
              </div>
            `;
          } else {
            const optionHtml = opts.map(o => {
              const sel = selected.has(String(o.value)) ? ' selected' : '';
              return `<option value="${this.escapeHtml(String(o.value))}"${sel}>${this.escapeHtml(o.label)}</option>`;
            }).join('');
            controlHtml = `
              <div class="mt-1">
                <select multiple class="select select-xs select-bordered w-full ${FIELD_SURFACE}"
                  size="${Math.min(opts.length, 5)}"
                  data-param-label="${escapedLabel}" data-param-type="multi-select">
                  ${optionHtml}
                </select>
              </div>
            `;
          }
        } else {
          const optionHtml = opts.map(o => {
            const sel = String(o.value) === String(p.currentValue) ? ' selected' : '';
            return `<option value="${this.escapeHtml(String(o.value))}"${sel}>${this.escapeHtml(o.label)}</option>`;
          }).join('');
          controlHtml = `
            <div class="mt-1">
              <select class="select select-xs select-bordered w-full ${FIELD_SURFACE}"
                data-param-label="${escapedLabel}" data-param-type="select">
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
            <input type="color" class="w-full h-7 cursor-pointer bg-transparent border border-base-content/20 rounded"
              value="${this.escapeHtml(String(p.currentValue))}"
              data-param-label="${escapedLabel}" data-param-type="color" />
          </div>
        `;
        break;
    }

    return `
      <div class="px-3 py-1.5 group">
        ${this.renderLabelRow(p, '')}
        ${descHtml}
        ${controlHtml}
      </div>
    `;
  }

  /**
   * A parameter's name plus the pencil that opens its declaration. The pencil
   * only fades in on hover — the panel is a value surface first, and every row
   * carrying a permanent button would read as a toolbar.
   */
  private renderLabelRow(p: UIParamDefinition, trailing: string): string {
    const escapedLabel = this.escapeHtml(p.label);
    const editButton = !this.editor ? '' : `
        <button class="btn btn-ghost btn-xs btn-square h-4 min-h-0 w-4 opacity-0 group-hover:opacity-100 focus:opacity-100 text-base-content/40 hover:text-base-content/70"
          data-param-edit="${escapedLabel}" title="Edit parameter">
          <span class="[&>svg]:size-3">${ICON_PENCIL}</span>
        </button>`;
    return `
      <div class="flex items-center gap-1">
        <label class="text-xs text-base-content/80 flex-1 truncate">${escapedLabel}</label>
        ${trailing}${editButton}
      </div>
    `;
  }

  private bindParamHandlers(): void {
    this.body.querySelectorAll<HTMLElement>('[data-param-edit]').forEach((el) => {
      el.addEventListener('click', () => {
        const def = this.currentParams.find(p => p.label === el.dataset.paramEdit);
        if (def) {
          this.editor?.openForEdit(def);
        }
      });
    });

    this.body.querySelectorAll<HTMLElement>('[data-param-label]').forEach((el) => {
      const label = el.dataset.paramLabel!;
      const type = el.dataset.paramType!;

      const sendChange = (rawValue: string) => {
        const def = this.currentParams.find(p => p.label === label);
        const value: string | number = def && typeof def.defaultValue === 'number'
          ? Number(rawValue)
          : rawValue;
        this.client.setParam(label, value);
      };

      const sendMultiChange = (rawValues: string[]) => {
        const def = this.currentParams.find(p => p.label === label);
        const numericOptions = def?.options?.[0] && typeof def.options[0].value === 'number';
        const value = numericOptions ? rawValues.map(Number) : rawValues;
        this.client.setParam(label, value);
      };

      if (type === 'slider') {
        el.addEventListener('input', () => {
          const display = this.body.querySelector(`[data-param-display="${CSS.escape(label)}"]`);
          if (display) {
            display.textContent = (el as HTMLInputElement).value;
          }
        });
        el.addEventListener('change', () => {
          sendChange((el as HTMLInputElement).value);
        });
      } else if (type === 'number' || type === 'text') {
        el.addEventListener('input', () => {
          this.debounceParam(label, () => sendChange((el as HTMLInputElement).value));
        });
        el.addEventListener('blur', () => {
          this.flushParam(label, () => sendChange((el as HTMLInputElement).value));
        });
      } else if (type === 'checkbox') {
        el.addEventListener('change', () => {
          this.client.setParam(label, (el as HTMLInputElement).checked);
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

  private debounceParam(label: string, fn: () => void): void {
    const existing = this.debounceTimers.get(label);
    if (existing) {
      clearTimeout(existing);
    }
    this.debounceTimers.set(label, setTimeout(() => {
      this.debounceTimers.delete(label);
      fn();
    }, 500));
  }

  private flushParam(label: string, fn: () => void): void {
    const existing = this.debounceTimers.get(label);
    if (existing) {
      clearTimeout(existing);
      this.debounceTimers.delete(label);
      fn();
    }
  }

  /**
   * Safe for both text and attribute positions. Labels are user-authored and
   * now user-editable from this panel, so a quote in one has to stay inside
   * the `data-param-label="…"` it lands in rather than ending it.
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
