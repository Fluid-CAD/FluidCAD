import type { HubClient, HubLoginState, HubStatus } from '../../api';
import { HubHandle } from './hub-handle';
import { HubIcons } from './hub-icons';
import type { HubTimers } from './hub-panel-state';

export type HubAccountDeps = {
  hub: HubClient;
  /** Open a web page in the user's browser, through the host. */
  openExternal(url: string): void;
  /** The signed-in handle was clicked: list that publisher's packages. */
  onPublisher(handle: string): void;
  /** A sign-in finished: the panel reads the status again (which names the handle). */
  onSignedIn(handle: string | null): void;
  /** The hub's host for sentences (`hub.fluidcad.io`), once the status is known. */
  hubHost(): string | null;
  /** Timers for following a sign-in (tests). */
  timers?: HubTimers;
};

type Notice = { tone: 'warning' | 'error'; text: string };

/**
 * Who the Hub panel is signed in as, and signing in from it (H11 follow-up
 * 2, the user's request of 2026-10-12). Three states in the header:
 *
 * - **Signed out:** Sign in. The engine starts `fluidcad login`'s own flow
 *   (`POST api/hub/login`) and answers the hub's authorize page, which
 *   opens in the user's browser through the host (`openExternal`: VS Code's
 *   `open-external`, `window.open` elsewhere).
 * - **Waiting:** "Signing in…" in the header, and below it "Finish signing
 *   in in your browser" with a way to open the page again (the browser
 *   didn't open, or its tab was closed) and Cancel. The engine is asked how
 *   the sign-in stands every {@link POLL_MS}; a sign-in another page
 *   started, or one still waiting after a reload, is followed the same way
 *   ({@link resume}).
 * - **Signed in:** the handle, which lists that publisher's packages
 *   ({@link HubHandle}).
 *
 * A sign-in that ends without signing in (denied in the browser, the hub
 * request's five minutes over, the hub unreachable) leaves the engine's
 * sentence below the header with Try again; a cancel just goes back to
 * Sign in.
 */
export class HubAccount {
  static readonly POLL_MS = 1000;

  /** The header's slot. */
  readonly el: HTMLSpanElement;
  /** The line under the header: the wait, or how the last sign-in ended. */
  readonly strip: HTMLDivElement;
  private readonly timers: HubTimers;
  private status: HubStatus | null = null;
  /** The sign-in this page follows while it waits; null otherwise. */
  private login: HubLoginState | null = null;
  private starting = false;
  private notice: Notice | null = null;
  private timer: unknown = null;
  private destroyed = false;

  constructor(private readonly deps: HubAccountDeps) {
    this.timers = deps.timers ?? { set: (callback, ms) => setTimeout(callback, ms), clear: (handle) => clearTimeout(handle as number) };
    this.el = document.createElement('span');
    this.el.dataset.ref = 'account';
    this.el.className = 'inline-flex items-center gap-1 text-[11px] text-base-content/45 shrink-0 min-w-0';
    this.strip = document.createElement('div');
    this.strip.dataset.ref = 'sign-in';
    this.strip.setAttribute('role', 'status');
    this.strip.className = 'hidden shrink-0 flex flex-col gap-1.5 px-3 py-2 border-b border-base-content/10 bg-base-200/60 text-xs';
    this.render();
  }

  /** The engine's `GET api/hub/status`: who the credentials name. */
  setStatus(status: HubStatus | null): void {
    this.status = status;
    this.render();
  }

  /** Whether a sign-in is being started or waits for the browser. */
  get signingIn(): boolean {
    return this.starting || this.login !== null;
  }

  /** Follow a sign-in the engine is already waiting on (started before a reload, or from another page). */
  async resume(): Promise<void> {
    if (this.signingIn) {
      return;
    }
    const answer = await this.deps.hub.loginState();
    if (answer.ok === false || !answer.login || answer.login.status !== 'pending' || this.signingIn || this.destroyed) {
      return;
    }
    this.follow(answer.login);
  }

  /** Sign in: the engine starts it, then its page opens in the browser. A second press while one waits does nothing. */
  async signIn(): Promise<void> {
    if (this.signingIn) {
      return;
    }
    this.starting = true;
    this.notice = null;
    this.render();
    const answer = await this.deps.hub.login();
    this.starting = false;
    if (this.destroyed) {
      return;
    }
    if (answer.ok === false) {
      const host = this.deps.hubHost() ?? 'the hub';
      this.notice = answer.code === 'hub-unreachable'
        ? { tone: 'error', text: `Couldn’t reach ${host}, so the sign-in didn’t start. Check the connection, then try again.` }
        : { tone: 'error', text: answer.error };
      this.render();
      return;
    }
    this.follow(answer.login);
    if (answer.login.authorizeUrl) {
      this.deps.openExternal(answer.login.authorizeUrl);
    }
  }

