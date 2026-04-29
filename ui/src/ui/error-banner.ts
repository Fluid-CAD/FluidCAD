import type { CompileError, SceneObjectRender } from '../types';
import { ICON_ALERT_TRIANGLE } from './icons';

type SourceLocation = { filePath: string; line: number; column: number };

const CHEVRON_DOWN_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

export class ErrorBanner {
  private element: HTMLDivElement;
  private messageEl: HTMLSpanElement;
  private countEl: HTMLSpanElement;
  private toggleEl: HTMLButtonElement;
  private listEl: HTMLDivElement;
  private expanded = false;
  private primaryLoc: SourceLocation | null = null;
  private onGotoSource: (loc: SourceLocation) => void;

  constructor(container: HTMLElement, onGotoSource: (loc: SourceLocation) => void) {
    this.onGotoSource = onGotoSource;

    this.element = document.createElement('div');
    this.element.id = 'fluidcad-error-banner';
    this.element.className = 'absolute top-4 left-1/2 -translate-x-1/2 z-[1001] pointer-events-auto hidden max-w-[600px]';
    this.element.innerHTML = `
      <div class="panel-bg border border-error/40 rounded-lg shadow-md overflow-hidden">
        <div class="flex items-start gap-3 px-5 py-2.5 text-sm select-none">
          <span class="text-error shrink-0 mt-0.5 [&>svg]:size-5">${ICON_ALERT_TRIANGLE}</span>
          <span data-ref="message" class="text-base-content/90 whitespace-pre-line break-words cursor-pointer hover:underline grow min-w-0"></span>
          <span data-ref="count" class="text-base-content/40 tabular-nums shrink-0 hidden mt-0.5"></span>
          <button data-ref="toggle" class="text-base-content/40 hover:text-base-content/70 shrink-0 hidden cursor-pointer transition-transform mt-0.5" aria-label="Toggle error list">
            ${CHEVRON_DOWN_SVG}
          </button>
        </div>
        <div data-ref="list" class="hidden border-t border-base-content/10 max-h-[40vh] overflow-y-auto"></div>
      </div>
    `;
    container.appendChild(this.element);

    this.messageEl = this.element.querySelector<HTMLSpanElement>('[data-ref="message"]')!;
    this.countEl = this.element.querySelector<HTMLSpanElement>('[data-ref="count"]')!;
    this.toggleEl = this.element.querySelector<HTMLButtonElement>('[data-ref="toggle"]')!;
    this.listEl = this.element.querySelector<HTMLDivElement>('[data-ref="list"]')!;

    this.messageEl.addEventListener('click', () => {
      if (this.primaryLoc) {
        this.onGotoSource(this.primaryLoc);
      }
    });

    this.toggleEl.addEventListener('click', () => {
      this.expanded = !this.expanded;
      this.listEl.classList.toggle('hidden', !this.expanded);
      this.toggleEl.classList.toggle('rotate-180', this.expanded);
    });
  }

  update(sceneObjects: SceneObjectRender[], compileError: CompileError | null): void {
    if (compileError) {
      const fileName = compileError.filePath ? compileError.filePath.split('/').pop() ?? '' : '';
      const prefix = fileName ? `${fileName}: ` : '';
      this.messageEl.textContent = prefix + compileError.message;
      this.primaryLoc = compileError.sourceLocation ?? null;
      this.countEl.classList.add('hidden');
      this.toggleEl.classList.add('hidden');
      this.listEl.classList.add('hidden');
      this.expanded = false;
      this.element.classList.remove('hidden');
      return;
    }

    const errored = sceneObjects.filter(o => o.hasError === true && typeof o.errorMessage === 'string' && o.errorMessage.length > 0);
    if (errored.length === 0) {
      this.element.classList.add('hidden');
      this.expanded = false;
      this.listEl.classList.add('hidden');
      this.toggleEl.classList.remove('rotate-180');
      this.primaryLoc = null;
      return;
    }

    this.messageEl.textContent = errored[0].errorMessage!;
    this.primaryLoc = errored[0].sourceLocation ?? null;

    if (errored.length > 1) {
      this.countEl.textContent = `+${errored.length - 1} more`;
      this.countEl.classList.remove('hidden');
      this.toggleEl.classList.remove('hidden');
      this.renderList(errored);
    } else {
      this.countEl.classList.add('hidden');
      this.toggleEl.classList.add('hidden');
      this.listEl.classList.add('hidden');
      this.expanded = false;
      this.toggleEl.classList.remove('rotate-180');
    }

    this.element.classList.remove('hidden');
  }

  private renderList(errored: SceneObjectRender[]): void {
    let html = '';
    for (let i = 0; i < errored.length; i++) {
      const e = errored[i];
      const name = e.name || e.type || 'object';
      const escapedMsg = (e.errorMessage || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const escapedName = name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      html += `
        <div data-error-index="${i}" class="px-5 py-2 text-sm cursor-pointer hover:bg-base-content/[0.06] flex items-start gap-2">
          <span class="text-error/70 shrink-0 mt-1">•</span>
          <div class="min-w-0">
            <div class="text-base-content/60 text-xs mb-0.5">${escapedName}</div>
            <div class="text-base-content/90 break-words whitespace-pre-line">${escapedMsg}</div>
          </div>
        </div>
      `;
    }
    this.listEl.innerHTML = html;
    this.listEl.querySelectorAll<HTMLElement>('[data-error-index]').forEach((el) => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.errorIndex!, 10);
        const loc = errored[idx]?.sourceLocation;
        if (loc) {
          this.onGotoSource(loc);
        }
      });
    });
  }
}
