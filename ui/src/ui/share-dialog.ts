import { getShareFiles, type ShareFiles } from '../api';
import { ICON_CLOSE } from './icons';

/** The public viewer the link opens in. */
export const VIEWER_URL = 'https://viewer.fluidcad.io';

/**
 * The top bar's Share flow: a confirmation that the model becomes public,
 * then the rendered model's source tree opens in the FluidCAD viewer as a
 * `#v=&entry=&files=` link (one file: `#code=`). The link carries the
 * source itself — nothing is uploaded, and there is nothing to revoke.
 */
export class ShareDialog {
  private overlay: HTMLDivElement;
  private fileEl: HTMLSpanElement;
  private statusEl: HTMLDivElement;
  private shareBtn: HTMLButtonElement;
  private sharing = false;

  constructor(container: HTMLElement) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'fixed inset-0 z-[300] bg-black/50 flex items-center justify-center hidden';
    this.overlay.innerHTML = `
      <div class="w-[400px] max-w-[92vw] bg-base-100 border border-base-content/10 rounded-lg p-5 shadow-[0_4px_24px_rgba(0,0,0,0.5)] flex flex-col">
        <div class="flex items-center justify-between mb-2">
          <h3 class="text-sm font-medium text-base-content/90">Share this model</h3>
          <button data-ref="close-btn" class="btn btn-ghost btn-square btn-xs text-base-content/60" title="Close">
            <span class="[&>svg]:size-4">${ICON_CLOSE}</span>
          </button>
        </div>
        <p class="text-[13px] text-base-content/80 leading-snug">
          <span data-ref="file" class="font-medium"></span> will be shared publicly: anyone with the link
          will be able to see the model and its source code.
        </p>
        <p class="text-[13px] text-base-content/60 leading-snug mt-2">
          Confirm to open it in the FluidCAD viewer; the link it opens is the one to share.
        </p>
        <div data-ref="status" class="text-xs text-error min-h-4 mt-3"></div>
        <div class="flex items-center justify-end gap-2 pt-1">
          <button data-ref="cancel-btn" class="btn btn-ghost btn-sm">Cancel</button>
          <button data-ref="share-btn" class="btn btn-primary btn-sm">Share</button>
        </div>
      </div>
    `;
    container.appendChild(this.overlay);
    this.fileEl = this.overlay.querySelector<HTMLSpanElement>('[data-ref="file"]')!;
    this.statusEl = this.overlay.querySelector<HTMLDivElement>('[data-ref="status"]')!;
    this.shareBtn = this.overlay.querySelector<HTMLButtonElement>('[data-ref="share-btn"]')!;

    this.overlay.querySelector('[data-ref="close-btn"]')!.addEventListener('click', () => this.hide());
    this.overlay.querySelector('[data-ref="cancel-btn"]')!.addEventListener('click', () => this.hide());
    this.shareBtn.addEventListener('click', () => void this.share());
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) {
        this.hide();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.overlay.classList.contains('hidden')) {
        e.stopPropagation();
        this.hide();
      }
    }, true);
  }

  /** Open for the rendered model; `absPath` names it in the confirmation (null: nothing rendered yet). */
  show(absPath: string | null): void {
    this.fileEl.textContent = absPath ? absPath.split('/').pop() ?? absPath : 'This model';
    this.statusEl.textContent = absPath ? '' : 'No model is rendered yet.';
    this.shareBtn.disabled = !absPath;
    this.overlay.classList.remove('hidden');
  }

  hide(): void {
    this.overlay.classList.add('hidden');
  }

  private async share(): Promise<void> {
    if (this.sharing) {
      return;
    }
    this.sharing = true;
    this.shareBtn.disabled = true;
    this.statusEl.textContent = '';
    try {
      const share = await getShareFiles();
      const url = await buildViewerLink(share);
      window.open(url, '_blank', 'noopener');
      this.hide();
    } catch (err: any) {
      this.statusEl.textContent = err?.message ?? String(err);
    } finally {
      this.sharing = false;
      this.shareBtn.disabled = false;
    }
  }
}

/**
 * The viewer's fragment link for a source tree — the inverse of the
 * viewer's loaders.js decoders: one file travels as `#code=<source>`, a
 * tree as `#files=<JSON { path: source }>` with its file names, both
 * base64url(deflate-raw(text)).
 */
export async function buildViewerLink(share: ShareFiles, base: string = VIEWER_URL): Promise<string> {
  const params = new URLSearchParams();
  params.set('v', share.fluidcadVersion);
  const names = Object.keys(share.files);
  if (share.entry !== 'model.fluid.js') {
    params.set('entry', share.entry);
  }
  if (names.length === 1 && names[0] === share.entry) {
    params.set('code', await encodeFragment(share.files[share.entry]));
  } else {
    params.set('files', await encodeFragment(JSON.stringify(share.files)));
  }
  return `${base}/#${params.toString()}`;
}

async function encodeFragment(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = '';
  for (let i = 0; i < compressed.length; i += 0x8000) {
    binary += String.fromCharCode(...compressed.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
