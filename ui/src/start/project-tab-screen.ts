import { START_SCREEN_PROTOCOL, type StartScreenHost, type WindowState } from './host';
import { OpeningOverlay } from './opening-overlay';
import { PROTOCOL_MISMATCH, problemText } from './problem';

export type TabOpening = Extract<WindowState, { phase: 'opening' }>;

/**
 * The tab `npx fluidcad` opens a project in, until the project's own page
 * takes it over: the opening panel and nothing else. The panel is drawn
 * before the first call to the start server, so the tab never shows the start
 * screen it was opened from, and it then follows the project — a new one
 * being set up, its engine downloading, starting — or says why it could not
 * be opened.
 */
export class ProjectTabScreen {
  private readonly overlay: OpeningOverlay;
  /** The failure on screen is a call of this page's that did not go through, not the project's: Try again asks again. */
  private ownFailure = false;

  constructor(
    root: HTMLElement,
    private readonly host: StartScreenHost,
    /** What the panel says until the start server answers. */
    private readonly opening: TabOpening,
  ) {
    this.overlay = new OpeningOverlay({
      cancel: () => void this.run(() => this.host.cancelOpen()),
      retry: () => void (this.ownFailure ? this.open() : this.run(() => this.host.retryOpen())),
    });
    root.replaceChildren(this.overlay.element);
    this.overlay.render(opening);
  }

  /** Introduce the page to its host, subscribe, and ask for the project. */
  async start(): Promise<void> {
    this.host.onWindowState((state) => this.show(state));
    await this.open();
  }

  private async open(): Promise<void> {
    this.show(this.opening);
    await this.run(async () => {
      const hello = await this.host.hello(START_SCREEN_PROTOCOL);
      if (!hello.ok) {
        this.fail(PROTOCOL_MISMATCH);
        return;
      }
      this.show(await this.host.windowState());
    });
  }

  private show(state: WindowState): void {
    this.ownFailure = false;
    this.overlay.render(state);
  }

  private fail(message: string): void {
    this.ownFailure = true;
    this.overlay.render({ phase: 'failed', project: this.opening.project, message });
  }

  /** Run one host call; a failure becomes the panel's message instead of an unhandled rejection. */
  private async run(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (err) {
      console.error('[project tab]', err);
      this.fail(problemText(err));
    }
  }
}
