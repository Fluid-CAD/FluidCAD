import type { ChatEvent, ChatMessage, ChatPart } from './chat-types';
import { ImagePartView } from './parts/image-part';
import { NoticePartView } from './parts/notice-part';
import { ParamsPartView } from './parts/params-part';
import type { PartContext, PartView } from './parts/part-view';
import { QuestionPartView } from './parts/question-part';
import { ReasoningPartView } from './parts/reasoning-part';
import { ReferencesPartView } from './parts/references-part';
import { TextPartView } from './parts/text-part';
import { ToolPartView } from './parts/tool-part';
import { VariantsPartView } from './parts/variants-part';

/** Within this many pixels of the end counts as "at the bottom". */
const STICK_SLACK_PX = 32;

/**
 * The messages of the session on screen, part by part (§10.3). A full
 * {@link render} builds them from a snapshot; every later event is applied
 * in place ({@link apply}), so a streaming answer grows without the rest
 * being touched. While content arrives it stays scrolled to the end —
 * unless the user scrolled up to read, until they come back down.
 */
export class ChatTranscript {
  readonly el: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly activity: HTMLDivElement;
  private readonly activityText: HTMLSpanElement;
  private readonly views = new Map<string, MessageView>();
  private stick = true;
  private readonly resizeObserver: ResizeObserver | null;

  constructor(private readonly ctx: PartContext) {
    this.el = document.createElement('div');
    this.el.className = 'chat-transcript';
    this.el.dataset.ref = 'transcript';
    this.list = document.createElement('div');
    this.list.className = 'chat-messages';
    this.list.dataset.ref = 'messages';

    this.activity = document.createElement('div');
    this.activity.className = 'chat-activity hidden';
    this.activity.dataset.ref = 'activity';
    const spinner = document.createElement('span');
    spinner.className = 'loading loading-dots loading-xs';
    this.activityText = document.createElement('span');
    this.activity.append(spinner, this.activityText);

    this.el.append(this.list, this.activity);
    this.el.addEventListener('scroll', () => {
      this.stick = this.distanceFromBottom() <= STICK_SLACK_PX;
    });
    this.resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.follow()) : null;
    this.resizeObserver?.observe(this.list);
  }

  get isEmpty(): boolean {
    return this.views.size === 0;
  }

  /** Whether it follows new content (the user has not scrolled up). */
  get sticking(): boolean {
    return this.stick;
  }

  /** Everything again, from a snapshot. `liveMessageId`: the message still streaming, if any. */
  render(messages: readonly ChatMessage[], liveMessageId: string | null): void {
    this.disposeViews();
    this.list.replaceChildren();
    this.views.clear();
    for (const message of messages) {
      const view = new MessageView(message, this.ctx, message.id === liveMessageId);
      this.views.set(message.id, view);
      this.list.append(view.el);
    }
    this.stick = true;
    this.follow();
  }

  /** One event, already folded into `messages` (the session's transcript after it). */
  apply(event: ChatEvent, messages: readonly ChatMessage[]): void {
    switch (event.type) {
      case 'message-start': {
        if (this.views.has(event.message.id)) {
          return;
        }
        const message = messages.find((m) => m.id === event.message.id);
        if (!message) {
          return;
        }
        if (message.role === 'user') {
          // The user's own message (from this tab or another): follow it down.
          this.stick = true;
        }
        const view = new MessageView(message, this.ctx, true);
        this.views.set(message.id, view);
        this.list.append(view.el);
        break;
      }
      case 'part-start': {
        const view = this.views.get(event.messageId);
        const part = findPart(messages, event.messageId, event.part.id);
        if (view && part) {
          view.addPart(part);
        }
        break;
      }
      case 'part-delta':
        this.views.get(event.messageId)?.part(event.partId)?.appendText?.(event.text);
        break;
      case 'part-update': {
        const part = findPart(messages, event.messageId, event.partId);
        if (part) {
          this.views.get(event.messageId)?.part(event.partId)?.update(part);
        }
        break;
      }
      case 'message-end':
        this.views.get(event.messageId)?.end();
        break;
      default:
        return;
    }
    this.follow();
  }

  /** Close every message still streaming (the turn ended without its message-end). */
  settleAll(): void {
    for (const view of this.views.values()) {
      view.end();
    }
  }

  /** The line under the last message while a turn runs ("Working…"); null hides it. */
  setActivity(text: string | null): void {
    this.activity.classList.toggle('hidden', text === null);
    this.activityText.textContent = text ?? '';
    this.follow();
  }

  /** The view of a message (tests; the panel puts each turn's revert action under its user message). */
  messageView(id: string): MessageView | undefined {
    return this.views.get(id);
  }

  scrollToBottom(): void {
    this.stick = true;
    this.follow();
  }

  /** The panel is closing: what a card put outside the panel (a variant, or a change waiting for approval, shown in the viewport) is taken back. */
  releaseOverlays(): void {
    for (const view of this.views.values()) {
      view.releaseOverlays();
    }
  }

  destroy(): void {
    this.disposeViews();
    this.resizeObserver?.disconnect();
  }

  private disposeViews(): void {
    for (const view of this.views.values()) {
      view.dispose();
    }
  }

  private follow(): void {
    if (this.stick) {
      this.el.scrollTop = this.el.scrollHeight;
    }
  }

  private distanceFromBottom(): number {
    return this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight;
  }
}

