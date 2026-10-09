import type { PackageInstallOutcome, PackagesClient } from '../../api';
import { PackageConsentDialog } from './package-consent-dialog';
import { PackageText, type PackagesState } from './packages-state';

/** What an install is for: a plain one, or the missing-package banner's (the file must be the package the project pins). */
export type PackageInstallIntent = {
  /** The pin the file should satisfy: pinned into the project too, which checks its version and contents. */
  expect?: { name: string; version: string | null };
};

export type PackageInstallFlowDeps = {
  client: PackagesClient;
  state: PackagesState;
  /** An install landed: the catalogs and the scene catch up (nothing broadcasts after one). */
  onInstalled(outcome: PackageInstallOutcome): void;
  /** A short notice with no dialog to carry it (a refused inspection, a file that isn't a package). */
  notify(message: string): void;
};

/**
 * One install from a file, wherever it starts — Install package… (Settings
 * → Packages, the project's Packages dialog), the missing-package banner's
 * Install from file…, or a `.fluidpkg` dropped on the window
 * ({@link PackageDropTarget}): the engine inspects the archive, the
 * {@link PackageConsentDialog} asks, and the install follows. After it the
 * page refetches what it shows; the engine announces nothing.
 */
export class PackageInstallFlow {
  static readonly EXTENSION = '.fluidpkg';

  readonly consent: PackageConsentDialog;
  private readonly input: HTMLInputElement;
  private pendingIntent: PackageInstallIntent = {};

  constructor(container: HTMLElement, private readonly deps: PackageInstallFlowDeps) {
    this.consent = new PackageConsentDialog(container, deps.client);
    this.input = document.createElement('input');
    this.input.type = 'file';
    this.input.accept = PackageInstallFlow.EXTENSION;
    this.input.style.display = 'none';
    this.input.dataset.role = 'package-file-input';
    container.appendChild(this.input);
    this.input.addEventListener('change', () => {
      const file = this.input.files?.[0];
      this.input.value = '';
      if (file) {
        void this.installFile(file, this.pendingIntent);
      }
    });
  }

  /** Install package… / Install from file…: pick a `.fluidpkg`, then the consent dialog. */
  pick(intent: PackageInstallIntent = {}): void {
    this.pendingIntent = intent;
    this.input.click();
  }

  static isPackageFile(file: { name: string }): boolean {
    return file.name.toLowerCase().endsWith(PackageInstallFlow.EXTENSION);
  }

  /** Inspect `file`, ask, install; resolves with the outcome, or null when refused or cancelled. */
  async installFile(file: File, intent: PackageInstallIntent = {}): Promise<PackageInstallOutcome | null> {
    if (!PackageInstallFlow.isPackageFile(file)) {
      this.deps.notify(`${file.name} isn't a package: packages are .fluidpkg files, made by fluidcad pack.`);
      return null;
    }
    // The project's state decides the target choice and the pin.
    await this.deps.state.refresh();
    const inspected = await this.deps.client.inspect(file);
    if (inspected.ok === false) {
      this.deps.notify(`Can't install ${file.name}: ${inspected.error}`);
      return null;
    }
    const { manifest } = inspected.inspection;
    const expected = intent.expect;
    const matches = expected !== undefined && manifest.name === expected.name
      && (expected.version === null || manifest.version === expected.version);
    const note = expected && !matches
      ? `This project uses ${PackageText.label(expected.name, expected.version)}, but this file is ${PackageText.label(manifest.name, manifest.version)}. Installing it won't fix the project.`
      : undefined;
    const outcome = await this.consent.open({
      inspection: inspected.inspection,
      file,
      projectOpen: this.deps.state.hasProject,
      // The banner's file is checked against the pin by pinning it: the
      // engine refuses one whose contents differ from what the project was
      // built with.
      pin: matches && this.deps.state.hasProject,
      note,
    });
    if (outcome) {
      this.deps.onInstalled(outcome);
    }
    return outcome;
  }
}

/**
 * Drag a `.fluidpkg` onto the window to install it: a hint covers the page
 * while a file is dragged over it, and the drop goes through the same
 * consent dialog as Install package…. Only file drags are taken — the
 * timeline's own row drags carry no files — and a drop into the code editor
 * is left to the editor.
 */
export class PackageDropTarget {
  private readonly hint: HTMLDivElement;
  /** dragenter/dragleave pairs across child elements: the hint hides when it falls to zero. */
  private depth = 0;

  constructor(container: HTMLElement, private readonly flow: PackageInstallFlow, private readonly target: Window = window) {
    this.hint = document.createElement('div');
    this.hint.dataset.role = 'package-drop-hint';
    this.hint.className = 'fixed inset-3 z-[1300] hidden items-center justify-center rounded-xl border-2 border-dashed border-primary/70 bg-base-100/70 pointer-events-none';
    const label = document.createElement('div');
    label.className = 'panel-bg border border-base-content/10 rounded-lg px-4 py-3 text-sm text-base-content/85 shadow-md';
    label.textContent = 'Drop a .fluidpkg file to install the package';
    this.hint.appendChild(label);
    container.appendChild(this.hint);

    this.target.addEventListener('dragenter', this.onDragEnter, true);
    this.target.addEventListener('dragover', this.onDragOver, true);
    this.target.addEventListener('dragleave', this.onDragLeave, true);
    this.target.addEventListener('drop', this.onDrop, true);
  }

  /** Stop listening and take the hint off the page. */
  destroy(): void {
    this.target.removeEventListener('dragenter', this.onDragEnter, true);
    this.target.removeEventListener('dragover', this.onDragOver, true);
    this.target.removeEventListener('dragleave', this.onDragLeave, true);
    this.target.removeEventListener('drop', this.onDrop, true);
    this.hint.remove();
  }

  private readonly onDragEnter = (e: DragEvent): void => {
    if (!this.takes(e)) {
      return;
    }
    this.depth++;
    this.show(true);
  };

  private readonly onDragOver = (e: DragEvent): void => {
    if (!this.takes(e)) {
      return;
    }
    // Without this the browser opens the dropped file as a page.
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
  };

  private readonly onDragLeave = (e: DragEvent): void => {
    if (!this.takes(e)) {
      return;
    }
    this.depth = Math.max(0, this.depth - 1);
    if (this.depth === 0) {
      this.show(false);
    }
  };

  private readonly onDrop = (e: DragEvent): void => {
    if (!this.takes(e)) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    this.depth = 0;
    this.show(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    const file = files.find((f) => PackageInstallFlow.isPackageFile(f)) ?? files[0];
    if (file) {
      void this.flow.installFile(file);
    }
  };

  get hintShown(): boolean {
    return !this.hint.classList.contains('hidden');
  }

  /** A drag that carries files and isn't over the code editor. */
  private takes(e: DragEvent): boolean {
    const types = e.dataTransfer?.types;
    if (!types || !Array.from(types).includes('Files')) {
      return false;
    }
    const over = e.target instanceof Element ? e.target : null;
    return !over?.closest('.monaco-editor');
  }

  private show(shown: boolean): void {
    this.hint.classList.toggle('hidden', !shown);
    this.hint.classList.toggle('flex', shown);
  }
}
