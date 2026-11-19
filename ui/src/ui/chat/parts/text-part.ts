import { createMarkdownStream, type MarkdownStream } from '../markdown-stream';
import type { ChatPart, TextPart } from '../chat-types';
import type { PartContext, PartView } from './part-view';

/**
 * An answer's text, rendered as streaming markdown: each delta is written
 * on; nothing already on screen is rendered again. `live` false (a message
 * that already ended) renders and closes at once.
 */
export class TextPartView implements PartView {
  readonly el: HTMLDivElement;
  private stream: MarkdownStream;
  private written = '';
  private settled = false;

  constructor(part: TextPart, private readonly ctx: PartContext, live: boolean) {
    this.el = document.createElement('div');
    this.el.className = 'chat-md';
    this.el.dataset.part = 'text';
    this.stream = this.newStream();
    this.write(part.text);
    if (!live) {
      this.settle();
    }
  }

  appendText(delta: string): void {
    this.write(delta);
  }

  update(part: ChatPart): void {
    if (part.type !== 'text') {
      return;
    }
    if (part.text === this.written) {
      return;
    }
    if (!this.settled && part.text.startsWith(this.written)) {
      this.write(part.text.slice(this.written.length));
      return;
    }
    // Rewritten rather than extended (or extended after it closed): render it again.
    this.el.replaceChildren();
    this.written = '';
    this.stream = this.newStream();
    this.write(part.text);
    if (this.settled) {
      this.stream.end();
    }
  }

  settle(): void {
    if (!this.settled) {
      this.settled = true;
      this.stream.end();
    }
  }

  private write(text: string): void {
    if (text === '') {
      return;
    }
    this.written += text;
    this.stream.write(text);
  }

  private newStream(): MarkdownStream {
    return createMarkdownStream(this.el, {
      openLink: (url) => this.ctx.openLink(url),
      colorizer: () => this.ctx.colorizer(),
    });
  }
}
