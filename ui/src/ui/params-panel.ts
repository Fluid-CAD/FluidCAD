import type { UIParamDefinition } from '../types';

export class ParamsPanel {
  private root: HTMLDivElement;
  private body: HTMLDivElement;
  private hasParams = false;
  private visible = false;
  private currentParams: UIParamDefinition[] = [];
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private collapsedGroups = new Set<string>();

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'w-[220px] mt-2 select-none hidden';
    container.appendChild(this.root);

    const panel = document.createElement('div');
    panel.className = 'panel-bg border border-base-content/10 rounded-md overflow-y-auto max-h-[60vh]';
    this.root.appendChild(panel);

    const header = document.createElement('div');
    header.className = 'flex items-center justify-between px-3 pt-2 pb-1';
    header.innerHTML = `
      <span class="text-xs font-medium text-base-content/50 uppercase tracking-wider">Parameters</span>
      <button class="btn btn-ghost btn-xs btn-circle text-base-content/40 hover:text-base-content/70" title="Reset all to defaults" data-reset-params>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5">
          <path fill-rule="evenodd" d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H4.598a.75.75 0 00-.75.75v3.634a.75.75 0 001.5 0v-2.09l.312.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm-10.624-2.85a5.5 5.5 0 019.201-2.465l.312.31H11.77a.75.75 0 000 1.5h3.634a.75.75 0 00.75-.75V3.535a.75.75 0 00-1.5 0v2.09l-.312-.31A7 7 0 002.63 8.453a.75.75 0 001.449.39z" clip-rule="evenodd" />
        </svg>
      </button>
    `;
    panel.appendChild(header);

    header.querySelector('[data-reset-params]')!.addEventListener('click', () => {
      fetch('/api/reset-params', { method: 'POST' })
        .catch(err => console.error('Reset params failed:', err));
    });

    this.body = document.createElement('div');
    this.body.className = 'px-3 pb-2';
    panel.appendChild(this.body);
  }

  update(params: UIParamDefinition[]): void {
    this.currentParams = params;
    this.hasParams = params.length > 0;
    this.renderParams();
  }

  toggle(): void {
    this.visible = !this.visible;
    this.applyVisibility();
  }

  get isVisible(): boolean {
    return this.visible;
  }

  get hasAnyParams(): boolean {
    return this.hasParams;
  }

  private applyVisibility(): void {
    this.root.classList.toggle('hidden', !this.visible || !this.hasParams);
  }

  private renderParams(): void {
    const params = this.currentParams;

    this.applyVisibility();

    if (params.length === 0) {
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
      html += this.renderParamControl(p, false);
    }
    for (const [groupName, groupParams] of groups) {
      const isCollapsed = this.collapsedGroups.has(groupName);
      const checked = isCollapsed ? '' : ' checked';
      let controlsHtml = '';
      for (const p of groupParams) {
        controlsHtml += this.renderParamControl(p, true);
      }
      html += `
        <div class="collapse collapse-arrow border border-base-content/10 rounded-md mt-1.5" data-param-group="${this.escapeHtml(groupName)}">
          <input type="checkbox"${checked} class="!min-h-0 !p-0 !h-8" />
          <div class="collapse-title !min-h-0 !py-2 !px-3 !pr-8 text-xs font-medium text-base-content/50 uppercase tracking-wider">${this.escapeHtml(groupName)}</div>
          <div class="collapse-content px-0 pb-0">${controlsHtml}</div>
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

  private renderParamControl(p: UIParamDefinition, grouped: boolean): string {
    const effectiveType = p.controlType === 'auto'
      ? (typeof p.defaultValue === 'boolean' ? 'checkbox' : typeof p.defaultValue === 'number' ? 'number' : 'text')
      : p.controlType;

    const descHtml = p.description
      ? `<div class="text-[11px] text-base-content/40 mt-0.5">${this.escapeHtml(p.description)}</div>`
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
            <span class="text-xs text-base-content/50 tabular-nums w-8 text-right" data-param-display="${escapedLabel}">${p.currentValue}</span>
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
            <input type="number" class="input input-xs input-bordered w-full bg-transparent"
              value="${p.currentValue}" ${attrs.join(' ')}
              data-param-label="${escapedLabel}" data-param-type="number" />
          </div>
        `;
        break;
      }
      case 'text':
        controlHtml = `
          <div class="mt-1">
            <input type="text" class="input input-xs input-bordered w-full bg-transparent"
              value="${this.escapeHtml(String(p.currentValue))}"
              data-param-label="${escapedLabel}" data-param-type="text" />
          </div>
        `;
        break;
      case 'checkbox': {
        const checked = p.currentValue ? ' checked' : '';
        const px = grouped ? 'px-3' : '';
        return `
          <div class="${px} py-1.5">
            <div class="flex items-center gap-2">
              <label class="text-xs text-base-content/60">${escapedLabel}</label>
              <input type="checkbox" class="toggle toggle-xs toggle-primary"
                ${checked}
                data-param-label="${escapedLabel}" data-param-type="checkbox" />
            </div>
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
                  <span class="text-xs text-base-content/60">${this.escapeHtml(o.label)}</span>
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
                <select multiple class="select select-xs select-bordered w-full bg-base-300"
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
              <select class="select select-xs select-bordered w-full bg-base-300"
                data-param-label="${escapedLabel}" data-param-type="select">
                ${optionHtml}
              </select>
            </div>
          `;
        }
        break;
      }
    }

    const px = grouped ? 'px-3' : '';
    return `
      <div class="${px} py-1.5">
        <label class="text-xs text-base-content/60">${escapedLabel}</label>
        ${descHtml}
        ${controlHtml}
      </div>
    `;
  }

  private bindParamHandlers(): void {
    this.body.querySelectorAll<HTMLElement>('[data-param-label]').forEach((el) => {
      const label = el.dataset.paramLabel!;
      const type = el.dataset.paramType!;

      const sendChange = (rawValue: string) => {
        const def = this.currentParams.find(p => p.label === label);
        const value: string | number = def && typeof def.defaultValue === 'number'
          ? Number(rawValue)
          : rawValue;
        fetch('/api/set-param', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label, value }),
        }).catch(err => console.error('Set param failed:', err));
      };

      const sendMultiChange = (rawValues: string[]) => {
        const def = this.currentParams.find(p => p.label === label);
        const numericOptions = def?.options?.[0] && typeof def.options[0].value === 'number';
        const value = numericOptions ? rawValues.map(Number) : rawValues;
        fetch('/api/set-param', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label, value }),
        }).catch(err => console.error('Set param failed:', err));
      };

      if (type === 'slider') {
        el.addEventListener('input', () => {
          const display = this.body.querySelector(`[data-param-display="${label}"]`);
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
          const checked = (el as HTMLInputElement).checked;
          fetch('/api/set-param', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label, value: checked }),
          }).catch(err => console.error('Set param failed:', err));
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

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
