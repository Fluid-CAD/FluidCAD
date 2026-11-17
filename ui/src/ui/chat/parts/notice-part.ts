import { ChatIcons } from '../chat-icons';
import type { ChatPart, NoticePart } from '../chat-types';
import type { PartView } from './part-view';

/** A line from the runtime: stopped, a rate limit, a sign-in problem, a restart. */
export class NoticePartView implements PartView {
  readonly el: HTMLDivElement;

  constructor(part: NoticePart) {
    this.el = document.createElement('div');
    this.el.dataset.part = 'notice';
    this.update(part);
  }

  update(part: ChatPart): void {
    if (part.type !== 'notice') {
      return;
    }
    this.el.className = `chat-notice chat-notice-${part.level}`;
    this.el.dataset.level = part.level;
    const icon = part.level === 'error' ? ChatIcons.ERROR : part.level === 'warning' ? ChatIcons.WARNING : ChatIcons.INFO;
    const words = document.createElement('span');
    words.className = 'min-w-0 break-words whitespace-pre-wrap';
    words.textContent = part.text;
    this.el.replaceChildren(ChatIcons.span(icon, '[&>svg]:size-3.5 mt-px'), words);
  }
}
