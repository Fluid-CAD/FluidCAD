/**
 * The start screen's contract with whatever hosts it: a launcher.
 *
 * Two launchers host this page. The desktop app serves it over
 * `fluidcad-app://start/` and answers through `window.fluidcadShell.start`;
 * `npx fluidcad` serves it over HTTP and answers at `/api/` (`http-host.ts`).
 * The page renders; the launcher owns the data (recents, thumbnails, the
 * feed, every project's engine pin) and performs the actions (open a project,
 * run a comparison, move a pin). The page never reaches an engine: it opens
 * projects, and each project shows its own engine's page.
 *
 * The page and its launcher always ship together — the desktop app's built-in
 * engine, or the CLI's own package — so this is not a cross-version contract.
 * It is still checked twice: the first call is {@link StartScreenHost.hello}
 * with {@link START_SCREEN_PROTOCOL}, and every reply goes through the runtime
 * guards in `contract-guards.ts`.
 *
 * The launcher keeps its own copies of these types (`launcher/src/start/
 * contract.ts`, across a package boundary, the same convention as
 * `file-kind.ts` and `project-pin.ts`), and
 * `launcher/tests/start-contract.test.ts` runs its real payloads through this
 * side's guards so the two cannot drift.
 */

import {
  checkActionResult,
  checkAppearance,
  checkApplyPinResult,
  checkEngineOptions,
  checkFeed,
  checkHello,
  checkProjectList,
  checkUpgradePreview,
  checkUpgradeProgress,
  checkWindowState,
} from './contract-guards';

/**
 * Bumped on any change to the shapes below; the launcher answers `hello` with
 * `ok: false` on a mismatch. 2: a `creating` step while a new project is set
 * up, and closing a project from its card. 3: `projectsRoot` in the hello
 * reply.
 */
export const START_SCREEN_PROTOCOL = 3;

export type HelloReply = {
  ok: boolean;
  appVersion: string;
  platform: string;
  /**
   * The folder every project lives in (`npx fluidcad --projects`), or null
   * when projects may live anywhere. With one, the page lists that folder's
   * projects, New Project asks for a name only, and Open Project is not
   * offered: every project there is already on the page.
   */
  projectsRoot: string | null;
  /** The user's home directory, for showing `~/…` paths; the page has no `os` of its own. */
  home: string;
};

export type OpeningProject = { path: string; name: string };

/** Where the engine a project opens with came from. */
export type OpeningSource = 'project' | 'cache' | 'builtin' | 'downloaded';

export type OpeningStatus =
  | { step: 'creating' }
  | { step: 'resolving' }
  | { step: 'downloading'; version: string; receivedBytes: number; totalBytes: number | null }
  | { step: 'starting'; version: string; source: OpeningSource };

/**
 * What the window this page is in is doing. `home` is the start screen
 * itself; `opening` and `failed` are drawn over it while a project is on its
 * way, or could not be opened. There is no `project` state here: by then the
 * window shows the project's own page, not this one.
 */
export type WindowState =
  | { phase: 'home' }
  | { phase: 'opening'; project: OpeningProject; status: OpeningStatus }
  | { phase: 'failed'; project: OpeningProject; message: string };

export type Appearance = { theme: string };

export type StartProject = {
  path: string;
  name: string;
  /** The engine version the project runs on, and where that comes from. */
  engine: string | null;
  engineSource: 'pin' | 'own' | null;
  /** The pin is the engine that ships with the app — the card says "latest". */
  latest: boolean;
  /** A newer built-in engine the pin could move to; the card says so. */
  upgradeTo: string | null;
  lastOpenedAt: string;
  /** Open in some window right now. */
  open: boolean;
  /** A `fluidcad-app://thumbnails/…` URL, or null before the first close with a solid up. */
  thumbnail: string | null;
};

export type StartProjectList = { projects: StartProject[] };

