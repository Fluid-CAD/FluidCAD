// DOF status pill for solved sketches (sketch-rewrite P3) — bottom-center
// indicator mirroring the assembly DofStatus: how many degrees of freedom
// remain, fully-constrained green, and an expandable list of conflicting
// statements that jumps to source. Read-only; P4 adds nothing here (drag
// health stays in the pill's states).

import { ICON_CIRCLE_CHECK, ICON_ALERT_TRIANGLE } from './icons';
import type { SketchDofState } from '../sketch-solver-client';
import type { SourceLocation } from '../types';

const DOT_SVG = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>';

export class SketchDofStatus {
  /** Fires on edges when the pill claims or releases the bottom-center spot. */
  onVisibilityChange?: (visible: boolean) => void;

  private pill: HTMLDivElement;
  private label: HTMLSpanElement;
  private icon: HTMLSpanElement;
  private expandedList: HTMLDivElement;
  private state: SketchDofState = { result: 'hidden' };
  private isExpanded = false;
  private lastVisible = false;
  private onSelectFailing: (loc: SourceLocation) => void;

  constructor(
    container: HTMLElement,
    onSelectFailing: (loc: SourceLocation) => void,
  ) {
    this.onSelectFailing = onSelectFailing;

    this.pill = document.createElement('div');
    this.pill.id = 'fluidcad-sketch-dof';
    this.pill.className = 'absolute bottom-6 left-[calc(50%+var(--fluidcad-editor-width,0px)/2)] -translate-x-1/2 z-[100] panel-bg border border-base-content/10 rounded-full px-4 py-2 text-xs text-base-content/70 select-none flex items-center gap-2 cursor-default hidden';

    this.icon = document.createElement('span');
    this.icon.className = 'shrink-0 [&>svg]:size-3.5';
    this.pill.appendChild(this.icon);

    this.label = document.createElement('span');
    this.pill.appendChild(this.label);

    container.appendChild(this.pill);

    this.expandedList = document.createElement('div');
    this.expandedList.className = 'absolute bottom-16 left-[calc(50%+var(--fluidcad-editor-width,0px)/2)] -translate-x-1/2 z-[100] panel-bg border border-base-content/10 rounded-md p-2 text-xs text-base-content/80 hidden min-w-[220px]';
    container.appendChild(this.expandedList);

    this.pill.addEventListener('click', () => {
      if (this.state.result !== 'conflict') {
        return;
      }
      this.isExpanded = !this.isExpanded;
      this.renderExpansion();
    });
  }

  update(state: SketchDofState): void {
    this.state = state;
    if (state.result !== 'conflict') {
      this.isExpanded = false;
    }
    this.render();
    this.renderExpansion();
  }

  private render(): void {
    if (this.state.result === 'hidden') {
      this.pill.classList.add('hidden');
      this.reportVisibility(false);
      return;
    }
    this.pill.classList.remove('hidden');
    this.reportVisibility(true);
    this.pill.classList.remove('cursor-pointer');

    switch (this.state.result) {
      case 'conflict': {
        const n = this.state.failed.length;
        this.icon.innerHTML = ICON_ALERT_TRIANGLE;
        this.icon.className = 'shrink-0 [&>svg]:size-3.5 text-error';
        this.label.textContent = `Over-constrained — ${n} conflicting statement${n === 1 ? '' : 's'}`;
        this.pill.classList.add('cursor-pointer');
        break;
      }
      case 'unsolved':
        this.icon.innerHTML = ICON_ALERT_TRIANGLE;
        this.icon.className = 'shrink-0 [&>svg]:size-3.5 text-error';
        this.label.textContent = this.state.outcome === 'singular'
          ? 'Sketch constraints are singular'
          : 'Sketch constraints did not converge';
        break;
      case 'constrained':
        this.icon.innerHTML = ICON_CIRCLE_CHECK;
        this.icon.className = 'shrink-0 [&>svg]:size-3.5 text-success';
        this.label.textContent = withRedundant('Fully constrained', this.state.redundant);
        break;
      case 'under':
        this.icon.innerHTML = DOT_SVG;
        this.icon.className = 'shrink-0 [&>svg]:size-2.5 text-warning';
        this.label.textContent = withRedundant(
          `${this.state.dof} DOF remaining`, this.state.redundant,
        );
        break;
    }
  }

  private reportVisibility(visible: boolean): void {
    if (visible === this.lastVisible) {
      return;
    }
    this.lastVisible = visible;
    this.onVisibilityChange?.(visible);
  }

  private renderExpansion(): void {
    if (!this.isExpanded || this.state.result !== 'conflict') {
      this.expandedList.classList.add('hidden');
      return;
    }
    this.expandedList.classList.remove('hidden');
    this.expandedList.innerHTML = `
      <div class="text-base-content/50 text-[10px] uppercase tracking-wide mb-1">Conflicting statements</div>
      ${this.state.failed.map((f, i) => `
        <div class="cursor-pointer hover:bg-base-content/[0.06] rounded px-2 py-1" data-failed-index="${i}">${escapeHtml(f.label)}</div>
      `).join('')}
    `;
    this.expandedList.querySelectorAll<HTMLElement>('[data-failed-index]').forEach((el) => {
      el.addEventListener('click', () => {
        const failed = this.state.result === 'conflict'
          ? this.state.failed[Number(el.dataset.failedIndex)] : undefined;
        if (failed?.sourceLocation) {
          this.onSelectFailing(failed.sourceLocation);
        }
      });
    });
  }
}

function withRedundant(text: string, redundant: number): string {
  return redundant > 0
    ? `${text} · ${redundant} redundant`
    : text;
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
