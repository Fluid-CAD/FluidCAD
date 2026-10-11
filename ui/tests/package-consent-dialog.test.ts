// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PackageConsentDialog } from '../src/ui/packages/package-consent-dialog';
import { PackageDropTarget, PackageInstallFlow } from '../src/ui/packages/package-install-flow';
import { PackagesState } from '../src/ui/packages/packages-state';
import { FakePackagesClient, packageFile, settle } from './fixtures/fake-packages-client';

// The consent step every install from the page goes through, and the flow
// around it: what the dialog shows of an inspected archive, its states
// (review, installing, conflict → Replace, error), Cancel discarding the
// inspection, and the entry points — a picked file, the missing-package
// banner's checked install, and a .fluidpkg dropped on the window.

const dialogs: PackageConsentDialog[] = [];
const drops: PackageDropTarget[] = [];

afterEach(() => {
  for (const dialog of dialogs.splice(0)) {
    dialog.destroy();
  }
  for (const drop of drops.splice(0)) {
    drop.destroy();
  }
  document.body.innerHTML = '';
});

function mountDialog(client = new FakePackagesClient()) {
  const dialog = new PackageConsentDialog(document.body, client);
  dialogs.push(dialog);
  const overlay = document.body.querySelector<HTMLElement>('[data-role="package-consent"]')!;
  const ref = <T extends HTMLElement>(name: string) => overlay.querySelector<T>(`[data-ref="${name}"]`)!;
  return { client, dialog, overlay, ref };
}

function mountFlow(client = new FakePackagesClient()) {
  const state = new PackagesState(client);
  const onInstalled = vi.fn();
  const notify = vi.fn();
  const flow = new PackageInstallFlow(document.body, { client, state, onInstalled, notify });
  dialogs.push(flow.consent);
  return { client, state, flow, onInstalled, notify, overlay: () => document.body.querySelector<HTMLElement>('[data-role="package-consent"]')! };
}

