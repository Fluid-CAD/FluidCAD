import { explainSelection } from '../../api';
import { entityKey } from '../../helpers/entities';
import { SubSelection } from '../../types';
import { SelectedEntity } from '../../viewer';

const TOOLTIP_DEBOUNCE_MS = 200;

/**
 * The teach-mode attribution tooltip: hovering an edge/face while a pick
 * mode is armed shows the expression that would select it — debounced,
 * cached per entity, resolved against the edit session's boundary when one
 * is open. The host clears the cache when the scene re-renders.
 */
export class TeachTooltip {
  private readonly tooltip: HTMLDivElement;
  private timer: number | null = null;
  private abort: AbortController | null = null;
  private cache = new Map<string, string>();

  constructor(
    private readonly container: HTMLElement,
    private readonly opts: {
      /** The tooltip only works while a mode is armed. */
      isActive: () => boolean;
      /** An open selection menu suppresses the tooltip. */
      isSuppressed: () => boolean;
      boundary: () => Parameters<typeof explainSelection>[2];
    },
  ) {
    this.tooltip = document.createElement('div');
    this.tooltip.id = 'fluidcad-modify-pick-tooltip';
    this.tooltip.className = 'hidden absolute z-[1001] pointer-events-none max-w-[420px] '
      + 'bg-base-100/95 border border-base-300 rounded px-2 py-1 font-mono text-[11px] text-base-content shadow-md';
    container.appendChild(this.tooltip);
  }

  /** Hover → attribution expression, debounced + cached. */
  handleHover(shapeId: string | null, sub: SubSelection, clientX: number, clientY: number): void {
    if (!this.opts.isActive()) {
      return;
    }
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    if (!shapeId || !sub || sub.type === 'sketch' || sub.type === 'axis' || sub.type === 'plane') {
      this.hide();
      return;
    }
    if (this.opts.isSuppressed()) {
      return;
    }

    const entity: SelectedEntity = { shapeId, sub };
    const key = entityKey(entity);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.show(cached, clientX, clientY);
      return;
    }

    this.timer = window.setTimeout(async () => {
      this.timer = null;
      this.abort?.abort();
      const abort = new AbortController();
      this.abort = abort;
      try {
        const result = await explainSelection([entity], abort.signal, this.opts.boundary());
        if (abort.signal.aborted || !this.opts.isActive()) {
          return;
        }
        const pick = result?.picks?.[0];
        const text = pick?.expression
          ?? pick?.error
          ?? (pick && !pick.attributed
            ? 'no classified origin — a geometric select() will be synthesized'
            : null);
        if (text) {
          this.cache.set(key, text);
          this.show(text, clientX, clientY);
        }
      } catch {
        // Aborted or unreachable — no tooltip.
      }
    }, TOOLTIP_DEBOUNCE_MS);
  }

  hide(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.abort?.abort();
    this.abort = null;
    this.tooltip.classList.add('hidden');
  }

  /** Entity attribution is scene-addressed — a re-render invalidates it. */
  clearCache(): void {
    this.cache.clear();
  }

  private show(text: string, clientX: number, clientY: number): void {
    const rect = this.container.getBoundingClientRect();
    this.tooltip.textContent = text;
    this.tooltip.style.left = `${clientX - rect.left + 14}px`;
    this.tooltip.style.top = `${clientY - rect.top + 18}px`;
    this.tooltip.classList.remove('hidden');
  }
}
