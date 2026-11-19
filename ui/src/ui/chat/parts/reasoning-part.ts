import { ChatIcons } from '../chat-icons';
import { createMarkdownStream, type MarkdownStream } from '../markdown-stream';
import type { ChatPart, ReasoningPart } from '../chat-types';
import type { PartContext, PartView } from './part-view';

/**
 * The agent's thinking, as the CLI streams it (summarised). Open while it
 * streams, under "Thinking…"; it folds away to "Thought" once the answer
 * (or anything else) starts after it, and opens again on a click. Thinking
 * with no text (the CLI sent none) is only the line, with nothing to open.
 */
export class ReasoningPartView implements PartView {
  readonly el: HTMLDivElement;
  private readonly toggle: HTMLButtonElement;
  private readonly label: HTMLSpanElement;
  private readonly chevron: HTMLSpanElement;
  private readonly body: HTMLDivElement;
  private stream: MarkdownStream;
  private written = '';
  private live: boolean;
  private expanded: boolean;
  /** The user opened or closed it: settling no longer folds it. */
  private touched = false;

  constructor(part: ReasoningPart, private readonly ctx: PartContext, live: boolean) {
    this.live = live;
    this.expanded = live;
    this.el = document.createElement('div');
    this.el.className = 'chat-reasoning';
    this.el.dataset.part = 'reasoning';

    this.toggle = document.createElement('button');
    this.toggle.type = 'button';
    this.toggle.dataset.ref = 'toggle';
    this.toggle.className = 'chat-reasoning-toggle';
    this.toggle.appendChild(ChatIcons.span(ChatIcons.THINKING, '[&>svg]:size-3.5'));
    this.label = document.createElement('span');
    this.chevron = ChatIcons.span(ChatIcons.CHEVRON_RIGHT, '[&>svg]:size-3 chat-chevron');
    this.toggle.append(this.label, this.chevron);
    this.toggle.addEventListener('click', () => {
      if (this.written === '') {
        return;
      }
      this.touched = true;
      this.expanded = !this.expanded;
      this.paint();
    });

    this.body = document.createElement('div');
    this.body.className = 'chat-reasoning-body chat-md';
    this.stream = this.newStream();
    this.el.append(this.toggle, this.body);
    this.write(part.text);
    if (!live) {
      this.stream.end();
    }
    this.paint();
  }

  get isExpanded(): boolean {
    return this.expanded;
  }

  appendText(delta: string): void {
    this.write(delta);
    this.paint();
  }

  update(part: ChatPart): void {
    if (part.type !== 'reasoning' || part.text === this.written) {
      return;
    }
    if (this.live && part.text.startsWith(this.written)) {
      this.write(part.text.slice(this.written.length));
    } else {
      this.body.replaceChildren();
      this.written = '';
      this.stream = this.newStream();
      this.write(part.text);
      if (!this.live) {
        this.stream.end();
      }
    }
    this.paint();
  }

  settle(): void {
    if (!this.live) {
      return;
    }
    this.live = false;
    this.stream.end();
    if (!this.touched) {
      this.expanded = false;
    }
    this.paint();
  }

  private paint(): void {
    const empty = this.written === '';
    this.label.textContent = this.live ? 'Thinking…' : 'Thought';
    this.el.classList.toggle('chat-reasoning-live', this.live);
    this.chevron.classList.toggle('hidden', empty);
    this.chevron.classList.toggle('rotate-90', this.expanded && !empty);
    this.toggle.setAttribute('aria-expanded', String(this.expanded && !empty));
    this.toggle.disabled = empty && !this.live;
    this.body.classList.toggle('hidden', !this.expanded || empty);
    // Thinking the CLI sent no words for says nothing once it is over.
    this.el.classList.toggle('hidden', empty && !this.live);
  }

  private write(text: string): void {
    if (text !== '') {
      this.written += text;
      this.stream.write(text);
    }
  }

  private newStream(): MarkdownStream {
    return createMarkdownStream(this.body, {
      openLink: (url) => this.ctx.openLink(url),
      colorizer: () => this.ctx.colorizer(),
    });
  }
}
