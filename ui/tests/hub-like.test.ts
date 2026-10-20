// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HubPanel } from '../src/ui/hub/hub-panel';
import { HubPanelState } from '../src/ui/hub/hub-panel-state';
import { FakeHubClient } from './fixtures/fake-hub-client';
import { FakePackagesClient, settle } from './fixtures/fake-packages-client';

// Like in a package's header (H13 in the app): the outline or filled heart,
// "Like"/"Liked" and the count, aria-pressed; read once the detail shows
// when signed in; signed out, a press starts the header's own sign-in and
// the state is read once it finishes; a press turns at once and takes the
// engine's count, or turns back with a short message (offering the
// sign-in when the engine is signed out or the sign-in predates likes);
// the results' row follows the count; signing out forgets it.

const NAME = '@acme/feature-tests';
const panels: HubPanel[] = [];

/** An element's words, the icons' markup whitespace folded away. */
const words = (el: Element) => el.textContent!.replace(/\s+/g, ' ').trim();
/** What Like reads: its label and its count. */
const face = (button: Element) => `${button.querySelector('[data-ref="like-label"]')!.textContent} ${button.querySelector('[data-ref="like-count"]')!.textContent}`;

afterEach(() => {
  for (const panel of panels.splice(0)) {
    panel.destroy();
  }
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty('--fluidcad-editor-width');
  document.body.innerHTML = '';
});

/** Timers the test fires by hand: the search debounce and the sign-in's polling. */
class ManualTimers {
  pending: { callback: () => void; ms: number }[] = [];
  set = (callback: () => void, ms: number): unknown => {
    const entry = { callback, ms };
    this.pending.push(entry);
    return entry;
  };
  clear = (handle: unknown): void => {
    this.pending = this.pending.filter((entry) => entry !== handle);
  };
  async fire(): Promise<void> {
    for (const entry of this.pending.splice(0)) {
      entry.callback();
    }
    await settle();
  }
}

