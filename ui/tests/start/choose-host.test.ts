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
    expect(await chooseStartHost({ bridge: undefined, search: '?host=fixture&recents=0', loadFixture })).toBe(fixture);
    expect(loadFixture.mock.calls[0][0].get('recents')).toBe('0');
    expect(await chooseStartHost({ bridge: undefined, search: '', loadFixture })).toBeNull();
    expect(await chooseStartHost({ bridge: undefined, search: '?host=fixture', loadFixture: null })).toBeNull();
  });
});