export type FeedTutorial = {
  id: string;
  title: string;
  description: string;
  url: string;
  thumbnail: string;
};

export type FeedNotification = {
  id: string;
  /** Remote HTML; rendered only through `sanitize-notice.ts`. */
  body: string;
  expiresAt: string | null;
  minVersion: string | null;
};

export type StartFeed = {
  tutorials: FeedTutorial[];
  notifications: FeedNotification[];
};

export type EngineChoice = {
  version: string;
  /** Ships with the app — the "latest" the start screen talks about. */
  builtin: boolean;
  /** Already on disk; anything else is downloaded when the pin moves. */
  installed: boolean;
};

export type EngineOptions = {
  current: string | null;
  currentSource: 'pin' | 'own' | null;
  latest: string | null;
  choices: EngineChoice[];
};

export type ModelDiffStatus = 'identical' | 'changed' | 'broken' | 'fixed';

export type ModelDiff = {
  /** Workspace-relative, for display. */
  file: string;
  status: ModelDiffStatus;
  notes: string[];
};

export type UpgradeDiff = {
  from: string;
  to: string;
  models: ModelDiff[];
  /** Files that were not compared because the cap was hit. */
  skipped: string[];
  identical: boolean;
};

export type UpgradePreview = { diff?: UpgradeDiff; error?: string };

/** What an action that can be refused answers: moving a pin, closing a project. */
export type ActionResult = { ok: boolean; error?: string };

export type ApplyPinResult = ActionResult;

export type UpgradeProgress = { workspacePath: string; message: string };

/**
 * `npx fluidcad` only: a project it opens in a browser tab, as that tab sees
 * it. The tab shows this page while the project opens, and goes to the
 * engine's page once the session runs.
 */
export type SessionView =
  | { phase: 'opening'; project: OpeningProject; status: OpeningStatus }
  | { phase: 'failed'; project: OpeningProject; message: string }
  | { phase: 'running'; project: OpeningProject; url: string; version: string; source: OpeningSource }
  | { phase: 'closed'; project: OpeningProject };

/** Pushed to every page whenever a session changes. */
export type SessionEvent = { path: string; view: SessionView };

/** One folder in the page's own folder picker. */
export type FolderEntry = { name: string; path: string; project: boolean };

export type FolderListing = {
  path: string;
  /** The listed folder is a project itself. */
  project: boolean;
  /** Null at a file-system root. */
  parent: string | null;
  home: string;
  /** Where browsing can start over: `/`, or each drive on Windows. */
  roots: string[];
  entries: FolderEntry[];
};

/**
 * What a folder holds, as far as opening or creating a project there goes.
 * `missing` does not exist yet (a new project creates it); `invalid-name` is a
 * name that cannot be a folder at all.
 */
export type FolderState = 'missing' | 'empty' | 'project' | 'not-empty' | 'not-a-folder' | 'unreadable' | 'invalid-name';

export type FolderCheck = { path: string; state: FolderState };

/**
 * How the page asks for a project's folder. The desktop app shows the
 * operating system's own dialogs. A browser cannot hand a page a real path,
 * so under `npx fluidcad` the page draws its own picker over folders the
 * launcher lists (`folder-picker.ts`).
 */
export type ProjectDialogs =
  | {
      kind: 'native';
      /** Pick a folder in a native dialog; the project there opens. */
      open(): Promise<void>;
      /** Pick an empty folder in a native dialog; a project is set up there and opens. */
      create(): Promise<void>;
    }
  | {
      kind: 'page';
      /** The subfolders of `path`, or of a sensible place to start when it is null. */
      browse(path: string | null): Promise<FolderListing>;
      /** What creating a project named `name` inside `parent` would do. */
      check(parent: string, name: string): Promise<FolderCheck>;
      /** Set a project up at `path` (a folder that is missing or empty) and open it. */
      create(path: string): Promise<void>;
    };

