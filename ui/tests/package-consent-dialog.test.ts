// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PackageTarget } from '../src/api';
import { PackageConsentDialog } from '../src/ui/packages/package-consent-dialog';
import { FakePackagesClient, settle } from './fixtures/fake-packages-client';

// The consent step an install from the page goes through (from H11, a hub
// download; packages install only from the hub, HD31): what the dialog
// shows of an inspected archive, its states (review, installing, conflict
// → Replace, error), and Cancel discarding the inspection. A Replace asks
// the caller for a fresh inspection (`reinspect`), here a fake.

const dialogs: PackageConsentDialog[] = [];

afterEach(() => {
  for (const dialog of dialogs.splice(0)) {
    dialog.destroy();
  }
  document.body.innerHTML = '';
});

/** The caller's fresh inspection for a Replace: `token-2`, for whichever target. */
function reinspect() {
  return vi.fn(async (_target: PackageTarget) => ({ ok: true as const, inspection: FakePackagesClient.inspection({ token: 'token-2' }) }));
}

function mountDialog(client = new FakePackagesClient()) {
  const dialog = new PackageConsentDialog(document.body, client);
  dialogs.push(dialog);
  const overlay = document.body.querySelector<HTMLElement>('[data-role="package-consent"]')!;
  const ref = <T extends HTMLElement>(name: string) => overlay.querySelector<T>(`[data-ref="${name}"]`)!;
  return { client, dialog, overlay, ref };
}