describe('PackageConsentDialog', () => {
  it('shows the name, version, description, features with icons, parts, engine, warnings and the permissions line', () => {
    const h = mountDialog();
    void h.dialog.open({ inspection: FakePackagesClient.inspection(), file: packageFile(), projectOpen: true });
    expect(h.dialog.isOpen()).toBe(true);
    expect(h.overlay.dataset.state).toBe('review');
    // The archive's bare name, and the public name it installs under (HD29).
    expect(h.ref('name').textContent).toBe('kit');
    expect(h.ref('installs-as').textContent).toBe('Installs as @acme/kit');
    expect(h.ref('version').textContent).toBe('0.1.0');
    expect(h.ref('description').textContent).toBe('Standoffs and spacers');
    const features = [...h.ref('features').querySelectorAll<HTMLElement>('[data-feature-id]')];
    expect(features.map((row) => row.dataset.featureId)).toEqual(['standoff', 'twist']);
    expect(features[0].querySelector('img')!.getAttribute('src')).toBe('icon/token-1/standoff');
    expect(features[1].querySelector('img')!.getAttribute('src')).toContain('icons/solid.png');
    expect(features[0].querySelector('[data-ref="occt"]')).toBeNull();
    expect(features[1].querySelector('[data-ref="occt"]')!.textContent).toBe('raw OpenCascade');
    expect(h.ref('parts').textContent).toContain('Spacer');
    expect(h.ref('engine').textContent).toBe('Needs FluidCAD 0.0.45 or newer (packed on 0.0.46). 6 files, 48.6 kB.');
    expect(h.overlay.querySelector('[data-warning="uses-occt"]')!.textContent!.trim()).toBe('twist calls raw OpenCascade.');
    expect(h.ref('trust').textContent).toBe("A package's code runs in the FluidCAD engine with your permissions. Install only packages you trust.");
    const targets = [...h.overlay.querySelectorAll<HTMLInputElement>('input[name="package-target"]')];
    expect(targets.map((input) => [input.value, input.checked, input.disabled])).toEqual([['library', true, false], ['project', false, false]]);
  });

  it('shows the @local name a file nothing names installs under', () => {
    const h = mountDialog();
    void h.dialog.open({ inspection: FakePackagesClient.inspection({ installsAs: '@local/kit' }), file: packageFile(), projectOpen: true });
    expect(h.ref('installs-as').textContent).toBe('Installs as @local/kit');
  });

  it("can't target the project without one, and opens on the setting's target with one", () => {
    const h = mountDialog();
    void h.dialog.open({ inspection: FakePackagesClient.inspection({ defaultTarget: 'project' }), file: packageFile(), projectOpen: false });
    const project = h.overlay.querySelector<HTMLInputElement>('input[value="project"]')!;
    expect(project.disabled).toBe(true);
    expect(h.overlay.querySelector<HTMLInputElement>('input[value="library"]')!.checked).toBe(true);
    void h.dialog.open({ inspection: FakePackagesClient.inspection({ defaultTarget: 'project' }), file: packageFile(), projectOpen: true });
    expect(h.overlay.querySelector<HTMLInputElement>('input[value="project"]')!.checked).toBe(true);
  });

  it('installs into the chosen target and resolves with the outcome', async () => {
    const h = mountDialog();
    const done = h.dialog.open({ inspection: FakePackagesClient.inspection(), file: packageFile(), projectOpen: true });
    const project = h.overlay.querySelector<HTMLInputElement>('input[value="project"]')!;
    project.checked = true;
    project.dispatchEvent(new Event('change'));
    h.ref<HTMLButtonElement>('install').click();
    expect(h.overlay.dataset.state).toBe('installing');
    expect(h.ref<HTMLButtonElement>('install').disabled).toBe(true);
    const outcome = await done;
    expect(h.client.install).toHaveBeenCalledWith({ token: 'token-1', target: 'project', replace: false, pin: false, as: '@acme/kit' });
    expect(outcome).toMatchObject({ status: 'installed', target: 'project' });
    expect(h.dialog.isOpen()).toBe(false);
    expect(h.client.discard).not.toHaveBeenCalled();
  });

  it('offers Replace on a conflict, inspecting the file again before replacing', async () => {
    const client = new FakePackagesClient();
    client.install.mockResolvedValueOnce({ ok: false, status: 409, code: 'conflict', error: '@acme/kit 0.1.0 is already in your library with different contents.' } as any);
    const h = mountDialog(client);
    const file = packageFile();
    const done = h.dialog.open({ inspection: FakePackagesClient.inspection(), file, projectOpen: true });
    h.ref<HTMLButtonElement>('install').click();
    await settle();
    expect(h.overlay.dataset.state).toBe('conflict');
    expect(h.ref('message').textContent).toContain('already in your library with different contents. Replace it with this file?');
    expect(h.ref<HTMLButtonElement>('install').textContent).toBe('Replace');

    h.ref<HTMLButtonElement>('install').click();
    const outcome = await done;
    expect(client.inspect).toHaveBeenCalledWith(file, 'library', '@acme/kit');
    expect(client.install).toHaveBeenLastCalledWith({ token: 'token-2', target: 'library', replace: true, pin: false, as: '@acme/kit' });
    expect(outcome).not.toBeNull();
  });

  it("shows a refusal as the engine words it, with no install to retry, and Cancel resolves null", async () => {
    const client = new FakePackagesClient();
    client.install.mockResolvedValueOnce({ ok: false, status: 409, code: 'version-change', error: 'This project pins @acme/kit 0.2.0; the pin was left alone.' } as any);
    const h = mountDialog(client);
    const done = h.dialog.open({ inspection: FakePackagesClient.inspection(), file: packageFile(), projectOpen: true, pin: true });
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
    const first = h.dialog.open({ inspection: FakePackagesClient.inspection(), file: packageFile(), projectOpen: true });
    h.ref<HTMLButtonElement>('cancel').click();
    expect(await first).toBeNull();
    expect(h.client.discard).toHaveBeenCalledWith('token-1');

    const second = h.dialog.open({ inspection: FakePackagesClient.inspection({ token: 'token-3' }), file: packageFile(), projectOpen: true });
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

describe('PackageInstallFlow', () => {
  it('inspects a file, asks, installs, and reports the install', async () => {
    const h = mountFlow();
    const done = h.flow.installFile(packageFile());
    await settle();
    expect(h.client.inspect).toHaveBeenCalledTimes(1);
    expect(h.overlay().dataset.state).toBe('review');
    h.overlay().querySelector<HTMLButtonElement>('[data-ref="install"]')!.click();
    expect(await done).toMatchObject({ status: 'installed' });
    expect(h.onInstalled).toHaveBeenCalledTimes(1);
    expect(h.client.install).toHaveBeenCalledWith(expect.objectContaining({ token: 'token-2', pin: false }));
  });

  it('refuses a file that is not a .fluidpkg, and an archive the engine refuses, with a notice', async () => {
    const h = mountFlow();
    expect(await h.flow.installFile(new File(['x'], 'bracket.step'))).toBeNull();
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("bracket.step isn't a package"));
    expect(h.client.inspect).not.toHaveBeenCalled();

    h.client.inspect.mockResolvedValueOnce({ ok: false, status: 400, code: 'model-archive', error: 'This is a model archive, not a package.' } as any);
    expect(await h.flow.installFile(packageFile('old.fluidpkg'))).toBeNull();
    expect(h.notify).toHaveBeenLastCalledWith("Can't install old.fluidpkg: This is a model archive, not a package.");
  });

  it('checks the banner\'s file against the pin by pinning it, and says when it is another package', async () => {
    const h = mountFlow();
    const matching = h.flow.installFile(packageFile(), { expect: { name: '@bea-tools/kit', version: '0.1.0' } });
    await settle();
    // The archive says `kit`: the pin's bare name. It is inspected and installed under the pin's name.
    expect(h.client.inspect).toHaveBeenLastCalledWith(expect.anything(), undefined, '@bea-tools/kit');
    expect(h.overlay().querySelector('[data-warning="note"]')).toBeNull();
    expect(h.overlay().querySelector('[data-ref="installs-as"]')!.textContent).toBe('Installs as @bea-tools/kit');
    h.overlay().querySelector<HTMLButtonElement>('[data-ref="install"]')!.click();
    await matching;
    expect(h.client.install).toHaveBeenLastCalledWith(expect.objectContaining({ pin: true, as: '@bea-tools/kit' }));

    const other = h.flow.installFile(packageFile(), { expect: { name: '@acme/gears', version: '1.2.0' } });
    await settle();
    expect(h.overlay().querySelector('[data-warning="note"]')!.textContent!.trim())
      .toBe("This project uses @acme/gears 1.2.0, but this file is @acme/kit 0.1.0. Installing it won't fix the project.");
    // Refused under the pin's name, then inspected as itself.
    expect(h.client.inspect.mock.calls.slice(-2).map((call) => call[2])).toEqual(['@acme/gears', undefined]);
    h.overlay().querySelector<HTMLButtonElement>('[data-ref="install"]')!.click();
    await other;
    expect(h.client.install).toHaveBeenLastCalledWith(expect.objectContaining({ pin: false }));
  });
});

describe('PackageDropTarget', () => {
  function drag(type: string, files: File[] = [], target: EventTarget = document.body): DragEvent {
    const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(event, 'dataTransfer', { value: { types: files.length > 0 ? ['Files'] : ['text/plain'], files, dropEffect: 'none' } });
    target.dispatchEvent(event);
    return event;
  }

  it('shows a hint while a file is dragged over the window and installs a dropped .fluidpkg', async () => {
    const h = mountFlow();
    const drop = new PackageDropTarget(document.body, h.flow);
    drops.push(drop);
    const install = vi.spyOn(h.flow, 'installFile').mockResolvedValue(null);
    const file = packageFile();
    drag('dragenter', [file]);
    expect(drop.hintShown).toBe(true);
    expect(drag('dragover', [file]).defaultPrevented).toBe(true);
    const dropped = drag('drop', [new File(['x'], 'notes.txt'), file]);
    expect(dropped.defaultPrevented).toBe(true);
    expect(drop.hintShown).toBe(false);
    expect(install).toHaveBeenCalledWith(file);
  });

  it('leaves drags without files (the timeline\'s own) and drops into the code editor alone', () => {
    const h = mountFlow();
    const drop = new PackageDropTarget(document.body, h.flow);
    drops.push(drop);
    const install = vi.spyOn(h.flow, 'installFile').mockResolvedValue(null);
    expect(drag('dragover').defaultPrevented).toBe(false);
    drag('drop');
    const editor = document.createElement('div');
    editor.className = 'monaco-editor';
    document.body.appendChild(editor);
    expect(drag('dragover', [packageFile()], editor).defaultPrevented).toBe(false);
    drag('drop', [packageFile()], editor);
    expect(install).not.toHaveBeenCalled();
  });
});
