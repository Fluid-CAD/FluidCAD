// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectPackagesDialog } from '../src/ui/packages/project-packages-dialog';
import { PackageInstallFlow } from '../src/ui/packages/package-install-flow';
import { PackagesState } from '../src/ui/packages/packages-state';
import { ErrorBanner } from '../src/ui/error-banner';
import { FakePackagesClient, settle } from './fixtures/fake-packages-client';

// The project's Packages dialog: the pins with where each loads from, Copy
// into project / Use from library, the missing-package banner with Install
// from file… (checked against the pin), and the "update available" chip.
// Then the render's own missing-package banner (the error banner's action).

const opened: { dialog: ProjectPackagesDialog; flow: PackageInstallFlow }[] = [];

afterEach(() => {
  for (const { dialog, flow } of opened.splice(0)) {
    dialog.destroy();
    flow.consent.destroy();
  }
  document.body.innerHTML = '';
});

const PINS = FakePackagesClient.overview({
  pins: [
    { name: '@acme/feature-tests', version: '0.1.0', integrity: 'sha256-a', availability: 'library', directory: '/lib/@acme/feature-tests/0.1.0' },
    { name: '@acme/kit', version: '0.1.0', integrity: 'sha256-b', availability: 'project', directory: '/ws/packages/@acme/kit/0.1.0' },
    { name: '@beta/gears', version: '1.2.0', integrity: 'sha256-c', availability: 'missing', directory: null },
  ],
  updates: { '@acme/feature-tests': '0.2.0' },
});

async function mount(overview = PINS) {
  const client = new FakePackagesClient(overview);
  const state = new PackagesState(client);
  const flow = new PackageInstallFlow(document.body, { client, state, onInstalled: vi.fn(), notify: vi.fn() });
  const onChanged = vi.fn();
  const dialog = new ProjectPackagesDialog(document.body, { state, flow, onChanged });
  opened.push({ dialog, flow });
  dialog.show();
  await settle();
  const overlay = document.body.querySelector<HTMLElement>('[data-role="project-packages"]')!;
  const pin = (name: string) => overlay.querySelector<HTMLElement>(`[data-pin="${name}"]`)!;
  return { client, state, flow, dialog, overlay, pin, onChanged };
}

