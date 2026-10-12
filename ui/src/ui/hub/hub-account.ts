import type { HubClient, HubLoginState, HubLogoutResult, HubStatus } from '../../api';
import { HubAccountMenu } from './hub-account-menu';
import { HubHandle } from './hub-handle';
import { HubIcons } from './hub-icons';
import type { HubTimers } from './hub-panel-state';

export type HubAccountDeps = {
  hub: HubClient;
  /** Open a web page in the user's browser, through the host. */
  openExternal(url: string): void;
  /** A sign-in finished: the panel reads the status again (which names the handle). */
  onSignedIn(handle: string | null): void;
  /** A sign-out finished: the panel reads the status again and whatever the hub answered for the account. */
  onSignedOut(): Promise<void>;
  /** The hub's host for sentences (`hub.fluidcad.io`), once the status is known. */
  hubHost(): string | null;
  /** Timers for following a sign-in (tests). */
  timers?: HubTimers;
};

/** A sentence under the header; `retry` offers Try again (a sign-in that didn't finish). */
type Notice = { tone: 'warning' | 'error'; text: string; retry: boolean };

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
 * - **Signed in:** your handle, which opens the account's menu
 *   ({@link HubAccountMenu}) with **Sign out** (H11 follow-up 3, the
 *   user's request of 2026-10-12): it doesn't list your packages, as the
 *   handles in results and bylines do. Sign out runs `fluidcad logout`'s
 *   own `HubLogout` in the engine (`POST api/hub/logout`): the token is
 *   revoked on the hub and forgotten here, "Signing out…" meanwhile, then
 *   back to Sign in.
 *
 * A sign-in that ends without signing in (denied in the browser, the hub
 * request's five minutes over, the hub unreachable) leaves the engine's
 * sentence below the header with Try again; a cancel just goes back to
 * Sign in. A sign-out the hub couldn't confirm (it didn't answer, or
 * refused to revoke the token) still signs out here, and says the token
 * stays valid on the hub; so does a `FLUIDCAD_HUB_TOKEN` that still signs
 * the engine's requests.
 */
export class HubAccount {
  static readonly POLL_MS = 1000;

  /** The header's slot. */
  readonly el: HTMLSpanElement;
  /** The line under the header: the wait, or how the last sign-in ended. */
  readonly strip: HTMLDivElement;
  private readonly timers: HubTimers;
  private readonly menu: HubAccountMenu;
  private status: HubStatus | null = null;
  /** The sign-in this page follows while it waits; null otherwise. */
  private login: HubLoginState | null = null;
  private starting = false;
  private signingOut = false;
  private notice: Notice | null = null;
  private timer: unknown = null;
  private destroyed = false;

  constructor(private readonly deps: HubAccountDeps) {
    this.timers = deps.timers ?? { set: (callback, ms) => setTimeout(callback, ms), clear: (handle) => clearTimeout(handle as number) };
    this.el = document.createElement('span');
    this.el.dataset.ref = 'account';
    this.el.className = 'relative inline-flex items-center gap-1 text-hub-xs text-base-content/45 shrink-0 min-w-0';
    this.menu = new HubAccountMenu(this.el, () => [{
      ref: 'sign-out',
      icon: HubIcons.SIGN_OUT,
      label: 'Sign out',
      title: `Revokes this computer’s token on ${this.deps.hubHost() ?? 'the hub'} and forgets it`,
      onSelect: () => void this.signOut(),
    }]);
    this.strip = document.createElement('div');
    this.strip.dataset.ref = 'sign-in';
    this.strip.setAttribute('role', 'status');
    this.strip.className = 'hidden shrink-0 flex flex-col gap-1.5 px-3 py-2 border-b border-base-content/10 bg-base-200/60 text-hub-sm';
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
    if (this.signingIn || this.signingOut) {
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
        ? { tone: 'error', text: `Couldn’t reach ${host}, so the sign-in didn’t start. Check the connection, then try again.`, retry: true }
        : { tone: 'error', text: answer.error, retry: true };
      this.render();
      return;
    }
    this.follow(answer.login);
    if (answer.login.authorizeUrl) {
      this.deps.openExternal(answer.login.authorizeUrl);
    }
  }

  /**
   * Sign out (the account menu): the engine revokes the token on the hub
   * and forgets it, then the panel reads the status again, which brings
   * Sign in back. Nothing happens while a sign-in or a sign-out runs.
   */
  async signOut(): Promise<void> {
    if (this.signingIn || this.signingOut) {
      return;
    }
    this.signingOut = true;
    this.notice = null;
    this.render();
    const answer = await this.deps.hub.logout();
    if (this.destroyed) {
      return;
    }
    if (answer.ok === false) {
      // The engine didn't sign out: still signed in, as the header says.
      this.signingOut = false;
      this.notice = { tone: 'error', text: `Couldn’t sign out: ${answer.error}`, retry: false };
      this.render();
      return;
    }
    this.notice = HubAccount.signedOut(answer.logout);
    // "Signing out…" stays until the status says who is signed in now.
    await this.deps.onSignedOut();
    if (this.destroyed) {
      return;
    }
    this.signingOut = false;
    this.render();
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
    this.menu.close();
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
      : { tone: login.status === 'failed' ? 'error' : 'warning', text: login.error ?? 'The sign-in didn’t finish. Nothing was saved.', retry: true };
    this.render();
  }

  /**
   * What a sign-out leaves to say: nothing when the hub revoked the token
   * (or had already), else that the token stays valid on the hub, and that
   * `FLUIDCAD_HUB_TOKEN` still signs the engine's requests when it is set.
   */
  private static signedOut(result: HubLogoutResult): Notice | null {
    const host = HubAccount.hostOf(result.hub);
    const sentences: string[] = [];
    if (result.outcome === 'not-revoked') {
      const why = result.unreachable
        ? `${host} didn’t answer, so the token wasn’t revoked.`
        : `${host} didn’t revoke the token${result.reason ? `: ${result.reason}` : '.'}`;
      sentences.push(`Signed out on this computer, but ${why} It stays valid on the hub until it’s revoked there or goes unused for a year.`);
    }
    if (result.envToken) {
      sentences.push('FLUIDCAD_HUB_TOKEN is still set where FluidCAD runs, so it still signs in with that token. Unset it and restart FluidCAD to stop.');
    }
    return sentences.length > 0 ? { tone: 'warning', text: sentences.join(' '), retry: false } : null;
  }

  private static hostOf(origin: string): string {
    try {
      return new URL(origin).host;
    } catch {
      return origin;
    }
  }

  // ---------------------------------------------------------------------------

  private render(): void {
    this.renderHeader();
    this.renderStrip();
  }

  private renderHeader(): void {
    this.el.replaceChildren();
    this.el.dataset.state = this.signingOut ? 'signing-out' : this.signingIn ? 'waiting' : this.status?.signedIn ? 'signed-in' : this.status ? 'signed-out' : 'unknown';
    if (this.signingIn || this.signingOut) {
      const spinner = document.createElement('span');
      spinner.className = 'loading loading-spinner loading-xs text-base-content/40';
      this.el.append(spinner, this.signingOut ? 'Signing out…' : 'Signing in…');
      this.menu.redrawn(null);
      return;
    }
    if (!this.status) {
      this.menu.redrawn(null);
      return;
    }
    const host = this.deps.hubHost() ?? 'the hub';
    const signedIn = this.status.signedIn;
    if (signedIn) {
      const button = this.accountButton(signedIn.handle, host);
      this.el.appendChild(button);
      this.menu.redrawn(button);
      return;
    }
    this.menu.redrawn(null);
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.ref = 'sign-in-button';
    button.className = 'btn btn-ghost btn-xs text-hub-xs gap-1 font-normal text-base-content/75';
    button.title = `Sign in to ${host} in your browser. Searching and installing work without it.`;
    button.append(HubIcons.span(HubIcons.SIGN_IN, '[&>svg]:size-3.5'), 'Sign in');
    button.addEventListener('click', () => void this.signIn());
    this.el.appendChild(button);
  }

  /** Who is signed in, as the button that opens the account's menu (not a publisher link: H11 follow-up 3). */
  private accountButton(handle: string | null, host: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.ref = 'account-button';
    button.className = 'btn btn-ghost btn-xs text-hub-xs gap-1 font-normal text-base-content/75 min-w-0 max-w-44';
    button.title = `Signed in to ${host}${handle ? ` as @${handle}` : ''}`;
    const label = document.createElement('span');
    label.dataset.ref = 'account-handle';
    label.className = 'truncate';
    label.textContent = handle && HubHandle.isHandle(handle) ? `@${handle}` : 'Signed in';
    button.append(
      HubIcons.span(HubIcons.USER, '[&>svg]:size-3.5'),
      label,
      HubIcons.span(HubIcons.CHEVRON_DOWN, '[&>svg]:size-3 opacity-60'),
    );
    return this.menu.wire(button);
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
      cancel.className = 'btn btn-ghost btn-xs text-hub-xs font-normal ml-auto';
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
      this.strip.appendChild(row);
      if (this.notice.retry) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.dataset.ref = 'sign-in-retry';
        retry.className = 'btn btn-ghost btn-xs text-hub-xs font-normal self-start text-base-content/75';
        retry.textContent = 'Try again';
        retry.addEventListener('click', () => void this.signIn());
        this.strip.appendChild(retry);
      }
      return;
    }
    delete this.strip.dataset.state;
    this.strip.classList.add('hidden');
  }
}
