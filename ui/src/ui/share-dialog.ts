import { getShareFiles, type ShareFiles } from '../api';
import { ICON_CLOSE } from './icons';

/** The public viewer the link opens in. */
export const VIEWER_URL = 'https://viewer.fluidcad.io';

/**
 * The longest link the share flow will open. Browsers take far more, but on
 * Linux the desktop hands the link to `xdg-open` as one argument, whose
 * limit is 128 KB — and a link past this size is unwieldy to paste anyway.
 */
export const MAX_LINK_CHARS = 100_000;

/** What a file in the link is, for the confirmation's file list. */
export type ShareFileKind = 'model' | 'script' | 'unit' | 'data';

const MODEL_SUFFIXES = ['.fluid.js', '.part.js', '.assembly.js'];
const SCRIPT_SUFFIXES = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'];

/**
 * Model files render, scripts are their helpers, `fluidcad.json` is the
 * rebuilt project unit — and anything else is data the model imported
 * (JSON, text), which is the one kind the user has to look at: it travels
 * verbatim and nothing here knows whether it holds something private.
 */
export function classifyShareFile(path: string): ShareFileKind {
  if (path === 'fluidcad.json') {
    return 'unit';
  }
  if (MODEL_SUFFIXES.some((suffix) => path.endsWith(suffix))) {
    return 'model';
  }
  if (SCRIPT_SUFFIXES.some((suffix) => path.endsWith(suffix))) {
    return 'script';
  }
  return 'data';
}

