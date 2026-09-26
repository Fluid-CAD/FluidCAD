import { ICON_CLOSE } from '../ui/icons';
import type { EngineOptions, StartProject, StartScreenHost, UpgradeProgress } from './host';
import { diffMessage, renderUpgradeDiff } from './upgrade-diff-view';

/** What a typed version must look like before Compare or Switch unlock. */
const VERSION_SHAPE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** The "Other" row's value: a version typed in, downloaded when switched to. */
const OTHER = 'other';

const ROW = 'flex items-center gap-3 px-3 py-2 border rounded-md cursor-pointer transition-colors';
const ROW_IDLE = `${ROW} border-base-content/10 hover:bg-base-content/[0.04]`;
const ROW_SELECTED = `${ROW} border-primary bg-primary/10`;

type DialogState = {
  project: StartProject;
  current: string | null;
  selected: string | null;
  working: boolean;
};

export type EngineDialogHandlers = {
  /** The pin moved; the page should re-read the recents. */
  applied(): void;
};

/**
 * "Change engine version…" for one project: the engines on disk (the one
 * that ships with the app first, marked latest) plus a typed version that is
 * downloaded when chosen. "Compare first" rebuilds the project on both
 * engines and shows what moved; "Switch" moves the pin, and an open project
 * reopens on it. While either runs, the dialog cannot be dismissed — Escape,
 * the backdrop and Cancel all wait — so a comparison is never abandoned
 * half-way with a download still going.
 *
 * Built like the Settings dialog: a fixed overlay, a header with a close
 * button, a scrolling body and a footer of actions.
 */
export class EngineDialog {
  readonly element: HTMLDivElement;
  private readonly lede: HTMLParagraphElement;
  private readonly versions: HTMLDivElement;
  private readonly result: HTMLDivElement;
  private readonly otherInput: HTMLInputElement;
  private readonly cancelBtn: HTMLButtonElement;
  private readonly closeBtn: HTMLButtonElement;
  private readonly compareBtn: HTMLButtonElement;
  private readonly applyBtn: HTMLButtonElement;
  private state: DialogState | null = null;

