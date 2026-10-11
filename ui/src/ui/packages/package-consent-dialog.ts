import type { PackageInspection, PackageInstallOutcome, PackagesClient, PackageTarget } from '../../api';
import { ICON_ALERT_TRIANGLE, ICON_CLOSE } from '../icons';
import { DEFAULT_ICON_SRC } from '../object-icons';
import { PackageText } from './packages-state';

/** What the dialog shows: the summary to consent to, an install in flight, a conflict that can be replaced, or a refusal. */
export type ConsentState = 'review' | 'installing' | 'conflict' | 'error';

export type ConsentRequest = {
  inspection: PackageInspection;
  /** The archive itself: a Replace inspects it again (an install, even a refused one, uses its inspection up). */
  file: Blob;
  /** Whether a project is open, so "This project" can be chosen. */
  projectOpen: boolean;
  /** Pin into the open project as well (the missing-package banner: the file must match the pin). */
  pin?: boolean;
  /** A sentence shown above the summary (the banner's "this is not the package the project uses"). */
  note?: string;
};

const SECTION = 'text-[11px] uppercase tracking-wide text-base-content/50 mt-3 mb-1';
const LIST = 'border border-base-content/10 rounded-md divide-y divide-base-content/[0.06] overflow-y-auto';
const ROW = 'flex items-center gap-2 px-3 py-1.5 text-xs text-base-content/85 min-w-0';
const WARNING = 'flex items-start gap-2 rounded-md px-3 py-2 text-xs leading-snug bg-warning/15 text-base-content/90';

/**
 * The consent step of every install from the page (research §3, "The
 * install flow"): Settings → Packages' Install package…, the project's
 * Packages dialog, the missing-package banner and a `.fluidpkg` dropped on
 * the window all land here once the engine has inspected the archive.
 *
 * It shows what is about to run: the package's name, version and
 * description, the public name it installs under (`installsAs`: the
 * archive holds only its author's bare name), its features (with their icons, served from the inspected
 * archive) and parts, the engine it needs, a warning for every feature that
 * reaches raw OpenCascade, and the plain statement that a package's code
 * runs in the engine with the user's permissions. The user picks where it
 * goes (the user library, or the open project's `packages/` folder) and
 * confirms. A refusal shows the engine's sentence; the same version with
 * other contents already installed offers Replace, which inspects the file
 * again and installs it over the old one. Cancel drops the inspection.
 *
 * Every value goes through `.textContent`; nothing from the manifest is
 * interpolated into markup.
 */
export class PackageConsentDialog {
  private readonly overlay: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly message: HTMLDivElement;
  private readonly installBtn: HTMLButtonElement;
  private readonly cancelBtn: HTMLButtonElement;
  private request: ConsentRequest | null = null;
  private inspection: PackageInspection | null = null;
  private resolve: ((outcome: PackageInstallOutcome | null) => void) | null = null;
  private target: PackageTarget = 'library';
  private _state: ConsentState = 'review';

