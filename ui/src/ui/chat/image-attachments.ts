// Images attached to a chat message: pasted into the message box, dropped
// on the panel, or picked from disk (a drawing, a photo, a screenshot).
//
// Each is made ready as it is added ({@link prepareImage}): an image the
// agents take as it is goes untouched; a larger one, or one in another
// format the browser reads (SVG, BMP, AVIF), is drawn again to fit. What is
// sent is `SendMessage.attachments`; the engine checks each again by its
// bytes (`parseSendMessage`).
//
// An attached image can be drawn on before it goes ({@link ImageAnnotator},
// docs/agent-chat-plan.md §28): the marked-up picture takes its place.

import { ChatIcons } from './chat-icons';
import type { AttachmentMediaType, MessageAttachment } from './chat-types';
import { markupName } from './markup';
import { blobToBase64 } from './scene-references';

/** Images one message may carry (the engine's `MAX_ATTACHMENTS`). */
export const MAX_ATTACHMENTS = 8;
/** The largest image sent (the engine's `MAX_ATTACHMENT_BYTES`: its base64 stays within the 5 MB the Anthropic API takes per image). */
export const MAX_ATTACHMENT_BYTES = 3_500_000;
/**
 * The longest edge sent, in pixels. A request with many images (a long chat
 * with screenshots) is refused over 2000 px by the Anthropic API, and the
 * models scale a larger image down themselves.
 */
export const MAX_IMAGE_EDGE_PX = 2000;

/** An image as it is sent. */
export type PreparedImage = { blob: Blob; mediaType: AttachmentMediaType };

/** Makes `file` an image a message can carry; rejects when it is not an image the browser reads. */
export type ImagePreparer = (file: Blob) => Promise<PreparedImage>;

/** The image type `head` (a file's first 12 bytes) starts as, by signature; null for anything else. */
export function sniffImageType(head: Uint8Array): AttachmentMediaType | null {
  const text = String.fromCharCode(...head.subarray(0, 12));
  if (text.startsWith('\x89PNG\r\n\x1a\n')) {
    return 'image/png';
  }
  if (text.startsWith('\xff\xd8\xff')) {
    return 'image/jpeg';
  }
  if (text.startsWith('GIF87a') || text.startsWith('GIF89a')) {
    return 'image/gif';
  }
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/**
 * The size an image of `width` × `height` is sent at: as it is when its
 * longest edge is within {@link MAX_IMAGE_EDGE_PX}, else scaled to it.
 */
export function fitImageSize(width: number, height: number, maxEdge = MAX_IMAGE_EDGE_PX): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * The browser's {@link ImagePreparer}. A PNG, JPEG, WebP or GIF within the
 * limits goes as it is (its type read from its bytes, whatever the file is
 * called). Anything else the browser can show is drawn to a canvas at
 * {@link fitImageSize}: as a PNG when that fits (line art, screenshots and
 * transparency stay exact), else as a JPEG on white, coarser and then
 * smaller until it fits.
 */
export const prepareImage: ImagePreparer = async (file) => {
  const type = sniffImageType(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const natural = { width: image.naturalWidth, height: image.naturalHeight };
    if (natural.width === 0 || natural.height === 0) {
      throw new Error('The image has no size.');
    }
    let size = fitImageSize(natural.width, natural.height);
    if (type && size.width === natural.width && size.height === natural.height && file.size <= MAX_ATTACHMENT_BYTES) {
      return { blob: file, mediaType: type };
    }
    const draw = (mediaType: 'image/png' | 'image/jpeg', quality?: number): Promise<Blob> => {
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext('2d');
      if (!context) {
        throw new Error('The image could not be drawn.');
      }
      if (mediaType === 'image/jpeg') {
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, size.width, size.height);
      }
      context.drawImage(image, 0, 0, size.width, size.height);
      return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The image could not be encoded.'))), mediaType, quality);
      });
    };
    if (type !== 'image/jpeg') {
      const png = await draw('image/png');
      if (png.size <= MAX_ATTACHMENT_BYTES) {
        return { blob: png, mediaType: 'image/png' };
      }
    }
    for (;;) {
      for (const quality of [0.9, 0.8]) {
        const jpeg = await draw('image/jpeg', quality);
        if (jpeg.size <= MAX_ATTACHMENT_BYTES) {
          return { blob: jpeg, mediaType: 'image/jpeg' };
        }
      }
      if (Math.max(size.width, size.height) <= 256) {
        throw new Error('The image could not be made small enough.');
      }
      size = fitImageSize(size.width, size.height, Math.round(Math.max(size.width, size.height) * 0.75));
    }
  } finally {
    URL.revokeObjectURL(url);
  }
};

