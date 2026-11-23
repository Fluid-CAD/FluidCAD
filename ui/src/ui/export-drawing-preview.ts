import type { ExportRequestBody } from '../api';

/** How long the options must rest before the preview asks the server for them. */
export const PREVIEW_DEBOUNCE_MS = 250;

/**
 * What the preview adds to the drawing it is handed, as CSS inside the SVG.
 * The file's lines are a fraction of a millimetre wide — right on paper,
 * invisible once a part half a metre across is fitted into the panel — so
 * here every line is one screen pixel, whatever the drawing's scale, and the
 * hidden layer's dashes are a few pixels long. A style rule outranks the
 * file's presentation attributes, so nothing of its markup has to be known
 * beyond the layer groups' ids.
 */
const DISPLAY_STYLE = '<style>'
  + '*{vector-effect:non-scaling-stroke;stroke-width:1px}'
  + '#hidden,#hidden *{stroke-dasharray:6px 4px}'
  + '</style>';

/** The panel's elements, found by the dialog in its own markup. */
export interface DrawingPreviewElements {
  /** The `<img>` the drawing is shown in. */
  image: HTMLImageElement;
  /** The one line under or over the image: loading, or why there is no preview. */
  status: HTMLElement;
}

/**
 * The export dialog's preview of a drawing (DXF, SVG): the SVG the server
 * draws for the options on screen, shown in an `<img>`.
 *
 * It asks only after the options have rested ({@link PREVIEW_DEBOUNCE_MS}),
 * and an answer is shown only while it is still the one being waited for —
 * a newer question, {@link pause} or {@link clear} discards the older answer
 * when it lands. The drawing reaches the page as an image of an object URL,
 * never as markup: what the server sent is drawn, not run. Every URL is
 * revoked when the next drawing replaces it and when the preview is cleared.
 *
 * A preview that cannot be had says so in one line and nothing more: the
 * export itself does not depend on it.
 */
export class DrawingPreview {
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by every question and every stop: an answer for an older number is dropped. */
  private sequence = 0;
  /** The object URL of the drawing on screen; null when there is none. */
  private url: string | null = null;
  /** The request the preview is showing or waiting for; null when neither. */
  private wanted: string | null = null;
  /** The request whose drawing is on screen; null when none is. */
  private shown: string | null = null;

  /**
   * `load` fetches the SVG of a request body from the engine; it rejects
   * with the reason when there is none to be had.
   */
  constructor(
    private elements: DrawingPreviewElements,
    private load: (body: ExportRequestBody) => Promise<Blob>,
  ) {
    // A file the browser cannot draw (a host that answered with something else) is no preview either.
    this.elements.image.addEventListener('error', () => {
      if (this.url !== null) {
        this.fail('the drawing could not be displayed');
      }
    });
  }

  /**
   * Preview `body`'s drawing. The one already shown or asked for is left
   * alone unless `force` says the scene behind it changed.
   */
  show(body: ExportRequestBody, force = false): void {
    const key = JSON.stringify(body);
    if (!force && key === this.wanted) {
      return;
    }
    this.wanted = key;
    const sequence = ++this.sequence;
    this.stopTimer();
    this.setLoading();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.fetch(body, key, sequence);
    }, PREVIEW_DEBOUNCE_MS);
  }

  /**
   * Stop asking — the format moved off drawings — and keep what is shown:
   * coming back to the same options needs no second request.
   */
  pause(): void {
    this.stopTimer();
    this.sequence++;
    this.wanted = this.shown;
    if (this.shown !== null) {
      this.setShown();
    }
  }

  /** Stop asking and drop the drawing: the dialog closed, or opened on something else. */
  clear(): void {
    this.stopTimer();
    this.sequence++;
    this.wanted = null;
    this.shown = null;
    this.replaceUrl(null);
    this.elements.image.classList.add('hidden');
    this.setStatus('', false);
  }

  private async fetch(body: ExportRequestBody, key: string, sequence: number): Promise<void> {
    let drawing: Blob;
    try {
      drawing = await DrawingPreview.forDisplay(await this.load(body));
    } catch (err: any) {
      if (sequence === this.sequence) {
        this.fail(err?.message ?? String(err));
      }
      return;
    }
    if (sequence !== this.sequence) {
      return;
    }
    let url: string;
    try {
      url = URL.createObjectURL(drawing);
    } catch (err: any) {
      this.fail(err?.message ?? String(err));
      return;
    }
    this.replaceUrl(url);
    this.shown = key;
    this.elements.image.src = url;
    this.setShown();
  }

  /**
   * The drawing with {@link DISPLAY_STYLE} added right after its root tag —
   * text in, text out; it is never parsed into this page. A file with no
   * `<svg` root to add it to is handed on as it came.
   */
  private static async forDisplay(drawing: Blob): Promise<Blob> {
    const text = await drawing.text();
    const root = text.indexOf('<svg');
    const end = root === -1 ? -1 : text.indexOf('>', root);
    if (end === -1 || text[end - 1] === '/') {
      return drawing;
    }
    return new Blob([text.slice(0, end + 1), DISPLAY_STYLE, text.slice(end + 1)], { type: 'image/svg+xml' });
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private replaceUrl(url: string | null): void {
    if (this.url !== null) {
      URL.revokeObjectURL(this.url);
    }
    this.url = url;
    if (url === null) {
      this.elements.image.removeAttribute('src');
    }
  }

  /** Waiting for a drawing: the one on screen, if any, stays, dimmed. */
  private setLoading(): void {
    this.elements.image.classList.toggle('opacity-40', this.shown !== null);
    this.setStatus(this.shown === null ? 'Loading preview…' : 'Updating…', false);
  }

  private setShown(): void {
    this.elements.image.classList.remove('hidden', 'opacity-40');
    this.setStatus('', false);
  }

  private fail(reason: string): void {
    this.shown = null;
    this.replaceUrl(null);
    this.elements.image.classList.add('hidden');
    this.elements.image.classList.remove('opacity-40');
    this.setStatus(`Preview unavailable: ${reason}`, true);
  }

  private setStatus(message: string, failed: boolean): void {
    const { status } = this.elements;
    status.textContent = message;
    // One line, whatever the reason's length; the whole of it on hover.
    status.title = failed ? message : '';
    status.classList.toggle('hidden', message === '');
    status.classList.toggle('text-red-700', failed);
    status.classList.toggle('text-black/50', !failed);
  }
}