function findPart(messages: readonly ChatMessage[], messageId: string, partId: string): ChatPart | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].id === messageId) {
      return messages[i].parts.find((p) => p.id === partId);
    }
  }
  return undefined;
}

/**
 * One message: a user's (a bubble on the right: their words as typed, the
 * images they attached in one row, the references, the capture) or the agent's (full width: text, thinking, tool
 * cards, notices). A live message settles each part when the next starts,
 * and all of them when it ends.
 *
 * `actions` (`data-ref="actions"`, under a user message) holds what the
 * panel offers for the turn: Revert this turn, the Reverted marker, the
 * revert's outcome. Phase 6's reference chips are the `references` part.
 */
export class MessageView {
  readonly el: HTMLDivElement;
  /** Under a user message: the turn's actions (Revert this turn), filled by the panel. */
  readonly actions: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly parts = new Map<string, PartView>();
  private last: PartView | null = null;
  private live: boolean;

  constructor(readonly message: ChatMessage, private readonly ctx: PartContext, live: boolean) {
    this.live = live;
    this.el = document.createElement('div');
    this.el.className = message.role === 'user' ? 'chat-message chat-message-user' : 'chat-message chat-message-assistant';
    this.el.dataset.role = message.role;
    this.el.dataset.messageId = message.id;
    this.body = document.createElement('div');
    this.body.className = message.role === 'user' ? 'chat-user-bubble' : 'chat-assistant-body';
    this.actions = document.createElement('div');
    this.actions.className = 'chat-message-actions';
    this.actions.dataset.ref = 'actions';
    this.el.append(this.body, this.actions);
    for (const part of message.parts) {
      this.addPart(part);
    }
    if (!live) {
      this.end();
    }
  }

  part(id: string): PartView | undefined {
    return this.parts.get(id);
  }

  get partCount(): number {
    return this.parts.size;
  }

  addPart(part: ChatPart): void {
    if (this.parts.has(part.id)) {
      return;
    }
    // Whatever streamed before is done once something follows it.
    this.last?.settle?.();
    const view = this.createView(part);
    this.parts.set(part.id, view);
    this.last = view;
    if (part.type === 'image' && part.name !== undefined) {
      // The images the user attached sit side by side, wrapping.
      this.attachedRow().append(view.el);
    } else {
      this.body.append(view.el);
    }
  }

  /** The row of attached images the message ends with, made when its first image comes. */
  private attachedRow(): HTMLElement {
    const last = this.body.lastElementChild;
    if (last instanceof HTMLElement && last.classList.contains('chat-images')) {
      return last;
    }
    const row = document.createElement('div');
    row.className = 'chat-images';
    row.dataset.ref = 'attached-images';
    this.body.append(row);
    return row;
  }

  end(): void {
    this.live = false;
    for (const view of this.parts.values()) {
      view.settle?.();
    }
  }

  /** See {@link ChatTranscript.releaseOverlays}. */
  releaseOverlays(): void {
    for (const view of this.parts.values()) {
      if (view instanceof VariantsPartView || view instanceof ToolPartView) {
        view.hideGhost();
      }
    }
  }

  dispose(): void {
    for (const view of this.parts.values()) {
      view.dispose?.();
    }
  }

  private createView(part: ChatPart): PartView {
    switch (part.type) {
      case 'text':
        return this.message.role === 'user' ? new UserTextView(part.text) : new TextPartView(part, this.ctx, this.live);
      case 'reasoning':
        return new ReasoningPartView(part, this.ctx, this.live);
      case 'tool':
        return new ToolPartView(part, this.ctx);
      case 'question':
        return new QuestionPartView(part, this.ctx);
      case 'variants':
        return new VariantsPartView(part, this.ctx);
      case 'params':
        return new ParamsPartView(part, this.ctx);
      case 'notice':
        return new NoticePartView(part);
      case 'image':
        return new ImagePartView(part, this.ctx);
      case 'references':
        return new ReferencesPartView(part);
    }
  }
}

/** A user's words, as typed: never markdown. */
class UserTextView implements PartView {
  readonly el: HTMLDivElement;

  constructor(text: string) {
    this.el = document.createElement('div');
    this.el.className = 'chat-user-text';
    this.el.dataset.part = 'text';
    this.el.textContent = text;
  }

  update(part: ChatPart): void {
    if (part.type === 'text') {
      this.el.textContent = part.text;
    }
  }

  appendText(delta: string): void {
    this.el.textContent += delta;
  }
}
