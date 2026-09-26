/**
 * The start screen's contract with whatever hosts it.
 *
 * In the desktop app that is the shell, through `window.fluidcadShell.start`
 * — the only thing this page may talk to. The page renders; the shell owns
 * the data (recents, thumbnails, the feed, every project's engine pin) and
 * performs the actions (open a project, run a comparison, move a pin). The
 * page never reaches an engine: none is running while it shows.
 *
 * Only the engine that ships inside the app renders this page, and it is
 * staged from the same checkout as the shell, so the two always ship together
 * and this is not a cross-version contract. It is still checked twice: the
 * first call is {@link StartScreenHost.hello} with {@link START_SCREEN_PROTOCOL},
 * and every reply goes through the runtime guards in `contract-guards.ts`.
 *
 * The shell keeps its own copies of these types (it cannot import across the
 * package boundary, the same convention as `file-kind.ts` and
 * `project-pin.ts`), and `shell/tests/start-contract.test.ts` runs the
 * shell's real payloads through this side's guards so the two cannot drift.
 */

import {
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

/** Bumped on any change to the shapes below; the shell answers `hello` with `ok: false` on a mismatch. */
export const START_SCREEN_PROTOCOL = 1;

export type HelloReply = {
  ok: boolean;
  appVersion: string;
  platform: string;
  /** The user's home directory, for showing `~/…` paths; the page has no `os` of its own. */
  home: string;
};

export type OpeningProject = { path: string; name: string };

/** Where the engine a project opens with came from. */
export type OpeningSource = 'project' | 'cache' | 'builtin' | 'downloaded';

export type OpeningStatus =
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

export type ApplyPinResult = { ok: boolean; error?: string };

export type UpgradeProgress = { workspacePath: string; message: string };

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
  /** Open a recent project in this window, or focus the window that already has it. */
  open(path: string): Promise<void>;
  /** Pick a folder in a native dialog; the result opens in this window. */
  openDialog(): Promise<void>;
  /** Scaffold a project into an empty folder the user picks; it opens in this window. */
  newProject(): Promise<void>;
  forget(path: string): Promise<void>;
  /** An http(s) link, opened in the user's browser. */
  openLink(url: string): Promise<void>;
  /** What the engine dialog lists for one project. */
  engineOptions(path: string): Promise<EngineOptions>;
  /** Rebuild the project on both engines and report what moved. Commits nothing. */
  previewUpgrade(path: string, version: string): Promise<UpgradePreview>;
  /** Move the pin; an open project is reopened on it in its own window. */
  applyPin(path: string, version: string): Promise<ApplyPinResult>;
  onUpgradeProgress(handler: (progress: UpgradeProgress) => void): void;
  /** The recents changed under the page (a project closed, a preview landed). */
  onChanged(handler: () => void): void;
}

/** The bridge as the preload exposes it: the same calls, with replies nobody has checked yet. */
export type StartScreenBridge = {
  [K in keyof StartScreenHost]: (...args: any[]) => any;
};

declare global {
  interface Window {
    fluidcadShell?: { start?: StartScreenBridge };
  }
}

/**
 * The shell bridge with every reply validated on the way in. A reply the
 * guards reject throws a `ContractError`, which the page shows as one plain
 * sentence rather than rendering half a screen from a payload it misread.
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
    openDialog: () => bridge.openDialog(),
    newProject: () => bridge.newProject(),
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

/** The desktop shell's bridge, checked, or null outside the desktop app. */
export function desktopStartHost(): StartScreenHost | null {
  const bridge = typeof window !== 'undefined' ? window.fluidcadShell?.start : undefined;
  return bridge ? guardedHost(bridge) : null;
}
