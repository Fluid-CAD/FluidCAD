import {
  checkActionResult,
  checkAppearance,
  checkApplyPinResult,
  checkEngineOptions,
  checkFeed,
  checkFolderCheck,
  checkFolderListing,
  checkHello,
  checkProjectList,
  checkSessionEvent,
  checkSessionView,
  checkUpgradePreview,
  checkUpgradeProgress,
} from './contract-guards';
import type {
  ProjectDialogs,
  SessionView,
  StartProject,
  StartScreenHost,
  UpgradeProgress,
  WindowState,
} from './host';
import type { TabOpening } from './project-tab-screen';
import { ProjectTabs, projectNameOf, projectOfTab } from './project-tabs';

/**
 * The start screen's host under `npx fluidcad`: the launcher's start server,
 * over HTTP. The same calls the desktop app answers over its preload bridge,
 * answered by the same launcher code (`launcher/src/start/api.ts`), plus what
 * a browser needs on top: the page's own folder picker, and a tab per project.
 *
 * A page is one of two things. At `/` it is the start screen. At
 * `/?project=<path>` it is the tab that project opens in: it shows the opening
 * overlay and nothing else (`tabOpening`, `project-tab-screen.ts`), asks the
 * start server to open the project, follows its progress, and goes to the
 * engine's page once the project runs — the browser's version of the desktop
 * window that swaps the start page for the project's.
 *
 * Every reply goes through the same runtime guards as the desktop bridge's.
 * Pushes (the recents changed, a comparison's progress, a session moved on)
 * arrive as Server-Sent Events on `api/events`.
 */

/** The header the start server wants on every call that changes something (`launcher/src/server/auth.ts`). */
const REQUEST_HEADER = 'x-fluidcad-launcher';

/** How long a project's tab waits for the event stream before asking where its project is. */
const EVENTS_READY_TIMEOUT_MS = 3_000;

/** A project's tab also asks now and then, in case an event was lost on the way. */
const SESSION_POLL_MS = 3_000;

const NOT_RUNNING = 'FluidCAD is not running any more. Run npx fluidcad again to start it.';

type EventSourceLike = Pick<EventSource, 'addEventListener' | 'readyState'>;

/** Everything the host needs from the browser, so a test can hand it stand-ins. */
export type HttpHostEnvironment = {
  /** The page's URL: `?project=` makes this page a project's tab. */
  search: string;
  fetch: typeof fetch;
  openEvents(url: string): EventSourceLike;
  tabs: ProjectTabs;
  /** Leave this page for `url`, with no way back to it. */
  navigate(url: string): void;
  /** Close this tab; a tab the user opened by hand cannot be, and stays open. */
  closeTab(): void;
  openExternal(url: string): void;
  /** Called whenever the page comes back into view. */
  onVisible(handler: () => void): void;
  setTimer(handler: () => void, ms: number): unknown;
};

export function browserEnvironment(): HttpHostEnvironment {
  return {
    search: location.search,
    fetch: (input, init) => fetch(input, init),
    openEvents: (url) => new EventSource(url),
    tabs: new ProjectTabs(window),
    navigate: (url) => location.replace(url),
    closeTab: () => window.close(),
    openExternal: (url) => void window.open(url, '_blank', 'noopener,noreferrer'),
    onVisible: (handler) => {
      window.addEventListener('focus', handler);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          handler();
        }
      });
    },
    setTimer: (handler, ms) => setTimeout(handler, ms),
  };
}

export class HttpStartHost implements StartScreenHost {
  readonly dialogs: ProjectDialogs;
  /** The project this tab opens, or null on the start screen. */
  private readonly tabProject: { path: string; create: boolean } | null;
  private readonly events: EventSourceLike;
  private readonly eventsReady: Promise<void>;
  /** Projects the last list said are open: a card for one of them looks for its tab first. */
  private openPaths = new Set<string>();
  private readonly stateHandlers: ((state: WindowState) => void)[] = [];
  /** This tab left for its project's page, or is closing: nothing more to draw. */
  private leaving = false;
  private polling = false;

