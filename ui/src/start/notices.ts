import { ICON_CLOSE } from '../ui/icons';
import type { FeedNotification } from './host';
import { sanitizeNoticeHtml } from './sanitize-notice';

export type NoticesHandlers = {
  dismiss(id: string): void;
  openLink(url: string): void;
};

/**
 * The feed's notifications: a quiet primary-tinted strip above the projects,
 * one dismissible notice each. Bodies are remote HTML and only ever rendered
 * through {@link sanitizeNoticeHtml}; their links leave for the browser.
 */
export class Notices {
  readonly element: HTMLDivElement;

  constructor(private readonly handlers: NoticesHandlers) {
    this.element = document.createElement('div');
    this.element.className = 'hidden grid gap-2.5 mb-6';
    this.element.setAttribute('aria-label', 'Notifications');
    // The page never navigates; a notice's link opens in the browser. The
    // shell's navigation lock is the backstop, this is the path that runs.
    this.element.addEventListener('click', (event) => {
      const link = (event.target as HTMLElement).closest('a');
      if (link) {
        event.preventDefault();
        const href = link.getAttribute('href');
        if (href) {
          this.handlers.openLink(href);
        }
      }
    });
  }

  render(notifications: FeedNotification[]): void {
    this.element.replaceChildren(...notifications.map((entry) => this.notice(entry)));
    this.syncVisibility();
  }

  private notice(entry: FeedNotification): HTMLElement {
    const notice = document.createElement('div');
    notice.className =
      'relative rounded-md border border-primary/25 bg-primary/10 pl-3.5 pr-10 py-2.5 text-[13px] text-base-content select-text ' +
      '[&_p]:mb-1 [&_p:last-child]:mb-0 [&_a]:text-primary [&_a]:cursor-pointer [&_a:hover]:underline ' +
      '[&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5 [&_code]:font-mono [&_code]:text-xs';
    notice.dataset.noticeId = entry.id;
    const body = document.createElement('div');
    body.appendChild(sanitizeNoticeHtml(entry.body));

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'absolute top-1.5 right-1.5 btn btn-ghost btn-square btn-xs text-base-content/60';
    dismiss.title = 'Dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss notification');
    dismiss.innerHTML = `<span class="[&>svg]:size-3.5">${ICON_CLOSE}</span>`;
    dismiss.addEventListener('click', () => {
      notice.remove();
      this.syncVisibility();
      this.handlers.dismiss(entry.id);
    });

    notice.append(body, dismiss);
    return notice;
  }

  private syncVisibility(): void {
    this.element.classList.toggle('hidden', this.element.childElementCount === 0);
  }
}
