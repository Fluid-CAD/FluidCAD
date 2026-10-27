import type { EngineClient } from '../engine-client';
import type { SceneObjectRender } from '../types';
import { APPEARANCES, resolveAppearance, type Appearance } from '../../../lib/common/appearances';
import { ICON_CHECK, ICON_CLOSE } from './icons';

type Row = { id: string | null; label: string; appearance: Appearance | null; disabled?: boolean };

/**
 * The Set appearance… dialog for a part row: the built-in appearances with
 * a swatch each, the part's current one checked, and **None** to take the
 * `.appearance()` chain off. The list is the shared table (no server round
 * trip — there is no custom table, unlike materials), and Apply dispatches
 * the acked set-part-appearance edit. An id the table lacks shows as a
 * checked, unpickable "Unknown appearance" row so the user sees what the
 * source says.
 */
export class SetAppearanceDialog {
  private overlay: HTMLDivElement;
  private subtitleEl: HTMLElement;
  private listEl: HTMLDivElement;
  private applyBtn: HTMLButtonElement;

  private part: SceneObjectRender | null = null;
  private current: string | null = null;
  private selected: string | null = null;

  constructor(container: HTMLElement, private client: EngineClient) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'fixed inset-0 z-[300] bg-black/50 flex items-center justify-center hidden';
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.setAttribute('aria-label', 'Set appearance');
    this.overlay.innerHTML = `
      <div data-role="box" class="w-[400px] max-w-[92vw] max-h-[85vh] bg-base-100 border border-base-content/10 rounded-lg p-5 shadow-[0_4px_24px_rgba(0,0,0,0.5)] flex flex-col">
        <div class="flex items-center justify-between mb-0.5">
          <h3 class="text-sm font-medium text-base-content/90">Set appearance</h3>
          <button data-ref="close" type="button" class="btn btn-ghost btn-square btn-xs text-base-content/60" aria-label="Close">
            <span class="[&>svg]:size-4">${ICON_CLOSE}</span>
          </button>
        </div>
        <div data-ref="subtitle" class="text-[11px] text-base-content/50 mb-3 truncate"></div>
        <div data-ref="list" role="listbox" aria-label="Appearances" class="overflow-y-auto max-h-[56vh] border border-base-content/10 rounded-md"></div>
        <div class="text-[11px] text-base-content/40 pt-2">Faces painted with color() keep their colour over the appearance.</div>
        <div class="flex items-center gap-2 pt-3">
          <span class="flex-1"></span>
          <button data-ref="cancel" type="button" class="btn btn-ghost btn-sm">Cancel</button>
          <button data-ref="apply" type="button" class="btn btn-primary btn-sm" disabled>Apply</button>
        </div>
      </div>
    `;
    container.appendChild(this.overlay);

