import type { PackagesOverview, PinnedPackage } from '../../api';
import { ICON_ALERT_TRIANGLE, ICON_CLOSE } from '../icons';
import { HubIcons } from '../hub/hub-icons';
import { PackageText, type PackagesState } from './packages-state';

export type ProjectPackagesDialogDeps = {
  state: PackagesState;
  /** Where the project loads a package from changed (a copy in, a copy removed): the scene and the catalogs catch up. */
  onChanged(): void;
  /** Open the Hub panel (H11): the dialog's way to new packages. Absent, no button. */
  onFindPackages?(): void;
  /** Install a missing pin from the hub, through the consent dialog (H11, as the error banner does). Absent, only the command shows. */
  onInstallMissing?(pin: { name: string; version: string }): void;
};

const ROW = 'flex items-center gap-2 px-3 py-2 border-b border-base-content/[0.07] last:border-b-0';
const CHIP = 'badge badge-xs shrink-0 whitespace-nowrap';

/**
 * The project's Packages, opened from the top bar's package button: the
 * packages this project pins (its `fluidcad.json` `dependencies`), each
 * with where it loads from — the user library or the copy in the project's
 * `packages/` folder — and what can change that:
 *
 * - **Copy into project** on a library-only pin copies the installed tree
 *   into `packages/`, unchanged, so the pin holds and the project carries
 *   its package (committed to git, zipped for a teammate, opened offline).
 * - **Use from library** on a project copy puts the same tree in the
 *   library (or finds it there with the same contents), then removes the
 *   copy. A library holding other contents under that version refuses it,
 *   and the copy stays.
 * - A pin installed nowhere leads the dialog as the missing-package
 *   banner, naming the command that downloads it,
 *   `fluidcad install @acme/kit@0.1.0`, with Install from the hub (H11:
 *   the download, then the consent dialog, as the error banner does).
 * - "Find packages in the Hub panel" opens the Hub panel (H11).
 * - An **update available** chip names a newer version the library holds;
 *   moving to it is Stage P10's previewed upgrade.
 *
 * Project-level, so not in Settings (whose tabs are the user's own
 * preferences): it is a project action beside Import, Export and Share.
 */
export class ProjectPackagesDialog {
  private readonly overlay: HTMLDivElement;
  private readonly banner: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly unsubscribe: () => void;
  /** The pin an action is running on, so its buttons wait. */
  private busy: string | null = null;