export interface StartScreenHost {
  /** The first call. A protocol mismatch makes the shell replace this page with its fallback. */
  hello(protocol: number): Promise<HelloReply>;
  windowState(): Promise<WindowState>;
  /** Pushed on every change of this window's state. */
  onWindowState(handler: (state: WindowState) => void): void;
  /** Abandon the open in progress (or the failed one) and come back here. */
  cancelOpen(): Promise<void>;
  retryOpen(): Promise<void>;
  /** Re-read on focus: a project window may have changed the theme meanwhile. */
  appearance(): Promise<Appearance>;
  list(): Promise<StartProjectList>;
  feed(): Promise<StartFeed>;
  dismissNotification(id: string): Promise<void>;
  /** Open a project, or bring forward the window or tab that already has it. */
  open(path: string): Promise<void>;
  /** How the user picks a folder to open, or to create a project in. */
  readonly dialogs: ProjectDialogs;
  /** Close an open project: its engine stops, and its window goes back to the start screen or its tab closes. */
  close(path: string): Promise<ActionResult>;
  forget(path: string): Promise<void>;
  /** An http(s) link, opened in the user's browser. */
  openLink(url: string): Promise<void>;
  /** What the engine dialog lists for one project. */
  engineOptions(path: string): Promise<EngineOptions>;
  /** Rebuild the project on both engines and report what moved. Commits nothing. */
  previewUpgrade(path: string, version: string): Promise<UpgradePreview>;
  /** Move the pin; an open project is reopened on it. */
  applyPin(path: string, version: string): Promise<ApplyPinResult>;
  onUpgradeProgress(handler: (progress: UpgradeProgress) => void): void;
  /** The recents changed under the page (a project closed, a preview landed). */
  onChanged(handler: () => void): void;
}

/**
 * The desktop app's bridge as its preload exposes it: the host's calls, with
 * the native dialogs as calls of their own and replies nobody has checked yet.
 */
export type StartScreenBridge = {
  [K in Exclude<keyof StartScreenHost, 'dialogs'> | 'openDialog' | 'newProject']: (...args: any[]) => any;
};

declare global {
  interface Window {
    fluidcadShell?: { start?: StartScreenBridge };
  }
}

/**
 * The desktop app's bridge with every reply validated on the way in. A reply
 * the guards reject throws a `ContractError`, which the page shows as one
 * plain sentence rather than rendering half a screen from a payload it
 * misread.
 */
export function guardedHost(bridge: StartScreenBridge): StartScreenHost {
  return {
    hello: async (protocol) => checkHello(await bridge.hello(protocol)),
    windowState: async () => checkWindowState(await bridge.windowState()),
    onWindowState: (handler) => bridge.onWindowState((state: unknown) => handler(checkWindowState(state))),
    cancelOpen: () => bridge.cancelOpen(),
    retryOpen: () => bridge.retryOpen(),
    appearance: async () => checkAppearance(await bridge.appearance()),
    list: async () => checkProjectList(await bridge.list()),
    feed: async () => checkFeed(await bridge.feed()),
    dismissNotification: (id) => bridge.dismissNotification(id),
    open: (path) => bridge.open(path),
    dialogs: { kind: 'native', open: () => bridge.openDialog(), create: () => bridge.newProject() },
    close: async (path) => checkActionResult(await bridge.close(path)),
    forget: (path) => bridge.forget(path),
    openLink: (url) => bridge.openLink(url),
    engineOptions: async (path) => checkEngineOptions(await bridge.engineOptions(path)),
    previewUpgrade: async (path, version) => checkUpgradePreview(await bridge.previewUpgrade(path, version)),
    applyPin: async (path, version) => checkApplyPinResult(await bridge.applyPin(path, version)),
    onUpgradeProgress: (handler) =>
      bridge.onUpgradeProgress((progress: unknown) => handler(checkUpgradeProgress(progress))),
    onChanged: (handler) => bridge.onChanged(() => handler()),
  };
}
