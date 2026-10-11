// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsModal } from '../src/ui/settings/settings-modal';
import { packageSettings } from '../src/ui/settings/package-settings';
import { PackagesState } from '../src/ui/packages/packages-state';
import type { UserPreferences } from '../src/api';
import { FakePackagesClient, settle } from './fixtures/fake-packages-client';

// Settings → Packages: the library folder (a text field the engine checks
// on Save, Browse… in the desktop app), "New packages go to", the library's
// packages with Remove, and the copy offered after the folder changed. No
// install button: packages install only from the hub (HD31) until the Hub
// panel (H11). Drafts like every tab; Remove and the copy act at once.

afterEach(() => {
  packageSettings.update({ libraryPath: '', installTarget: 'library' });
  delete (window as any).fluidcadDesktop;
  document.body.innerHTML = '';
});

function mount(client = new FakePackagesClient()) {
  const state = new PackagesState(client);
  const onLibraryChanged = vi.fn();
  const savePreference = vi.fn();
  const modal = new SettingsModal(document.body, {
    savePreference,
    resetPreferences: vi.fn(async (): Promise<UserPreferences | null> => null),
    applyPreferences: vi.fn(),
    packages: { state, onLibraryChanged },
  });
  modal.show('packages');
  const overlay = document.body.querySelector<HTMLElement>('[aria-label="Settings"]')!;
  const tab = overlay.querySelector<HTMLElement>('[data-panel="packages"]')!;
  const ref = <T extends HTMLElement>(name: string) => tab.querySelector<T>(`[data-ref="${name}"]`)!;
  const dot = () => !overlay.querySelector('[data-tab="packages"] [data-dirty]')!.classList.contains('hidden');
  const save = () => overlay.querySelector<HTMLButtonElement>('[data-ref="save"]')!;
  const type = (value: string) => {
    const input = ref<HTMLInputElement>('library-path');
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };
  return { client, state, modal, overlay, tab, ref, dot, save, type, onLibraryChanged, savePreference };
}