  constructor(
    private readonly host: Pick<StartScreenHost, 'engineOptions' | 'previewUpgrade' | 'applyPin'>,
    private readonly handlers: EngineDialogHandlers,
  ) {
    this.element = document.createElement('div');
    this.element.className = 'fixed inset-0 z-[300] bg-black/50 flex items-center justify-center p-4 hidden';
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-modal', 'true');
    this.element.setAttribute('aria-labelledby', 'fluidcad-engine-dialog-title');
    this.element.innerHTML = `
      <div class="w-[560px] max-w-full max-h-[85vh] flex flex-col bg-base-100 border border-base-content/10 rounded-lg shadow-[0_4px_24px_rgba(0,0,0,0.5)] overflow-hidden">
        <div class="flex items-center justify-between px-5 py-3 border-b border-base-content/10 shrink-0">
          <h3 id="fluidcad-engine-dialog-title" class="text-sm font-medium text-base-content/90">Engine version</h3>
          <button data-ref="close" type="button" class="btn btn-ghost btn-square btn-xs text-base-content/60" title="Close" aria-label="Close">
            <span class="[&>svg]:size-4">${ICON_CLOSE}</span>
          </button>
        </div>
        <div class="flex-1 min-h-0 overflow-y-auto px-5 py-4 grid gap-3 content-start">
          <p data-ref="lede" class="text-sm text-base-content/70"></p>
          <div data-ref="versions" role="radiogroup" aria-label="Engine versions" class="grid gap-1"></div>
          <div data-ref="result" class="hidden"></div>
        </div>
        <div class="flex items-center justify-end gap-2 px-5 py-3 border-t border-base-content/10 shrink-0">
          <button data-ref="cancel" type="button" class="btn btn-sm btn-ghost">Cancel</button>
          <button data-ref="compare" type="button" class="btn btn-sm btn-outline">Compare first</button>
          <button data-ref="apply" type="button" class="btn btn-sm btn-primary">Switch</button>
        </div>
      </div>
    `;
    const ref = <T extends HTMLElement>(name: string) => this.element.querySelector<T>(`[data-ref="${name}"]`)!;
    this.lede = ref('lede');
    this.versions = ref('versions');
    this.result = ref('result');
    this.cancelBtn = ref('cancel');
    this.closeBtn = ref('close');
    this.compareBtn = ref('compare');
    this.applyBtn = ref('apply');

    this.otherInput = document.createElement('input');
    this.otherInput.type = 'text';
    this.otherInput.className = 'input input-sm w-32 tabular-nums';
    this.otherInput.placeholder = 'e.g. 0.0.42';
    this.otherInput.spellcheck = false;
    this.otherInput.setAttribute('aria-label', 'Other engine version');
    this.otherInput.addEventListener('input', () => this.sync());
    this.otherInput.addEventListener('focus', () => this.select(OTHER));

    this.cancelBtn.addEventListener('click', () => this.close());
    this.closeBtn.addEventListener('click', () => this.close());
    this.compareBtn.addEventListener('click', () => void this.compare());
    this.applyBtn.addEventListener('click', () => void this.apply());
    this.element.addEventListener('mousedown', (event) => {
      if (event.target === this.element) {
        this.close();
      }
    });
    // Capture phase, like the other modals: the dialog is on top, so its
    // Escape is its own. It never abandons a comparison mid-flight.
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape' && this.isOpen()) {
          event.stopPropagation();
          event.preventDefault();
          this.close();
        }
      },
      true,
    );
  }

  isOpen(): boolean {
    return !this.element.classList.contains('hidden');
  }

  get working(): boolean {
    return this.state?.working ?? false;
  }

  async open(project: StartProject): Promise<void> {
    const options = await this.host.engineOptions(project.path);
    this.state = { project, current: options.current, selected: null, working: false };
    this.otherInput.value = '';
    this.renderLede(project, options);
    this.renderVersions(options);
    this.showResult(null);
    // Preselect the obvious move: the latest engine when the pin lags it,
    // otherwise the current one, so the dialog shows where the project is.
    const preselect = options.latest && options.latest !== options.current ? options.latest : options.current;
    if (preselect && options.choices.some((choice) => choice.version === preselect)) {
      this.select(preselect);
    } else {
      this.sync();
    }
    this.element.classList.remove('hidden');
    const focusTarget =
      this.versions.querySelector<HTMLInputElement>('input[type="radio"]:checked') ??
      this.versions.querySelector<HTMLInputElement>('input[type="radio"]');
    focusTarget?.focus();
  }

  /** A progress line from the shell while a comparison or switch runs for this dialog's project. */
  progress(update: UpgradeProgress): void {
    if (this.state?.working && this.state.project.path === update.workspacePath && update.message) {
      this.showResult(diffMessage(update.message, 'progress'));
    }
  }

  close(): void {
    if (this.working) {
      return;
    }
    this.state = null;
    this.element.classList.add('hidden');
  }

  private selectedVersion(): string | null {
    if (!this.state) {
      return null;
    }
    if (this.state.selected === OTHER) {
      return this.otherInput.value.trim() || null;
    }
    return this.state.selected;
  }

  private select(version: string): void {
    if (!this.state) {
      return;
    }
    this.state.selected = version;
    const radio = [...this.versions.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
      (candidate) => candidate.value === version,
    );
    if (radio) {
      radio.checked = true;
    }
    this.sync();
  }

  /** Buttons and row highlights, from the selection and whether something runs. */
  private sync(): void {
    const version = this.selectedVersion();
    const valid = version !== null && VERSION_SHAPE.test(version) && version !== this.state?.current;
    const busy = this.working;
    this.cancelBtn.disabled = busy;
    this.closeBtn.disabled = busy;
    this.compareBtn.disabled = busy || !valid;
    this.applyBtn.disabled = busy || !valid;
    this.applyBtn.textContent = valid ? `Switch to ${version}` : 'Switch';
    for (const row of this.versions.children) {
      const element = row as HTMLElement;
      element.className = element.dataset.version === this.state?.selected ? ROW_SELECTED : ROW_IDLE;
    }
  }

  private renderLede(project: StartProject, options: EngineOptions): void {
    const code = document.createElement('code');
    code.className = 'font-mono text-xs';
    code.textContent = options.current ?? 'unpinned';
    this.lede.replaceChildren(`${project.name} · currently `, code, options.currentSource === 'pin' ? ' (fluidcad.json)' : '');
  }

  private renderVersions(options: EngineOptions): void {
    const rows: HTMLElement[] = [];
    for (const choice of options.choices) {
      const notes: string[] = [];
      if (choice.builtin) {
        notes.push('latest · ships with the app');
      }
      if (choice.version === options.current) {
        notes.push('current');
      }
      if (!choice.builtin && choice.version !== options.current) {
        notes.push('installed');
      }
      const label = document.createElement('span');
      label.className = 'font-semibold tabular-nums min-w-16';
      label.textContent = choice.version;
      rows.push(this.row(choice.version, label, notes.join(' · ')));
    }
    const otherLabel = document.createElement('span');
    otherLabel.className = 'inline-flex items-center gap-2';
    const otherText = document.createElement('span');
    otherText.className = 'font-semibold min-w-16';
    otherText.textContent = 'Other';
    otherLabel.append(otherText, this.otherInput);
    rows.push(this.row(OTHER, otherLabel, 'downloaded when switched'));
    this.versions.replaceChildren(...rows);
  }

  private row(value: string, label: HTMLElement, note: string): HTMLLabelElement {
    const row = document.createElement('label');
    row.className = ROW_IDLE;
    row.dataset.version = value;
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'fluidcad-engine-version';
    radio.className = 'radio radio-primary radio-sm';
    radio.value = value;
    radio.addEventListener('change', () => this.select(value));
    row.append(radio, label);
    if (note) {
      const text = document.createElement('span');
      text.className = 'text-xs text-base-content/60';
      text.textContent = note;
      row.appendChild(text);
    }
    return row;
  }

  private showResult(content: HTMLElement | null): void {
    this.result.replaceChildren(...(content ? [content] : []));
    this.result.classList.toggle('hidden', content === null);
  }

  private async whileWorking(action: (state: DialogState, version: string) => Promise<void>): Promise<void> {
    const state = this.state;
    const version = this.selectedVersion();
    if (!state || !version || state.working) {
      return;
    }
    state.working = true;
    this.sync();
    try {
      await action(state, version);
    } catch (err) {
      this.showResult(diffMessage(err instanceof Error ? err.message : String(err), 'error'));
    } finally {
      state.working = false;
      if (this.state === state) {
        this.sync();
      }
    }
  }

  private compare(): Promise<void> {
    return this.whileWorking(async (state, version) => {
      this.showResult(diffMessage('Preparing…', 'progress'));
      const result = await this.host.previewUpgrade(state.project.path, version);
      this.showResult(
        result.diff ? renderUpgradeDiff(result.diff) : diffMessage(result.error || 'The comparison failed.', 'error'),
      );
    });
  }

  private async apply(): Promise<void> {
    let applied = false;
    await this.whileWorking(async (state, version) => {
      this.showResult(diffMessage(`Switching to engine ${version}…`, 'progress'));
      const result = await this.host.applyPin(state.project.path, version);
      if (result.ok) {
        applied = true;
      } else {
        this.showResult(diffMessage(result.error || 'The pin could not be changed.', 'error'));
      }
    });
    // Closed only once the dialog stopped working, or `close` would refuse.
    if (applied) {
      this.close();
      this.handlers.applied();
    }
  }
}
