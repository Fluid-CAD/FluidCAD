// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HubPanel } from '../src/ui/hub/hub-panel';
import { HubMissingInstall } from '../src/ui/hub/hub-missing-install';
import { ExternalLinks } from '../src/ui/external-links';
import { PackageConsentDialog } from '../src/ui/packages/package-consent-dialog';
import { FakeHubClient } from './fixtures/fake-hub-client';
import { FakePackagesClient, settle } from './fixtures/fake-packages-client';

// The Hub panel as the page mounts it (hub-plan H11): one slot with the
// code editor (decision 5), the header ("FluidCAD Hub" and who is signed
// in, with Sign in when nobody is: H11 follow-up 2; your handle opening the
// account's menu with Sign out: H11 follow-up 3), the search → package →
// Results round trip, the marks read again after an install, a publisher's
// handle in a result or a byline listing that publisher's packages; then
// the missing-package banner's Install from the hub (consent, never the
// panel) and links leaving through the host.

const panels: HubPanel[] = [];

/** An element's words, the icons' markup whitespace folded away. */
const words = (el: Element) => el.textContent!.replace(/\s+/g, ' ').trim();

afterEach(() => {
  for (const panel of panels.splice(0)) {
    panel.destroy();
  }
  vi.unstubAllGlobals();
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

function mount(hub = new FakeHubClient()) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  hub.packages.set('@acme/feature-tests', FakeHubClient.pkg());
  const events: string[] = [];
  const onPackagesChanged = vi.fn();
  const onWidthChange = vi.fn();
  const openExternal = vi.fn();
  const timers = new ManualTimers();
  const panel = new HubPanel({
    container,
    hub,
    packages: new FakePackagesClient(),
    installSetting: () => 'library',
    projectOpen: () => true,
    openExternal,
    onPackagesChanged,
    width: () => 500,
    onWidthChange,
    onTakeSlot: () => events.push('editor closed'),
    onOpenChange: (open) => events.push(open ? 'hub open' : 'hub closed'),
    timers,
  });
  panels.push(panel);
  const width = () => document.documentElement.style.getPropertyValue('--fluidcad-editor-width');
  const $ = <T extends Element = HTMLElement>(selector: string) => panel.el.querySelector<T>(selector);
  const account = () => $('[data-ref="account"]')!;
  const strip = () => $('[data-ref="sign-in"]')!;
  return { hub, panel, container, events, width, onPackagesChanged, onWidthChange, openExternal, timers, $, account, strip };
}

describe('the Hub panel', () => {
  it('takes the editor slot: the editor closes first, then the panel takes its width', async () => {
    vi.stubGlobal('innerWidth', 1440);
    const h = mount();
    expect(h.panel.el.classList.contains('hidden')).toBe(true);
    h.panel.show();
    await settle();
    expect(h.events).toEqual(['editor closed', 'hub open']);
    expect(h.panel.isOpen()).toBe(true);
    expect(h.width()).toBe('500px');
    expect(h.panel.el.style.width).toBe('500px');
    // The editor opening takes the slot back: the panel hides and leaves the width alone.
    document.documentElement.style.setProperty('--fluidcad-editor-width', '420px');
    h.panel.yieldSlot();
    expect(h.panel.isOpen()).toBe(false);
    expect(h.panel.el.classList.contains('hidden')).toBe(true);
    expect(h.width()).toBe('420px');
    // Its own close hands the width back to the scene.
    h.panel.show();
    h.panel.close();
    expect(h.width()).toBe('0px');
  });

  it('covers the scene in a narrow window, as the editor does', () => {
    vi.stubGlobal('innerWidth', 600);
    const h = mount();
    h.panel.show();
    expect(h.width()).toBe('0px');
    expect(h.panel.el.style.width).toBe('calc(100% - var(--fluidcad-rail-width, 0px))');
  });

  it('says "FluidCAD Hub" with no address, who is signed in, and searches on its first open only', async () => {
    const hub = new FakeHubClient();
    hub.statusValue = FakeHubClient.status({ signedIn: { handle: 'acme' } });
    const h = mount(hub);
    h.panel.show();
    await settle();
    const header = h.$('[data-ref="close"]')!.parentElement!;
    expect(words(header)).toBe('FluidCAD Hub @acme');
    expect(header.textContent).not.toContain('localhost');
    expect(h.$('[data-ref="hub-host"]')).toBeNull();
    expect(h.account().dataset.state).toBe('signed-in');
    expect(words(h.account())).toBe('@acme');
    expect(hub.search).toHaveBeenCalledTimes(1);
    h.panel.close();
    h.panel.show();
    await settle();
    expect(hub.search).toHaveBeenCalledTimes(1);

    hub.statusValue = FakeHubClient.status();
    h.panel.close();
    h.panel.show();
    await settle();
    expect(h.account().dataset.state).toBe('signed-out');
    expect(words(h.account())).toBe('Sign in');
    expect(h.strip().classList.contains('hidden')).toBe(true);
  });

  it('opens a package from its row, and Results comes back to the search, read again after an install', async () => {
    const h = mount();
    h.panel.show();
    await settle();
    h.panel.el.querySelector<HTMLElement>('[data-package="@acme/feature-tests"]')!.click();
    await settle();
    expect(h.panel.currentView).toBe('package');
    expect(h.panel.el.querySelector('[data-role="hub-package"]')!.classList.contains('hidden')).toBe(false);
    expect(h.panel.el.querySelector('[data-role="hub-search"]')!.classList.contains('hidden')).toBe(true);
    h.panel.el.querySelector<HTMLButtonElement>('[data-ref="install"]')!.click();
    await settle();
    expect(h.onPackagesChanged).toHaveBeenCalledTimes(1);
    const searches = h.hub.search.mock.calls.length;
    h.panel.el.querySelector<HTMLButtonElement>('[data-ref="back"]')!.click();
    await settle();
    expect(h.panel.currentView).toBe('search');
    expect(h.hub.search.mock.calls.length).toBe(searches + 1);
  });

  it('shows the offline dot and state when the hub does not answer', async () => {
    const hub = new FakeHubClient();
    hub.searchRefusal = { status: 503, error: "Couldn't reach the hub.", code: 'hub-unreachable' };
    hub.statusValue = FakeHubClient.status({ reachable: false });
    const h = mount(hub);
    h.panel.show();
    await settle();
    expect(h.panel.el.querySelector('[data-ref="offline-dot"]')!.classList.contains('hidden')).toBe(false);
    expect(h.panel.el.querySelector('[data-state="offline"]')).not.toBeNull();
  });
});

describe('signing in from the header (H11 follow-up 2)', () => {
  it('Sign in → the authorize page opens through the host → waiting → the handle', async () => {
    const h = mount();
    h.panel.show();
    await settle();
    h.$<HTMLButtonElement>('[data-ref="sign-in-button"]')!.click();
    await settle();
    expect(h.hub.login).toHaveBeenCalledTimes(1);
    expect(h.openExternal).toHaveBeenCalledWith(FakeHubClient.loginState().authorizeUrl);
    // Waiting: "Signing in…" in the header, the wait below it, no Sign in.
    expect(h.account().dataset.state).toBe('waiting');
    expect(words(h.account())).toBe('Signing in…');
    expect(h.$('[data-ref="sign-in-button"]')).toBeNull();
    expect(h.strip().dataset.state).toBe('waiting');
    expect(h.strip().classList.contains('hidden')).toBe(false);
    expect(h.$('[data-ref="sign-in-lead"]')!.textContent).toBe('Finish signing in in your browser.');
    // Open the page again (the browser didn't open, or its tab was closed).
    h.$<HTMLButtonElement>('[data-ref="sign-in-open"]')!.click();
    expect(h.openExternal).toHaveBeenCalledTimes(2);
    expect(h.openExternal).toHaveBeenLastCalledWith(FakeHubClient.loginState().authorizeUrl);

    // Still waiting at the next look.
    await h.timers.fire();
    expect(h.hub.loginState).toHaveBeenCalled();
    expect(h.account().dataset.state).toBe('waiting');

    // The user authorizes in the browser; the engine saved the credentials.
    h.hub.endLogin({ status: 'signed-in', handle: 'acme' });
    h.hub.statusValue = FakeHubClient.status({ signedIn: { handle: 'acme' } });
    const statusReads = h.hub.status.mock.calls.length;
    await h.timers.fire();
    expect(h.hub.status.mock.calls.length).toBe(statusReads + 1);
    expect(h.account().dataset.state).toBe('signed-in');
    expect(h.$('[data-ref="account-button"] [data-ref="account-handle"]')!.textContent).toBe('@acme');
    expect(h.strip().classList.contains('hidden')).toBe(true);
    // Nothing more to follow.
    expect(h.timers.pending).toHaveLength(0);
  });

  it('a second press while one waits starts nothing more, and a reload follows the waiting one', async () => {
    const h = mount();
    h.panel.show();
    await settle();
    // A double click: the button's second press lands before the first answer.
    const button = h.$<HTMLButtonElement>('[data-ref="sign-in-button"]')!;
    button.click();
    button.click();
    await settle();
    expect(h.$('[data-ref="sign-in-button"]')).toBeNull();
    expect(h.hub.login).toHaveBeenCalledTimes(1);
    expect(h.openExternal).toHaveBeenCalledTimes(1);

    // A second page on the same engine (or this one after a reload) shows the same wait.
    const other = mount(h.hub);
    other.panel.show();
    await settle();
    expect(other.account().dataset.state).toBe('waiting');
    expect(other.$('[data-ref="sign-in-lead"]')).not.toBeNull();
    expect(h.hub.login).toHaveBeenCalledTimes(1);
    expect(other.openExternal).not.toHaveBeenCalled();
  });

  it('denial and expiry leave the sentence with Try again; a dismissed one goes back to Sign in', async () => {
    for (const [status, error, tone] of [
      ['denied', 'The sign-in was denied in the browser. Nothing was saved.', 'text-warning'],
      ['expired', 'The sign-in wasn’t finished within 5 minutes, the time the hub gives it. Nothing was saved.', 'text-warning'],
      ['failed', 'Couldn’t reach localhost:8787 to finish signing in. Nothing was saved.', 'text-error'],
    ] as const) {
      const h = mount();
      h.panel.show();
      await settle();
      h.$<HTMLButtonElement>('[data-ref="sign-in-button"]')!.click();
      await settle();
      h.hub.endLogin({ status, error, code: status === 'failed' ? 'hub-unreachable' : null });
      await h.timers.fire();
      expect(h.account().dataset.state).toBe('signed-out');
      expect(h.strip().dataset.state).toBe('ended');
      expect(h.$('[data-ref="sign-in-notice"]')!.textContent).toBe(error);
      expect(h.strip().querySelector(`.${tone}`)).not.toBeNull();
      expect(h.timers.pending).toHaveLength(0);
      // Try again starts a new sign-in.
      h.$<HTMLButtonElement>('[data-ref="sign-in-retry"]')!.click();
      await settle();
      expect(h.hub.login).toHaveBeenCalledTimes(2);
      expect(h.account().dataset.state).toBe('waiting');
      h.hub.endLogin({ status, error });
      await h.timers.fire();
      h.$<HTMLButtonElement>('[data-ref="sign-in-dismiss"]')!.click();
      expect(h.strip().classList.contains('hidden')).toBe(true);
      expect(words(h.account())).toBe('Sign in');
    }
  });

  it('Cancel stops the wait and goes back to Sign in; a cancel too late waits for the outcome', async () => {
    const h = mount();
    h.panel.show();
    await settle();
    h.$<HTMLButtonElement>('[data-ref="sign-in-button"]')!.click();
    await settle();
    h.$<HTMLButtonElement>('[data-ref="sign-in-cancel"]')!.click();
    await settle();
    expect(h.hub.cancelLogin).toHaveBeenCalledTimes(1);
    expect(words(h.account())).toBe('Sign in');
    expect(h.strip().classList.contains('hidden')).toBe(true);
    expect(h.timers.pending).toHaveLength(0);

    // The browser came back before the cancel: the engine finishes, and the handle shows.
    h.hub.cancelTooLate = true;
    h.$<HTMLButtonElement>('[data-ref="sign-in-button"]')!.click();
    await settle();
    h.$<HTMLButtonElement>('[data-ref="sign-in-cancel"]')!.click();
    await settle();
    expect(h.account().dataset.state).toBe('waiting');
    h.hub.endLogin({ status: 'signed-in', handle: 'acme' });
    h.hub.statusValue = FakeHubClient.status({ signedIn: { handle: 'acme' } });
    await h.timers.fire();
    expect(h.account().dataset.state).toBe('signed-in');
  });

  it("a hub that doesn't answer starts nothing and says so", async () => {
    const hub = new FakeHubClient();
    hub.loginRefusal = { status: 503, error: 'connect ECONNREFUSED', code: 'hub-unreachable' };
    const h = mount(hub);
    h.panel.show();
    await settle();
    h.$<HTMLButtonElement>('[data-ref="sign-in-button"]')!.click();
    await settle();
    expect(h.openExternal).not.toHaveBeenCalled();
    expect(words(h.account())).toBe('Sign in');
    expect(h.$('[data-ref="sign-in-notice"]')!.textContent).toBe('Couldn’t reach localhost:8787, so the sign-in didn’t start. Check the connection, then try again.');
    expect(h.timers.pending).toHaveLength(0);
  });
});

describe('publisher handles list their packages (H11 follow-up 2)', () => {
  async function filtered() {
    const hub = new FakeHubClient();
    hub.statusValue = FakeHubClient.status({ signedIn: { handle: 'bea-tools' } });
    hub.answer = FakeHubClient.answer([FakeHubClient.row(), FakeHubClient.row({ fullName: '@bea-tools/kit' })]);
    const h = mount(hub);
    h.panel.show();
    await settle();
    h.panel.state.setSort('newest');
    h.panel.state.flipOrder();
    h.panel.state.toggle('license', 'MIT');
    h.panel.state.toggle('units', 'metric');
    h.panel.state.setPage(2);
    await settle();
    return h;
  }

  function expectPublisherSearch(h: ReturnType<typeof mount>, handle: string) {
    expect(h.panel.currentView).toBe('search');
    expect(h.hub.search.mock.calls.at(-1)![0]).toEqual({
      q: `@${handle}`, contents: [], units: [], license: [], sort: 'newest', order: 'asc', page: 1,
    });
    expect(h.$<HTMLInputElement>('[data-ref="query"]')!.value).toBe(`@${handle}`);
  }

  it("a result's @scope searches for the publisher, resets the filters and the page, keeps the sort, and doesn't open the package", async () => {
    const h = await filtered();
    const scope = h.$('[data-package="@bea-tools/kit"] [data-ref="publisher"]') as HTMLButtonElement;
    expect(scope.tagName).toBe('BUTTON');
    expect(scope.textContent).toBe('@bea-tools');
    expect(scope.getAttribute('aria-label')).toBe('Show @bea-tools’s packages');
    scope.click();
    await settle();
    expectPublisherSearch(h, 'bea-tools');
    expect(h.hub.package).not.toHaveBeenCalled();
  });

  it("the detail's @scope goes back to the results for that publisher", async () => {
    const h = await filtered();
    await h.panel.openPackage('@acme/feature-tests');
    await settle();
    expect(h.panel.currentView).toBe('package');
    h.$<HTMLButtonElement>('[data-role="hub-package"] [data-ref="name"] [data-ref="publisher"]')!.click();
    await settle();
    expectPublisherSearch(h, 'acme');
    expect(h.$('[data-role="hub-package"]')!.classList.contains('hidden')).toBe(true);
  });

  it("the header's own handle is not one of them: it lists nothing", async () => {
    const h = await filtered();
    const searches = h.hub.search.mock.calls.length;
    expect(h.$('[data-ref="account"] [data-ref="publisher"]')).toBeNull();
    h.$<HTMLButtonElement>('[data-ref="account-button"]')!.click();
    await settle();
    expect(h.hub.search.mock.calls.length).toBe(searches);
    expect(h.$<HTMLInputElement>('[data-ref="query"]')!.value).toBe('');
    h.panel.destroy();
  });
});

describe('your handle opens the account menu, with Sign out (H11 follow-up 3)', () => {
  async function signedIn(handle = 'acme') {
    const hub = new FakeHubClient();
    hub.statusValue = FakeHubClient.status({ signedIn: { handle } });
    const h = mount(hub);
    h.panel.show();
    await settle();
    const button = () => h.$<HTMLButtonElement>('[data-ref="account-button"]')!;
    const menu = () => h.$('[data-ref="account-menu"]');
    const signOut = () => h.$<HTMLButtonElement>('[data-ref="account-menu"] [data-ref="sign-out"]')!;
    return { ...h, button, menu, signOut };
  }

  function key(target: EventTarget, key: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  }

  it('the handle is a menu button: a click opens Sign out with the focus on it, a second click closes it', async () => {
    const h = await signedIn();
    const button = h.button();
    expect(words(button)).toBe('@acme');
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.title).toBe('Signed in to localhost:8787 as @acme');
    expect(h.menu()).toBeNull();

    button.click();
    expect(h.menu()!.getAttribute('role')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const items = h.menu()!.querySelectorAll('[role="menuitem"]');
    expect([...items].map((item) => words(item))).toEqual(['Sign out']);
    expect(document.activeElement).toBe(h.signOut());
    expect(h.signOut().title).toBe('Revokes this computer’s token on localhost:8787 and forgets it');

    button.click();
    expect(h.menu()).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(h.hub.logout).not.toHaveBeenCalled();
  });

  it('Escape closes it, hands the focus back to the handle and goes no further; a press outside closes it too', async () => {
    const h = await signedIn();
    const beyond = vi.fn();
    document.addEventListener('keydown', beyond);
    try {
      h.button().click();
      const escape = key(h.signOut(), 'Escape');
      expect(escape.defaultPrevented).toBe(true);
      expect(beyond).not.toHaveBeenCalled();
      expect(h.menu()).toBeNull();
      expect(document.activeElement).toBe(h.button());
      expect(h.button().getAttribute('aria-expanded')).toBe('false');

      // Closed, Escape is the page's again.
      key(h.button(), 'Escape');
      expect(beyond).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', beyond);
    }

    h.button().click();
    h.$('[data-ref="query"]')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(h.menu()).toBeNull();
    expect(h.hub.logout).not.toHaveBeenCalled();
  });

  it('the keyboard: ArrowDown on the handle opens it, the arrows stay on its rows, Tab closes it', async () => {
    const h = await signedIn();
    h.button().focus();
    expect(key(h.button(), 'ArrowDown').defaultPrevented).toBe(true);
    expect(h.menu()).not.toBeNull();
    expect(document.activeElement).toBe(h.signOut());
    for (const name of ['ArrowDown', 'ArrowUp', 'End', 'Home']) {
      expect(key(h.signOut(), name).defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(h.signOut());
    }
    key(h.signOut(), 'Tab');
    expect(h.menu()).toBeNull();
    expect(h.hub.logout).not.toHaveBeenCalled();
  });

  it('a status read landing while it shows keeps it open under the new button, the focus where it was', async () => {
    const h = await signedIn();
    // Opened again: the last status shows at once, the new one is still on its way.
    h.panel.close();
    let release!: () => void;
    h.hub.status.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ ok: true, status: h.hub.statusValue });
    }));
    h.panel.show();
    const before = h.button();
    before.click();
    expect(document.activeElement).toBe(h.signOut());
    release();
    await settle();
    expect(h.button()).not.toBe(before);
    expect(h.menu()!.parentElement).toBe(h.account());
    expect(h.button().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(h.signOut());
  });

  it('the focus leaving it closes it, and the search field keeps its keys', async () => {
    const h = await signedIn();
    h.button().click();
    const query = h.$<HTMLInputElement>('[data-ref="query"]')!;
    query.focus();
    expect(h.menu()).toBeNull();
    h.button().click();
    // A redrawn header drops the focus to nowhere: still open.
    h.signOut().blur();
    expect(h.menu()).not.toBeNull();
    // The rows' keys are the rows' only: the search field keeps Home and End.
    for (const name of ['Home', 'End', 'ArrowDown']) {
      expect(key(query, name).defaultPrevented).toBe(false);
    }
    expect(h.menu()).not.toBeNull();
    h.button().click();
    expect(h.menu()).toBeNull();
  });

  it('Sign out: "Signing out…", then Sign in, and an open package is read again for nobody', async () => {
    const h = await signedIn();
    h.hub.versions.set('@acme/feature-tests@0.1.1', FakeHubClient.version());
    await h.panel.openPackage('@acme/feature-tests');
    await settle();
    // A feature's parameters, read with the account's token.
    h.$<HTMLButtonElement>('[data-feature="fastener"] button')!.click();
    await settle();
    expect(h.hub.version).toHaveBeenCalledTimes(1);
    const packageReads = h.hub.package.mock.calls.length;
    let release!: () => void;
    h.hub.logoutGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    h.button().click();
    h.signOut().click();
    await settle();
    expect(h.menu()).toBeNull();
    expect(h.hub.logout).toHaveBeenCalledTimes(1);
    expect(h.account().dataset.state).toBe('signing-out');
    expect(words(h.account())).toBe('Signing out…');
    expect(h.$('[data-ref="account-button"]')).toBeNull();

    const statusReads = h.hub.status.mock.calls.length;
    release();
    await settle();
    expect(h.hub.status.mock.calls.length).toBe(statusReads + 1);
    expect(h.account().dataset.state).toBe('signed-out');
    expect(words(h.account())).toBe('Sign in');
    expect(h.strip().classList.contains('hidden')).toBe(true);
    expect(h.hub.package.mock.calls.length).toBe(packageReads + 1);
    expect(h.panel.currentView).toBe('package');
    // The open feature's version is read again, not answered from what the account saw.
    expect(h.hub.version).toHaveBeenCalledTimes(2);
    expect(h.$('[data-feature="fastener"] [data-param]')).not.toBeNull();
    // Nothing was searched for the account.
    expect(h.hub.search.mock.calls.every(([params]) => params.q === '')).toBe(true);
  });

  it("a token the hub couldn't revoke is said, with no Try again", async () => {
    for (const [result, text] of [
      [
        { outcome: 'not-revoked', unreachable: true, reason: 'Couldn’t reach http://localhost:8787: connect ECONNREFUSED.' },
        'Signed out on this computer, but localhost:8787 didn’t answer, so the token wasn’t revoked. It stays valid on the hub until it’s revoked there or goes unused for a year.',
      ],
      [
        { outcome: 'not-revoked', unreachable: false, reason: 'http://localhost:8787 answered with HTTP 403.' },
        'Signed out on this computer, but localhost:8787 didn’t revoke the token: http://localhost:8787 answered with HTTP 403. It stays valid on the hub until it’s revoked there or goes unused for a year.',
      ],
    ] as const) {
      const h = await signedIn();
      h.hub.logoutResult = result;
      h.button().click();
      h.signOut().click();
      await settle();
      expect(words(h.account())).toBe('Sign in');
      expect(h.strip().dataset.state).toBe('ended');
      expect(h.$('[data-ref="sign-in-notice"]')!.textContent).toBe(text);
      expect(h.strip().querySelector('.text-warning')).not.toBeNull();
      expect(h.$('[data-ref="sign-in-retry"]')).toBeNull();
      h.$<HTMLButtonElement>('[data-ref="sign-in-dismiss"]')!.click();
      expect(h.strip().classList.contains('hidden')).toBe(true);
    }
  });

  it('FLUIDCAD_HUB_TOKEN still signing in is said, and the header still shows who', async () => {
    const h = await signedIn();
    h.hub.logoutResult = { envToken: true };
    h.button().click();
    h.signOut().click();
    await settle();
    expect(h.account().dataset.state).toBe('signed-in');
    expect(h.$('[data-ref="sign-in-notice"]')!.textContent).toBe(
      'FLUIDCAD_HUB_TOKEN is still set where FluidCAD runs, so it still signs in with that token. Unset it and restart FluidCAD to stop.',
    );
    expect(h.$('[data-ref="sign-in-retry"]')).toBeNull();
  });

  it("an engine that didn't sign out leaves you signed in, and says so", async () => {
    const h = await signedIn();
    h.hub.logoutRefusal = { status: 0, error: 'The engine didn’t answer: Failed to fetch' };
    const statusReads = h.hub.status.mock.calls.length;
    h.button().click();
    h.signOut().click();
    await settle();
    expect(h.account().dataset.state).toBe('signed-in');
    expect(words(h.button())).toBe('@acme');
    expect(h.hub.status.mock.calls.length).toBe(statusReads);
    expect(h.$('[data-ref="sign-in-notice"]')!.textContent).toBe('Couldn’t sign out: The engine didn’t answer: Failed to fetch');
    expect(h.strip().querySelector('.text-error')).not.toBeNull();
    expect(h.$('[data-ref="sign-in-retry"]')).toBeNull();
  });

  it('an account without a handle yet still gets the menu', async () => {
    const hub = new FakeHubClient();
    hub.statusValue = FakeHubClient.status({ signedIn: { handle: null } });
    const h = mount(hub);
    h.panel.show();
    await settle();
    const button = h.$<HTMLButtonElement>('[data-ref="account-button"]')!;
    expect(words(button)).toBe('Signed in');
    button.click();
    expect(h.$('[data-ref="account-menu"] [data-ref="sign-out"]')).not.toBeNull();
    h.panel.destroy();
    // Destroyed with the menu open: it leaves no listener behind.
    const beyond = vi.fn();
    document.addEventListener('keydown', beyond);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.removeEventListener('keydown', beyond);
    expect(beyond).toHaveBeenCalledTimes(1);
  });
});