    const ref = <T extends HTMLElement>(name: string): T => this.overlay.querySelector<T>(`[data-ref="${name}"]`)!;
    this.subtitleEl = ref('subtitle');
    this.listEl = ref('list');
    this.applyBtn = ref('apply');
    this.bindEvents();
  }

  get isOpen(): boolean {
    return !this.overlay.classList.contains('hidden');
  }

  /** Open for `part` (a part row). */
  open(part: SceneObjectRender): void {
    this.part = part;
    this.current = typeof part.object?.appearance === 'string' ? (part.object.appearance as string) : null;
    this.selected = this.current;
    this.subtitleEl.textContent = part.object?.name ? String(part.object.name) : part.name ?? '';
    this.renderList();
    this.overlay.classList.remove('hidden');
    this.applyBtn.focus();
  }

  hide(): void {
    this.overlay.classList.add('hidden');
    this.part = null;
  }

  private bindEvents(): void {
    const close = () => this.hide();
    this.overlay.querySelector('[data-ref="close"]')!.addEventListener('click', close);
    this.overlay.querySelector('[data-ref="cancel"]')!.addEventListener('click', close);
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) {
        close();
      }
    });
    this.overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement && e.target.dataset.ref === 'cancel')) {
        e.preventDefault();
        this.apply();
      }
    });
    this.applyBtn.addEventListener('click', () => this.apply());
  }

  /** None (and an unknown current id) first, then the table in its order. */
  private rows(): Row[] {
    const rows: Row[] = [{ id: null, label: 'None', appearance: null }];
    if (this.current !== null && resolveAppearance(this.current) === undefined) {
      rows.push({ id: this.current, label: `Unknown appearance: ${this.current}`, appearance: null, disabled: true });
    }
    for (const appearance of APPEARANCES) {
      rows.push({ id: appearance.id, label: appearance.name, appearance });
    }
    return rows;
  }

  private renderList(): void {
    this.listEl.innerHTML = '';
    for (const row of this.rows()) {
      this.listEl.appendChild(this.buildRow(row));
    }
    this.applyBtn.disabled = this.selected === this.current;
  }

  private buildRow(row: Row): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'option');
    const selected = row.id === this.selected;
    button.setAttribute('aria-selected', String(selected));
    button.dataset.appearanceId = row.id ?? '';
    button.disabled = row.disabled === true;
    button.className = `w-full flex items-center gap-3 px-3 py-1.5 text-left text-xs border-b border-base-content/[0.07] last:border-b-0 ${
      selected ? 'bg-primary/15' : 'hover:bg-base-content/[0.06]'
    } disabled:opacity-60`;

    const check = document.createElement('span');
    check.className = 'w-3.5 shrink-0 text-primary [&>svg]:size-3';
    check.innerHTML = row.id === this.current ? ICON_CHECK : '';
    check.title = row.id === this.current ? 'Current appearance' : '';
    button.appendChild(check);

    button.appendChild(SetAppearanceDialog.swatch(row.appearance));

    const label = document.createElement('span');
    label.className = 'flex-1 min-w-0 truncate text-base-content/90';
    label.textContent = row.label;
    button.appendChild(label);

    if (row.appearance) {
      const id = document.createElement('span');
      id.className = 'text-[11px] text-base-content/40 shrink-0 font-mono';
      id.textContent = row.appearance.id;
      button.appendChild(id);
    }

    if (!row.disabled) {
      button.addEventListener('click', () => {
        this.selected = row.id;
        this.renderList();
      });
      button.addEventListener('dblclick', () => {
        this.selected = row.id;
        this.apply();
      });
    }
    return button;
  }

  /**
   * A round swatch: the base colour with grain stripes for a wood, else
   * with a highlight that reads as polished for a metal and soft for a
   * dielectric. None is an empty ring.
   */
  private static swatch(appearance: Appearance | null): HTMLElement {
    const swatch = document.createElement('span');
    swatch.dataset.swatch = appearance?.id ?? 'none';
    swatch.className = 'w-5 h-5 rounded-full shrink-0 border border-base-content/20 overflow-hidden';
    if (!appearance) {
      return swatch;
    }
    swatch.style.backgroundColor = appearance.color;
    if (appearance.wood) {
      const dark = `rgba(0,0,0,${(appearance.wood.stripeVisibility * 0.28).toFixed(2)})`;
      swatch.style.backgroundImage = `repeating-linear-gradient(100deg, transparent 0 2px, ${dark} 2px 3px, transparent 3px 5px)`;
      return swatch;
    }
    const sheen = appearance.metalness > 0.5 ? 'rgba(255,255,255,0.85) 0%, rgba(255,255,255,0.15) 28%' : 'rgba(255,255,255,0.45) 0%, rgba(255,255,255,0) 45%';
    swatch.style.backgroundImage = `radial-gradient(circle at 32% 30%, ${sheen}, rgba(0,0,0,0.25) 100%)`;
    swatch.style.backgroundColor = appearance.color;
    return swatch;
  }

  private apply(): void {
    const part = this.part;
    if (!part || !part.sourceLocation || this.selected === this.current) {
      return;
    }
    void this.client.editor?.setPartAppearance(part.sourceLocation, this.selected);
    this.hide();
  }
}
