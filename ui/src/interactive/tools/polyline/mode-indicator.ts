import type { ModeId } from './types';

const MODE_LABELS: Record<ModeId, string> = {
  line: 'Line',
  hLine: 'H-Line',
  vLine: 'V-Line',
  arc: 'Arc',
  tArc: 'T-Arc',
  tLine: 'T-Line',
};

export class ModeIndicator {
  private el: HTMLDivElement;
  private labelSpan: HTMLSpanElement;

  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'absolute z-[999] pointer-events-none hidden';

    const badge = document.createElement('div');
    badge.className = 'panel-bg border border-base-content/10 rounded-md px-2 py-0.5 shadow-sm flex items-center gap-1.5';

    this.labelSpan = document.createElement('span');
    this.labelSpan.className = 'text-xs font-mono text-base-content/70';

    const hint = document.createElement('span');
    hint.className = 'text-[10px] text-base-content/30';
    hint.textContent = 'Space';

    badge.appendChild(this.labelSpan);
    badge.appendChild(hint);
    this.el.appendChild(badge);
    container.appendChild(this.el);
  }

  show(modeId: ModeId): void {
    this.labelSpan.textContent = MODE_LABELS[modeId];
    this.el.classList.remove('hidden');
  }

  hide(): void {
    this.el.classList.add('hidden');
  }

  update(modeId: ModeId): void {
    this.labelSpan.textContent = MODE_LABELS[modeId];
  }

  updatePosition(clientX: number, clientY: number): void {
    this.el.style.left = `${clientX + 16}px`;
    this.el.style.top = `${clientY + 16}px`;
  }

  dispose(): void {
    this.el.remove();
  }
}