  constructor(container: HTMLElement, private readonly client: PackagesClient) {
    this.overlay = document.createElement('div');
    // Above Settings (z-[300]), which opens it from its Packages tab, the
    // Packages dialog (z-[1100]) and the error banner (z-[1001]), whose
    // missing-package Install opens it too.
    this.overlay.className = 'fixed inset-0 z-[1110] bg-black/50 flex items-center justify-center hidden';
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.setAttribute('aria-label', 'Install package');
    this.overlay.dataset.role = 'package-consent';
    this.overlay.innerHTML = `
      <div data-ref="box" class="w-[480px] max-w-[92vw] max-h-[86vh] bg-base-100 border border-base-content/10 rounded-lg p-5 shadow-[0_4px_24px_rgba(0,0,0,0.5)] flex flex-col">
        <div class="flex items-center justify-between mb-2 shrink-0">
          <h3 class="text-sm font-medium text-base-content/90">Install package</h3>
          <button data-ref="close" class="btn btn-ghost btn-square btn-xs text-base-content/60" title="Close" aria-label="Close">
            <span class="[&>svg]:size-4">${ICON_CLOSE}</span>
          </button>
        </div>
        <div data-ref="body" class="flex flex-col min-h-0 overflow-y-auto"></div>
        <div data-ref="message" class="hidden rounded-md px-3 py-2 mt-3 text-xs leading-snug shrink-0"></div>
        <div class="flex items-center justify-end gap-2 pt-3 shrink-0">
          <button data-ref="cancel" type="button" class="btn btn-ghost btn-sm">Cancel</button>
          <button data-ref="install" type="button" class="btn btn-primary btn-sm">Install</button>
        </div>
      </div>
    `;
    container.appendChild(this.overlay);
    this.body = this.overlay.querySelector<HTMLDivElement>('[data-ref="body"]')!;
    this.message = this.overlay.querySelector<HTMLDivElement>('[data-ref="message"]')!;
    this.installBtn = this.overlay.querySelector<HTMLButtonElement>('[data-ref="install"]')!;
    this.cancelBtn = this.overlay.querySelector<HTMLButtonElement>('[data-ref="cancel"]')!;
    this.installBtn.addEventListener('click', () => void this.confirm());
    this.cancelBtn.addEventListener('click', () => this.cancel());
    this.overlay.querySelector('[data-ref="close"]')!.addEventListener('click', () => this.cancel());
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay && this._state !== 'installing') {
        this.cancel();
      }
    });
    // Window capture runs ahead of the Settings dialog's document capture,
    // so an Escape here closes this dialog and leaves Settings open.
    window.addEventListener('keydown', this.onKeyDown, true);
  }

  /** Take the dialog off the page for good (an open one answers "cancelled"). */
  destroy(): void {
    this.cancel();
    window.removeEventListener('keydown', this.onKeyDown, true);
    this.overlay.remove();
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.overlay.isConnected && this.isOpen()) {
      e.stopPropagation();
      e.preventDefault();
      if (this._state !== 'installing') {
        this.cancel();
      }
    }
  };

  get state(): ConsentState {
    return this._state;
  }

  isOpen(): boolean {
    return !this.overlay.classList.contains('hidden');
  }

  /** Show the summary; resolves with the install's outcome, or null when the user cancelled. */
  open(request: ConsentRequest): Promise<PackageInstallOutcome | null> {
    // A dialog already open answers "cancelled" to its own caller first.
    this.finish(null, { discard: true });
    this.request = request;
    this.inspection = request.inspection;
    this.target = request.projectOpen ? request.inspection.defaultTarget : 'library';
    this.render();
    this.setState('review');
    this.overlay.classList.remove('hidden');
    this.installBtn.focus();
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  // ---------------------------------------------------------------------------
  // Markup
  // ---------------------------------------------------------------------------

  private render(): void {
    const request = this.request!;
    const { manifest, warnings, bytes } = request.inspection;
    this.body.replaceChildren();

    if (request.note) {
      this.body.appendChild(PackageConsentDialog.warningBox(request.note, 'note'));
    }

    const title = document.createElement('div');
    title.className = 'flex items-baseline gap-2 min-w-0';
    const name = document.createElement('span');
    name.dataset.ref = 'name';
    name.className = 'text-[15px] font-medium text-base-content/90 truncate';
    name.textContent = manifest.name;
    const version = document.createElement('span');
    version.dataset.ref = 'version';
    version.className = 'text-xs text-base-content/60 tabular-nums shrink-0';
    version.textContent = manifest.version;
    title.append(name, version);
    this.body.appendChild(title);

    // The public name it installs under: the archive knows only its bare name (HD29).
    if (request.inspection.installsAs) {
      const installsAs = document.createElement('p');
      installsAs.dataset.ref = 'installs-as';
      installsAs.className = 'text-[11px] text-base-content/60 mt-0.5';
      installsAs.append('Installs as ');
      const publicName = document.createElement('span');
      publicName.className = 'font-mono text-base-content/80';
      publicName.textContent = request.inspection.installsAs;
      installsAs.appendChild(publicName);
      this.body.appendChild(installsAs);
    }

    if (manifest.description) {
      const description = document.createElement('p');
      description.dataset.ref = 'description';
      description.className = 'text-[13px] text-base-content/75 leading-snug mt-1';
      description.textContent = manifest.description;
      this.body.appendChild(description);
    }
    const byline = [manifest.author, manifest.license].filter((part): part is string => typeof part === 'string' && part !== '');
    if (byline.length > 0) {
      const meta = document.createElement('p');
      meta.className = 'text-[11px] text-base-content/50 mt-0.5';
      meta.textContent = byline.join(' · ');
      this.body.appendChild(meta);
    }

    if (manifest.features.length > 0) {
      this.body.appendChild(PackageConsentDialog.section(`Features (${manifest.features.length})`));
      const list = document.createElement('div');
      list.dataset.ref = 'features';
      list.className = `${LIST} max-h-[150px]`;
      for (const feature of manifest.features) {
        list.appendChild(this.featureRow(feature));
      }
      this.body.appendChild(list);
    }
    if (manifest.parts.length > 0) {
      this.body.appendChild(PackageConsentDialog.section(`Parts (${manifest.parts.length})`));
      const list = document.createElement('div');
      list.dataset.ref = 'parts';
      list.className = `${LIST} max-h-[110px]`;
      for (const part of manifest.parts) {
        const row = document.createElement('div');
        row.className = ROW;
        const label = document.createElement('span');
        label.className = 'truncate';
        label.textContent = part.name || part.exportName;
        const kind = document.createElement('span');
        kind.className = 'ml-auto text-[11px] text-base-content/45 shrink-0';
        kind.textContent = part.kind === 'assembly' ? 'assembly' : 'part';
        row.append(label, kind);
        list.appendChild(row);
      }
      this.body.appendChild(list);
    }

    const engine = document.createElement('p');
    engine.dataset.ref = 'engine';
    engine.className = 'text-xs text-base-content/65 mt-3';
    engine.textContent = `${PackageText.engine(manifest)} ${manifest.files.length} files, ${PackageText.bytes(bytes)}.`;
    this.body.appendChild(engine);

    const warningList = document.createElement('div');
    warningList.dataset.ref = 'warnings';
    warningList.className = 'flex flex-col gap-1.5 mt-2';
    for (const warning of warnings) {
      warningList.appendChild(PackageConsentDialog.warningBox(warning.message, warning.code));
    }
    if (warnings.length > 0) {
      this.body.appendChild(warningList);
    }

    const trust = document.createElement('p');
    trust.dataset.ref = 'trust';
    trust.className = 'text-xs text-base-content/80 leading-snug mt-3';
    trust.textContent = "A package's code runs in the FluidCAD engine with your permissions. Install only packages you trust.";
    this.body.appendChild(trust);

    this.body.appendChild(PackageConsentDialog.section('Install into'));
    this.body.appendChild(this.targetChoice(request.projectOpen));
  }

  private featureRow(feature: PackageInspection['manifest']['features'][number]): HTMLDivElement {
    const row = document.createElement('div');
    row.className = ROW;
    row.dataset.featureId = feature.id;
    const icon = document.createElement('img');
    icon.className = 'w-4 h-4 object-contain shrink-0';
    icon.alt = '';
    icon.src = feature.meta?.icon ? this.client.inspectedIconUrl(this.inspection!.token, feature.id) : DEFAULT_ICON_SRC;
    // A missing or broken icon falls back to the generic one, once.
    icon.addEventListener('error', () => {
      icon.src = DEFAULT_ICON_SRC;
    }, { once: true });
    const label = document.createElement('span');
    label.className = 'truncate';
    label.textContent = feature.meta?.label ?? feature.exportName;
    const id = document.createElement('span');
    id.className = 'text-[11px] text-base-content/45 font-mono truncate';
    id.textContent = feature.id;
    row.append(icon, label, id);
    if (feature.usesOcct) {
      const occt = document.createElement('span');
      occt.dataset.ref = 'occt';
      occt.className = 'ml-auto badge badge-xs badge-warning shrink-0';
      occt.textContent = 'raw OpenCascade';
      occt.title = 'This feature calls the OpenCascade kernel directly, which can crash the engine.';
      row.appendChild(occt);
    }
    return row;
  }

  private targetChoice(projectOpen: boolean): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.dataset.ref = 'target';
    wrap.className = 'flex flex-col gap-1.5';
    const option = (value: PackageTarget, label: string, hint: string, enabled: boolean) => {
      const row = document.createElement('label');
      row.className = `flex items-start gap-2 text-xs ${enabled ? 'cursor-pointer' : 'opacity-50'}`;
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'package-target';
      input.value = value;
      input.className = 'radio radio-xs radio-primary mt-0.5';
      input.checked = this.target === value;
      input.disabled = !enabled;
      input.addEventListener('change', () => {
        if (input.checked) {
          this.target = value;
        }
      });
      const text = document.createElement('span');
      text.className = 'flex flex-col';
      const title = document.createElement('span');
      title.className = 'text-base-content/85';
      title.textContent = label;
      const sub = document.createElement('span');
      sub.className = 'text-[11px] text-base-content/50';
      sub.textContent = hint;
      text.append(title, sub);
      row.append(input, text);
      return row;
    };
    wrap.appendChild(option('library', 'My library', 'Every project can use it; a project records only the version it uses.', true));
    wrap.appendChild(option('project', 'This project', projectOpen
      ? "A copy in this project's packages/ folder, committed with it."
      : 'Needs an open project.', projectOpen));
    return wrap;
  }

  private static section(text: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = SECTION;
    el.textContent = text;
    return el;
  }

  private static warningBox(text: string, code: string): HTMLDivElement {
    const box = document.createElement('div');
    box.className = WARNING;
    box.dataset.warning = code;
    const icon = document.createElement('span');
    icon.className = 'text-warning shrink-0 [&>svg]:size-4';
    icon.innerHTML = ICON_ALERT_TRIANGLE;
    const text_ = document.createElement('span');
    text_.textContent = text;
    box.append(icon, text_);
    return box;
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  private async confirm(): Promise<void> {
    if (!this.request || !this.inspection || this._state === 'installing') {
      return;
    }
    const replace = this._state === 'conflict';
    const target = this.target;
    const pin = this.request.pin === true;
    this.setState('installing');
    // Under the name the inspection said (`installsAs`): the archive holds only its bare name.
    const as = this.inspection.installsAs;
    if (replace) {
      // The refused install used the inspection up: inspect the same bytes again.
      const again = await this.client.inspect(this.request.file, target, as);
      if (again.ok === false) {
        this.fail(again.error, 'error');
        return;
      }
      this.inspection = again.inspection;
    }
    const answer = await this.client.install({ token: this.inspection.token, target, replace, pin, as: this.inspection.installsAs ?? as });
    if (!this.request) {
      return;
    }
    if (answer.ok === false) {
      this.fail(answer.error, answer.code === 'conflict' ? 'conflict' : 'error');
      return;
    }
    this.finish(answer.outcome, { discard: false });
  }

  private cancel(): void {
    this.finish(null, { discard: true });
  }

  private fail(sentence: string, state: 'conflict' | 'error'): void {
    this.message.textContent = state === 'conflict'
      ? `${sentence} Replace it with this file? Projects that pinned the old contents will ask about the change.`
      : sentence;
    this.message.className = state === 'conflict'
      ? 'rounded-md px-3 py-2 mt-3 text-xs leading-snug shrink-0 bg-warning/15 text-base-content/90'
      : 'rounded-md px-3 py-2 mt-3 text-xs leading-snug shrink-0 bg-error text-error-content';
    this.setState(state);
  }

  private setState(state: ConsentState): void {
    this._state = state;
    this.overlay.dataset.state = state;
    if (state === 'review') {
      this.message.classList.add('hidden');
    }
    this.installBtn.disabled = state === 'installing' || state === 'error';
    this.installBtn.textContent = state === 'conflict' ? 'Replace' : state === 'installing' ? 'Installing…' : 'Install';
    this.installBtn.classList.toggle('btn-warning', state === 'conflict');
    this.installBtn.classList.toggle('btn-primary', state !== 'conflict');
    this.cancelBtn.disabled = state === 'installing';
    for (const input of this.overlay.querySelectorAll<HTMLInputElement>('input[name="package-target"]')) {
      input.disabled = state === 'installing' || (input.value === 'project' && !this.request?.projectOpen);
    }
  }

  private finish(outcome: PackageInstallOutcome | null, options: { discard: boolean }): void {
    const resolve = this.resolve;
    const inspection = this.inspection;
    this.resolve = null;
    this.request = null;
    this.inspection = null;
    this.overlay.classList.add('hidden');
    if (options.discard && inspection && this._state !== 'error' && this._state !== 'conflict') {
      // Declined before any install used it: the engine drops its scratch now.
      void this.client.discard(inspection.token);
    }
    resolve?.(outcome);
  }
}
