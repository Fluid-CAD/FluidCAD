import type { EngineChoice } from '../engine/upgrade.ts';
import type { EngineSource } from '../engine/resolver.ts';

/**
 * The launcher's side of the start screen's contract.
 *
 * The page owns the authoritative copy (`ui/src/start/host.ts`); these are the
 * launcher's own copies, following the repo's convention for crossing that
 * boundary (`file-kind.ts`, `engine/project-pin.ts`), and
 * `tests/start-contract.test.ts` runs payloads built by the launcher's real
 * functions through the page's runtime guards, so the two cannot drift
 * silently.
 *
 * Two launchers speak it. The desktop app answers over its preload bridge,
 * `window.fluidcadShell.start`; `npx fluidcad` answers over HTTP, and adds the
 * payloads a browser needs that a native app does not (sessions, the folder
 * picker). The page and its launcher always come from one release — the
 * desktop app's built-in engine, or the CLI's own package — so the protocol
 * only has to match itself.
 */

/** 2: a `creating` step while a new project is scaffolded, and closing a project from its card. */
export const START_SCREEN_PROTOCOL = 2;

export type HelloReply = { ok: boolean; appVersion: string; platform: string; home: string };

export type OpeningProject = { path: string; name: string };

export type OpeningStatus =
  | { step: 'creating' }
  | { step: 'resolving' }
  | { step: 'downloading'; version: string; receivedBytes: number; totalBytes: number | null }
  | { step: 'starting'; version: string; source: EngineSource };

/** What the start page draws for its window. A window showing a project shows the project's page instead. */
export type PageWindowState =
  | { phase: 'home' }
  | { phase: 'opening'; project: OpeningProject; status: OpeningStatus }
  | { phase: 'failed'; project: OpeningProject; message: string };

export type Appearance = { theme: string };

export type StartProject = {
  path: string;
  name: string;
  engine: string | null;
  engineSource: 'pin' | 'own' | null;
  latest: boolean;
  upgradeTo: string | null;
  lastOpenedAt: string;
  open: boolean;
  thumbnail: string | null;
};

export type EngineOptions = {
  current: string | null;
  currentSource: 'pin' | 'own' | null;
  latest: string | null;
  choices: EngineChoice[];
};

export type UpgradeProgressMessage = { workspacePath: string; message: string };

/** What an action that can be refused answers: moving a pin, closing a project. */
export type ActionResult = { ok: boolean; error?: string };

// ---------------------------------------------------------------------------
// `npx fluidcad` only: a browser has no native dialogs and no windows to swap
// ---------------------------------------------------------------------------

/**
 * A project `npx fluidcad` is opening or running, as the tab it opens in sees
 * it. The tab shows the start page while the project opens, and goes to the
 * project's own page once it runs.
 */
export type SessionView =
  | { phase: 'opening'; project: OpeningProject; status: OpeningStatus }
  | { phase: 'failed'; project: OpeningProject; message: string }
  | { phase: 'running'; project: OpeningProject; url: string; version: string; source: EngineSource }
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
 * `missing` is a folder that does not exist yet (a new project creates it);
 * `invalid-name` is a name that cannot be a folder at all.
 */
export type FolderState = 'missing' | 'empty' | 'project' | 'not-empty' | 'not-a-folder' | 'unreadable' | 'invalid-name';

export type FolderCheck = { path: string; state: FolderState };

/** The answer to the page's first call. */
export function helloReply(protocol: unknown, app: { version: string; platform: string; home: string }): HelloReply {
  return { ok: protocol === START_SCREEN_PROTOCOL, appVersion: app.version, platform: app.platform, home: app.home };
}
