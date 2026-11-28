import { importFile } from '../api';
import { desktop } from '../desktop';

type DesktopBridge = NonNullable<ReturnType<typeof desktop>>;

const STEP_FILTERS = [{ name: 'STEP Files', extensions: ['step', 'stp'] }];

/** The last segment of a path the native dialog returned, either separator. */
function baseName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath;
}

export class FileImporter {
  private importToast: HTMLDivElement;
  private fileInput: HTMLInputElement;
  private importToastTimer: ReturnType<typeof setTimeout> | null = null;
  private showLoading: (text: string) => void;
  private hideLoading: () => void;
  private refusal: () => string | null;

  /**
   * @param deps.refusal why nothing can be imported right now (no model is
   * open, or the open one is an assembly), or null. Asked before the picker
   * opens, so the person is told before they go looking for a file.
   */
  constructor(
    container: HTMLElement,
    deps: { showLoading: (text: string) => void; hideLoading: () => void; refusal: () => string | null },
  ) {
    this.showLoading = deps.showLoading;
    this.hideLoading = deps.hideLoading;
    this.refusal = deps.refusal;

    this.importToast = document.createElement('div');
    this.importToast.className = 'absolute bottom-16 left-[calc(var(--fluidcad-scene-left,0px)+1.5rem)] z-[100] panel-bg border border-base-content/10 rounded-lg px-4 py-3 text-sm text-base-content/80 hidden';
    container.appendChild(this.importToast);

    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = '.step,.stp';
    this.fileInput.style.display = 'none';
    container.appendChild(this.fileInput);

    this.fileInput.addEventListener('change', () => this.handleFileChange());
  }

  /**
   * Ask for a STEP file and import it. The desktop app asks with its native
   * dialog: a hidden file input opens only on a click in the page, and the
   * application menu's Import STEP is not one, so the input stayed shut from
   * there unless the page had been clicked moments before.
   */
  openPicker(): void {
    const refusal = this.refusal();
    if (refusal) {
      this.showToast(refusal);
      return;
    }
    const api = desktop();
    if (api) {
      void this.pickNative(api);
      return;
    }
    this.fileInput.click();
  }

  private async pickNative(api: DesktopBridge): Promise<void> {
    const picked = await api.showOpenDialog({
      title: 'Import STEP',
      filters: STEP_FILTERS,
      properties: ['openFile'],
    });
    const filePath = picked?.[0];
    if (!filePath) {
      return;
    }
    this.showLoading('Importing file...');
    try {
      const read = await api.readFile(filePath);
      if (!read.ok || read.base64 === undefined) {
        this.showToast(`Import failed: ${read.error || 'could not read the file'}`);
        return;
      }
      await this.importBytes(baseName(filePath), read.base64);
    } catch (_err) {
      this.showToast('Import failed: could not read the file');
    } finally {
      this.hideLoading();
    }
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
      await this.importBytes(file.name, btoa(binary));
    } catch (_err) {
      this.showToast('Import failed: network error');
    } finally {
      this.hideLoading();
    }
  }

  /** Send the file to the server and say how it went. */
  private async importBytes(fileName: string, base64: string): Promise<void> {
    // On success the server has the editor host write the load() call into
    // the document itself, so the model appearing in the scene is the
    // feedback — there is nothing to tell the user to paste.
    const result = await importFile(fileName, base64);
    if (!result.success) {
      this.showToast(`Import failed: ${result.error || 'Unknown error'}`);
    } else if (result.sourceUnits && result.sourceUnits.length.length > 0) {
      // The one thing the scene cannot show: which unit the file was in.
      const count = result.solidCount ?? 0;
      const solids = `${count} solid${count === 1 ? '' : 's'}`;
      this.showToast(`Imported ${result.fileName ?? fileName}: ${solids}, file unit ${result.sourceUnits.length.join(', ')}`);
    }
  }
}
