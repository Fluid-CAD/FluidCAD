import type { HubClient, PackageRefusal } from '../../api';
import { HubIcons } from './hub-icons';
import { HubText } from './hub-text';

export type HubLikeControlDeps = {
  hub: HubClient;
  /** Start the panel's own sign-in (the header's, `HubAccount.signIn`). */
  signIn(): void;
  /** Sign out, revoking the token from before likes, then sign in (`HubAccount.signInAgain`). */
  signInAgain(): void;
  /** The hub's host for sentences (`hub.fluidcad.io`), once the status is known. */
  hubHost(): string | null;
  /** A like or unlike answered: the package's count now, for whatever else shows it. */
  onLikes(name: string, likes: number): void;
};

/** What to offer under the button: the sign-in, or nothing beyond Dismiss. */
type LikeNotice = { tone: 'warning' | 'error'; text: string; action: { label: string; title: string; again: boolean } | null };

/**
 * The package detail's Like (H13 in the app): a toggle with the heart,
 * "Like" or "Liked" and the package's count, as the hub's own package page
 * draws it (`.btn-like`: the outline heart, filled in the selection gold
 * when pressed). It acts through the engine as the signed-in account
 * (`PUT`/`DELETE api/hub/packages/@s/n/like`).
 *
 * - **Signed in:** whether you like the package is read once its detail
 *   is shown ({@link show}), never holding the detail up; until it
 *   answers the toggle reads as not liked (a like is idempotent, so a
 *   press then is still right).
 * - **Signed out:** a press starts the panel's sign-in, the header's own;
 *   once it finishes the state is read again ({@link accountChanged}).
 * - **A press** turns the toggle and the count at once, then takes the
 *   engine's answer (`likes` is the hub's count after the change); a
 *   refusal puts both back and says why below, offering the sign-in when
 *   the engine is signed out or the sign-in predates likes
 *   (`sign-in-again`). Presses while one is in flight do nothing.
 *
 * The count the last answer gave wins over a detail read afterwards, which
 * the hub may serve from before the change.
 */
export class HubLikeControl {
  readonly el: HTMLButtonElement;
  /** The line under the header: why the last press didn't take. */
  readonly notice: HTMLDivElement;
  private name: string | null = null;
  private likes = 0;
  /** Whether the account likes the package; null until the engine says (or signed out). */
  private liked: boolean | null = null;
  /** The panel's status: null until it is known. */
  private signedIn: boolean | null = null;
  /** The count the last like or unlike of {@link name} answered. */
  private answered: number | null = null;
  /** The press in flight for {@link name}; null when none (or the package or account changed under it). */
  private inflight: number | null = null;
  private presses = 0;
  /** Bumped by a press and an account change: a state read that started before is stale. */
  private ticket = 0;
  /** The {@link ticket} a state read is running for, so a second one isn't started. */
  private reading: number | null = null;
  private message: LikeNotice | null = null;
  private destroyed = false;

  constructor(private readonly deps: HubLikeControlDeps) {
    this.el = document.createElement('button');
    this.el.type = 'button';
    this.el.dataset.ref = 'like';
    this.el.className = 'btn btn-sm text-hub-sm font-normal gap-1.5 px-2.5 shrink-0';
    this.el.addEventListener('click', () => void this.press());
    this.notice = document.createElement('div');
    this.notice.dataset.ref = 'like-notice';
    this.notice.setAttribute('role', 'status');
    this.notice.className = 'hidden';
    this.render();
  }

  /** Whether you like the package shown; null until known. */
  get isLiked(): boolean | null {
    return this.liked;
  }

  get count(): number {
    return this.likes;
  }

  /**
   * The detail of `name` was read, with `likes` from the hub. Another
   * package starts over; the same one keeps what it knows, and the count
   * the last press answered.
   */
  show(name: string, likes: number): void {
    if (name !== this.name) {
      this.name = name;
      this.liked = null;
      this.answered = null;
      this.inflight = null;
      this.message = null;
      this.ticket++;
    }
    this.likes = this.answered ?? likes;
    this.render();
    if (this.signedIn !== false && this.liked === null && this.inflight === null && this.reading !== this.ticket) {
      void this.readState();
    }
  }

