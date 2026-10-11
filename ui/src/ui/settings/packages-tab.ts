import type { InstalledPackage, PackagesOverview, PackageTarget } from '../../api';
import { desktop } from '../../desktop';
import { ICON_FOLDER, ICON_TRASH } from '../icons';
import { PackageText, type PackagesState } from '../packages/packages-state';
import { packageSettings } from './package-settings';
import {
  FIELD,
  FIELD_HINT,
  FIELD_LABEL,
  SELECT,
  textField,
  type PersistPreference,
  type SettingsContext,
  type SettingsTab,
} from './settings-tab';

/** What the tab needs beyond the preference stores; absent, it shows the settings without the library list. */
export type PackagesTabDeps = {
  state: PackagesState;
  /** The library changed under the page (a new folder, a removal, a copy): the catalogs and the scene catch up. */
  onLibraryChanged(): void;
};

const ERROR_BOX = 'bg-error text-error-content rounded-md px-3 py-2 text-xs leading-snug';
const NOTE_BOX = 'border border-base-content/10 rounded-md px-3 py-2.5 text-xs leading-snug flex flex-col gap-2';

/**
 * Settings → Packages: where the user library lives, where new packages go,
 * and what the library holds.
 *
 * - **Library folder** is a path field (a Browse… button beside it in the
 *   desktop app). The engine checks it on Save — absolute, and a folder it
 *   can read or create — and a refusal shows here with its reason, the
 *   draft kept. Changing it moves nothing: projects pin by name and version,
 *   so the tab then offers to copy the old folder's packages across.
 *   `FLUIDCAD_PACKAGES`, when set, outranks the setting, and the tab says so.
 * - **New packages go to** is where an install puts a package unless it is
 *   told otherwise (`fluidcad install`, and from H11 the Hub panel).
 * - **Installed in my library** lists each package with its version,
 *   contents and size, with Remove (behind a confirmation: projects that use
 *   it will ask for it again). There is no install button: packages install
 *   only from the hub (HD31), and the Hub panel (H11) brings one.
 *
 * The two settings are drafts saved by the dialog's Save, like every tab;
 * Remove and the copy act at once, like Advanced's reset.
 */
