export class LoadingOverlay {
  private element: HTMLDivElement;
  private textEl: Element;

  constructor(container: HTMLElement) {
    this.element = document.createElement('div');
    this.element.id = 'fluidcad-loading';
    this.element.className = 'absolute top-4 left-1/2 -translate-x-1/2 z-[1000] pointer-events-none';
    this.element.innerHTML = `
      <div class="flex items-center gap-3 panel-bg border border-base-content/10 rounded-lg px-6 py-3 text-base-content/70 text-sm leading-none select-none">
        <span class="loading loading-spinner loading-sm"></span>
        <span class="loading-text">Loading FluidCAD...</span>
      </div>
    `;
    container.appendChild(this.element);
    this.textEl = this.element.querySelector('.loading-text')!;
  }

  show(text: string): void {
    this.textEl.textContent = text;
    this.element.classList.remove('hidden');
  }

  hide(): void {
    this.element.classList.add('hidden');
  }
}
