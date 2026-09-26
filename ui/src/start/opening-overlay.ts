import { ICON_ALERT_TRIANGLE } from '../ui/icons';
import { megabytes } from './format';
import type { OpeningProject, OpeningStatus, WindowState } from './host';

export type OpeningOverlayHandlers = {
  /** Abandon the open in progress, or leave a failed one, and show the projects again. */
  cancel(): void;
  retry(): void;
};

/**
 * Drawn over the start screen while this window opens a project: resolving
 * its engine, downloading it if the pin is not installed, starting it. When
 * the engine is ready the shell replaces this whole page with the project's,
 * so the overlay never has a "done" state. If the open fails, the same panel
 * says why and offers to try again or go back.
 */
export class OpeningOverlay {
  readonly element: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private lastPhase: WindowState['phase'] = 'home';

  constructor(private readonly handlers: OpeningOverlayHandlers) {
    this.element = document.createElement('div');
    this.element.className =
      'hidden fixed inset-0 z-[400] grid place-items-center p-4 bg-base-100/70 backdrop-blur-[2px]';
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-modal', 'true');
    this.element.setAttribute('aria-labelledby', 'fluidcad-opening-title');
    this.panel = document.createElement('div');
    this.panel.className =
      'w-[440px] max-w-full grid gap-3 p-5 bg-base-100 border border-base-content/10 rounded-lg ' +
      'shadow-[0_4px_24px_rgba(0,0,0,0.5)]';
    this.element.appendChild(this.panel);
  }

  get visible(): boolean {
    return this.lastPhase !== 'home';
  }

  render(state: WindowState): void {
    const phaseChanged = state.phase !== this.lastPhase;
    this.lastPhase = state.phase;
    this.element.classList.toggle('hidden', state.phase === 'home');
    if (state.phase === 'home') {
      this.panel.replaceChildren();
      return;
    }
    if (state.phase === 'opening') {
      this.renderOpening(state.project, state.status);
    } else {
      this.renderFailed(state.project, state.message);
    }
    if (phaseChanged) {
      // Keyboard focus follows the panel's main action: Cancel while opening,
      // Try again after a failure.
      this.panel.querySelector<HTMLButtonElement>('[data-autofocus]')?.focus();
    }
  }

  private renderOpening(project: OpeningProject, status: OpeningStatus): void {
    const { line, detail, fraction } = OpeningOverlay.describe(project, status);

    const progress = document.createElement('progress');
    progress.className = 'progress progress-primary w-full';
    progress.max = 1;
    if (fraction !== null) {
      progress.value = fraction;
    }

    const statusLine = document.createElement('p');
    statusLine.className = 'text-sm text-base-content/80';
    statusLine.setAttribute('aria-live', 'polite');
    statusLine.dataset.status = status.step;
    statusLine.textContent = line;

    const detailLine = document.createElement('p');
    detailLine.className = 'min-h-4 text-xs text-base-content/55 break-words';
    detailLine.textContent = detail;

    const actions = OpeningOverlay.actions(
      OpeningOverlay.button('Cancel', 'btn btn-sm btn-ghost', () => this.handlers.cancel(), true),
    );
    this.panel.replaceChildren(OpeningOverlay.title(`Opening ${project.name}…`), statusLine, progress, detailLine, actions);
  }

  private renderFailed(project: OpeningProject, message: string): void {
    const title = OpeningOverlay.title(`${project.name} could not be opened`);
    const icon = document.createElement('span');
    icon.className = 'text-error [&>svg]:size-4 shrink-0';
    icon.innerHTML = ICON_ALERT_TRIANGLE;
    title.prepend(icon);

    const text = document.createElement('p');
    text.className = 'text-sm text-error whitespace-pre-wrap break-words select-text max-h-[40vh] overflow-auto';
    text.dataset.message = '';
    text.textContent = message;

    const actions = OpeningOverlay.actions(
      OpeningOverlay.button('Back to projects', 'btn btn-sm btn-outline', () => this.handlers.cancel(), false),
      OpeningOverlay.button('Try again', 'btn btn-sm btn-primary', () => this.handlers.retry(), true),
    );
    this.panel.replaceChildren(title, text, actions);
  }

  /** What the panel says for one step of an open; `fraction` is null for an indeterminate bar. */
  static describe(
    project: OpeningProject,
    status: OpeningStatus,
  ): { line: string; detail: string; fraction: number | null } {
    switch (status.step) {
      case 'resolving':
        return { line: 'Finding the engine for this project…', detail: project.path, fraction: null };
      case 'downloading': {
        const line = `Downloading engine ${status.version}…`;
        if (status.totalBytes) {
          const fraction = Math.min(1, status.receivedBytes / status.totalBytes);
          return {
            line,
            detail: `${megabytes(status.receivedBytes)} of ${megabytes(status.totalBytes)} (${Math.round(fraction * 100)}%)`,
            fraction,
          };
        }
        return {
          line,
          detail: status.receivedBytes
            ? megabytes(status.receivedBytes)
            : 'This project pins a version that is not installed yet.',
          fraction: null,
        };
      }
      case 'starting':
        return {
          line: `Starting engine ${status.version}…`,
          detail: status.source === 'project' ? "Using this project's own install." : '',
          fraction: null,
        };
    }
  }

  private static title(text: string): HTMLHeadingElement {
    const title = document.createElement('h2');
    title.id = 'fluidcad-opening-title';
    title.className = 'flex items-center gap-2 text-[15px] font-semibold text-base-content break-words';
    title.append(text);
    return title;
  }

  private static button(label: string, className: string, onClick: () => void, autofocus: boolean): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    if (autofocus) {
      button.dataset.autofocus = '';
    }
    button.addEventListener('click', onClick);
    return button;
  }

  private static actions(...buttons: HTMLButtonElement[]): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'flex justify-end gap-2 pt-1';
    row.append(...buttons);
    return row;
  }
}
