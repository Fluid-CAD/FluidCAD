import type { ChatPart, ImagePart } from '../chat-types';
import type { PartContext, PartView } from './part-view';

/** An image a message carries (the references capture), from the session's `files/`. */
export class ImagePartView implements PartView {
  readonly el: HTMLDivElement;
  private readonly img: HTMLImageElement;

  constructor(part: ImagePart, private readonly ctx: PartContext) {
    this.el = document.createElement('div');
    this.el.className = 'chat-image';
    this.el.dataset.part = 'image';
    this.img = document.createElement('img');
    this.img.alt = 'The attached capture';
    this.img.loading = 'lazy';
    this.el.append(this.img);
    this.update(part);
  }

  update(part: ChatPart): void {
    if (part.type === 'image') {
      this.img.src = this.ctx.fileUrl(part.file);
    }
  }
}
