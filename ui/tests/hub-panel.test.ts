// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HubPanel } from '../src/ui/hub/hub-panel';
import { HubMissingInstall } from '../src/ui/hub/hub-missing-install';
import { ExternalLinks } from '../src/ui/external-links';
import { PackageConsentDialog } from '../src/ui/packages/package-consent-dialog';
import { FakeHubClient } from './fixtures/fake-hub-client';
import { FakePackagesClient, settle } from './fixtures/fake-packages-client';

// The Hub panel as the page mounts it (hub-plan H11): one slot with the
// code editor (decision 5), the header naming the hub and who is signed in,
// the search → package → Results round trip, the marks read again after an
// install; then the missing-package banner's Install from the hub (consent,
// never the panel) and links leaving through the host.

const panels: HubPanel[] = [];

afterEach(() => {
  for (const panel of panels.splice(0)) {
    panel.destroy();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty('--fluidcad-editor-width');
  document.body.innerHTML = '';
});

function mount(hub = new FakeHubClient()) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  hub.packages.set('@acme/feature-tests', FakeHubClient.pkg());
  const events: string[] = [];
  const onPackagesChanged = vi.fn();
  const onWidthChange = vi.fn();
  const panel = new HubPanel({
    container,
    hub,
    packages: new FakePackagesClient(),
    installSetting: () => 'library',
    projectOpen: () => true,
    openExternal: vi.fn(),
    onPackagesChanged,
    width: () => 500,
    onWidthChange,
    onTakeSlot: () => events.push('editor closed'),
    onOpenChange: (open) => events.push(open ? 'hub open' : 'hub closed'),
    timers: { set: () => null, clear: () => undefined },
  });
  panels.push(panel);
  const width = () => document.documentElement.style.getPropertyValue('--fluidcad-editor-width');
  return { hub, panel, container, events, width, onPackagesChanged, onWidthChange };
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

  it('names the hub and who is signed in, and searches on its first open only', async () => {
    const hub = new FakeHubClient();
    hub.statusValue = FakeHubClient.status({ signedIn: { handle: 'acme' } });
    const h = mount(hub);
    h.panel.show();
    await settle();
    expect(h.panel.el.querySelector('[data-ref="hub-host"]')!.textContent).toBe('localhost:8787');
    expect(h.panel.el.querySelector('[data-ref="account"]')!.textContent!.trim()).toBe('@acme');
    expect(hub.search).toHaveBeenCalledTimes(1);
    h.panel.close();
    h.panel.show();
    await settle();
    expect(hub.search).toHaveBeenCalledTimes(1);

    hub.statusValue = FakeHubClient.status();
    h.panel.close();
    h.panel.show();
    await settle();
    expect(h.panel.el.querySelector('[data-ref="account"]')!.textContent).toBe('Not signed in');
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