describe("the missing-package banner's Install from the hub", () => {
  it('downloads the pinned version, asks for consent, installs it pinned, and never opens the panel', async () => {
    const hub = new FakeHubClient();
    const packages = new FakePackagesClient();
    const consent = new PackageConsentDialog(document.body, packages);
    const busy: boolean[] = [];
    const onInstalled = vi.fn();
    const install = new HubMissingInstall({
      hub,
      consent,
      installSetting: () => 'library',
      projectOpen: () => true,
      onBusy: (b) => busy.push(b),
      onError: vi.fn(),
      onInstalled,
    });
    const running = install.run({ name: '@acme/feature-tests', version: '0.1.0' });
    await settle();
    expect(hub.inspect).toHaveBeenCalledWith({ name: '@acme/feature-tests', version: '0.1.0', target: 'library' });
    expect(busy).toEqual([true, false]);
    const overlay = document.querySelector<HTMLElement>('[data-role="package-consent"]')!;
    expect(overlay.classList.contains('hidden')).toBe(false);
    expect(packages.install).not.toHaveBeenCalled();
    overlay.querySelector<HTMLButtonElement>('[data-ref="install"]')!.click();
    await running;
    expect(packages.install).toHaveBeenCalledWith({ token: 'token-@acme/feature-tests-0.1.0-library', target: 'library', replace: false, pin: true });
    expect(onInstalled).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-role="hub-panel"]')).toBeNull();
    consent.destroy();
  });

  it("says it couldn't reach the hub, with no dialog", async () => {
    const hub = new FakeHubClient();
    hub.inspectRefusal = { status: 503, error: 'ECONNREFUSED', code: 'hub-unreachable' };
    const packages = new FakePackagesClient();
    const consent = new PackageConsentDialog(document.body, packages);
    const onError = vi.fn();
    const install = new HubMissingInstall({ hub, consent, installSetting: () => 'library', projectOpen: () => true, onError, onInstalled: vi.fn() });
    expect(await install.run({ name: '@acme/kit', version: '0.1.0' })).toBeNull();
    expect(onError).toHaveBeenCalledWith("Couldn't reach the hub to download @acme/kit 0.1.0. Check the connection and try again.");
    expect(consent.isOpen()).toBe(false);
    consent.destroy();
  });
});

describe('ExternalLinks', () => {
  it('opens a web page itself when the page is on its own, and only http(s)', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await ExternalLinks.open('http://localhost:8787/@acme/kit');
    await ExternalLinks.open('javascript:alert(1)');
    expect(open.mock.calls).toEqual([['http://localhost:8787/@acme/kit', '_blank', 'noopener,noreferrer']]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('asks the host through the engine when framed (VS Code), and opens it itself when no host took it', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    vi.spyOn(window, 'parent', 'get').mockReturnValue({} as Window);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ delivered: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await ExternalLinks.open('https://hub.fluidcad.io/@acme/kit?model=parts%2Fa.part.js');
    expect(fetch).toHaveBeenCalledWith('api/host/open-external', expect.objectContaining({ method: 'POST', body: JSON.stringify({ url: 'https://hub.fluidcad.io/@acme/kit?model=parts%2Fa.part.js' }) }));
    expect(open).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ delivered: false }), { status: 200 }));
    await ExternalLinks.open('https://hub.fluidcad.io/@acme/kit');
    expect(open).toHaveBeenCalledWith('https://hub.fluidcad.io/@acme/kit', '_blank', 'noopener,noreferrer');
  });
});