describe('the project\'s Packages', () => {
  it('lists each pin with where it loads from, and an update chip for a newer library version', async () => {
    const h = await mount();
    expect([...h.overlay.querySelectorAll<HTMLElement>('[data-pin]')].map((row) => row.dataset.pin))
      .toEqual(['@acme/feature-tests', '@acme/kit', '@beta/gears']);
    expect(h.pin('@acme/feature-tests').querySelector('[data-ref="where"]')!.textContent).toBe('From your library');
    expect(h.pin('@acme/kit').querySelector('[data-ref="where"]')!.textContent).toBe("Copied into this project's packages/ folder");
    expect(h.pin('@beta/gears').querySelector('[data-ref="where"]')!.textContent).toBe('Not installed');
    expect(h.pin('@acme/feature-tests').querySelector('[data-ref="update"]')!.textContent).toBe('0.2.0 available');
    expect(h.pin('@acme/kit').querySelector('[data-ref="update"]')).toBeNull();
    expect(h.pin('@acme/feature-tests').querySelector('[data-action="copy-into-project"]')).not.toBeNull();
    expect(h.pin('@acme/kit').querySelector('[data-action="use-from-library"]')).not.toBeNull();
    expect(h.pin('@beta/gears').querySelector('button')).toBeNull();
  });

  it('leads with the missing-package banner, whose Install from file… is checked against the pin', async () => {
    const h = await mount();
    const banner = h.overlay.querySelector<HTMLElement>('[data-missing="@beta/gears"]')!;
    expect(banner.textContent).toContain("This project uses @beta/gears 1.2.0, which isn't installed.");
    const pick = vi.spyOn(h.flow, 'pick').mockImplementation(() => {});
    banner.querySelector<HTMLButtonElement>('[data-action="install-missing"]')!.click();
    expect(pick).toHaveBeenCalledWith({ expect: { name: '@beta/gears', version: '1.2.0' } });
    h.overlay.querySelector<HTMLButtonElement>('[data-ref="install"]')!.click();
    expect(pick).toHaveBeenLastCalledWith();
  });

  it('copies a library pin into the project, then refetches and lets the scene follow', async () => {
    const h = await mount();
    h.pin('@acme/feature-tests').querySelector<HTMLButtonElement>('[data-action="copy-into-project"]')!.click();
    await settle();
    expect(h.client.copy).toHaveBeenCalledWith('@acme/feature-tests', '0.1.0', 'project');
    expect(h.onChanged).toHaveBeenCalledTimes(1);
    expect(h.overlay.querySelector('[data-ref="status"]')!.textContent).toContain('Copied @acme/feature-tests 0.1.0 into packages/.');
  });

  it('uses a project copy from the library: the library gets the tree first, then the copy goes', async () => {
    const h = await mount();
    h.pin('@acme/kit').querySelector<HTMLButtonElement>('[data-action="use-from-library"]')!.click();
    await settle();
    expect(h.client.copy).toHaveBeenCalledWith('@acme/kit', '0.1.0', 'library');
    expect(h.client.remove).toHaveBeenCalledWith('@acme/kit', '0.1.0', 'project');
    expect(h.client.copy.mock.invocationCallOrder[0]).toBeLessThan(h.client.remove.mock.invocationCallOrder[0]);
    expect(h.onChanged).toHaveBeenCalledTimes(1);
  });

  it('keeps the project copy when the library holds other contents under that version', async () => {
    const h = await mount();
    h.client.copy.mockResolvedValueOnce({ ok: false, status: 409, code: 'conflict', error: '@acme/kit 0.1.0 is already in your library with different contents.' } as any);
    h.pin('@acme/kit').querySelector<HTMLButtonElement>('[data-action="use-from-library"]')!.click();
    await settle();
    expect(h.client.remove).not.toHaveBeenCalled();
    const status = h.overlay.querySelector<HTMLElement>('[data-ref="status"]')!;
    expect(status.textContent).toBe('@acme/kit 0.1.0 is already in your library with different contents. The copy in this project stays.');
    expect(status.className).toContain('text-error');
  });

  it('says so when the project uses no packages', async () => {
    const h = await mount(FakePackagesClient.overview({ pins: [] }));
    expect(h.overlay.querySelector('[data-ref="empty"]')!.textContent).toContain('This project uses no packages yet.');
    expect(h.overlay.querySelector<HTMLElement>('[data-ref="banner"]')!.classList.contains('hidden')).toBe(true);
  });
});

describe('the render\'s missing-package banner', () => {
  it('offers Install from file… on a compile error naming a missing pin, and nothing on other errors', () => {
    const banner = new ErrorBanner(document.body, () => {});
    const install = vi.fn();
    banner.setInstallMissingHandler(install);
    const button = document.body.querySelector<HTMLButtonElement>('[data-ref="install-missing"]')!;
    banner.update([], {
      message: "This project uses `@acme/feature-tests` 0.1.0, which isn't installed.",
      packageProblems: [{ code: 'missing', name: '@acme/feature-tests', version: '0.1.0', message: '…' }],
    });
    expect(button.classList.contains('hidden')).toBe(false);
    button.click();
    expect(install).toHaveBeenCalledWith({ name: '@acme/feature-tests', version: '0.1.0' });

    banner.update([], { message: 'SyntaxError: Unexpected token' });
    expect(button.classList.contains('hidden')).toBe(true);
    banner.update([], { message: 'integrity', packageProblems: [{ code: 'integrity', name: '@acme/x', version: '1.0.0', message: '…' }] });
    expect(button.classList.contains('hidden')).toBe(true);
  });
});