  /** The panel's status said who is signed in (null: not known yet). Signing in reads the state; signing out forgets it. */
  setSignedIn(signedIn: boolean | null): void {
    if (signedIn === this.signedIn) {
      return;
    }
    this.signedIn = signedIn;
    if (signedIn === false) {
      this.liked = null;
      this.ticket++;
    } else if (signedIn && this.name && this.liked === null && this.inflight === null && this.reading !== this.ticket) {
      void this.readState();
    }
    this.render();
  }

  /**
   * A sign-in or a sign-out finished in the header: what the old account
   * liked, a press in flight and the message are forgotten, and the state
   * is read again for the new one (`signedIn`) when the detail is `showing`.
   */
  accountChanged(signedIn: boolean | null, showing: boolean): void {
    this.signedIn = signedIn;
    this.liked = null;
    this.inflight = null;
    this.message = null;
    this.ticket++;
    this.render();
    if (signedIn !== false && showing && this.name) {
      void this.readState();
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.el.remove();
    this.notice.remove();
  }

  // ---------------------------------------------------------------------------

  private async readState(): Promise<void> {
    const name = this.name;
    if (!name) {
      return;
    }
    const ticket = this.ticket;
    this.reading = ticket;
    const answer = await this.deps.hub.socialState(name);
    if (this.reading === ticket) {
      this.reading = null;
    }
    if (this.destroyed || ticket !== this.ticket || name !== this.name) {
      return;
    }
    if (answer.ok === false) {
      // Signed out: not liked. Any other refusal leaves it unknown: a press says why, if it fails too.
      if (answer.code === 'signed-out') {
        this.liked = false;
      }
    } else {
      this.liked = answer.state.liked;
    }
    this.render();
  }

  private async press(): Promise<void> {
    const name = this.name;
    if (!name || this.inflight !== null) {
      return;
    }
    if (this.signedIn === false) {
      this.message = null;
      this.render();
      this.deps.signIn();
      return;
    }
    const before = { liked: this.liked, likes: this.likes };
    const want = !(this.liked ?? false);
    const press = ++this.presses;
    this.inflight = press;
    this.ticket++;
    this.liked = want;
    this.likes = Math.max(0, this.likes + (want ? 1 : -1));
    this.message = null;
    this.render();
    const answer = await this.deps.hub.setLiked(name, want);
    if (answer.ok !== false) {
      // The hub's count, whatever happened here meanwhile: the results' row follows it.
      this.deps.onLikes(name, answer.like.likes);
    }
    if (this.destroyed || this.inflight !== press) {
      return;
    }
    this.inflight = null;
    if (answer.ok === false) {
      this.liked = before.liked;
      this.likes = before.likes;
      this.message = this.refusal(answer, name, want);
    } else {
      this.liked = answer.like.liked;
      this.likes = answer.like.likes;
      this.answered = answer.like.likes;
    }
    this.render();
  }

  /** What a refused press says, and whether it offers the sign-in. */
  private refusal(answer: PackageRefusal, name: string, want: boolean): LikeNotice {
    const host = this.deps.hubHost() ?? 'the hub';
    const what = want ? 'like' : 'unlike';
    switch (answer.code) {
      case 'signed-out':
        return {
          tone: 'warning',
          text: `Sign in to ${host} to like packages.`,
          action: { label: 'Sign in', title: `Sign in to ${host} in your browser`, again: false },
        };
      case 'sign-in-again':
        return {
          tone: 'warning',
          text: 'This computer’s sign-in was made before FluidCAD could like packages. Sign in again to allow it.',
          action: { label: 'Sign in again', title: `Signs out, revoking this computer’s token on ${host}, then signs in in your browser; the new sign-in can like packages`, again: true },
        };
      case 'rate-limited':
        return { tone: 'warning', text: `Too many likes this minute, so the ${what} didn’t go through. Try again in a minute.`, action: null };
      case 'hub-unreachable':
        return { tone: 'error', text: `Couldn’t reach ${host}, so the ${what} didn’t go through. Try again when it answers.`, action: null };
      case 'not-found':
        return { tone: 'error', text: `${name} isn’t public on ${host}, so it can’t be liked.`, action: null };
      case 'forbidden':
        return { tone: 'error', text: `${host} refused the ${what}: ${answer.error}`, action: null };
      default:
        return { tone: 'error', text: `Couldn’t ${what} ${name}: ${answer.error}`, action: null };
    }
  }

  // ---------------------------------------------------------------------------

  private render(): void {
    this.renderButton();
    this.renderNotice();
  }

  private renderButton(): void {
    const liked = this.liked === true;
    const name = this.name ?? 'this package';
    this.el.setAttribute('aria-pressed', String(liked));
    // The name stays put while the state flips (aria-pressed says it), as on the hub's page.
    this.el.setAttribute('aria-label', `Like ${name}`);
    this.el.setAttribute('aria-busy', String(this.inflight !== null));
    this.el.dataset.liked = String(liked);
    const host = this.deps.hubHost() ?? 'the hub';
    this.el.title = this.signedIn === false
      ? `Sign in to ${host} to like ${name}`
      : `${HubText.plural(this.likes, 'like')}${liked ? ', yours among them' : ''}`;
    const label = document.createElement('span');
    label.dataset.ref = 'like-label';
    label.textContent = liked ? 'Liked' : 'Like';
    const count = document.createElement('span');
    count.dataset.ref = 'like-count';
    count.className = 'font-mono text-hub-xs tabular-nums opacity-70';
    count.textContent = HubText.count(this.likes);
    this.el.replaceChildren(
      HubIcons.span(liked ? HubIcons.HEART_FILLED : HubIcons.HEART, '[&>svg]:size-4'),
      label,
      count,
    );
  }

  private renderNotice(): void {
    const message = this.message;
    if (!message) {
      this.notice.className = 'hidden';
      this.notice.replaceChildren();
      return;
    }
    this.notice.className = `flex flex-col gap-1.5 rounded-md px-3 py-2 text-hub-sm leading-snug ${message.tone === 'warning' ? 'bg-warning/15' : 'bg-error/10 border border-error/30'}`;
    this.notice.dataset.tone = message.tone;
    const row = document.createElement('span');
    row.className = 'flex items-start gap-2';
    row.appendChild(HubIcons.span(HubIcons.WARNING, `[&>svg]:size-4 mt-px ${message.tone === 'warning' ? 'text-warning' : 'text-error'}`));
    const text = document.createElement('span');
    text.dataset.ref = 'like-message';
    text.className = 'flex-1 text-base-content/90';
    text.textContent = message.text;
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.dataset.ref = 'like-dismiss';
    dismiss.className = 'btn btn-ghost btn-square btn-xs h-5 w-5 min-h-0 text-base-content/50';
    dismiss.title = 'Dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.appendChild(HubIcons.span(HubIcons.CLOSE, '[&>svg]:size-3.5'));
    dismiss.addEventListener('click', () => {
      this.message = null;
      this.renderNotice();
    });
    row.append(text, dismiss);
    this.notice.replaceChildren(row);
    if (message.action) {
      const action = document.createElement('button');
      action.type = 'button';
      action.dataset.ref = 'like-sign-in';
      action.className = 'btn btn-xs text-hub-xs gap-1 font-normal self-start ml-6';
      action.title = message.action.title;
      action.append(HubIcons.span(HubIcons.SIGN_IN, '[&>svg]:size-3.5'), message.action.label);
      const again = message.action.again;
      action.addEventListener('click', () => {
        this.message = null;
        this.renderNotice();
        if (again) {
          this.deps.signInAgain();
        } else {
          this.deps.signIn();
        }
      });
      this.notice.appendChild(action);
    }
  }
}
