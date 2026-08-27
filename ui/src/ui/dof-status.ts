// DOF status pill — bottom-center indicator for the assembly solver health.
//
// Phase 04 only renders the placeholder ("Free assembly · drag to move").
// Phase 05 wires the real solver result through `update(...)`.

import { ICON_CIRCLE_CHECK, ICON_ALERT_TRIANGLE } from './icons';

export type DofStatusUpdate =
  | { result: 'placeholder' }
  | { result: 'okay'; dof: number }
  | { result: 'inconsistent'; dof: number; failed: { mateId: string; label: string }[] };

const DOT_SVG = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>';

export class DofStatus {
  private pill: HTMLDivElement;
  private label: HTMLSpanElement;
  private icon: HTMLSpanElement;
  private expandedList: HTMLDivElement;
  private state: DofStatusUpdate = { result: 'placeholder' };
  private isExpanded = false;
  private onSelectFailingMate: (mateId: string) => void;

  constructor(
    container: HTMLElement,
    onSelectFailingMate: (mateId: string) => void,
  ) {
    this.onSelectFailingMate = onSelectFailingMate;

    this.pill = document.createElement('div');
    // Centered on the scene rather than the window — the panel rail and the
    // editor pane take real width off the left.
    this.pill.className = 'absolute bottom-6 left-[calc(50%+var(--fluidcad-scene-left,0px)/2)] -translate-x-1/2 z-[100] panel-bg border border-base-content/10 rounded-full px-4 py-2 text-xs text-base-content/70 select-none flex items-center gap-2 cursor-default hidden';

    this.icon = document.createElement('span');
    this.icon.className = 'shrink-0 [&>svg]:size-3.5';
    this.pill.appendChild(this.icon);

    this.label = document.createElement('span');
    this.pill.appendChild(this.label);

    container.appendChild(this.pill);

    this.expandedList = document.createElement('div');
    this.expandedList.className = 'absolute bottom-16 left-[calc(50%+var(--fluidcad-scene-left,0px)/2)] -translate-x-1/2 z-[100] panel-bg border border-base-content/10 rounded-md p-2 text-xs text-base-content/80 hidden min-w-[200px]';
    container.appendChild(this.expandedList);

    this.pill.addEventListener('click', () => {
      if (this.state.result !== 'inconsistent') return;
      this.isExpanded = !this.isExpanded;
      this.renderExpansion();
    });

    this.render();
  }

  show(): void {
    this.pill.classList.remove('hidden');
    this.renderExpansion();
  }

  hide(): void {
    this.pill.classList.add('hidden');
    this.expandedList.classList.add('hidden');
    this.isExpanded = false;
  }

  update(state: DofStatusUpdate): void {
    this.state = state;
    if (state.result !== 'inconsistent') {
      this.isExpanded = false;
    }
    this.render();
    this.renderExpansion();
  }

  private render(): void {
    switch (this.state.result) {
      case 'placeholder':
        this.icon.innerHTML = DOT_SVG;
        this.icon.className = 'shrink-0 [&>svg]:size-2.5 text-base-content/40';
        this.label.textContent = 'Free assembly · drag to move';
        this.pill.classList.remove('cursor-pointer');
        break;
      case 'okay':
        if (this.state.dof === 0) {
          this.icon.innerHTML = ICON_CIRCLE_CHECK;
          this.icon.className = 'shrink-0 [&>svg]:size-3.5 text-success';
          this.label.textContent = 'Fully constrained';
        } else {
          this.icon.innerHTML = DOT_SVG;
          this.icon.className = 'shrink-0 [&>svg]:size-2.5 text-warning';
          this.label.textContent = `${this.state.dof} DOF remaining`;
        }
        this.pill.classList.remove('cursor-pointer');
        break;
      case 'inconsistent':
        this.icon.innerHTML = ICON_ALERT_TRIANGLE;
        this.icon.className = 'shrink-0 [&>svg]:size-3.5 text-error';
        this.label.textContent = `Inconsistent — ${this.state.failed.length} mate${this.state.failed.length === 1 ? '' : 's'} failing`;
        this.pill.classList.add('cursor-pointer');
        break;
    }
  }

  private renderExpansion(): void {
    if (!this.isExpanded || this.state.result !== 'inconsistent') {
      this.expandedList.classList.add('hidden');
      return;
    }
    this.expandedList.classList.remove('hidden');
    this.expandedList.innerHTML = `
      <div class="text-base-content/50 text-[10px] uppercase tracking-wide mb-1">Failing mates</div>
      ${this.state.failed.map(f => `
        <div class="cursor-pointer hover:bg-base-content/[0.06] rounded px-2 py-1" data-mate-id="${f.mateId}">${escapeHtml(f.label)}</div>
      `).join('')}
    `;
    this.expandedList.querySelectorAll<HTMLElement>('[data-mate-id]').forEach((el) => {
      el.addEventListener('click', () => {
        this.onSelectFailingMate(el.dataset.mateId!);
      });
    });
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
