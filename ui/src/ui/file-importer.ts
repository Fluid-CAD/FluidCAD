import { ICON_FILE_IMPORT, ICON_COPY } from './icons';
import { importFile } from '../api';

export class FileImporter {
  private importBtn: HTMLDivElement;
  private importToast: HTMLDivElement;
  private fileInput: HTMLInputElement;
  private importToastTimer: ReturnType<typeof setTimeout> | null = null;
  private showLoading: (text: string) => void;
  private hideLoading: () => void;

  constructor(
    container: HTMLElement,
    deps: { showLoading: (text: string) => void; hideLoading: () => void },
  ) {
    this.showLoading = deps.showLoading;
    this.hideLoading = deps.hideLoading;

    this.importBtn = document.createElement('div');
    this.importBtn.className = 'absolute bottom-6 left-6 z-[100]';
    this.importBtn.innerHTML = `
      <button class="btn btn-ghost btn-square btn-sm text-base-content/60" title="Import File">
        <span class="[&>svg]:size-5">${ICON_FILE_IMPORT}</span>
      </button>
    `;
    container.appendChild(this.importBtn);

    this.importToast = document.createElement('div');
    this.importToast.className = 'absolute bottom-16 left-6 z-[100] panel-bg border border-base-content/10 rounded-lg px-4 py-3 text-sm text-base-content/80 hidden';
    container.appendChild(this.importToast);

    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = '.step,.stp';
    this.fileInput.style.display = 'none';
    container.appendChild(this.fileInput);

    this.importBtn.querySelector('button')!.addEventListener('click', () => {
      this.fileInput.click();
    });

    this.fileInput.addEventListener('change', () => this.handleFileChange());
  }

  openPicker(): void {
    this.fileInput.click();
  }

  private showToast(message: string, loadCmd?: string): void {
    if (loadCmd) {
      this.importToast.innerHTML = `
        <div class="flex items-center gap-2">
          <span>${message} <code class="bg-base-content/10 px-1.5 py-0.5 rounded text-base-content/90">${loadCmd}</code></span>
          <button class="btn btn-ghost btn-square btn-xs text-base-content/60 import-toast-copy" title="Copy">
            <span class="[&>svg]:size-3.5">${ICON_COPY}</span>
          </button>
        </div>
      `;
      this.importToast.querySelector('.import-toast-copy')!.addEventListener('click', () => {
        navigator.clipboard.writeText(loadCmd);
        const btn = this.importToast.querySelector('.import-toast-copy')!;
        btn.setAttribute('title', 'Copied!');
        setTimeout(() => btn.setAttribute('title', 'Copy'), 1500);
      });
    } else {
      this.importToast.textContent = message;
    }
    this.importToast.classList.remove('hidden');
    if (this.importToastTimer) {
      clearTimeout(this.importToastTimer);
    }
    this.importToastTimer = setTimeout(() => {
      this.importToast.classList.add('hidden');
      this.importToastTimer = null;
    }, 6000);
  }

  private async handleFileChange(): Promise<void> {
    const file = this.fileInput.files?.[0];
    if (!file) {
      return;
    }
    this.fileInput.value = '';

    this.showLoading('Importing file...');

    try {
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);

      const result = await importFile(file.name, base64);
      if (!result.success) {
        this.showToast(`Import failed: ${result.error || 'Unknown error'}`);
      } else {
        this.showToast('Imported! Use:', `load('${result.fileName}')`);
      }
    } catch (_err) {
      this.showToast('Import failed: network error');
    } finally {
      this.hideLoading();
    }
  }
}
