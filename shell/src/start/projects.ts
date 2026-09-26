import path from 'path';
import { EngineUpgrade } from '../engine-upgrade';
import { projectInstalledEngine, readProjectPin } from '../engine/project-pin';
import { isEngineManagedLink } from '../engine/resolver';
import { listRecentProjects } from '../state';
import { thumbnailUrlFor } from '../thumbnails';
import type { EngineOptions, StartProject } from './contract';

/**
 * What the start screen lists: the recents, each with its preview and the
 * engine it runs on, and — for the engine dialog — what a project can move to.
 * Read live on every call, so a pin moved from the engine dialog, a preview
 * captured on close, or a project opened in another window shows up at once.
 */

export type ProjectOpenCheck = (workspacePath: string) => boolean;

export function describeProject(workspacePath: string, lastOpenedAt: string, isOpen: ProjectOpenCheck): StartProject {
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
    open: isOpen(workspacePath),
    thumbnail: thumbnailUrlFor(workspacePath),
  };
}

/** Every stored recent that still exists, newest first. */
export function listStartProjects(isOpen: ProjectOpenCheck): { projects: StartProject[] } {
  return {
    projects: listRecentProjects().map((entry) => describeProject(entry.path, entry.lastOpenedAt, isOpen)),
  };
}

/** What the "Change engine version…" dialog lists for one project. */
export function engineOptionsFor(workspacePath: string): EngineOptions {
  const project = describeProject(workspacePath, '', () => false);
  return {
    current: project.engine,
    currentSource: project.engineSource,
    latest: EngineUpgrade.latestVersion(),
    choices: EngineUpgrade.choices(),
  };
}