export class PackagesTab implements SettingsTab {
  readonly id = 'packages';
  readonly label = 'Packages';
  private ctx!: SettingsContext;
  private pathInput!: HTMLInputElement;
  private pathHint!: HTMLParagraphElement;
  private pathError!: HTMLDivElement;
  private targetSelect!: HTMLSelectElement;
  private listEl!: HTMLDivElement;
  private listStatus!: HTMLParagraphElement;
  private offerEl!: HTMLDivElement;
  private draftPath = packageSettings.current.libraryPath;
  private draftTarget: PackageTarget = packageSettings.current.installTarget;
  /** A library-folder save waiting for the engine's verdict. */
  private savingPath: string | null = null;
  /** The library row whose Remove asks for confirmation. */
  private confirming: string | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly deps: PackagesTabDeps | null = null) {}

  mount(root: HTMLElement, ctx: SettingsContext): void {
    this.ctx = ctx;
    const intro = document.createElement('p');
    intro.className = `${FIELD_HINT} mb-3 leading-snug`;
    intro.textContent = 'Packages bring custom features and parts. A package installs once into your library and every '
      + 'project can use it; a project records only the version it uses.';
    root.appendChild(intro);

    // Library folder: the path, Browse… in the desktop app, the folder in
    // use, and the engine's refusal of a path it can't use.
    this.pathInput = textField((value) => {
      this.draftPath = value;
      this.showPathError(null);
      ctx.changed();
    }, { placeholder: 'Default folder', mono: true });
    this.pathInput.dataset.ref = 'library-path';
    const pathRow = document.createElement('div');
    pathRow.className = 'flex items-center gap-2';
    pathRow.appendChild(this.pathInput);
    if (desktop()) {
      const browse = document.createElement('button');
      browse.type = 'button';
      browse.dataset.ref = 'browse';
      browse.className = 'btn btn-sm btn-ghost gap-1 shrink-0';
      browse.innerHTML = `<span class="[&>svg]:size-4">${ICON_FOLDER}</span>`;
      browse.appendChild(document.createTextNode('Browse…'));
      browse.addEventListener('click', () => void this.browse());
      pathRow.appendChild(browse);
    }
    const pathField = document.createElement('div');
    pathField.className = FIELD;
    const pathLabel = document.createElement('label');
    pathLabel.className = FIELD_LABEL;
    pathLabel.textContent = 'Library folder';
    this.pathHint = document.createElement('p');
    this.pathHint.dataset.ref = 'library-hint';
    this.pathHint.className = `${FIELD_HINT} break-all`;
    this.pathError = document.createElement('div');
    this.pathError.dataset.ref = 'library-error';
    this.pathError.className = `${ERROR_BOX} hidden`;
    pathField.append(pathLabel, pathRow, this.pathHint, this.pathError);
    root.appendChild(pathField);

    this.targetSelect = document.createElement('select');
    this.targetSelect.className = SELECT;
    this.targetSelect.dataset.ref = 'install-target';
    for (const [value, text] of [['library', 'My library'], ['project', 'This project']] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      this.targetSelect.appendChild(option);
    }
    this.targetSelect.addEventListener('change', () => {
      this.draftTarget = this.targetSelect.value === 'project' ? 'project' : 'library';
      ctx.changed();
    });
    const targetField = document.createElement('div');
    targetField.className = FIELD;
    const targetLabel = document.createElement('label');
    targetLabel.className = FIELD_LABEL;
    targetLabel.textContent = 'New packages go to';
    const targetHint = document.createElement('p');
    targetHint.className = FIELD_HINT;
    targetHint.textContent = 'Where a package goes when you install it, unless you choose otherwise. This project: a copy in its packages/ folder.';
    targetField.append(targetLabel, this.targetSelect, targetHint);
    root.appendChild(targetField);

    this.offerEl = document.createElement('div');
    this.offerEl.dataset.ref = 'offer';
    this.offerEl.className = `${NOTE_BOX} hidden mb-4`;
    root.appendChild(this.offerEl);

    const header = document.createElement('div');
    header.className = 'flex items-center justify-between gap-2 mb-1.5';
    const heading = document.createElement('span');
    heading.className = FIELD_LABEL;
    heading.textContent = 'Installed in my library';
    header.appendChild(heading);
    root.appendChild(header);
    this.listEl = document.createElement('div');
    this.listEl.dataset.ref = 'library-list';
    this.listEl.className = 'overflow-y-auto max-h-[160px] border border-base-content/10 rounded-md';
    root.appendChild(this.listEl);
    this.listStatus = document.createElement('p');
    this.listStatus.dataset.ref = 'list-status';
    this.listStatus.className = 'text-xs mt-2 min-h-4';
    root.appendChild(this.listStatus);

    this.unsubscribe = this.deps?.state.subscribe((overview) => this.renderOverview(overview)) ?? null;
    this.sync();
  }

  sync(): void {
    this.draftPath = packageSettings.current.libraryPath;
    this.draftTarget = packageSettings.current.installTarget;
    this.pathInput.value = this.draftPath;
    this.targetSelect.value = this.draftTarget;
    this.showPathError(null);
    this.confirming = null;
    this.setListStatus('');
    this.renderOverview(this.deps?.state.current ?? null);
    void this.deps?.state.refresh();
  }

  isDirty(): boolean {
    return this.draftPath.trim() !== packageSettings.current.libraryPath
      || this.draftTarget !== packageSettings.current.installTarget;
  }

  save(persist: PersistPreference): void {
    if (this.draftTarget !== packageSettings.current.installTarget) {
      packageSettings.update({ installTarget: this.draftTarget });
      persist('packageInstallTarget', this.draftTarget);
    }
    const path = this.draftPath.trim();
    if (path === packageSettings.current.libraryPath || this.savingPath !== null) {
      return;
    }
    if (this.deps) {
      void this.saveLibraryPath(path);
    } else {
      // No engine client to hear a refusal through: saved like any setting.
      packageSettings.update({ libraryPath: path });
      persist('packageLibraryPath', path);
    }
  }

  destroy(): void {
    this.unsubscribe?.();
  }

  // ---------------------------------------------------------------------------
  // Library folder
  // ---------------------------------------------------------------------------

  /**
   * The one setting the engine checks before it keeps it: saved on its own
   * so a refusal can be shown, with the draft (and the tab's dot) left as
   * they were.
   */
  private async saveLibraryPath(path: string): Promise<void> {
    if (!this.deps) {
      return;
    }
    this.savingPath = path;
    this.showPathError(null);
    const before = packageSettings.current.libraryPath;
    const answer = await this.deps.state.client.savePreferences({ packageLibraryPath: path });
    this.savingPath = null;
    if (answer.ok === false) {
      this.showPathError(answer.error);
      this.ctx.changed();
      return;
    }
    packageSettings.update({ libraryPath: typeof answer.prefs.packageLibraryPath === 'string' ? answer.prefs.packageLibraryPath : path });
    // A Cancel while the save was out reset the draft to the old folder; it
    // follows the saved one instead.
    if (this.draftPath.trim() === before || this.draftPath.trim() === path) {
      this.draftPath = packageSettings.current.libraryPath;
      this.pathInput.value = this.draftPath;
    }
    this.ctx.changed();
    await this.deps.state.refresh();
    this.deps.onLibraryChanged();
  }

  private async browse(): Promise<void> {
    const api = desktop();
    if (!api) {
      return;
    }
    const current = this.draftPath.trim() || this.deps?.state.current?.library.path;
    const picked = await api.showOpenDialog({
      title: 'Choose the package library folder',
      ...(current ? { defaultPath: current } : {}),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!picked || picked.length === 0) {
      return;
    }
    this.draftPath = picked[0];
    this.pathInput.value = picked[0];
    this.showPathError(null);
    this.ctx.changed();
  }

  private showPathError(text: string | null): void {
    this.pathError.textContent = text ?? '';
    this.pathError.classList.toggle('hidden', text === null);
  }

  // ---------------------------------------------------------------------------
  // The library's packages and the copy offer
  // ---------------------------------------------------------------------------

  private renderOverview(overview: PackagesOverview | null): void {
    this.renderPathHint(overview);
    this.renderOffer(overview);
    this.listEl.replaceChildren();
    const packages = overview?.library.packages ?? null;
    if (packages === null) {
      this.listEl.appendChild(PackagesTab.empty(this.deps ? 'Reading your library…' : 'The library is listed when the engine is up.'));
      return;
    }
    if (packages.length === 0) {
      this.listEl.appendChild(PackagesTab.empty('No packages in your library yet.'));
      return;
    }
    for (const entry of packages) {
      this.listEl.appendChild(this.libraryRow(entry));
    }
  }

  private renderPathHint(overview: PackagesOverview | null): void {
    if (!overview) {
      this.pathHint.textContent = 'Empty uses the default folder.';
      return;
    }
    const { path, source } = overview.library;
    if (source === 'env') {
      this.pathHint.textContent = `FLUIDCAD_PACKAGES is set, so this engine uses ${path}; the folder here applies once it isn't.`;
    } else if (source === 'default') {
      this.pathHint.textContent = `In use: ${path} (the default; leave the field empty to keep it).`;
    } else {
      this.pathHint.textContent = `In use: ${path}.`;
    }
  }

  private renderOffer(overview: PackagesOverview | null): void {
    const offer = overview?.libraryOffer ?? null;
    this.offerEl.replaceChildren();
    this.offerEl.classList.toggle('hidden', offer === null);
    if (!offer || !this.deps) {
      return;
    }
    const text = document.createElement('span');
    text.className = 'text-base-content/85';
    const names = offer.packages.map((p) => PackageText.label(p.name, p.version)).join(', ');
    const count = offer.packages.length === 1 ? '1 package' : `${offer.packages.length} packages`;
    const them = offer.packages.length === 1 ? 'it' : 'them';
    text.textContent = `The folder you left, ${offer.path}, still holds ${count} (${names}). Copy ${them} into the new library folder? Nothing moves by itself.`;
    const actions = document.createElement('div');
    actions.className = 'flex justify-end gap-2';
    const leave = document.createElement('button');
    leave.type = 'button';
    leave.dataset.action = 'leave';
    leave.className = 'btn btn-ghost btn-xs';
    leave.textContent = 'Leave them';
    leave.addEventListener('click', () => void this.dismissOffer());
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.dataset.action = 'copy-offer';
    copy.className = 'btn btn-primary btn-xs';
    copy.textContent = 'Copy packages';
    copy.addEventListener('click', () => void this.copyOffer());
    actions.append(leave, copy);
    this.offerEl.append(text, actions);
  }

  private libraryRow(entry: InstalledPackage): HTMLDivElement {
    const key = `${entry.name}@${entry.version}`;
    const row = document.createElement('div');
    row.dataset.package = key;
    row.className = 'flex items-center gap-2 px-3 py-1.5 border-b border-base-content/[0.07] last:border-b-0';
    const text = document.createElement('div');
    text.className = 'flex-1 min-w-0';
    const title = document.createElement('div');
    title.className = 'flex items-baseline gap-1.5 min-w-0';
    const name = document.createElement('span');
    name.className = 'text-xs font-medium text-base-content/90 truncate';
    name.textContent = entry.name;
    const version = document.createElement('span');
    version.className = 'text-[11px] text-base-content/55 tabular-nums shrink-0';
    version.textContent = entry.version;
    title.append(name, version);
    const meta = document.createElement('div');
    meta.className = 'text-[11px] text-base-content/50 truncate';
    meta.textContent = PackageText.installed(entry);
    meta.title = entry.directory;
    text.append(title, meta);
    row.appendChild(text);

    if (this.confirming === key) {
      const ask = document.createElement('span');
      ask.className = 'text-[11px] text-base-content/70 shrink-0';
      ask.textContent = 'Projects using it will ask for it again.';
      const confirm = document.createElement('button');
      confirm.type = 'button';
      confirm.dataset.action = 'confirm-remove';
      confirm.className = 'btn btn-error btn-xs shrink-0';
      confirm.textContent = 'Remove';
      confirm.addEventListener('click', () => void this.remove(entry));
      const keep = document.createElement('button');
      keep.type = 'button';
      keep.dataset.action = 'keep';
      keep.className = 'btn btn-ghost btn-xs shrink-0';
      keep.textContent = 'Keep';
      keep.addEventListener('click', () => {
        this.confirming = null;
        this.renderOverview(this.deps?.state.current ?? null);
      });
      row.append(ask, keep, confirm);
      return row;
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.dataset.action = 'remove';
    remove.className = 'btn btn-ghost btn-square btn-xs text-error/80 shrink-0';
    remove.title = `Remove ${PackageText.label(entry.name, entry.version)} from your library`;
    remove.innerHTML = `<span class="[&>svg]:size-3.5">${ICON_TRASH}</span>`;
    remove.disabled = !this.deps;
    remove.addEventListener('click', () => {
      this.confirming = key;
      this.renderOverview(this.deps?.state.current ?? null);
    });
    row.appendChild(remove);
    return row;
  }

  private async remove(entry: InstalledPackage): Promise<void> {
    if (!this.deps) {
      return;
    }
    this.confirming = null;
    const answer = await this.deps.state.client.remove(entry.name, entry.version, 'library');
    if (answer.ok === false) {
      this.setListStatus(answer.error, true);
    } else {
      const label = PackageText.label(entry.name, entry.version);
      this.setListStatus(answer.strandedPin
        ? `Removed ${label}. This project still uses it and asks for it again until it is installed.`
        : `Removed ${label}.`);
    }
    await this.deps.state.refresh();
    this.deps.onLibraryChanged();
  }

  private async copyOffer(): Promise<void> {
    if (!this.deps) {
      return;
    }
    const answer = await this.deps.state.client.copyLibraryOffer();
    if (answer.ok === false) {
      this.setListStatus(answer.error, true);
    } else {
      const copied = answer.copies.filter((c) => c.status !== 'refused').length;
      const refused = answer.copies.filter((c) => c.status === 'refused');
      const copiedText = copied === 1 ? 'Copied 1 package into your library.' : `Copied ${copied} packages into your library.`;
      this.setListStatus(refused.length === 0
        ? copiedText
        : `${copiedText} ${refused.map((c) => c.error ?? PackageText.label(c.name, c.version)).join(' ')}`, refused.length > 0);
    }
    await this.deps.state.refresh();
    this.deps.onLibraryChanged();
  }

  private async dismissOffer(): Promise<void> {
    if (!this.deps) {
      return;
    }
    await this.deps.state.client.dismissLibraryOffer();
    await this.deps.state.refresh();
  }

  private setListStatus(text: string, isError = false): void {
    this.listStatus.textContent = text;
    this.listStatus.className = `text-xs mt-2 min-h-4 ${isError ? 'text-error' : 'text-base-content/60'}`;
  }

  private static empty(text: string): HTMLDivElement {
    const el = document.createElement('div');
    el.dataset.ref = 'empty';
    el.className = 'text-[11px] text-base-content/40 text-center py-3';
    el.textContent = text;
    return el;
  }
}