  constructor(container: HTMLElement, private readonly deps: ProjectPackagesDialogDeps) {
    this.overlay = document.createElement('div');
    // Above the error banner (z-[1001]): its missing-package sentence would
    // otherwise sit on the dialog's own banner.
    this.overlay.className = 'fixed inset-0 z-[1100] bg-black/50 flex items-center justify-center hidden';
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.setAttribute('aria-label', 'Packages in this project');
    this.overlay.dataset.role = 'project-packages';
    this.overlay.innerHTML = `
      <div data-ref="box" class="w-[520px] max-w-[92vw] max-h-[82vh] bg-base-100 border border-base-content/10 rounded-lg p-5 shadow-[0_4px_24px_rgba(0,0,0,0.5)] flex flex-col">
        <div class="flex items-center justify-between mb-2 shrink-0">
          <h3 class="text-sm font-medium text-base-content/90">Packages in this project</h3>
          <button data-ref="close" class="btn btn-ghost btn-square btn-xs text-base-content/60" title="Close" aria-label="Close">
            <span class="[&>svg]:size-4">${ICON_CLOSE}</span>
          </button>
        </div>
        <p class="text-xs text-base-content/55 leading-snug mb-3 shrink-0">
          The project records the exact version of each package it uses. A package loads from your library,
          or from a copy in the project's <span class="font-mono">packages/</span> folder when there is one.
        </p>
        <div data-ref="banner" class="hidden flex-col gap-2 mb-3 shrink-0"></div>
        <div data-ref="list" class="overflow-y-auto min-h-0 border border-base-content/10 rounded-md"></div>
        <div data-ref="status" class="text-xs min-h-4 mt-2 shrink-0"></div>
        <div data-ref="footer" class="flex items-center justify-end gap-2 pt-2 shrink-0">
          <button data-ref="done" type="button" class="btn btn-sm">Close</button>
        </div>
      </div>
    `;
    container.appendChild(this.overlay);
    this.banner = this.overlay.querySelector<HTMLDivElement>('[data-ref="banner"]')!;
    this.list = this.overlay.querySelector<HTMLDivElement>('[data-ref="list"]')!;
    this.status = this.overlay.querySelector<HTMLDivElement>('[data-ref="status"]')!;
    this.overlay.querySelector('[data-ref="close"]')!.addEventListener('click', () => this.hide());
    this.overlay.querySelector('[data-ref="done"]')!.addEventListener('click', () => this.hide());
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) {
        this.hide();
      }
    });
    document.addEventListener('keydown', this.onKeyDown, true);
    if (deps.onFindPackages) {
      const find = document.createElement('button');
      find.type = 'button';
      find.dataset.ref = 'find-packages';
      find.className = 'btn btn-ghost btn-sm gap-1.5 font-normal text-primary mr-auto';
      find.append(HubIcons.span(HubIcons.PACKAGES, '[&>svg]:size-4'), 'Find packages in the Hub panel');
      find.addEventListener('click', () => {
        this.hide();
        deps.onFindPackages?.();
      });
      this.overlay.querySelector('[data-ref="footer"]')!.prepend(find);
    }
    this.unsubscribe = deps.state.subscribe((overview) => this.render(overview));
  }

  isOpen(): boolean {
    return !this.overlay.classList.contains('hidden');
  }

  show(): void {
    this.setStatus('');
    this.render(this.deps.state.current);
    this.overlay.classList.remove('hidden');
    void this.deps.state.refresh();
  }

  hide(): void {
    this.overlay.classList.add('hidden');
  }

  destroy(): void {
    this.unsubscribe();
    document.removeEventListener('keydown', this.onKeyDown, true);
    this.overlay.remove();
  }

  /** Escape closes the dialog. */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.overlay.isConnected && this.isOpen()) {
      e.stopPropagation();
      this.hide();
    }
  };

  // ---------------------------------------------------------------------------
  // Markup
  // ---------------------------------------------------------------------------

  private render(overview: PackagesOverview | null): void {
    this.renderBanner(overview);
    this.list.replaceChildren();
    if (!overview) {
      this.list.appendChild(ProjectPackagesDialog.empty('The engine did not answer.'));
      return;
    }
    if (!overview.project) {
      this.list.appendChild(ProjectPackagesDialog.empty('No project is open.'));
      return;
    }
    if (overview.pinsProblem) {
      this.list.appendChild(ProjectPackagesDialog.empty(overview.pinsProblem));
      return;
    }
    const pins = overview.pins ?? [];
    if (pins.length === 0) {
      this.list.appendChild(ProjectPackagesDialog.empty(
        'This project uses no packages yet. A package pins itself here the first time you use one of its features or parts.'));
      return;
    }
    for (const pin of pins) {
      const version = overview.updates?.[pin.name];
      this.list.appendChild(this.row(pin, version ? { version, from: overview.updatesFrom?.[pin.name] ?? 'library' } : null));
    }
  }

  private renderBanner(overview: PackagesOverview | null): void {
    const missing = (overview?.pins ?? []).filter((pin) => pin.availability === 'missing');
    this.banner.replaceChildren();
    this.banner.classList.toggle('hidden', missing.length === 0);
    this.banner.classList.toggle('flex', missing.length > 0);
    for (const pin of missing) {
      const box = document.createElement('div');
      box.dataset.missing = pin.name;
      box.className = 'flex items-start gap-2 rounded-md px-3 py-2 text-xs leading-snug border border-error/40 bg-error/10';
      const icon = document.createElement('span');
      icon.className = 'text-error shrink-0 [&>svg]:size-4';
      icon.innerHTML = ICON_ALERT_TRIANGLE;
      const text = document.createElement('span');
      text.className = 'flex-1 min-w-0 text-base-content/90';
      text.append(`This project uses ${PackageText.label(pin.name, pin.version)}, which isn't installed: `);
      const command = document.createElement('code');
      command.dataset.ref = 'install-command';
      command.className = 'font-mono text-[11px] text-base-content select-all';
      command.textContent = ProjectPackagesDialog.installCommand(pin);
      text.append(command, ' downloads it from the hub.');
      box.append(icon, text);
      if (this.deps.onInstallMissing) {
        const install = document.createElement('button');
        install.type = 'button';
        install.dataset.ref = 'install-missing';
        install.className = 'btn btn-xs btn-primary shrink-0';
        install.textContent = 'Install from the hub';
        install.addEventListener('click', () => {
          this.hide();
          this.deps.onInstallMissing?.({ name: pin.name, version: pin.version });
        });
        box.appendChild(install);
      }
      this.banner.appendChild(box);
    }
  }

  private row(pin: PinnedPackage, update: { version: string; from: 'library' | 'hub' } | null): HTMLDivElement {
    const row = document.createElement('div');
    row.className = ROW;
    row.dataset.pin = pin.name;
    const text = document.createElement('div');
    text.className = 'flex-1 min-w-0';
    const title = document.createElement('div');
    title.className = 'flex items-center gap-1.5 min-w-0';
    const name = document.createElement('span');
    name.className = 'text-xs font-medium text-base-content/90 truncate';
    name.textContent = pin.name;
    const version = document.createElement('span');
    version.className = 'text-[11px] text-base-content/55 tabular-nums shrink-0';
    version.textContent = pin.version;
    title.append(name, version);
    if (update) {
      const chip = document.createElement('span');
      chip.dataset.ref = 'update';
      chip.className = `${CHIP} badge-info badge-soft`;
      chip.textContent = `${update.version} available`;
      const where = update.from === 'hub'
        ? `${PackageText.label(pin.name, update.version)} is on the hub.`
        : `Your library holds ${PackageText.label(pin.name, update.version)}.`;
      chip.title = `${where} Moving this project to it, with a preview of what changes, comes in a later version.`;
      title.appendChild(chip);
    }
    const where = document.createElement('div');
    where.dataset.ref = 'where';
    where.className = 'text-[11px] text-base-content/50 truncate';
    where.textContent = ProjectPackagesDialog.whereText(pin);
    if (pin.directory) {
      where.title = pin.directory;
    }
    text.append(title, where);
    row.appendChild(text);

    const action = this.actionFor(pin);
    if (action) {
      row.appendChild(action);
    }
    return row;
  }

  /** The command that downloads a missing pin: `fluidcad install @acme/kit@0.1.0`. */
  static installCommand(pin: Pick<PinnedPackage, 'name' | 'version'>): string {
    return `fluidcad install ${pin.name}@${pin.version}`;
  }

  private static whereText(pin: PinnedPackage): string {
    if (pin.availability === 'library') {
      return 'From your library';
    }
    if (pin.availability === 'project') {
      return "Copied into this project's packages/ folder";
    }
    return 'Not installed';
  }

  private actionFor(pin: PinnedPackage): HTMLButtonElement | null {
    if (pin.availability === 'missing') {
      return null;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-ghost btn-xs shrink-0';
    button.disabled = this.busy !== null;
    if (pin.availability === 'library') {
      button.dataset.action = 'copy-into-project';
      button.textContent = 'Copy into project';
      button.title = "Copy the package into this project's packages/ folder, so the project carries it.";
      button.addEventListener('click', () => void this.copyIntoProject(pin));
    } else {
      button.dataset.action = 'use-from-library';
      button.textContent = 'Use from library';
      button.title = 'Load the package from your library and remove the copy from this project.';
      button.addEventListener('click', () => void this.useFromLibrary(pin));
    }
    return button;
  }

  private static empty(text: string): HTMLDivElement {
    const el = document.createElement('div');
    el.dataset.ref = 'empty';
    el.className = 'text-xs text-base-content/50 text-center px-4 py-5 leading-snug';
    el.textContent = text;
    return el;
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  private async copyIntoProject(pin: PinnedPackage): Promise<void> {
    await this.run(pin, async () => {
      const copied = await this.deps.state.client.copy(pin.name, pin.version, 'project');
      if (copied.ok === false) {
        return { ok: false, message: copied.error };
      }
      return { ok: true, message: `Copied ${PackageText.label(pin.name, pin.version)} into packages/. The project loads it from there now.` };
    });
  }

  private async useFromLibrary(pin: PinnedPackage): Promise<void> {
    await this.run(pin, async () => {
      const client = this.deps.state.client;
      // The library gets the same tree (or already has it): only then does
      // the copy go, so the pin never points at nothing.
      const inLibrary = await client.copy(pin.name, pin.version, 'library');
      if (inLibrary.ok === false) {
        return { ok: false, message: `${inLibrary.error} The copy in this project stays.` };
      }
      const removed = await client.remove(pin.name, pin.version, 'project');
      if (removed.ok === false) {
        return { ok: false, message: removed.error };
      }
      return { ok: true, message: `${PackageText.label(pin.name, pin.version)} loads from your library now; the project's copy is gone.` };
    });
  }

  /** Run one pin's action with its buttons waiting, then refetch and let the scene follow. */
  private async run(pin: PinnedPackage, action: () => Promise<{ ok: boolean; message: string }>): Promise<void> {
    if (this.busy !== null) {
      return;
    }
    this.busy = pin.name;
    this.render(this.deps.state.current);
    let result: { ok: boolean; message: string };
    try {
      result = await action();
    } finally {
      this.busy = null;
    }
    await this.deps.state.refresh();
    this.setStatus(result.message, !result.ok);
    this.deps.onChanged();
  }

  private setStatus(text: string, isError = false): void {
    this.status.textContent = text;
    this.status.className = `text-xs min-h-4 mt-2 shrink-0 ${isError ? 'text-error' : 'text-base-content/60'}`;
  }
}
