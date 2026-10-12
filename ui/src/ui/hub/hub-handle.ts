/**
 * A publisher's handle as a control (H11 follow-up 2, the user's request of
 * 2026-10-12): `@acme` wherever the Hub panel shows a handle (a result's
 * scope, a package's byline, the signed-in account) lists that publisher's
 * packages, which is the search for `@acme`.
 *
 * It is a real button, so Tab reaches it and Enter or Space presses it, and
 * its click stops at it: a result row around it doesn't open its package
 * as well. Only a handle the hub could have issued (HD6's grammar) is made
 * a control; anything else stays text.
 */
export class HubHandle {
  /** The hub's handle grammar (HD6): lowercase letters, digits and single dashes, starting with a letter. */
  static readonly PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

  static isHandle(handle: string): boolean {
    return HubHandle.PATTERN.test(handle) && handle.length >= 2 && handle.length <= 39;
  }

  /**
   * `@handle` as a button that calls `onPublisher(handle)`; the look comes
   * from `className` (the surrounding text's size and tone), with the
   * link's underline on hover and focus.
   */
  static button(handle: string, onPublisher: (handle: string) => void, options: { className?: string; label?: Node[] } = {}): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.ref = 'publisher';
    button.dataset.handle = handle;
    button.className = `link link-hover hover:text-primary focus-visible:text-primary ${options.className ?? ''}`.trim();
    button.title = `Show @${handle}’s packages`;
    button.setAttribute('aria-label', `Show @${handle}’s packages`);
    button.append(...(options.label ?? [`@${handle}`]));
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onPublisher(handle);
    });
    return button;
  }

  /** The handle a full name is published under: `@acme/kit` → `acme`; null when it has no valid scope. */
  static scopeOf(fullName: string): string | null {
    const match = /^@([^/]+)\//.exec(fullName);
    return match && HubHandle.isHandle(match[1]) ? match[1] : null;
  }
}
