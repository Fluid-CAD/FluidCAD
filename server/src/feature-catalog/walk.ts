import { join } from 'path';
import { normalizePath } from '../normalize-path.ts';
import { WorkspaceFiles } from '../files/workspace-files.ts';

/**
 * The workspace's custom feature modules: `*.feature.js` files. The suffix
 * stays out of the kernel's script suffixes on purpose — a feature module's
 * own frames are skipped when a call records its source location, so the
 * feature is attributed to the model's call line.
 */
export class FeatureModules {
  static readonly SUFFIX = '.feature.js';

  static isModule(path: string): boolean {
    return path.endsWith(FeatureModules.SUFFIX);
  }

  /**
   * Every feature module under `workspacePath`, absolute and sorted, found
   * by the part catalog's walker: gitignore honored, `node_modules` and dot
   * directories pruned.
   */
  static async list(workspacePath: string): Promise<string[]> {
    if (!workspacePath) {
      return [];
    }
    const relFiles = await WorkspaceFiles.collect(workspacePath);
    return relFiles
      .filter(rel => FeatureModules.isModule(rel))
      .map(rel => normalizePath(join(workspacePath, rel)));
  }
}
