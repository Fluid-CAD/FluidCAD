import { ICON_ALERT_TRIANGLE } from './icons';

/** What the engine says when its kernel trapped (`engine-suspect`), as the banner reads it. */
export type EngineSuspectReport = {
  message: string;
  featureName: string | null;
  usesOcct: boolean;
  traps: number;
  /** `engine`: the engine restarts itself on request; null: `hint` says how to restart it. */
  restart: 'engine' | null;
  hint: string | null;
};

/** The ways the page can restart the engine. */
export type EngineRestarter = {
  /** The desktop shell's own restart; null outside the shell. */
  desktop: (() => Promise<void>) | null;
  /** Ask the engine to end so its host starts a fresh one (`POST /api/engine/restart`). */
  engine: () => Promise<{ ok: true } | { ok: false; error: string }>;
};

/**
 * The banner a suspect engine raises: its OpenCascade kernel trapped, so its
 * memory may be damaged and nothing it builds can be trusted until it
 * restarts. It says what trapped and offers the restart this host has — the
 * desktop shell's, or the engine's own (`fluidcad serve` starts a fresh one
 * when it ends) — or, where neither exists, says how to restart by hand.
 *
 * It stays up until the page reconnects (a fresh engine, which never sends
 * the report; a still-suspect engine sends it again on connect).
 */
export class EngineSuspectBanner {
  readonly element: HTMLDivElement;
  private readonly messageEl: HTMLSpanElement;
  private readonly hintEl: HTMLSpanElement;
  private readonly button: HTMLButtonElement;
  private report: EngineSuspectReport | null = null;

  constructor(container: HTMLElement, private readonly restarter: EngineRestarter) {
    this.element = document.createElement('div');
    this.element.id = 'fluidcad-engine-suspect-banner';
    this.element.setAttribute('role', 'alert');
    this.element.className = 'absolute bottom-16 left-[calc(50%+var(--fluidcad-scene-left,0px)/2)] -translate-x-1/2 '
      + 'z-[1150] pointer-events-auto hidden w-max max-w-[min(640px,calc(100vw-32px))]';
    this.element.innerHTML = `
      <div class="panel-bg border border-warning/50 rounded-lg shadow-md flex items-start gap-3 px-4 py-2.5 text-sm">
        <span class="text-warning shrink-0 mt-0.5 [&>svg]:size-5">${ICON_ALERT_TRIANGLE}</span>
        <div class="flex flex-col gap-1 min-w-0 grow">
          <span data-ref="message" class="text-base-content/90 break-words"></span>
          <span data-ref="hint" class="text-base-content/60 text-xs hidden"></span>
        </div>
        <button data-ref="restart" type="button" class="btn btn-warning btn-sm shrink-0 hidden">Restart engine</button>
      </div>
    `;
    container.appendChild(this.element);
    this.messageEl = this.element.querySelector('[data-ref="message"]')!;
    this.hintEl = this.element.querySelector('[data-ref="hint"]')!;
    this.button = this.element.querySelector('[data-ref="restart"]')!;
    this.button.addEventListener('click', () => {
      void this.restart();
    });
  }

  get isVisible(): boolean {
    return !this.element.classList.contains('hidden');
  }

  /** The engine reported itself suspect (again: another trap). */
  show(report: EngineSuspectReport): void {
    this.report = report;
    this.messageEl.textContent = report.traps > 1 ? `${report.message} (${report.traps} crashes so far.)` : report.message;
    const restartable = this.restarter.desktop !== null || report.restart === 'engine';
    this.button.classList.toggle('hidden', !restartable);
    if (!this.button.disabled) {
      this.button.textContent = 'Restart engine';
    }
    this.setHint(restartable ? null : report.hint);
    this.element.classList.remove('hidden');
  }

  /** The page connected to an engine afresh: it replays the report if it is still suspect. */
  hide(): void {
    this.report = null;
    this.button.disabled = false;
    this.button.textContent = 'Restart engine';
    this.element.classList.add('hidden');
  }

  private async restart(): Promise<void> {
    if (!this.report || this.button.disabled) {
      return;
    }
    this.button.disabled = true;
    this.button.textContent = 'Restarting…';
    if (this.restarter.desktop) {
      await this.restarter.desktop();
      return;
    }
    const answer = await this.restarter.engine();
    if ('error' in answer) {
      this.button.disabled = false;
      this.button.textContent = 'Restart engine';
      this.setHint(answer.error);
    }
  }

  private setHint(text: string | null): void {
    this.hintEl.textContent = text ?? '';
    this.hintEl.classList.toggle('hidden', !text);
  }
}
