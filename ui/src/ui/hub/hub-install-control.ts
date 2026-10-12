import type { HubClient, HubLocalMarks, PackageInstallOutcome, PackageRefusal, PackagesClient, PackageTarget, ProjectUiStateClient } from '../../api';
import { HubIcons } from './hub-icons';
import { HubText } from './hub-text';

/** Where a project's last install target is kept: the engine's per-project UI state (`ProjectUiStateClient`). */
export type HubTargetMemory = {
  load(): Promise<PackageTarget | null>;
  save(target: PackageTarget): void;
};

/** The memories a {@link HubInstallTarget} can keep its choice in. */
export class HubTargetMemories {
  /** The project's `.fluidcad/ui-state.json`, through the engine (every host talks to the same engine). */
  static project(client: ProjectUiStateClient): HubTargetMemory {
    return {
      load: async () => (await client.load())?.hubInstallTarget ?? null,
      save: (target) => void client.save({ hubInstallTarget: target }),
    };
  }
}

/**
 * Where the panel's installs go (hub-plan H11 decision 6, as corrected by
 * the user on 2026-10-12): the Install button's dropdown selects it, and
 * Install and "Upgrade to X" both install there.
 *
 * **Each project remembers its own last choice** (the user, 2026-10-12,
 * H12): a choice made with a project open is saved through `memory` (the
 * project's `.fluidcad/ui-state.json`) and read back when the panel starts
 * ({@link restore}), across reloads and restarts. Until a project has a
 * choice, it starts at Settings → Packages' "New packages go to", which is
 * My library unless changed. Without an open project it is the library,
 * and nothing is saved.
 */
export class HubInstallTarget {
  private chosen: PackageTarget | null = null;

  constructor(
    private readonly setting: () => PackageTarget,
    private readonly projectOpen: () => boolean,
    private readonly memory: HubTargetMemory | null = null,
  ) {}

  get current(): PackageTarget {
    const target = this.chosen ?? this.setting();
    return target === 'project' && this.projectOpen() ? 'project' : 'library';
  }

  /** Reads this project's remembered choice; a choice made before it answers wins. */
  async restore(): Promise<void> {
    if (!this.memory || !this.projectOpen()) {
      return;
    }
    const remembered = await this.memory.load();
    if (remembered && this.chosen === null) {
      this.chosen = remembered;
    }
  }

  set(target: PackageTarget): void {
    this.chosen = target;
    if (this.memory && this.projectOpen()) {
      this.memory.save(target);
    }
  }
}

/** What the control offers for one package. */
export type HubInstallModel = {
  name: string;
  /** The version an install gets here (the newest this FluidCAD runs); null when none. */
  offered: string | null;
  local: HubLocalMarks;
  projectOpen: boolean;
  /** The hub's host, for sentences. */
  host: string | null;
  /** The archive's size, for the download sentence. */
  size: number | null;
  /** Why nothing can be installed (offered null): the caption under the disabled button. */
  unavailable?: string;
};

/** What an install did, for the panel to catch up (the marks, the catalogs, the scene). */
export type HubInstalled = { name: string; version: string; outcome: PackageInstallOutcome; upgrade: boolean };

export type HubInstallControlDeps = {
  hub: HubClient;
  packages: PackagesClient;
  target: HubInstallTarget;
  onInstalled(installed: HubInstalled): void;
};

type Phase =
  | { kind: 'idle' }
  | { kind: 'downloading' | 'installing'; version: string; upgrade: boolean }
  | { kind: 'done'; text: string; notes: string[] }
  | { kind: 'error'; text: string }
  | { kind: 'conflict'; text: string; version: string; upgrade: boolean };

/** The action the button takes for a model and target. */
type Action = { kind: 'install' | 'upgrade' | 'installed' | 'none'; label: string; caption: string; version: string | null };

/**
 * The detail's Install control (H11 decisions 6 and 7): no consent dialog.
 *
 * - **The split button.** The chevron opens the targets (My library: the
 *   library, used by the open project; This project: a copy in its
 *   `packages/` folder) and selects one; the chosen one shows beside the
 *   button, and Install installs there.
 * - **Install X** downloads and checks the package (`POST /api/hub/inspect`),
 *   then installs it with its token (`POST /api/packages/install`), pinned
 *   in the open project; progress, the hub's notes and the result show
 *   inline.
 * - **Upgrade to X** when the project uses an older version: the same
 *   steps with `upgrade`, which moves the pin to X (temporary until P10's
 *   previewed upgrade; the user accepted that).
 * - The same version with other contents already installed offers Replace,
 *   which downloads it again and installs it over the old one.
 */
