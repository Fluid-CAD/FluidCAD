import { ChatIcons } from '../chat-icons';
import type { ChatPart, NoticePart } from '../chat-types';
import { localizeIsoInstants, resetsText } from '../time-format';
import type { PartView } from './part-view';

/** The notice's words with its reset time in local time ("… It resets in 3 h, at 17:00."). */
export function noticeText(part: NoticePart, now: Date = new Date()): string {
  // Older notices carry the instant in the words.
  const text = localizeIsoInstants(part.text, now);
  const resets = part.resetsAt ? resetsText(part.resetsAt, now) : null;
  return resets ? `${text} It ${resets}.` : text;
}

/**
 * A line from the runtime: stopped, a plan limit (with when it resets, in
 * the user's own time), a sign-in problem, a restart.
 */
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
    words.textContent = noticeText(part);
    if (part.resetsAt) {
      words.title = new Date(part.resetsAt).toLocaleString();
    }
    this.el.replaceChildren(ChatIcons.span(icon, '[&>svg]:size-3.5 mt-px'), words);
  }
}
