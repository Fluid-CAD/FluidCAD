import { describe, expect, it, vi } from 'vitest';
import { chooseStartHost } from '../../src/start/choose-host';
import { ContractError } from '../../src/start/contract-guards';
import type { StartScreenBridge, StartScreenHost } from '../../src/start/host';

function bridge(overrides: Partial<StartScreenBridge> = {}): StartScreenBridge {
  const noop = vi.fn(async () => undefined);
  return {
    hello: vi.fn(async () => ({ ok: true, appVersion: '0.0.45', platform: 'linux', home: '/h' })),
    windowState: vi.fn(async () => ({ phase: 'home' })),
    onWindowState: vi.fn(),
    cancelOpen: noop,
    retryOpen: noop,
    appearance: vi.fn(async () => ({ theme: 'fluidcad-dark' })),
    list: vi.fn(async () => ({ projects: [] })),
    feed: vi.fn(async () => ({ tutorials: [], notifications: [] })),
    dismissNotification: noop,
    open: noop,
    openDialog: noop,
    newProject: noop,
    close: vi.fn(async () => ({ ok: true })),
    forget: noop,
    openLink: noop,
    engineOptions: noop,
    previewUpgrade: noop,
    applyPin: noop,
    onUpgradeProgress: vi.fn(),
    onChanged: vi.fn(),
    ...overrides,
  };
}

describe('chooseStartHost', () => {
  it('uses the desktop bridge whenever it is there, with replies checked', async () => {
    const loadFixture = vi.fn();
    const host = await chooseStartHost({
      bridge: bridge({ list: vi.fn(async () => ({ projects: 'nope' })) }),
      search: '?host=fixture',
      loadFixture,
      loadHttp: vi.fn(),
    });
    expect(host).not.toBeNull();
    expect(loadFixture).not.toHaveBeenCalled();
    await expect(host!.hello(1)).resolves.toMatchObject({ ok: true });
    await expect(host!.list()).rejects.toBeInstanceOf(ContractError);
  });

  it('checks pushed window states before the page sees them', async () => {
    let push: (state: unknown) => void = () => undefined;
    const host = await chooseStartHost({
      bridge: bridge({ onWindowState: (handler: (state: unknown) => void) => (push = handler) }),
      search: '',
      loadFixture: null,
      loadHttp: null,
    });
    const seen: unknown[] = [];
    host!.onWindowState((state) => seen.push(state));
    push({ phase: 'home' });
    expect(seen).toEqual([{ phase: 'home' }]);
    expect(() => push({ phase: 'elsewhere' })).toThrow(ContractError);
  });

  it('loads the fixture only in a dev build that asks for it', async () => {
    const fixture = {} as StartScreenHost;
    const loadFixture = vi.fn(async () => fixture);
    expect(await chooseStartHost({ bridge: undefined, search: '?host=fixture&recents=0', loadFixture, loadHttp: null })).toBe(fixture);
    expect(loadFixture.mock.calls[0][0].get('recents')).toBe('0');
    expect(await chooseStartHost({ bridge: undefined, search: '', loadFixture, loadHttp: null })).toBeNull();
    expect(await chooseStartHost({ bridge: undefined, search: '?host=fixture', loadFixture: null, loadHttp: null })).toBeNull();
  });

  it("talks to npx fluidcad's start server when the page came over http, and the desktop bridge is not there", async () => {
    const http = {} as StartScreenHost;
    const loadHttp = vi.fn(() => http);
    expect(await chooseStartHost({ bridge: undefined, search: '?project=%2Fhome%2Fyou%2Fcad%2Fbracket', loadFixture: null, loadHttp })).toBe(http);
    // The desktop bridge wins wherever the page came from.
    expect(await chooseStartHost({ bridge: bridge(), search: '', loadFixture: null, loadHttp })).not.toBe(http);
    // A dev build asking for the fixture gets it, not the start server.
    const fixture = {} as StartScreenHost;
    expect(await chooseStartHost({ bridge: undefined, search: '?host=fixture', loadFixture: async () => fixture, loadHttp })).toBe(fixture);
    expect(loadHttp).toHaveBeenCalledTimes(1);
  });

  it('turns the bridge\'s own dialog calls into native dialogs', async () => {
    const openDialog = vi.fn(async () => undefined);
    const newProject = vi.fn(async () => undefined);
    const host = await chooseStartHost({ bridge: bridge({ openDialog, newProject }), search: '', loadFixture: null, loadHttp: null });
    expect(host!.dialogs.kind).toBe('native');
    if (host!.dialogs.kind === 'native') {
      await host!.dialogs.open();
      await host!.dialogs.create();
    }
    expect(openDialog).toHaveBeenCalledTimes(1);
    expect(newProject).toHaveBeenCalledTimes(1);
  });
});