/** The message for a link past {@link MAX_LINK_CHARS}, or null when it fits. */
export function linkSizeProblem(url: string): string | null {
  if (url.length <= MAX_LINK_CHARS) {
    return null;
  }
  const kb = (n: number) => Math.round(n / 1024);
  return `This model is too large to share as a link (${kb(url.length)} KB compressed; the limit is ${kb(MAX_LINK_CHARS)} KB).`;
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

const KIND_NOTE: Record<ShareFileKind, string> = {
  model: '',
  script: '',
  unit: 'project unit only',
  data: 'Data file: check that it holds nothing private',
};

/**
 * The top bar's Share flow. Opening the dialog collects the rendered model's
 * source tree and builds the viewer link right away, so the confirmation can
 * list every file that will travel (data files flagged) and refuse a link
 * that is too large before anything opens. Confirming opens the link
 * synchronously in the click — popup blockers allow that — and then keeps
 * the link on screen with Open and Copy, so a blocked or silently failed
 * open never loses it. The link carries the source itself: nothing is
 * uploaded, and there is nothing to revoke.
 */
export class ShareDialog {
  private overlay: HTMLDivElement;
  private confirmStage: HTMLDivElement;
  private linkStage: HTMLDivElement;
  private fileEl: HTMLSpanElement;
  private filesEl: HTMLDivElement;
  private statusEl: HTMLDivElement;
  private shareBtn: HTMLButtonElement;
  private linkEl: HTMLAnchorElement;
  private openLink: HTMLAnchorElement;
  private copyBtn: HTMLButtonElement;
  private copyLabel: HTMLSpanElement;
  private link: string | null = null;
  /** Bumped per show(); a collect that finishes for an older show is dropped. */
  private generation = 0;

  constructor(container: HTMLElement) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'fixed inset-0 z-[300] bg-black/50 flex items-center justify-center hidden';
    this.overlay.innerHTML = `
      <div class="w-[440px] max-w-[92vw] max-h-[82vh] bg-base-100 border border-base-content/10 rounded-lg p-5 shadow-[0_4px_24px_rgba(0,0,0,0.5)] flex flex-col">
        <div class="flex items-center justify-between mb-2">
          <h3 class="text-sm font-medium text-base-content/90">Share this model</h3>
          <button data-ref="close-btn" class="btn btn-ghost btn-square btn-xs text-base-content/60" title="Close">
            <span class="[&>svg]:size-4">${ICON_CLOSE}</span>
          </button>
        </div>
        <div data-ref="confirm-stage" class="flex flex-col min-h-0">
          <p class="text-[13px] text-base-content/80 leading-snug">
            <span data-ref="file" class="font-medium"></span> will be shared publicly: anyone with the link
            will be able to see the model and its source code.
          </p>
          <div class="text-[11px] uppercase tracking-wide text-base-content/50 mt-3 mb-1">Files in the link</div>
          <div data-ref="files" class="overflow-y-auto max-h-[36vh] border border-base-content/10 rounded-md divide-y divide-base-content/[0.06]"></div>
          <p class="text-[13px] text-base-content/60 leading-snug mt-3">
            Confirm to open it in the FluidCAD viewer; the link it opens is the one to share.
          </p>
          <div data-ref="status" class="text-xs text-error min-h-4 mt-3"></div>
          <div class="flex items-center justify-end gap-2 pt-1">
            <button data-ref="cancel-btn" class="btn btn-ghost btn-sm">Cancel</button>
            <button data-ref="share-btn" class="btn btn-primary btn-sm" disabled>Share</button>
          </div>
        </div>
        <div data-ref="link-stage" class="flex flex-col min-h-0 hidden">
          <p class="text-[13px] text-base-content/80 leading-snug">
            The viewer is opening in a new tab. If nothing opened, your browser blocked the tab: use Open below.
          </p>
          <a data-ref="link" target="_blank" rel="noopener" class="block mt-3 px-2 py-1.5 rounded-md border border-base-content/10 bg-base-content/[0.04] font-mono text-[11px] text-base-content/70 truncate"></a>
          <div class="flex items-center justify-end gap-2 pt-4">
            <button data-ref="copy-btn" class="btn btn-ghost btn-sm"><span data-ref="copy-label">Copy link</span></button>
            <a data-ref="open-link" target="_blank" rel="noopener" class="btn btn-primary btn-sm">Open in viewer</a>
          </div>
        </div>
      </div>
    `;
    container.appendChild(this.overlay);
    const ref = <T extends Element>(name: string) => this.overlay.querySelector<T>(`[data-ref="${name}"]`)!;
    this.confirmStage = ref<HTMLDivElement>('confirm-stage');
    this.linkStage = ref<HTMLDivElement>('link-stage');
    this.fileEl = ref<HTMLSpanElement>('file');
    this.filesEl = ref<HTMLDivElement>('files');
    this.statusEl = ref<HTMLDivElement>('status');
    this.shareBtn = ref<HTMLButtonElement>('share-btn');
    this.linkEl = ref<HTMLAnchorElement>('link');
    this.openLink = ref<HTMLAnchorElement>('open-link');
    this.copyBtn = ref<HTMLButtonElement>('copy-btn');
    this.copyLabel = ref<HTMLSpanElement>('copy-label');

    ref('close-btn').addEventListener('click', () => this.hide());
    ref('cancel-btn').addEventListener('click', () => this.hide());
    this.shareBtn.addEventListener('click', () => this.share());
    this.copyBtn.addEventListener('click', () => void this.copy());
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
    this.generation += 1;
    this.link = null;
    this.confirmStage.classList.remove('hidden');
    this.linkStage.classList.add('hidden');
    this.fileEl.textContent = absPath ? absPath.split('/').pop() ?? absPath : 'This model';
    this.shareBtn.disabled = true;
    this.filesEl.innerHTML = '';
    this.overlay.classList.remove('hidden');
    if (!absPath) {
      this.statusEl.textContent = 'No model is rendered yet.';
      return;
    }
    this.statusEl.textContent = '';
    this.setFilesNote('Collecting files…');
    void this.collect(this.generation);
  }

  hide(): void {
    this.overlay.classList.add('hidden');
  }

  private async collect(generation: number): Promise<void> {
    let share: ShareFiles;
    let link: string;
    try {
      share = await getShareFiles();
      link = await buildViewerLink(share);
    } catch (err: any) {
      if (generation === this.generation) {
        this.filesEl.innerHTML = '';
        this.statusEl.textContent = err?.message ?? String(err);
      }
      return;
    }
    if (generation !== this.generation) {
      return;
    }
    this.renderFiles(share);
    const problem = linkSizeProblem(link);
    if (problem) {
      this.statusEl.textContent = problem;
      return;
    }
    this.link = link;
    this.shareBtn.disabled = false;
  }

  private renderFiles(share: ShareFiles): void {
    this.filesEl.innerHTML = '';
    const paths = Object.keys(share.files).sort((a, b) => (a === share.entry ? -1 : b === share.entry ? 1 : a.localeCompare(b)));
    for (const path of paths) {
      const kind = classifyShareFile(path);
      const row = document.createElement('div');
      row.className = 'px-2 py-1 text-[12px] flex flex-col';
      const name = document.createElement('span');
      name.className = kind === 'data' ? 'font-mono text-warning' : 'font-mono text-base-content/80';
      name.textContent = path;
      row.appendChild(name);
      const note = KIND_NOTE[kind];
      if (note) {
        const noteEl = document.createElement('span');
        noteEl.className = kind === 'data' ? 'text-[11px] text-warning/80' : 'text-[11px] text-base-content/50';
        noteEl.textContent = note;
        row.appendChild(noteEl);
      }
      this.filesEl.appendChild(row);
    }
  }

  private setFilesNote(text: string): void {
    this.filesEl.innerHTML = '';
    const note = document.createElement('div');
    note.className = 'px-2 py-1.5 text-[12px] text-base-content/50';
    note.textContent = text;
    this.filesEl.appendChild(note);
  }

  /** Synchronous on purpose: the open has to happen inside the click for popup blockers to allow it. */
  private share(): void {
    if (!this.link) {
      return;
    }
    const url = this.link;
    this.linkEl.href = url;
    this.linkEl.textContent = url;
    this.openLink.href = url;
    this.copyLabel.textContent = 'Copy link';
    this.confirmStage.classList.add('hidden');
    this.linkStage.classList.remove('hidden');
    window.open(url, '_blank', 'noopener');
  }

  private async copy(): Promise<void> {
    if (!this.link) {
      return;
    }
    try {
      await navigator.clipboard.writeText(this.link);
      this.copyLabel.textContent = 'Copied!';
    } catch {
      this.copyLabel.textContent = 'Copy failed';
    }
    setTimeout(() => { this.copyLabel.textContent = 'Copy link'; }, 1500);
  }
}
