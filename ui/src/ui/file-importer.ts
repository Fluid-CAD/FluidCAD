import { importFile } from '../api';

export class FileImporter {
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

    this.importToast = document.createElement('div');
    this.importToast.className = 'absolute bottom-16 left-6 z-[100] panel-bg border border-base-content/10 rounded-lg px-4 py-3 text-sm text-base-content/80 hidden';
    container.appendChild(this.importToast);

    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = '.step,.stp';
    this.fileInput.style.display = 'none';
    container.appendChild(this.fileInput);

    this.fileInput.addEventListener('change', () => this.handleFileChange());
  }

  openPicker(): void {
    this.fileInput.click();
  }

  private showToast(message: string): void {
    this.importToast.textContent = message;
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

      // On success the server has the extension write the load() call into
      // the document itself, so the model appearing in the scene is the
      // feedback — there is nothing to tell the user to paste.
      const result = await importFile(file.name, base64);
      if (!result.success) {
        this.showToast(`Import failed: ${result.error || 'Unknown error'}`);
      }
    } catch (_err) {
      this.showToast('Import failed: network error');
    } finally {
      this.hideLoading();
    }
  }
}