/** The panel open on `@acme/feature-tests` (12 likes), signed in as `acme` unless told otherwise. */
async function mount(options: { signedIn?: boolean; liked?: boolean } = {}) {
  const hub = new FakeHubClient();
  hub.statusValue = FakeHubClient.status({ signedIn: options.signedIn === false ? null : { handle: 'acme' } });
  hub.packages.set(NAME, FakeHubClient.pkg({ counts: { installs: 2, likes: 12, comments: 0 } }));
  hub.answer = FakeHubClient.answer([FakeHubClient.row({ likes: 12 })]);
  if (options.liked) {
    hub.liked.add(NAME);
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const timers = new ManualTimers();
  const openExternal = vi.fn();
  const panel = new HubPanel({
    container,
    hub,
    packages: new FakePackagesClient(),
    installSetting: () => 'library',
    projectOpen: () => true,
    openExternal,
    onPackagesChanged: vi.fn(),
    width: () => 500,
    timers,
  });
  panels.push(panel);
  panel.show();
  await settle();
  await panel.openPackage(NAME);
  await settle();
  const $ = <T extends Element = HTMLElement>(selector: string) => panel.el.querySelector<T>(selector);
  const like = () => $<HTMLButtonElement>('[data-role="hub-package"] [data-ref="like"]')!;
  const notice = () => $('[data-ref="like-notice"]')!;
  /** The likes the search row shows (its first stat). */
  const rowLikes = () => words(panel.el.querySelector('[data-role="hub-search"] [title="Likes"]')!);
  return { hub, panel, timers, openExternal, $, like, notice, rowLikes };
}

describe('Like in the package header', () => {
  it('signed in: reads whether you like it after the detail, then shows the filled heart, Liked and the count', async () => {
    const h = await mount({ liked: true });
    expect(h.hub.socialState).toHaveBeenCalledTimes(1);
    expect(h.hub.socialState).toHaveBeenCalledWith(NAME);
    const button = h.like();
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute('aria-label')).toBe(`Like ${NAME}`);
    expect(button.dataset.liked).toBe('true');
    expect(face(button)).toBe('Liked 12');
    expect(button.querySelector('svg')!.getAttribute('class')).toContain('icons-tabler-filled');
    // Beside the name, in the header.
    expect(button.parentElement!.querySelector('[data-ref="name"]')).not.toBeNull();
  });

  it('does not hold the detail up: it shows while the state is still being read', async () => {
    const hub = new FakeHubClient();
    hub.statusValue = FakeHubClient.status({ signedIn: { handle: 'acme' } });
    hub.packages.set(NAME, FakeHubClient.pkg({ counts: { installs: 2, likes: 3, comments: 0 } }));
    let answer!: () => void;
    hub.socialState.mockImplementationOnce(async (name: string) => {
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
      return { ok: true, state: { package: name, liked: true, lists: [], helpful: [] } };
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new HubPanel({
      container, hub, packages: new FakePackagesClient(), installSetting: () => 'library', projectOpen: () => true,
      openExternal: vi.fn(), onPackagesChanged: vi.fn(), width: () => 500, timers: new ManualTimers(),
    });
    panels.push(panel);
    panel.show();
    await settle();
    await panel.openPackage(NAME);
    await settle();
    const like = panel.el.querySelector<HTMLButtonElement>('[data-ref="like"]')!;
    expect(panel.el.querySelector('[data-ref="tabs"]')).not.toBeNull();
    expect(like.getAttribute('aria-pressed')).toBe('false');
    expect(face(like)).toBe('Like 3');
    answer();
    await settle();
    expect(like.getAttribute('aria-pressed')).toBe('true');
    expect(face(like)).toBe('Liked 3');
  });

  it('a press turns it at once, takes the engine\'s count, and the results\' row follows when going back', async () => {
    const h = await mount();
    expect(face(h.like())).toBe('Like 12');
    let release!: () => void;
    h.hub.likeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Someone else liked it meanwhile: the hub answers 14.
    h.hub.likeCounts.set(NAME, 13);
    h.like().click();
    await settle();
    expect(h.like().getAttribute('aria-pressed')).toBe('true');
    expect(h.like().getAttribute('aria-busy')).toBe('true');
    expect(face(h.like())).toBe('Liked 13');
    // A second press while the first is in flight sends nothing.
    h.like().click();
    await settle();
    expect(h.hub.setLiked).toHaveBeenCalledTimes(1);
    expect(h.hub.setLiked).toHaveBeenCalledWith(NAME, true);

    release();
    await settle();
    expect(h.like().getAttribute('aria-busy')).toBe('false');
    expect(face(h.like())).toBe('Liked 14');
    h.hub.likeGate = null;

    // Back to the results: the row says 14, not the 12 of the search held.
    h.$<HTMLButtonElement>('[data-ref="back"]')!.click();
    await settle();
    expect(h.rowLikes()).toBe('14');

    // The detail read again (as after an install) may come from the hub's cache: the answered count stays.
    await h.panel.openPackage(NAME);
    await settle();
    expect(face(h.like())).toBe('Liked 14');

    // Unlike: the outline heart and the count back down.
    h.like().click();
    await settle();
    expect(h.hub.setLiked).toHaveBeenLastCalledWith(NAME, false);
    expect(h.like().getAttribute('aria-pressed')).toBe('false');
    expect(face(h.like())).toBe('Like 13');
    expect(h.like().querySelector('svg')!.getAttribute('class')).toContain('icons-tabler-outline');
  });

  it('a refusal turns it back and says why; hub-unreachable, rate-limited, forbidden and not-found have no sign-in', async () => {
    const cases: [string, string, RegExp][] = [
      ['hub-unreachable', 'The engine could not reach the hub.', /^Couldn’t reach localhost:8787, so the like didn’t go through\./],
      ['rate-limited', 'Too many changes this minute.', /^Too many likes this minute/],
      ['forbidden', "This API token doesn't have the `social` scope.", /^localhost:8787 refused the like: This API token doesn't have the `social` scope\.$/],
      ['not-found', 'No package.', /isn’t public on localhost:8787/],
    ];
    const h = await mount();
    for (const [code, error, text] of cases) {
      h.hub.likeRefusal = { status: 400, error, code };
      h.like().click();
      await settle();
      expect(h.like().getAttribute('aria-pressed')).toBe('false');
      expect(face(h.like())).toBe('Like 12');
      expect(h.notice().classList.contains('hidden')).toBe(false);
      expect(h.$('[data-ref="like-message"]')!.textContent).toMatch(text);
      expect(h.$('[data-ref="like-sign-in"]')).toBeNull();
    }
    // The next press that goes through clears it.
    h.like().click();
    await settle();
    expect(h.notice().classList.contains('hidden')).toBe(true);
    expect(face(h.like())).toBe('Liked 13');
  });

  it('dismissing the message hides it', async () => {
    const h = await mount();
    h.hub.likeRefusal = { status: 503, error: 'down', code: 'hub-unreachable' };
    h.like().click();
    await settle();
    h.$<HTMLButtonElement>('[data-ref="like-dismiss"]')!.click();
    expect(h.notice().classList.contains('hidden')).toBe(true);
  });

  it('a sign-in older than likes: the message says to sign in again and offers it, then the state is read for the new sign-in', async () => {
    const h = await mount();
    h.hub.likeRefusal = { status: 403, error: 'This sign-in can’t like packages or keep lists…', code: 'sign-in-again' };
    h.like().click();
    await settle();
    expect(face(h.like())).toBe('Like 12');
    expect(h.$('[data-ref="like-message"]')!.textContent).toBe('This computer’s sign-in was made before FluidCAD could like packages. Sign in again to allow it.');
    const again = h.$<HTMLButtonElement>('[data-ref="like-sign-in"]')!;
    expect(words(again)).toBe('Sign in again');

    again.click();
    await settle();
    // The header's own sign-in, opened in the browser.
    expect(h.hub.login).toHaveBeenCalledTimes(1);
    expect(h.openExternal).toHaveBeenCalledWith(FakeHubClient.loginState().authorizeUrl);
    expect(h.$('[data-ref="account"]')!.dataset.state).toBe('waiting');
    expect(h.notice().classList.contains('hidden')).toBe(true);

    const reads = h.hub.socialState.mock.calls.length;
    h.hub.liked.add(NAME);
    h.hub.endLogin({ status: 'signed-in', handle: 'acme' });
    await h.timers.fire();
    expect(h.hub.socialState.mock.calls.length).toBe(reads + 1);
    expect(h.like().getAttribute('aria-pressed')).toBe('true');
  });

  it('the engine signed out under the panel (no credentials, or a refused token): the message offers Sign in', async () => {
    const h = await mount();
    h.hub.likeRefusal = { status: 401, error: 'Not signed in.', code: 'signed-out' };
    h.like().click();
    await settle();
    expect(face(h.like())).toBe('Like 12');
    expect(h.$('[data-ref="like-message"]')!.textContent).toBe('Sign in to localhost:8787 to like packages.');
    h.$<HTMLButtonElement>('[data-ref="like-sign-in"]')!.click();
    await settle();
    expect(h.hub.login).toHaveBeenCalledTimes(1);
  });

  it('signed out: no state is read, and a press starts the header\'s sign-in; once signed in the state is read', async () => {
    const h = await mount({ signedIn: false, liked: true });
    expect(h.hub.socialState).not.toHaveBeenCalled();
    expect(h.like().getAttribute('aria-pressed')).toBe('false');
    expect(face(h.like())).toBe('Like 12');
    expect(h.like().title).toBe(`Sign in to localhost:8787 to like ${NAME}`);

    h.like().click();
    await settle();
    expect(h.hub.setLiked).not.toHaveBeenCalled();
    expect(h.hub.login).toHaveBeenCalledTimes(1);
    expect(h.$('[data-ref="account"]')!.dataset.state).toBe('waiting');
    // A second press while it waits starts nothing more.
    h.like().click();
    await settle();
    expect(h.hub.login).toHaveBeenCalledTimes(1);

    h.hub.endLogin({ status: 'signed-in', handle: 'acme' });
    h.hub.statusValue = FakeHubClient.status({ signedIn: { handle: 'acme' } });
    await h.timers.fire();
    expect(h.hub.socialState).toHaveBeenCalledTimes(1);
    expect(h.like().getAttribute('aria-pressed')).toBe('true');
    expect(face(h.like())).toBe('Liked 12');
  });

  it('signing out forgets whether you liked it, and a press then asks to sign in', async () => {
    const h = await mount({ liked: true });
    expect(h.like().getAttribute('aria-pressed')).toBe('true');
    h.$<HTMLButtonElement>('[data-ref="account-button"]')!.click();
    h.$<HTMLButtonElement>('[data-ref="sign-out"]')!.click();
    await settle();
    expect(h.$('[data-ref="account"]')!.dataset.state).toBe('signed-out');
    expect(h.like().getAttribute('aria-pressed')).toBe('false');
    expect(face(h.like())).toBe('Like 12');
    const reads = h.hub.socialState.mock.calls.length;
    h.like().click();
    await settle();
    expect(h.hub.socialState.mock.calls.length).toBe(reads);
    expect(h.hub.setLiked).not.toHaveBeenCalled();
    expect(h.hub.login).toHaveBeenCalledTimes(1);
  });
});

describe('HubPanelState.noteLikes', () => {
  it('shows a like\'s count in the held row at once, and over search answers for the hub\'s cache minute only', async () => {
    const hub = new FakeHubClient();
    hub.answer = FakeHubClient.answer([FakeHubClient.row({ likes: 12 }), FakeHubClient.row({ fullName: '@acme/other', likes: 1 })]);
    let now = 1_000;
    const state = new HubPanelState(hub, undefined, () => now);
    const seen: number[][] = [];
    state.subscribe((snapshot) => seen.push(snapshot.answer?.results.map((row) => row.likes) ?? []));
    state.search();
    await settle();
    state.noteLikes(NAME, 13);
    expect(seen.at(-1)).toEqual([13, 1]);
    // The hub's search, from its cache of before the like.
    state.refresh();
    await settle();
    expect(state.snapshot.answer!.results.map((row) => row.likes)).toEqual([13, 1]);
    // A minute on, the hub's own count again.
    now += HubPanelState.LIKES_MEMORY_MS + 1;
    state.refresh();
    await settle();
    expect(state.snapshot.answer!.results.map((row) => row.likes)).toEqual([12, 1]);
    // A package not in the results changes nothing and emits nothing.
    const emitted = seen.length;
    state.noteLikes('@acme/elsewhere', 4);
    expect(seen.length).toBe(emitted);
    state.dispose();
  });
});
