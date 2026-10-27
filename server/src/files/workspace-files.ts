import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, relative } from 'path';
import ignoreFactory, { type Ignore } from 'ignore';
import { normalizePath } from '../normalize-path.ts';
import { PackageRoots } from '../packages/package-roots.ts';

// `ignore` ships a CJS `module.exports = factory`, but its bundled types use
// `export default`, which loses the call signature under `module: nodenext`.
// Pin the factory's real signature; the runtime value is the callable factory.
const ignore = ignoreFactory as unknown as (options?: object) => Ignore;

/**
 * The workspace's own files, as the feature and part catalog walks, the
 * cross-file script analyses and the old model packer (`fluidcad publish`)
 * see them.
 */
export class WorkspaceFiles {
  // Enforced on top of any `.gitignore`: dependency trees, prior pack outputs
  // (the latter would otherwise recurse into the next pack), and `fluidcad.json`
  // (the local hub binding — model id + name — which the hub already owns and
  // should never ship as model source). `node_modules` is also pruned during the
  // walk for speed. Hidden dot-entries are excluded by the walk directly (see
  // below), so VCS metadata (`.git`) and secrets (`.env`) need no pattern here.
  private static readonly ALWAYS_EXCLUDE = ['node_modules', '*.fluidpkg', 'fluidcad.json'];

  /**
   * Every non-ignored file in the workspace, workspace-relative and sorted.
   *
   * A root `.gitignore` is honored via the mature `ignore` package (same matcher
   * eslint/prettier use). Hidden dot-entries (names starting with `.`) are ALWAYS
   * excluded — `.git`, `.env`, and tool/editor state like `.claude`/`.vscode` are
   * never model content and may hold secrets — regardless of whether they're
   * gitignored. `node_modules` is pruned too; `ALWAYS_EXCLUDE` (prior `.fluidpkg`
   * outputs) is enforced on top of any `.gitignore`. We walk and filter per-file
   * rather than pruning ignored directories so negation rules (`!keep/this`) work.
   *
   * Installed package copies are pruned too (`PackageRoots.isManaged`: a
   * `packages/@scope/name/<version>/` holding `manifest.json`, by location
   * plus marker), so a copied `.feature.js` never shows up as one of the
   * workspace's own modules. The rest of a `packages/` folder is walked.
   */
  static async collect(workspaceAbs: string): Promise<string[]> {
    const gitignorePath = join(workspaceAbs, '.gitignore');
    const hasGitignore = existsSync(gitignorePath);
    const ig = ignore().add(WorkspaceFiles.ALWAYS_EXCLUDE);
    if (hasGitignore) {
      ig.add(await readFile(gitignorePath, 'utf8'));
    }

    const out: string[] = [];

    async function walk(dir: string) {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const name = entry.name;
        // Skip dependency trees and ALL hidden dot-entries (VCS metadata, secrets,
        // editor/tool state) — never packaged, gitignore or not.
        if (name === 'node_modules' || name.startsWith('.')) {
          continue;
        }

        const full = join(dir, name);
        const rel = normalizePath(relative(workspaceAbs, full));
        if (entry.isDirectory()) {
          if (PackageRoots.isManaged(full, workspaceAbs)) {
            continue;
          }
          await walk(full);
        } else if (entry.isFile()) {
          if (ig.ignores(rel)) {
            continue;
          }
          out.push(rel);
        }
      }
    }

    await walk(workspaceAbs);
    return out.sort();
  }
}