  /** Stop waiting. Once the browser has come back the engine finishes the exchange, and the outcome follows. */
  async cancel(): Promise<void> {
    if (!this.login) {
      return;
    }
    const answer = await this.deps.hub.cancelLogin();
    if (answer.ok === false || this.destroyed) {
      return;
    }
    if (answer.login && answer.login.id === this.login?.id && answer.login.status !== 'pending') {
      this.ended(answer.login);
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.stopPolling();
    this.el.remove();
    this.strip.remove();
  }

  // ---------------------------------------------------------------------------

  private follow(login: HubLoginState): void {
    this.login = login;
    this.notice = null;
    this.render();
    this.schedule();
  }

  private schedule(): void {
    this.stopPolling();
    this.timer = this.timers.set(() => {
      this.timer = null;
      void this.poll();
    }, HubAccount.POLL_MS);
  }

  private stopPolling(): void {
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    const following = this.login;
    if (!following || this.destroyed) {
      return;
    }
    const answer = await this.deps.hub.loginState();
    if (this.destroyed || this.login !== following) {
      return;
    }
    if (answer.ok === false || !answer.login) {
      // The engine didn't answer this time: ask again.
      this.schedule();
      return;
    }
    if (answer.login.id !== following.id) {
      // Another page started a new sign-in after this one ended: follow that one while it waits.
      if (answer.login.status === 'pending') {
        this.follow(answer.login);
      } else {
        this.login = null;
        this.render();
      }
      return;
    }
    if (answer.login.status === 'pending') {
      this.login = answer.login;
      this.schedule();
      return;
    }
    this.ended(answer.login);
  }

  private ended(login: HubLoginState): void {
    this.stopPolling();
    this.login = null;
    if (login.status === 'signed-in') {
      this.notice = null;
      this.render();
      this.deps.onSignedIn(login.handle);
      return;
    }
    this.notice = login.status === 'cancelled'
      ? null
      : { tone: login.status === 'failed' ? 'error' : 'warning', text: login.error ?? 'The sign-in didn’t finish. Nothing was saved.' };
    this.render();
  }

  // ---------------------------------------------------------------------------

  private render(): void {
    this.renderHeader();
    this.renderStrip();
  }

  private renderHeader(): void {
    this.el.replaceChildren();
    this.el.removeAttribute('title');
    this.el.dataset.state = this.signingIn ? 'waiting' : this.status?.signedIn ? 'signed-in' : this.status ? 'signed-out' : 'unknown';
    if (this.signingIn) {
      const spinner = document.createElement('span');
      spinner.className = 'loading loading-spinner loading-xs text-base-content/40';
      this.el.append(spinner, 'Signing in…');
      return;
    }
    if (!this.status) {
      return;
    }
    const host = this.deps.hubHost() ?? 'the hub';
    const signedIn = this.status.signedIn;
    if (signedIn) {
      this.el.classList.replace('text-base-content/45', 'text-base-content/65');
      this.el.appendChild(HubIcons.span(HubIcons.USER, '[&>svg]:size-3.5'));
      if (signedIn.handle && HubHandle.isHandle(signedIn.handle)) {
        this.el.appendChild(HubHandle.button(signedIn.handle, (handle) => this.deps.onPublisher(handle), { className: 'truncate' }));
      } else {
        this.el.append('Signed in');
      }
      this.el.title = `Signed in to ${host}${signedIn.handle ? ` as @${signedIn.handle}` : ''}`;
      return;
    }
    this.el.classList.replace('text-base-content/65', 'text-base-content/45');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.ref = 'sign-in-button';
    button.className = 'btn btn-ghost btn-xs gap-1 font-normal text-base-content/75';
    button.title = `Sign in to ${host} in your browser. Searching and installing work without it.`;
    button.append(HubIcons.span(HubIcons.SIGN_IN, '[&>svg]:size-3.5'), 'Sign in');
    button.addEventListener('click', () => void this.signIn());
    this.el.appendChild(button);
  }

  private renderStrip(): void {
    this.strip.replaceChildren();
    if (this.login) {
      this.strip.dataset.state = 'waiting';
      this.strip.classList.remove('hidden');
      const lead = document.createElement('span');
      lead.dataset.ref = 'sign-in-lead';
      lead.className = 'text-base-content/85';
      lead.textContent = 'Finish signing in in your browser.';
      const actions = document.createElement('span');
      actions.className = 'flex items-center gap-3 text-base-content/65';
      const again = document.createElement('button');
      again.type = 'button';
      again.dataset.ref = 'sign-in-open';
      again.className = 'link link-hover hover:text-primary';
      again.textContent = 'Open the sign-in page';
      again.title = 'If your browser didn’t open it, or you closed its tab';
      const url = this.login.authorizeUrl;
      again.addEventListener('click', () => {
        if (url) {
          this.deps.openExternal(url);
        }
      });
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.dataset.ref = 'sign-in-cancel';
      cancel.className = 'btn btn-ghost btn-xs font-normal ml-auto';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => void this.cancel());
      actions.append(again, cancel);
      this.strip.append(lead, actions);
      return;
    }
    if (this.notice) {
      this.strip.dataset.state = 'ended';
      this.strip.classList.remove('hidden');
      const row = document.createElement('span');
      row.className = 'flex items-start gap-2';
      row.appendChild(HubIcons.span(HubIcons.WARNING, `[&>svg]:size-4 mt-px ${this.notice.tone === 'warning' ? 'text-warning' : 'text-error'}`));
      const text = document.createElement('span');
      text.dataset.ref = 'sign-in-notice';
      text.className = 'flex-1 text-base-content/85 leading-snug';
      text.textContent = this.notice.text;
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.dataset.ref = 'sign-in-dismiss';
      dismiss.className = 'btn btn-ghost btn-square btn-xs h-5 w-5 min-h-0 text-base-content/50';
      dismiss.title = 'Dismiss';
      dismiss.setAttribute('aria-label', 'Dismiss');
      dismiss.appendChild(HubIcons.span(HubIcons.CLOSE, '[&>svg]:size-3.5'));
      dismiss.addEventListener('click', () => {
        this.notice = null;
        this.render();
      });
      row.append(text, dismiss);
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.dataset.ref = 'sign-in-retry';
      retry.className = 'btn btn-ghost btn-xs font-normal self-start text-base-content/75';
      retry.textContent = 'Try again';
      retry.addEventListener('click', () => void this.signIn());
      this.strip.append(row, retry);
      return;
    }
    delete this.strip.dataset.state;
    this.strip.classList.add('hidden');
  }
}
