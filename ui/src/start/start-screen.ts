import { closePopupMenu } from '../ui/popup-menu';
import { ContractError } from './contract-guards';
import { EngineDialog } from './engine-dialog';
import { FolderPicker } from './folder-picker';
import { START_SCREEN_PROTOCOL, type StartProject, type StartScreenHost } from './host';
import { LearnPanel } from './learn-panel';
import { Notices } from './notices';
import { OpeningOverlay } from './opening-overlay';
import { ProjectGrid } from './project-grid';
import { StartTopBar } from './start-top-bar';

/** Only a theme name reaches `data-theme`; anything else is ignored. */
const THEME_NAME = /^[\w-]+$/;

/**
 * The start screen: where the desktop app's windows and `npx fluidcad`'s
 * browser tabs begin. A top bar with Open Project and New Project, the feed's
 * notifications, the recent projects, and "Learn FluidCAD". Opening a project
 * gives it a window or tab of its own, which shows this page under the
 * opening overlay until the project's own page takes its place.
 *
 * Everything it shows comes from the host and every action goes back to it;
 * the page keeps no state of its own beyond what is on screen. It re-reads the
 * recents, the feed and the theme whenever the window regains focus, and the
 * recents whenever the shell says they changed.
 */
export class StartScreen {
  private readonly topBar: StartTopBar;
  private readonly problem: HTMLDivElement;
  private readonly notices: Notices;
  private readonly grid: ProjectGrid;
  private readonly learn: LearnPanel;
  private readonly overlay: OpeningOverlay;
  private readonly engineDialog: EngineDialog;
  /** The page's own folder picker, for a host without native dialogs (a browser). */
  private readonly folderPicker: FolderPicker | null;
  private readonly content: HTMLElement;
  private home = '';

  constructor(
    root: HTMLElement,
    private readonly host: StartScreenHost,
  ) {
    root.classList.add('relative', 'flex', 'flex-col', 'overflow-hidden');

    const dialogs = host.dialogs;
    this.folderPicker =
      dialogs.kind === 'page'
        ? new FolderPicker(dialogs, {
            open: (path) => void this.run(() => this.host.open(path)),
            create: (path) => void this.run(() => dialogs.create(path)),
          })
        : null;
    this.topBar = new StartTopBar({
      openProject: () =>
        this.run(() => (dialogs.kind === 'native' ? dialogs.open() : this.folderPicker!.show('open'))),
      newProject: () =>
        this.run(() => (dialogs.kind === 'native' ? dialogs.create() : this.folderPicker!.show('create'))),
    });

    this.problem = document.createElement('div');
    this.problem.className = 'hidden alert alert-error alert-soft mb-6 text-sm';
    this.problem.setAttribute('role', 'alert');

    this.notices = new Notices({
      dismiss: (id) => void this.run(() => this.host.dismissNotification(id)),
      openLink: (url) => void this.run(() => this.host.openLink(url)),
    });
    this.grid = new ProjectGrid(
      {
        open: (project) => this.run(() => this.host.open(project.path)),
        changeEngine: (project) => void this.openEngineDialog(project),
        close: (project) => this.run(async () => {
          const result = await this.host.close(project.path);
          if (!result.ok) {
            this.showProblem(result.error ?? `${project.name} could not be closed.`);
          }
          await this.refreshProjects();
        }),
        forget: (project) => this.run(async () => {
          await this.host.forget(project.path);
          await this.refreshProjects();
        }),
      },
      root,
    );
    this.learn = new LearnPanel((url) => void this.run(() => this.host.openLink(url)));

    const column = document.createElement('div');
    column.className = 'max-w-[1100px] mx-auto px-6 pt-6 pb-10';
    column.append(this.problem, this.notices.element, this.grid.element, this.learn.element);
    this.content = document.createElement('main');
    this.content.className = 'flex-1 min-h-0 overflow-y-auto';
    this.content.appendChild(column);
    this.content.addEventListener('scroll', () => closePopupMenu());

    this.overlay = new OpeningOverlay({
      cancel: () => void this.run(() => this.host.cancelOpen()),
      retry: () => void this.run(() => this.host.retryOpen()),
    });
    this.engineDialog = new EngineDialog(this.host, { applied: () => void this.refreshProjects() });

    root.replaceChildren(
      this.topBar.element,
      this.content,
      this.overlay.element,
      this.engineDialog.element,
      ...(this.folderPicker ? [this.folderPicker.element] : []),
    );
  }