export class HubInstallControl {
  readonly el: HTMLDivElement;
  private model: HubInstallModel | null = null;
  private phase: Phase = { kind: 'idle' };
  private menuOpen = false;
  private menu: HTMLDivElement | null = null;

  constructor(private readonly deps: HubInstallControlDeps) {
    this.el = document.createElement('div');
    this.el.dataset.role = 'hub-install';
    this.el.className = 'flex flex-col gap-1.5';
  }

  /** Show `model`; a result for the same package stays until the next install. */
  update(model: HubInstallModel): void {
    if (this.model && this.model.name !== model.name) {
      this.phase = { kind: 'idle' };
    }
    this.model = model;
    this.render();
  }

  get busy(): boolean {
    return this.phase.kind === 'downloading' || this.phase.kind === 'installing';
  }

  destroy(): void {
    this.closeMenu();
    this.el.remove();
  }

  /** What the button does for this model and target. */
  static action(model: HubInstallModel, target: PackageTarget): Action {
    const { offered, local, projectOpen } = model;
    if (!offered) {
      return { kind: 'none', label: 'Install', caption: model.unavailable ?? 'No published version runs on this FluidCAD.', version: null };
    }
    const where = target === 'project' ? 'into this project\'s packages/ folder' : 'into your library';
    if (projectOpen && local.pinned) {
      const order = HubText.compareVersions(offered, local.pinned);
      if (order > 0) {
        return {
          kind: 'upgrade',
          label: `Upgrade to ${offered}`,
          caption: `This project uses ${local.pinned}. Upgrade installs ${offered} ${where} and moves the project to it.`,
          version: offered,
        };
      }
      return {
        kind: 'installed',
        label: 'Installed',
        caption: order === 0 ? `This project uses ${local.pinned}.` : `This project uses ${local.pinned}, newer than ${offered}.`,
        version: null,
      };
    }
    if (!projectOpen) {
      if (local.installed.includes(offered)) {
        return { kind: 'installed', label: 'Installed', caption: 'In your library. Every project can use it.', version: null };
      }
      return { kind: 'install', label: `Install ${offered}`, caption: 'Goes to your library. Every project can use it.', version: offered };
    }
    if (target === 'project') {
      return { kind: 'install', label: `Install ${offered}`, caption: 'A copy goes into this project\'s packages/ folder, committed with it, and the project uses it.', version: offered };
    }
    return {
      kind: 'install',
      label: `Install ${offered}`,
      caption: local.installed.includes(offered)
        ? 'Already in your library: this adds it to this project.'
        : 'Goes to your library, and this project uses it. Every project can use it.',
      version: offered,
    };
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  private render(): void {
    const model = this.model;
    if (!model) {
      this.el.replaceChildren();
      return;
    }
    const target = this.deps.target.current;
    const action = HubInstallControl.action(model, target);
    const row = document.createElement('div');
    row.className = 'flex items-center gap-2 flex-wrap';
    const join = document.createElement('div');
    join.className = 'relative join';
    const main = document.createElement('button');
    main.type = 'button';
    main.dataset.ref = 'install';
    main.dataset.action = action.kind;
    main.className = 'btn btn-sm text-hub-sm btn-primary join-item gap-1.5';
    const chevron = document.createElement('button');
    chevron.type = 'button';
    chevron.dataset.ref = 'target-menu';
    chevron.className = 'btn btn-sm text-hub-sm btn-primary join-item px-1.5 border-l border-l-primary-content/25';
    chevron.setAttribute('aria-label', 'Install into…');
    chevron.setAttribute('aria-haspopup', 'true');
    chevron.setAttribute('aria-expanded', String(this.menuOpen));
    chevron.appendChild(HubIcons.span(HubIcons.CHEVRON_DOWN, '[&>svg]:size-3.5'));
    chevron.addEventListener('click', () => this.toggleMenu());

    const phase = this.phase;
    if (phase.kind === 'downloading' || phase.kind === 'installing') {
      const spinner = document.createElement('span');
      spinner.className = 'loading loading-spinner loading-xs';
      main.append(spinner, phase.kind === 'downloading' ? 'Downloading…' : 'Installing…');
      main.disabled = true;
      chevron.disabled = true;
    } else {
      if (action.kind === 'installed') {
        main.appendChild(HubIcons.span(HubIcons.CHECK, '[&>svg]:size-3.5'));
      }
      main.append(action.label);
      main.disabled = action.kind === 'installed' || action.kind === 'none';
      // Nothing to install, so nothing to choose a place for.
      chevron.disabled = main.disabled;
      main.addEventListener('click', () => {
        if (action.version) {
          void this.run(action.version, action.kind === 'upgrade', false);
        }
      });
    }
    join.append(main, chevron);
    if (this.menuOpen) {
      this.menu = this.targetMenu(model.projectOpen);
      join.appendChild(this.menu);
    }
    const where = document.createElement('span');
    where.dataset.ref = 'target';
    where.className = 'text-hub-xs text-base-content/50';
    where.textContent = target === 'project' ? 'into this project' : 'into my library';
    row.append(join, where);

    const below = this.below(action, model);
    this.el.replaceChildren(row, ...below);
  }

  /** The caption, or what the last install said. */
  private below(action: Action, model: HubInstallModel): HTMLElement[] {
    const phase = this.phase;
    if (phase.kind === 'downloading') {
      return [HubInstallControl.caption(`Downloading ${phase.version}${model.size ? ` (${HubInstallControl.bytes(model.size)})` : ''} from ${model.host ?? 'the hub'} and checking its integrity.`)];
    }
    if (phase.kind === 'installing') {
      return [HubInstallControl.caption(phase.upgrade ? `Installing ${phase.version} and moving this project to it.` : `Installing ${phase.version}.`)];
    }
    if (phase.kind === 'done') {
      const box = HubInstallControl.box('success', phase.text);
      box.dataset.ref = 'result';
      const out: HTMLElement[] = [box];
      for (const note of phase.notes) {
        out.push(HubInstallControl.caption(note, 'note'));
      }
      return out;
    }
    if (phase.kind === 'error') {
      const box = HubInstallControl.box('error', phase.text);
      box.dataset.ref = 'error';
      return [box, HubInstallControl.caption(action.caption)];
    }
    if (phase.kind === 'conflict') {
      const box = HubInstallControl.box('warning', `${phase.text} Replace it with this download? Projects that pinned the old contents will ask about the change.`);
      box.dataset.ref = 'conflict';
      const replace = document.createElement('button');
      replace.type = 'button';
      replace.dataset.ref = 'replace';
      replace.className = 'btn btn-xs text-hub-xs btn-warning self-start';
      replace.textContent = 'Replace';
      replace.addEventListener('click', () => void this.run(phase.version, phase.upgrade, true));
      return [box, replace];
    }
    return [HubInstallControl.caption(action.caption)];
  }

  private targetMenu(projectOpen: boolean): HTMLDivElement {
    const menu = document.createElement('div');
    menu.dataset.role = 'install-targets';
    menu.className = 'absolute left-0 top-[calc(100%+4px)] z-20 w-64 p-1 bg-base-100 border border-base-content/10 rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.4)] flex flex-col text-hub-sm';
    const option = (value: PackageTarget, title: string, hint: string, enabled: boolean) => {
      const selected = this.deps.target.current === value;
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.target = value;
      button.disabled = !enabled;
      button.className = `flex items-start gap-2 px-2 py-1.5 rounded text-left${selected ? ' bg-base-content/[0.06]' : ' hover:bg-base-content/[0.06]'}${enabled ? '' : ' opacity-50'}`;
      button.setAttribute('aria-checked', String(selected));
      button.setAttribute('role', 'menuitemradio');
      button.appendChild(HubIcons.span(HubIcons.CHECK, `[&>svg]:size-3.5 mt-0.5 text-primary${selected ? '' : ' invisible'}`));
      const text = document.createElement('span');
      text.className = 'flex flex-col';
      const name = document.createElement('span');
      name.textContent = title;
      const sub = document.createElement('span');
      sub.className = 'text-hub-xs text-base-content/50';
      sub.textContent = hint;
      text.append(name, sub);
      button.appendChild(text);
      button.addEventListener('click', () => {
        this.deps.target.set(value);
        this.closeMenu();
        this.render();
      });
      return button;
    };
    menu.append(
      option('library', 'My library', projectOpen ? 'Every project can use it; this project uses it.' : 'Every project can use it.', true),
      option('project', 'This project', projectOpen ? 'A copy in its packages/ folder, committed with it.' : 'Needs an open project.', projectOpen),
    );
    return menu;
  }

  private toggleMenu(): void {
    if (this.menuOpen) {
      this.closeMenu();
      this.render();
      return;
    }
    this.menuOpen = true;
    document.addEventListener('pointerdown', this.onPointerDown, true);
    document.addEventListener('keydown', this.onKeyDown, true);
    this.render();
  }

  private closeMenu(): void {
    if (!this.menuOpen) {
      return;
    }
    this.menuOpen = false;
    this.menu = null;
    document.removeEventListener('pointerdown', this.onPointerDown, true);
    document.removeEventListener('keydown', this.onKeyDown, true);
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (this.el.contains(e.target as Node)) {
      return;
    }
    this.closeMenu();
    this.render();
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      this.closeMenu();
      this.render();
    }
  };