/**
 * Lets the user draw on `image` (the attached image called `name`, as it
 * would be sent): resolves with the marked-up picture, a PNG, or null when
 * they drew nothing or cancelled; rejects when the image could not be opened.
 */
export type ImageAnnotator = (image: Blob, name: string) => Promise<Blob | null>;

export type ImageAttachmentsDeps = {
  /** Defaults to {@link prepareImage} (the browser's decoder and a canvas). */
  prepare?: ImagePreparer;
  /** Mark up an attached image (the pen on its thumbnail). Absent: thumbnails have no pen. */
  annotate?: ImageAnnotator;
  /** Images were added or taken away. */
  onChange?(): void;
};

type Attached = {
  id: number;
  name: string;
  /** The thumbnail's object URL, of the file as it was added. */
  url: string;
  /** Null until it is ready. */
  image: PreparedImage | null;
  /** Settles once the image is ready, or was dropped because it could not be read. */
  ready: Promise<void>;
  /** The markup dialog is open on it. */
  annotating?: boolean;
};

/** What a send takes: the images, and their ids to clear once the engine took them. */
export type ImagesForSend = { ids: number[]; attachments: MessageAttachment[] };

/**
 * The images attached to the next message, above the message box: a
 * thumbnail each, with a button to take it away and, when the panel can
 * mark images up, a pen to draw on it; under them one line when something
 * could not be attached (not an image, too many) or will not reach the model
 * (it does not take images).
 *
 * `el` (`data-ref="image-attachments"`) hides itself while it has nothing to
 * show.
 */
export class ImageAttachments {
  readonly el: HTMLDivElement;
  private readonly thumbs: HTMLDivElement;
  private readonly noticeEl: HTMLDivElement;
  private readonly prepare: ImagePreparer;
  private items: Attached[] = [];
  private nextId = 1;
  /** Why the last add left something out; cleared by the next change. */
  private notice = '';
  private modelTakesImages = true;

  constructor(private readonly deps: ImageAttachmentsDeps = {}) {
    this.prepare = deps.prepare ?? prepareImage;
    this.el = document.createElement('div');
    this.el.className = 'chat-attach';
    this.el.dataset.ref = 'image-attachments';
    this.thumbs = document.createElement('div');
    this.thumbs.className = 'chat-attach-images';
    this.thumbs.dataset.ref = 'image-thumbs';
    this.noticeEl = document.createElement('div');
    this.noticeEl.className = 'chat-attach-notice';
    this.noticeEl.dataset.ref = 'image-notice';
    this.el.append(this.thumbs, this.noticeEl);
    this.paint();
  }

  /** How many images the next message carries (those still being made ready too). */
  get size(): number {
    return this.items.length;
  }

  /** Whether the next message already carries all the images one takes. */
  get full(): boolean {
    return this.items.length >= MAX_ATTACHMENTS;
  }

  /** Say `notice` under the thumbnails (why something was not attached), until the next change. */
  say(notice: string): void {
    this.notice = notice;
    this.paint();
  }

  /**
   * Attach `files`: the images among them, up to {@link MAX_ATTACHMENTS} in
   * all. What is left out is said under the thumbnails.
   */
  add(files: Iterable<File>): void {
    const all = [...files];
    const images = all.filter((file) => file.type.startsWith('image/'));
    const room = MAX_ATTACHMENTS - this.items.length;
    this.notice = images.length > room
      ? `A message takes at most ${MAX_ATTACHMENTS} images.`
      : images.length < all.length
        ? 'Only images can be attached.'
        : '';
    for (const file of images.slice(0, Math.max(0, room))) {
      this.attach(file);
    }
    this.changed();
  }

  /** Take `item` away (the × on its thumbnail). */
  private remove(item: Attached): void {
    if (this.items.includes(item)) {
      this.drop(item);
      this.notice = '';
      this.changed();
    }
  }

