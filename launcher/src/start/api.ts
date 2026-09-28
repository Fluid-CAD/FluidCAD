import os from 'os';
import path from 'path';
import { EngineUpgrade, type ReopenTarget, type UpgradePreview } from '../engine/upgrade.ts';
import { dismissedNotificationIds, dismissNotification, forgetProject } from '../projects/app-state.ts';
import { engineOptionsFor, listStartProjects } from '../projects/listing.ts';
import type { ThumbnailUrl } from '../previews/thumbnails.ts';
import {
  helloReply,
  type ActionResult,
  type Appearance,
  type EngineOptions,
  type HelloReply,
  type StartProject,
  type UpgradeProgressMessage,
} from './contract.ts';
import { FeedService, type StartFeed } from './feed.ts';
import { readSavedTheme } from './theme.ts';

/**
 * The start screen's data and actions, the same for every launcher: the
 * desktop app answers its page with these over IPC (`shell/src/start/ipc.ts`),
 * `npx fluidcad` over HTTP (`server/routes.ts`). What differs between the two
 * — which projects are open, where previews are served from, how an open
 * project is reopened — comes in through {@link StartApiHost}.
 *
 * Every argument arrives from a page and is checked here before anything acts
 * on it: the page is trusted because of where it comes from, and this is what
 * keeps a malformed call from reaching the disk.
 */

/** A call whose arguments do not hold up. Refused before anything happens. */
export class StartCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartCallError';
  }
}

/** A version the page may pin: the release shape, nothing else reaches `fluidcad.json`. */
const VERSION_SHAPE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** `value`, when it is a non-empty string. */
export function textArgument(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new StartCallError(`Expected ${what} as a non-empty string.`);
  }
  return value;
}

/** `value`, when it is an absolute path, normalised. A relative one would resolve against wherever the launcher started. */
export function pathArgument(value: unknown, what: string): string {
  const text = textArgument(value, what);
  if (!path.isAbsolute(text)) {
    throw new StartCallError(`Expected ${what} as an absolute path.`);
  }
  return path.resolve(text);
}

/** `value`, when it is an engine version. */
export function versionArgument(value: unknown): string {
  const checked = textArgument(value, 'a version');
  if (!VERSION_SHAPE.test(checked)) {
    throw new StartCallError(`"${checked}" is not an engine version.`);
  }
  return checked;
}

export type StartApiHost = {
  /** The launcher's version: what the page is told, and what a notification's `minVersion` gates on. */
  appVersion: string;
  /** Whether this launcher has `workspacePath` open: in a window, or behind a tab. */
  isOpen(workspacePath: string): boolean;
  /** Where this launcher's start page loads previews from. */
  thumbnailUrl: ThumbnailUrl;
  /** Whatever shows `workspacePath` right now, for a pin change to reopen it. */
  openProjectFor(workspacePath: string): ReopenTarget | null;
  /** Something every start screen shows has changed: the recents, a pin, a preview. */
  changed(): void;
};

export class StartApi {
  constructor(private readonly host: StartApiHost) {}

  hello(protocol: unknown): HelloReply {
    return helloReply(protocol, { version: this.host.appVersion, platform: process.platform, home: os.homedir() });
  }

  appearance(): Appearance {
    return { theme: readSavedTheme() };
  }

  list(): { projects: StartProject[] } {
    return listStartProjects({ isOpen: (path) => this.host.isOpen(path), thumbnailUrl: this.host.thumbnailUrl });
  }

  /** Tutorials + notifications from the feed, minus what was dismissed. */
  async feed(): Promise<StartFeed> {
    const feed = await FeedService.load(this.host.appVersion);
    const dismissed = new Set(dismissedNotificationIds());
    return { ...feed, notifications: feed.notifications.filter((entry) => !dismissed.has(entry.id)) };
  }

  dismissNotification(id: unknown): void {
    dismissNotification(textArgument(id, 'a notification id'));
  }

  forget(workspacePath: unknown): void {
    forgetProject(pathArgument(workspacePath, 'a project path'));
    this.host.changed();
  }

  engineOptions(workspacePath: unknown): EngineOptions {
    return engineOptionsFor(pathArgument(workspacePath, 'a project path'));
  }

  /** Rebuild the project on both engines and report what moved. Commits nothing. */
  previewUpgrade(
    workspacePath: unknown,
    version: unknown,
    onProgress: (progress: UpgradeProgressMessage) => void,
  ): Promise<UpgradePreview> {
    const project = pathArgument(workspacePath, 'a project path');
    return EngineUpgrade.preview(project, versionArgument(version), (message) =>
      onProgress({ workspacePath: project, message }),
    );
  }

  /** Move the pin; an open project is reopened on it. */
  async applyPin(workspacePath: unknown, version: unknown): Promise<ActionResult> {
    const result = await EngineUpgrade.apply(pathArgument(workspacePath, 'a project path'), versionArgument(version), {
      openProjectFor: (project) => this.host.openProjectFor(project),
    });
    this.host.changed();
    return result;
  }
}