  // ---------------------------------------------------------------------------
  // Installing
  // ---------------------------------------------------------------------------

  private async run(version: string, upgrade: boolean, replace: boolean): Promise<void> {
    const model = this.model;
    if (!model || this.busy) {
      return;
    }
    const target = this.deps.target.current;
    this.closeMenu();
    this.phase = { kind: 'downloading', version, upgrade };
    this.render();
    const inspected = await this.deps.hub.inspect({ name: model.name, version, target });
    if (this.model?.name !== model.name) {
      return;
    }
    if (inspected.ok === false) {
      this.phase = { kind: 'error', text: HubInstallControl.refusal(inspected, model, version) };
      this.render();
      return;
    }
    const inspection = inspected.inspection;
    this.phase = { kind: 'installing', version, upgrade };
    this.render();
    const installed = await this.deps.packages.install({ token: inspection.token, target, pin: model.projectOpen, upgrade, replace });
    if (this.model?.name !== model.name) {
      return;
    }
    if (installed.ok === false) {
      this.phase = installed.code === 'conflict'
        ? { kind: 'conflict', text: installed.error, version, upgrade }
        : { kind: 'error', text: HubInstallControl.refusal(installed, model, version) };
      this.render();
      return;
    }
    const notes = [...inspection.warnings.map((warning) => warning.message), ...inspection.notes];
    this.phase = { kind: 'done', text: HubInstallControl.done(model, installed.outcome, upgrade, target), notes };
    this.render();
    this.deps.onInstalled({ name: model.name, version, outcome: installed.outcome, upgrade });
  }