  constructor(private readonly env: HttpHostEnvironment = browserEnvironment()) {
    this.tabProject = projectOfTab(env.search);
    this.events = env.openEvents('api/events');
    this.eventsReady = new Promise((resolve) => {
      this.events.addEventListener('open', () => resolve(), { once: true });
      env.setTimer(resolve, EVENTS_READY_TIMEOUT_MS);
    });
    this.events.addEventListener('session', (event) => {
      const update = checkSessionEvent(JSON.parse((event as MessageEvent).data));
      if (this.tabProject && update.path === this.tabProject.path) {
        this.show(update.view);
      }
    });
    this.dialogs = {
      kind: 'page',
      browse: async (path) =>
        checkFolderListing(await this.request('GET', path === null ? 'api/folders' : `api/folders?${new URLSearchParams({ path })}`)),
      check: async (parent, name) => checkFolderCheck(await this.request('POST', 'api/folders/check', { parent, name })),
      create: async (path) => this.showTab(path, { running: false, create: true }),
    };
    if (!this.tabProject) {
      // A browser tab gives no notice before it closes, so the start screen
      // coming back into view is when running projects' previews are retaken.
      env.onVisible(() => void this.request('POST', 'api/start/refresh-previews').catch(() => undefined));
    }
  }

  /**
   * What a project's tab draws from its first frame, before the start server
   * has said anything: the step every open begins with. Null on the start
   * screen.
   */
  get tabOpening(): TabOpening | null {
    const tab = this.tabProject;
    return tab
      ? {
          phase: 'opening',
          project: { path: tab.path, name: projectNameOf(tab.path) },
          status: { step: tab.create ? 'creating' : 'resolving' },
        }
      : null;
  }

  async hello(protocol: number) {
    return checkHello(await this.request('POST', 'api/start/hello', { protocol }));
  }

  async windowState(): Promise<WindowState> {
    if (!this.tabProject) {
      return { phase: 'home' };
    }
    // Listening first: a project that is quick to open must not run before
    // this tab hears about it.
    await this.eventsReady;
    const view = checkSessionView(await this.request('POST', 'api/sessions', this.tabProject));
    this.pollWhileOpening();
    return this.stateOf(view);
  }

  onWindowState(handler: (state: WindowState) => void): void {
    this.stateHandlers.push(handler);
  }

  async cancelOpen(): Promise<void> {
    if (!this.tabProject) {
      return;
    }
    try {
      await this.request('POST', 'api/sessions/cancel', { path: this.tabProject.path });
    } finally {
      // Whatever the start server said, this tab has nothing left to open.
      this.leave();
    }
  }

  async retryOpen(): Promise<void> {
    if (this.tabProject) {
      await this.request('POST', 'api/sessions/retry', { path: this.tabProject.path });
      this.pollWhileOpening();
    }
  }

  async appearance() {
    return checkAppearance(await this.request('GET', 'api/start/appearance'));
  }

  async list() {
    const list = checkProjectList(await this.request('GET', 'api/start/projects'));
    this.openPaths = new Set(list.projects.filter((project: StartProject) => project.open).map((project) => project.path));
    return list;
  }

  async feed() {
    return checkFeed(await this.request('GET', 'api/start/feed'));
  }

  async dismissNotification(id: string): Promise<void> {
    await this.request('POST', 'api/start/dismiss-notification', { id });
  }

  /** Opens `path` in its own tab. Synchronous up to `window.open`: it runs inside the click. */
  async open(path: string): Promise<void> {
    const running = this.openPaths.has(path);
    this.showTab(path, { running });
    if (running) {
      // Its tab may be showing an engine that has since stopped; this starts
      // it again, on the same port, where that tab reconnects by itself.
      await this.request('POST', 'api/sessions', { path });
    }
  }

  async close(path: string) {
    const result = checkActionResult(await this.request('POST', 'api/start/close', { path }));
    if (result.ok) {
      this.env.tabs.close(path);
    }
    return result;
  }

