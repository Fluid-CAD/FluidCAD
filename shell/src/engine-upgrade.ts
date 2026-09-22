import path from 'path';
import { builtinEngine, findEngine, listEngines } from './engine/cache';
import { describeEngineIncompatibility } from './engine/compat';
import { compareVersionsDescending, downloadEngine } from './engine/download';
import { serverEntryFor } from './engine/paths';
import { projectInstalledEngine, readProjectPin, writeProjectPin } from './engine/project-pin';
import { isEngineManagedLink, type ResolvedEngine } from './engine/resolver';
import { UpgradeDiffer, type UpgradeDiff } from './engine/upgrade-diff';
import type { ProjectWindow } from './project-window';
import { upgradePromptPreference } from './state';

/**
 * Moving a project from one engine to another.
 *
 * "Latest" is the engine that ships inside the app: the shell updates itself
 * silently, so whatever it carries *is* the newest release, and no registry
 * has to be asked. A project whose pin is older than that is offered the
 * upgrade — offered, never given: the pin only moves on an explicit gesture,
 * either from the start screen's engine dialog or from the prompt a project
 * window shows on open. Both can run the comparison first.
 */

export type EngineChoice = {
  version: string;
  /** Ships with the app — the "latest" the start screen talks about. */
  builtin: boolean;
  /** Already on disk; anything else is downloaded when the pin moves. */
  installed: boolean;
};

export type UpgradeCandidate = { from: string; to: string };

export type UpgradePreview = { diff?: UpgradeDiff; error?: string };

export type ApplyDeps = {
  /** The window currently showing the project, if any; it is reopened on the new pin. */
  openWindow: ProjectWindow | undefined;
  openProject: (target: string) => Promise<unknown>;
};

export class EngineUpgrade {
  static latestVersion(): string | null {
    return builtinEngine()?.version ?? null;
  }

  /** Every engine the shell can offer without a download, newest first. */
  static choices(): EngineChoice[] {
    return listEngines()
      .filter((engine) => describeEngineIncompatibility(engine.version) === null)
      .map((engine) => ({ version: engine.version, builtin: engine.builtin, installed: true }))
      .sort((a, b) => compareVersionsDescending(a.version, b.version));
  }

  /**
   * The newer built-in engine a pinned project could move to, or null. A
   * project running its own `node_modules` install is never a candidate: its
   * lockfile decides, not the pin.
   */
  static pendingFor(workspacePath: string): UpgradeCandidate | null {
    if (EngineUpgrade.ownInstall(workspacePath)) {
      return null;
    }
    const pin = readProjectPin(workspacePath).engine;
    const latest = EngineUpgrade.latestVersion();
    if (!pin || !latest || compareVersionsDescending(pin, latest) <= 0) {
      return null;
    }
    return { from: pin, to: latest };
  }

  /** `pendingFor`, minus what the user asked not to be told about. */
  static promptFor(workspacePath: string): UpgradeCandidate | null {
    const candidate = EngineUpgrade.pendingFor(workspacePath);
    if (!candidate) {
      return null;
    }
    const preference = upgradePromptPreference(workspacePath);
    if (preference.muted) {
      return null;
    }
    // "Keep" holds until something newer than the declined engine ships.
    if (preference.declinedUpgradeTo && compareVersionsDescending(preference.declinedUpgradeTo, candidate.to) <= 0) {
      return null;
    }
    return candidate;
  }

  /**
   * Download the target engine if needed, rebuild every model in the project
   * with both engines, and return the diff. **Nothing is committed here** — the
   * pin only moves in `apply`, once the user has seen what they were shown.
   */
  static async preview(
    workspacePath: string,
    version: string,
    onProgress: (message: string) => void,
  ): Promise<UpgradePreview> {
    try {
      const incompatible = describeEngineIncompatibility(version);
      if (incompatible) {
        return { error: incompatible };
      }
      const current = EngineUpgrade.currentEngineFor(workspacePath);
      if (!current) {
        return { error: 'This project has no engine to compare against yet — open it once first.' };
      }
      if (current.version === version) {
        return { error: `This project already runs engine ${version}.` };
      }

      const target = await EngineUpgrade.ensureInstalled(version, onProgress);
      const { models, skipped } = UpgradeDiffer.findModels(workspacePath);
      if (models.length === 0) {
        return { error: 'This project has no part or assembly files to compare.' };
      }

      onProgress(`Building with the current engine ${current.version}…`);
      const before = await UpgradeDiffer.snapshotWithEngine(current, workspacePath, models, onProgress);
      onProgress(`Building with engine ${version}…`);
      const after = await UpgradeDiffer.snapshotWithEngine(target, workspacePath, models, onProgress);

      onProgress('');
      return { diff: UpgradeDiffer.compare(workspacePath, before, after, skipped) };
    } catch (err: any) {
      onProgress('');
      return { error: err?.message ?? String(err) };
    }
  }

  /**
   * Commit the pin. Separate from the preview on purpose. An open project is
   * reopened, so the user never sees a window whose title says one version
   * and whose geometry came from another.
   */
  static async apply(workspacePath: string, version: string, deps: ApplyDeps): Promise<{ ok: boolean; error?: string }> {
    try {
      const incompatible = describeEngineIncompatibility(version);
      if (incompatible) {
        return { ok: false, error: incompatible };
      }
      writeProjectPin(workspacePath, version);
      if (deps.openWindow) {
        await deps.openWindow.close({ reopening: true });
        await deps.openProject(workspacePath);
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  }

  private static ownInstall(workspacePath: string): string | null {
    return isEngineManagedLink(workspacePath) ? null : projectInstalledEngine(workspacePath);
  }

  /** An installed engine as the resolver would hand it over, minus the pin bookkeeping. */
  private static asResolved(version: string, packageRoot: string, source: ResolvedEngine['source']): ResolvedEngine {
    return { version, packageRoot, serverEntry: serverEntryFor(packageRoot), source, pin: null, unpinned: false };
  }

  private static async ensureInstalled(version: string, onProgress: (message: string) => void): Promise<ResolvedEngine> {
    const installed = findEngine(version);
    if (installed) {
      return EngineUpgrade.asResolved(version, installed.packageRoot, installed.builtin ? 'builtin' : 'cache');
    }
    onProgress(`Downloading engine ${version}…`);
    const downloaded = await downloadEngine(version, {
      onProgress: (state) => {
        if (state.totalBytes) {
          const percent = Math.round((state.receivedBytes / state.totalBytes) * 100);
          onProgress(`Downloading engine ${version}… ${percent}%`);
        }
      },
    });
    return EngineUpgrade.asResolved(version, downloaded.packageRoot, 'downloaded');
  }

  /**
   * The engine a project currently runs on, without opening it: its own
   * install if it has one, otherwise its pin, otherwise the built-in.
   */
  private static currentEngineFor(workspacePath: string): ResolvedEngine | null {
    const own = EngineUpgrade.ownInstall(workspacePath);
    if (own) {
      return EngineUpgrade.asResolved(own, path.join(workspacePath, 'node_modules', 'fluidcad'), 'project');
    }
    const pin = readProjectPin(workspacePath).engine;
    const installed = pin ? findEngine(pin) : builtinEngine();
    if (!installed) {
      return null;
    }
    return EngineUpgrade.asResolved(installed.version, installed.packageRoot, installed.builtin ? 'builtin' : 'cache');
  }
}