  /**
   * Draw on `item` (the pen on its thumbnail): the marked-up picture takes
   * its place in the row, under its name ending in `-markup.png`, and is
   * made ready like any image added. Nothing changes when the user cancels
   * or draws nothing.
   */
  private async annotate(item: Attached): Promise<void> {
    const annotate = this.deps.annotate;
    if (!annotate || !item.image || item.annotating) {
      return;
    }
    item.annotating = true;
    let marked: Blob | null = null;
    try {
      marked = await annotate(item.image.blob, item.name);
    } catch {
      if (this.items.includes(item)) {
        this.notice = `${item.name} could not be opened to mark up.`;
        this.changed();
      }
      return;
    } finally {
      item.annotating = false;
    }
    if (!marked || !this.items.includes(item)) {
      return;
    }
    const file = new File([marked], markupName(item.name), { type: 'image/png' });
    URL.revokeObjectURL(item.url);
    item.name = file.name;
    item.url = URL.createObjectURL(file);
    item.image = null;
    this.makeReady(item, file);
    this.notice = '';
    this.changed();
  }

  /** Whether the model the next message goes to takes images; when it does not, the strip says so. */
  setModelTakesImages(takes: boolean): void {
    if (this.modelTakesImages !== takes) {
      this.modelTakesImages = takes;
      this.paint();
    }
  }

  /**
   * What the next message carries, once every image is ready (one still
   * being drawn is waited for).
   */
  async forSend(): Promise<ImagesForSend> {
    await Promise.all(this.items.map((item) => item.ready));
    const ready = this.items.filter((item) => item.image !== null);
    const attachments = await Promise.all(
      ready.map(async (item): Promise<MessageAttachment> => ({
        mediaType: item.image!.mediaType,
        base64: await blobToBase64(item.image!.blob),
        name: item.name,
      })),
    );
    return { ids: ready.map((item) => item.id), attachments };
  }

  /** The engine took the message: its images leave the strip (one added since stays). */
  clearSent(ids: readonly number[]): void {
    for (const item of this.items.filter((i) => ids.includes(i.id))) {
      this.drop(item);
    }
    this.notice = '';
    this.changed();
  }

  destroy(): void {
    for (const item of [...this.items]) {
      this.drop(item);
    }
    this.el.remove();
  }

  private attach(file: File): void {
    const item: Attached = {
      id: this.nextId++,
      name: file.name || 'image',
      url: URL.createObjectURL(file),
      image: null,
      ready: Promise.resolve(),
    };
    this.makeReady(item, file);
    this.items.push(item);
  }

  /** Make `file` what `item` sends; an image that cannot be read is dropped, and said. */
  private makeReady(item: Attached, file: Blob): void {
    item.ready = this.prepare(file).then(
      (image) => {
        if (this.items.includes(item)) {
          item.image = image;
          this.paint();
        }
      },
      () => {
        if (this.items.includes(item)) {
          this.drop(item);
          this.notice = `${item.name} could not be read as an image.`;
          this.changed();
        }
      },
    );
  }

  private drop(item: Attached): void {
    this.items = this.items.filter((i) => i !== item);
    URL.revokeObjectURL(item.url);
  }

  private changed(): void {
    this.paint();
    this.deps.onChange?.();
  }

  private paint(): void {
    this.thumbs.replaceChildren(...this.items.map((item) => this.thumb(item)));
    this.thumbs.classList.toggle('hidden', this.items.length === 0);
    const notice = this.items.length > 0 && !this.modelTakesImages
      ? `This model does not take images: ${this.items.length === 1 ? 'it' : 'they'} will be left out.`
      : this.notice;
    this.noticeEl.textContent = notice;
    this.noticeEl.classList.toggle('hidden', notice === '');
    this.el.classList.toggle('hidden', this.items.length === 0 && notice === '');
  }

  private thumb(item: Attached): HTMLElement {
    const thumb = document.createElement('div');
    thumb.className = 'chat-attach-image';
    thumb.dataset.ref = 'image-thumb';
    thumb.dataset.state = item.image ? 'ready' : 'preparing';
    thumb.title = item.name;
    const img = document.createElement('img');
    img.src = item.url;
    img.alt = item.name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'chat-attach-image-remove';
    remove.dataset.ref = 'remove-image';
    remove.title = 'Remove';
    remove.setAttribute('aria-label', `Remove ${item.name}`);
    remove.innerHTML = ChatIcons.CLOSE;
    remove.addEventListener('click', () => this.remove(item));
    thumb.append(img, remove);
    if (this.deps.annotate && item.image) {
      const annotate = document.createElement('button');
      annotate.type = 'button';
      annotate.className = 'chat-attach-image-annotate';
      annotate.dataset.ref = 'annotate-image';
      annotate.title = 'Mark up';
      annotate.setAttribute('aria-label', `Mark up ${item.name}`);
      annotate.innerHTML = ChatIcons.MARKUP;
      annotate.addEventListener('click', () => void this.annotate(item));
      thumb.append(annotate);
    }
    return thumb;
  }
}
