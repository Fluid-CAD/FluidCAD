import type { EngineChoice } from '../engine-upgrade';
import type { EngineSource } from '../engine/resolver';

/**
 * The shell's side of the start screen's contract, `window.fluidcadShell.start`.
 *
 * The page owns the authoritative copy (`ui/src/start/host.ts`). These are the
 * shell's own copies — it cannot import across the package boundary, the same
 * convention as `file-kind.ts` and `engine/project-pin.ts` — and
 * `tests/start-contract.test.ts` runs payloads built by the shell's real
 * functions through the page's runtime guards, so the two cannot drift
 * silently. Only the built-in engine renders the page, and it ships with this
 * shell, so the protocol only has to match itself.
 */

export const START_SCREEN_PROTOCOL = 1;

export type HelloReply = { ok: boolean; appVersion: string; platform: string; home: string };

export type OpeningProject = { path: string; name: string };

export type OpeningStatus =
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

/** The answer to the page's first call. */
export function helloReply(protocol: unknown, app: { version: string; platform: string; home: string }): HelloReply {
  return { ok: protocol === START_SCREEN_PROTOCOL, appVersion: app.version, platform: app.platform, home: app.home };
}