  /** The result sentence. */
  private static done(model: HubInstallModel, outcome: PackageInstallOutcome, upgrade: boolean, target: PackageTarget): string {
    const where = target === 'project' ? 'into this project\'s packages/ folder' : 'in your library';
    const label = `${model.name} ${outcome.version}`;
    if (upgrade) {
      return `This project now uses ${label}, installed ${where}. Its models render with it from now on.`;
    }
    const installedText = outcome.status === 'unchanged' ? `${label} was already ${where}` : `Installed ${label} ${where}`;
    if (outcome.pin === 'pinned') {
      return `${installedText}, and this project uses it. Its features are under Custom in the toolbar.`;
    }
    return `${installedText}. Every project can use it.`;
  }

  /** The panel's own words for the refusals an install can meet; the engine's sentence otherwise. */
  static refusal(refusal: PackageRefusal, model: HubInstallModel, version: string): string {
    const host = model.host ?? 'the hub';
    switch (refusal.code) {
      case 'hub-unreachable':
        return `Couldn't reach ${host}. Nothing was installed; try again when it answers.`;
      case 'not-found':
      case 'nothing-published':
        return `${model.name} ${version} isn't on ${host} any more. Nothing was installed.`;
      case 'version-removed':
        return `${model.name} ${version} was removed from ${host}. Nothing was installed.`;
      case 'integrity-mismatch':
        return `${refusal.error} Nothing was installed.`;
      default:
        return refusal.error;
    }
  }

  private static caption(text: string, mark = 'caption'): HTMLParagraphElement {
    const p = document.createElement('p');
    p.dataset.ref = mark;
    p.className = 'text-hub-xs text-base-content/55 leading-snug';
    p.textContent = text;
    return p;
  }

  private static box(tone: 'success' | 'error' | 'warning', text: string): HTMLDivElement {
    const box = document.createElement('div');
    const look = { success: 'bg-success/10', error: 'bg-error/10 border border-error/30', warning: 'bg-warning/15' }[tone];
    const icon = { success: 'text-success', error: 'text-error', warning: 'text-warning' }[tone];
    box.className = `flex items-start gap-2 rounded-md px-3 py-2 text-hub-sm leading-snug text-base-content/90 ${look}`;
    box.appendChild(HubIcons.span(tone === 'success' ? HubIcons.DONE : HubIcons.WARNING, `[&>svg]:size-4 mt-px ${icon}`));
    const span = document.createElement('span');
    span.textContent = text;
    box.appendChild(span);
    return box;
  }

  private static bytes(n: number): string {
    if (n < 1024) {
      return `${n} B`;
    }
    if (n < 1024 * 1024) {
      return `${(n / 1024).toFixed(1)} kB`;
    }
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }
}