describe('Settings → Packages', () => {
  it('lists the library with versions, contents and sizes, and the folder in use', async () => {
    const client = new FakePackagesClient(FakePackagesClient.overview({
      library: {
        path: '/home/me/.fluidcad/packages', source: 'default',
        packages: [FakePackagesClient.installed('@acme/kit', '0.1.0'), FakePackagesClient.installed('@acme/kit', '0.2.0'), FakePackagesClient.installed('@other/x', '1.0.0', { manifest: null, problem: "Its manifest.json can't be read." })],
      },
    }));
    const h = mount(client);
    await settle();
    const rows = [...h.ref('library-list').querySelectorAll<HTMLElement>('[data-package]')];
    expect(rows.map((row) => row.dataset.package)).toEqual(['@acme/kit@0.1.0', '@acme/kit@0.2.0', '@other/x@1.0.0']);
    expect(rows[0].textContent).toContain('2 features, 1 part · 48.6 kB');
    expect(rows[2].textContent).toContain("Its manifest.json can't be read.");
    expect(h.ref('library-hint').textContent).toContain('In use: /home/me/.fluidcad/packages (the default');
    expect(h.ref('library-path').getAttribute('placeholder')).toBe('Default folder');
  });

  it('marks the tab dirty on an edit and drops the draft on Cancel', () => {
    const h = mount();
    expect(h.dot()).toBe(false);
    h.type('/data/packages');
    expect(h.dot()).toBe(true);
    expect(h.save().disabled).toBe(false);
    h.overlay.querySelector<HTMLButtonElement>('[data-ref="cancel"]')!.click();
    h.modal.show('packages');
    expect(h.ref<HTMLInputElement>('library-path').value).toBe('');
    expect(h.dot()).toBe(false);
  });

  it('saves the library folder through the engine and follows it; the target through the preference', async () => {
    const h = mount();
    h.type('  /data/packages ');
    h.ref<HTMLSelectElement>('install-target').value = 'project';
    h.ref<HTMLSelectElement>('install-target').dispatchEvent(new Event('change'));
    h.save().click();
    expect(h.savePreference).toHaveBeenCalledWith('packageInstallTarget', 'project');
    expect(h.client.savePreferences).toHaveBeenCalledWith({ packageLibraryPath: '/data/packages' });
    await settle();
    expect(packageSettings.current).toEqual({ libraryPath: '/data/packages', installTarget: 'project' });
    expect(h.dot()).toBe(false);
    expect(h.ref('library-error').classList.contains('hidden')).toBe(true);
    expect(h.onLibraryChanged).toHaveBeenCalledTimes(1);
    // The library path never goes through the fire-and-forget save.
    expect(h.savePreference).not.toHaveBeenCalledWith('packageLibraryPath', expect.anything());
  });

  it("shows the engine's refusal of a folder and keeps the draft and the dot", async () => {
    const client = new FakePackagesClient();
    client.savePreferences.mockResolvedValueOnce({ ok: false, status: 400, error: 'The library folder must be an absolute path, not "pkgs".' } as any);
    const h = mount(client);
    h.type('pkgs');
    h.save().click();
    await settle();
    const error = h.ref('library-error');
    expect(error.classList.contains('hidden')).toBe(false);
    expect(error.textContent).toBe('The library folder must be an absolute path, not "pkgs".');
    expect(packageSettings.current.libraryPath).toBe('');
    expect(h.ref<HTMLInputElement>('library-path').value).toBe('pkgs');
    expect(h.dot()).toBe(true);
    expect(h.onLibraryChanged).not.toHaveBeenCalled();
    // Typing again clears the refusal.
    h.type('/abs/pkgs');
    expect(error.classList.contains('hidden')).toBe(true);
  });

  it('says when FLUIDCAD_PACKAGES holds the library in place', async () => {
    const h = mount(new FakePackagesClient(FakePackagesClient.overview({ library: { path: '/ci/lib', source: 'env', packages: [] } })));
    await settle();
    expect(h.ref('library-hint').textContent).toBe("FLUIDCAD_PACKAGES is set, so this engine uses /ci/lib; the folder here applies once it isn't.");
    expect(h.ref('library-list').textContent).toContain('No packages in your library yet.');
  });

  it('removes a package only after the confirmation, and refetches', async () => {
    const h = mount();
    await settle();
    const row = () => h.ref('library-list').querySelector<HTMLElement>('[data-package="@acme/kit@0.1.0"]')!;
    row().querySelector<HTMLButtonElement>('[data-action="remove"]')!.click();
    expect(h.client.remove).not.toHaveBeenCalled();
    expect(row().textContent).toContain('Projects using it will ask for it again.');
    row().querySelector<HTMLButtonElement>('[data-action="keep"]')!.click();
    expect(row().querySelector('[data-action="confirm-remove"]')).toBeNull();

    row().querySelector<HTMLButtonElement>('[data-action="remove"]')!.click();
    const fetches = h.client.overview.mock.calls.length;
    row().querySelector<HTMLButtonElement>('[data-action="confirm-remove"]')!.click();
    await settle();
    expect(h.client.remove).toHaveBeenCalledWith('@acme/kit', '0.1.0', 'library');
    expect(h.client.overview.mock.calls.length).toBeGreaterThan(fetches);
    expect(h.ref('list-status').textContent).toBe('Removed @acme/kit 0.1.0.');
    expect(h.onLibraryChanged).toHaveBeenCalled();
  });

  it('offers the old folder\'s packages after the folder changed, and copies or leaves them', async () => {
    const client = new FakePackagesClient(FakePackagesClient.overview({
      library: { path: '/new', source: 'preference', packages: [] },
      libraryOffer: { path: '/old', packages: [{ name: '@acme/kit', version: '0.1.0' }, { name: '@acme/other', version: '1.0.0' }] },
    }));
    const h = mount(client);
    await settle();
    const offer = h.ref('offer');
    expect(offer.classList.contains('hidden')).toBe(false);
    expect(offer.textContent).toContain('The folder you left, /old, still holds 2 packages (@acme/kit 0.1.0, @acme/other 1.0.0).');
    client.overviewValue = FakePackagesClient.overview({ library: { path: '/new', source: 'preference', packages: [] }, libraryOffer: null });
    offer.querySelector<HTMLButtonElement>('[data-action="copy-offer"]')!.click();
    await settle();
    expect(client.copyLibraryOffer).toHaveBeenCalledTimes(1);
    expect(h.ref('list-status').textContent).toBe('Copied 1 package into your library.');
    expect(offer.classList.contains('hidden')).toBe(true);
  });

  it('has no install button (HD31), and says where an install puts a package', async () => {
    const h = mount();
    await settle();
    expect(h.tab.querySelector('[data-ref="install"]')).toBeNull();
    expect(h.tab.textContent).not.toMatch(/Install package/);
    expect(h.tab.textContent).toContain('Where a package goes when you install it, unless you choose otherwise. This project: a copy in its packages/ folder.');
  });

  it('offers Browse… only in the desktop app, asking for a folder it may create', async () => {
    expect(mount().tab.querySelector('[data-ref="browse"]')).toBeNull();
    document.body.innerHTML = '';
    const showOpenDialog = vi.fn(async () => ['/Volumes/Team/packages']);
    (window as any).fluidcadDesktop = { isDesktop: true, showOpenDialog };
    const h = mount();
    await settle();
    h.ref<HTMLButtonElement>('browse').click();
    await settle();
    expect(showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ properties: ['openDirectory', 'createDirectory'], defaultPath: '/lib' }));
    expect(h.ref<HTMLInputElement>('library-path').value).toBe('/Volumes/Team/packages');
    expect(h.dot()).toBe(true);
  });
});