describe('PackageConsentDialog', () => {
  it('shows the name, version, description, features with icons, parts, engine, warnings and the permissions line', () => {
    const h = mountDialog();
    void h.dialog.open({ inspection: FakePackagesClient.inspection(), reinspect: reinspect(), projectOpen: true });
    expect(h.dialog.isOpen()).toBe(true);
    expect(h.overlay.dataset.state).toBe('review');
    // The package's one name (HD30): no second name it installs under.
    expect(h.ref('name').textContent).toBe('@acme/kit');
    expect(h.overlay.querySelector('[data-ref="installs-as"]')).toBeNull();
    expect(h.overlay.textContent).not.toMatch(/Installs as/);
    expect(h.ref('version').textContent).toBe('0.1.0');
    expect(h.ref('description').textContent).toBe('Standoffs and spacers');
    const features = [...h.ref('features').querySelectorAll<HTMLElement>('[data-feature-id]')];
    expect(features.map((row) => row.dataset.featureId)).toEqual(['standoff', 'twist']);
    expect(features[0].querySelector('img')!.getAttribute('src')).toBe('icon/token-1/standoff');
    expect(features[1].querySelector('img')!.getAttribute('src')).toContain('icons/solid.png');
    // twist reaches raw OpenCascade (usesOcct): the dialog says nothing about it.
    expect(features[1].textContent).toBe('Twisttwist');
    expect(h.overlay.querySelector('[data-ref="occt"]')).toBeNull();
    expect(h.overlay.textContent).not.toMatch(/OpenCascade/i);
    expect(h.ref('parts').textContent).toContain('Spacer');
    expect(h.ref('engine').textContent).toBe('Needs FluidCAD 0.0.45 or newer (packed on 0.0.46). 6 files, 48.6 kB.');
    expect(h.overlay.querySelector('[data-warning="sdk-version"]')!.textContent!.trim()).toBe('Built against a newer feature SDK (version 2); this engine has version 1.');
    expect(h.overlay.querySelector('[data-warning="uses-occt"]')).toBeNull();
    expect(h.ref('trust').textContent).toBe("A package's code runs in the FluidCAD engine with your permissions. Install only packages you trust.");
    const targets = [...h.overlay.querySelectorAll<HTMLInputElement>('input[name="package-target"]')];
    expect(targets.map((input) => [input.value, input.checked, input.disabled])).toEqual([['library', true, false], ['project', false, false]]);
  });

  it("can't target the project without one, and opens on the setting's target with one", () => {
    const h = mountDialog();
    void h.dialog.open({ inspection: FakePackagesClient.inspection({ defaultTarget: 'project' }), reinspect: reinspect(), projectOpen: false });
    const project = h.overlay.querySelector<HTMLInputElement>('input[value="project"]')!;
    expect(project.disabled).toBe(true);
    expect(h.overlay.querySelector<HTMLInputElement>('input[value="library"]')!.checked).toBe(true);
    void h.dialog.open({ inspection: FakePackagesClient.inspection({ defaultTarget: 'project' }), reinspect: reinspect(), projectOpen: true });
    expect(h.overlay.querySelector<HTMLInputElement>('input[value="project"]')!.checked).toBe(true);
  });

  it('installs into the chosen target and resolves with the outcome', async () => {
    const h = mountDialog();
    const done = h.dialog.open({ inspection: FakePackagesClient.inspection(), reinspect: reinspect(), projectOpen: true });
    const project = h.overlay.querySelector<HTMLInputElement>('input[value="project"]')!;
    project.checked = true;
    project.dispatchEvent(new Event('change'));
    h.ref<HTMLButtonElement>('install').click();
    expect(h.overlay.dataset.state).toBe('installing');
    expect(h.ref<HTMLButtonElement>('install').disabled).toBe(true);
    const outcome = await done;
    expect(h.client.install).toHaveBeenCalledWith({ token: 'token-1', target: 'project', replace: false, pin: false });
    expect(outcome).toMatchObject({ status: 'installed', target: 'project' });
    expect(h.dialog.isOpen()).toBe(false);
    expect(h.client.discard).not.toHaveBeenCalled();
  });

  it('offers Replace on a conflict, asking the caller for a fresh inspection for the chosen target before replacing', async () => {
    const client = new FakePackagesClient();
    client.install.mockResolvedValueOnce({ ok: false, status: 409, code: 'conflict', error: '@acme/kit 0.1.0 is already in your library with different contents.' } as any);
    const h = mountDialog(client);
    const again = reinspect();
    const done = h.dialog.open({ inspection: FakePackagesClient.inspection(), reinspect: again, projectOpen: true });
    h.ref<HTMLButtonElement>('install').click();
    await settle();
    expect(h.overlay.dataset.state).toBe('conflict');
    expect(h.ref('message').textContent).toContain('already in your library with different contents. Replace it with this download?');
    expect(h.ref<HTMLButtonElement>('install').textContent).toBe('Replace');
    expect(again).not.toHaveBeenCalled();

    h.ref<HTMLButtonElement>('install').click();
    const outcome = await done;
    expect(again).toHaveBeenCalledWith('library');
    expect(client.install).toHaveBeenLastCalledWith({ token: 'token-2', target: 'library', replace: true, pin: false });
    expect(outcome).not.toBeNull();
  });

  it('shows the refusal when the fresh inspection for a Replace fails, installing nothing', async () => {
    const client = new FakePackagesClient();
    client.install.mockResolvedValueOnce({ ok: false, status: 409, code: 'conflict', error: '@acme/kit 0.1.0 is already in your library with different contents.' } as any);
    const h = mountDialog(client);
    const again = vi.fn(async (_target: PackageTarget) => ({ ok: false as const, status: 0, error: 'The hub could not be reached.' }));
    void h.dialog.open({ inspection: FakePackagesClient.inspection(), reinspect: again, projectOpen: true });
    h.ref<HTMLButtonElement>('install').click();
    await settle();
    h.ref<HTMLButtonElement>('install').click();
    await settle();
    expect(h.overlay.dataset.state).toBe('error');
    expect(h.ref('message').textContent).toBe('The hub could not be reached.');
    expect(client.install).toHaveBeenCalledTimes(1);
  });

  it("shows a refusal as the engine words it, with no install to retry, and Cancel resolves null", async () => {
    const client = new FakePackagesClient();
    client.install.mockResolvedValueOnce({ ok: false, status: 409, code: 'version-change', error: 'This project pins @acme/kit 0.2.0; the pin was left alone.' } as any);
    const h = mountDialog(client);
    const done = h.dialog.open({ inspection: FakePackagesClient.inspection(), reinspect: reinspect(), projectOpen: true, pin: true });
    h.ref<HTMLButtonElement>('install').click();
    await settle();
    expect(client.install).toHaveBeenCalledWith(expect.objectContaining({ pin: true }));
    expect(h.overlay.dataset.state).toBe('error');
    expect(h.ref('message').textContent).toBe('This project pins @acme/kit 0.2.0; the pin was left alone.');
    expect(h.ref<HTMLButtonElement>('install').disabled).toBe(true);
    h.ref<HTMLButtonElement>('cancel').click();
    expect(await done).toBeNull();
    // The failed install used the inspection up: nothing to discard.
    expect(client.discard).not.toHaveBeenCalled();
  });

  it('discards the inspection on Cancel and on Escape', async () => {
    const h = mountDialog();
    const first = h.dialog.open({ inspection: FakePackagesClient.inspection(), reinspect: reinspect(), projectOpen: true });
    h.ref<HTMLButtonElement>('cancel').click();
    expect(await first).toBeNull();
    expect(h.client.discard).toHaveBeenCalledWith('token-1');

    const second = h.dialog.open({ inspection: FakePackagesClient.inspection({ token: 'token-3' }), reinspect: reinspect(), projectOpen: true });
    // A document listener (Settings underneath) never hears this Escape.
    const below = vi.fn();
    document.addEventListener('keydown', below, true);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.removeEventListener('keydown', below, true);
    expect(await second).toBeNull();
    expect(below).not.toHaveBeenCalled();
    expect(h.client.discard).toHaveBeenLastCalledWith('token-3');
  });
});
