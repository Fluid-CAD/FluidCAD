import path from 'path';
import { EngineUpgrade } from '../engine/upgrade.ts';
import { projectInstalledEngine, readProjectPin } from '../engine/project-pin.ts';
import { isEngineManagedLink } from '../engine/resolver.ts';
import { listRecentProjects } from './app-state.ts';
import type { ProjectsRoot } from './projects-root.ts';
import { thumbnailStamp, type ThumbnailUrl } from '../previews/thumbnails.ts';
import type { EngineOptions, StartProject } from '../start/contract.ts';

/**
 * What the start screen lists: the recents, each with its preview and the
 * engine it runs on, and — for the engine dialog — what a project can move to.
 * Read live on every call, so a pin moved from the engine dialog, a preview
 * captured on close, or a project opened in another window shows up at once.
 */

export type ProjectOpenCheck = (workspacePath: string) => boolean;

/** What a launcher adds to a listing: which projects it has open, and how its start page loads a preview. */
export type ListingContext = { isOpen: ProjectOpenCheck; thumbnailUrl: ThumbnailUrl };

export function describeProject(workspacePath: string, lastOpenedAt: string, context: ListingContext): StartProject {
  // An install the user made wins, a link the engine planted does not count
  // as one, and the pin is read live so a moved pin shows without reopening.
  const own = isEngineManagedLink(workspacePath) ? null : projectInstalledEngine(workspacePath);
  const pin = readProjectPin(workspacePath).engine;
  const latest = EngineUpgrade.latestVersion();
  return {
    path: workspacePath,
    name: path.basename(workspacePath),
    engine: own ?? pin,
    engineSource: own ? 'own' : pin ? 'pin' : null,
    latest: !own && pin !== null && pin === latest,
    upgradeTo: EngineUpgrade.pendingFor(workspacePath)?.to ?? null,
    lastOpenedAt,
    open: context.isOpen(workspacePath),
    thumbnail: thumbnailOf(workspacePath, context.thumbnailUrl),
  };
}

function thumbnailOf(workspacePath: string, url: ThumbnailUrl): string | null {
  const stamp = thumbnailStamp(workspacePath);
  return stamp ? url(stamp) : null;
}

/**
 * Every stored recent that still exists, newest first. With a projects root,
 * every project in that folder instead: the ones opened before come first,
 * newest first, then the rest by name; a recent outside the root is not
 * listed, since the launcher would refuse to open it.
 */
export function listStartProjects(context: ListingContext, root: ProjectsRoot | null = null): { projects: StartProject[] } {
  const recents = listRecentProjects();
  if (!root) {
    return { projects: recents.map((entry) => describeProject(entry.path, entry.lastOpenedAt, context)) };
  }
  const openedAt = new Map(recents.map((entry) => [entry.path, entry.lastOpenedAt]));
  const projects = root
    .list()
    .map((project) => describeProject(project.path, openedAt.get(project.path) ?? '', context))
    .sort((a, b) => (a.lastOpenedAt === b.lastOpenedAt ? 0 : b.lastOpenedAt.localeCompare(a.lastOpenedAt)));
  return { projects };
}

/** What the "Change engine version…" dialog lists for one project. */
export function engineOptionsFor(workspacePath: string): EngineOptions {
  const project = describeProject(workspacePath, '', { isOpen: () => false, thumbnailUrl: () => '' });
  return {
    current: project.engine,
    currentSource: project.engineSource,
    latest: EngineUpgrade.latestVersion(),
    choices: EngineUpgrade.choices(),
  };
}
