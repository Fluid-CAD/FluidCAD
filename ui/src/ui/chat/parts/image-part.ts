import type { ChatPart, ImagePart } from '../chat-types';
import type { PartContext, PartView } from './part-view';

/**
 * An image a message carries, from the session's `files/`: the references
 * capture, or an image the user attached (`part.name`: a thumbnail under
 * its file name; a click shows it in full, another makes it small again).
 */
export class ImagePartView implements PartView {
  readonly el: HTMLDivElement;
  private readonly img: HTMLImageElement;

  constructor(part: ImagePart, private readonly ctx: PartContext) {
    this.el = document.createElement('div');
    this.el.className = 'chat-image';
    this.el.dataset.part = 'image';
    this.img = document.createElement('img');
    this.img.loading = 'lazy';
    this.img.addEventListener('click', () => {
      if (this.el.dataset.kind === 'attached') {
        this.el.classList.toggle('chat-image-full');
      }
    });
    this.el.append(this.img);
    this.update(part);
  }

  update(part: ChatPart): void {
    if (part.type === 'image') {
      this.el.dataset.kind = part.name === undefined ? 'capture' : 'attached';
      this.img.alt = part.name ?? 'The attached capture';
      this.img.title = part.name ?? '';
      this.img.src = this.ctx.fileUrl(part.file);
    }
  }
}