  async forget(path: string): Promise<void> {
    await this.request('POST', 'api/start/forget', { path });
  }

  async openLink(url: string): Promise<void> {
    if (/^https?:\/\//.test(url)) {
      this.env.openExternal(url);
    }
  }

  async engineOptions(path: string) {
    return checkEngineOptions(await this.request('GET', `api/start/engine-options?${new URLSearchParams({ path })}`));
  }

  async previewUpgrade(path: string, version: string) {
    return checkUpgradePreview(await this.request('POST', 'api/start/preview-upgrade', { path, version }));
  }

  async applyPin(path: string, version: string) {
    const wasOpen = this.openPaths.has(path);
    const result = checkApplyPinResult(await this.request('POST', 'api/start/apply-pin', { path, version }));
    if (result.ok && wasOpen) {
      // Its engine stopped for the switch; its tab opens it again on the new one.
      this.env.tabs.reopen(path);
    }
    return result;
  }

  onUpgradeProgress(handler: (progress: UpgradeProgress) => void): void {
    this.events.addEventListener('upgrade-progress', (event) =>
      handler(checkUpgradeProgress(JSON.parse((event as MessageEvent).data))),
    );
  }

  onChanged(handler: () => void): void {
    this.events.addEventListener('changed', () => handler());
  }

  // -------------------------------------------------------------------------

  private showTab(path: string, options: { running: boolean; create?: boolean }): void {
    if (!this.env.tabs.show(path, options)) {
      throw new Error('The browser blocked the new tab. Allow pop-ups for this page, then try again.');
    }
  }

  /** A session as this tab's overlay draws it; a running one sends the tab to the project's page. */
  private stateOf(view: SessionView): WindowState {
    switch (view.phase) {
      case 'opening':
        return { phase: 'opening', project: view.project, status: view.status };
      case 'failed':
        return { phase: 'failed', project: view.project, message: view.message };
      case 'running':
        if (!this.leaving) {
          this.leaving = true;
          this.env.navigate(view.url);
        }
        return { phase: 'opening', project: view.project, status: { step: 'starting', version: view.version, source: view.source } };
      case 'closed':
        // Cancelled, here or from another page: this tab has nothing left to show.
        this.leave();
        return { phase: 'home' };
    }
  }

  private show(view: SessionView): void {
    if (this.leaving) {
      return;
    }
    const state = this.stateOf(view);
    for (const handler of this.stateHandlers) {
      handler(state);
    }
  }

  /** Ask where the project is every few seconds while it opens: the stream is the fast path, this the safety net. */
  private pollWhileOpening(): void {
    const project = this.tabProject;
    if (!project || this.polling) {
      return;
    }
    this.polling = true;
    const poll = async () => {
      let again = false;
      try {
        if (!this.leaving) {
          const view = checkSessionView(
            await this.request('GET', `api/sessions?${new URLSearchParams({ path: project.path })}`),
          );
          this.show(view);
          again = view.phase === 'opening';
        }
      } catch {
        // The start server is gone; the next action says so.
      }
      if (again) {
        this.env.setTimer(() => void poll(), SESSION_POLL_MS);
      } else {
        this.polling = false;
      }
    };
    this.env.setTimer(() => void poll(), SESSION_POLL_MS);
  }

  /** Close this tab, or show the start screen in it when the browser will not close it. */
  private leave(): void {
    if (this.leaving) {
      return;
    }
    this.leaving = true;
    this.env.closeTab();
    this.env.setTimer(() => this.env.navigate('/'), 100);
  }

  private async request(method: 'GET' | 'POST', url: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.env.fetch(url, {
        method,
        credentials: 'same-origin',
        headers: { [REQUEST_HEADER]: '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error(NOT_RUNNING);
    }
    const payload: any = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(typeof payload?.error === 'string' ? payload.error : `FluidCAD answered ${response.status}.`);
    }
    return payload;
  }
}