  /** Introduce the page to its host, subscribe, and draw everything once. */
  async start(): Promise<void> {
    try {
      const hello = await this.host.hello(START_SCREEN_PROTOCOL);
      if (!hello.ok) {
        this.showProblem('This start screen does not match the app. Reinstalling FluidCAD fixes this.');
        return;
      }
      this.home = hello.home;
    } catch (err) {
      this.report(err);
      return;
    }

    this.host.onWindowState((state) => this.showWindowState(state));
    this.host.onChanged(() => void this.refreshProjects());
    this.host.onUpgradeProgress((progress) => this.engineDialog.progress(progress));
    window.addEventListener('focus', () => {
      void this.refreshAppearance();
      void this.refreshProjects();
      void this.refreshFeed();
    });
    window.addEventListener('blur', () => closePopupMenu());
    window.addEventListener('resize', () => closePopupMenu());

    await Promise.all([
      this.run(async () => this.showWindowState(await this.host.windowState())),
      this.refreshAppearance(),
      this.refreshProjects(),
      this.refreshFeed(),
    ]);
  }

  private async refreshProjects(): Promise<void> {
    await this.run(async () => {
      const { projects } = await this.host.list();
      closePopupMenu();
      this.grid.render(projects, this.home);
    });
  }

  /** The feed is a nicety: offline, or unreadable, the page simply has no notices or tutorials. */
  private async refreshFeed(): Promise<void> {
    try {
      const feed = await this.host.feed();
      this.notices.render(feed.notifications);
      this.learn.render(feed.tutorials);
    } catch (err) {
      if (err instanceof ContractError) {
        this.report(err);
      }
    }
  }

  /** A project window may have changed the theme while this one sat behind it. */
  private async refreshAppearance(): Promise<void> {
    await this.run(async () => {
      const { theme } = await this.host.appearance();
      const html = document.documentElement;
      if (THEME_NAME.test(theme) && html.getAttribute('data-theme') !== theme) {
        html.setAttribute('data-theme', theme);
      }
    });
  }

  private showWindowState(state: Parameters<OpeningOverlay['render']>[0]): void {
    this.overlay.render(state);
    // Behind the overlay nothing is reachable, by pointer or by Tab.
    this.content.inert = this.overlay.visible;
    this.topBar.element.inert = this.overlay.visible;
    if (this.overlay.visible) {
      closePopupMenu();
      this.engineDialog.close();
      this.folderPicker?.close();
    }
  }

  private async openEngineDialog(project: StartProject): Promise<void> {
    closePopupMenu();
    await this.run(() => this.engineDialog.open(project));
  }

  /**
   * Run one host call; a failure becomes a line on the page instead of an
   * unhandled rejection. The action starts synchronously, inside the event
   * that asked for it: a browser opens a project's tab only then.
   */
  private async run(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (err) {
      this.report(err);
    }
  }

  private report(err: unknown): void {
    if (err instanceof ContractError) {
      this.showProblem(
        `The app and its start screen disagree (${err.message}). Reinstalling FluidCAD fixes this.`,
      );
      return;
    }
    console.error('[start screen]', err);
    this.showProblem(`Something went wrong: ${err instanceof Error ? err.message : String(err)}`);
  }

  private showProblem(message: string): void {
    this.problem.textContent = message;
    this.problem.classList.remove('hidden');
  }
}
