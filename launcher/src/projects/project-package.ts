import fs from 'fs';
import path from 'path';

/** A package workspace's identity, as the start screen badges it. */
export type ProjectPackageIdentity = { name: string; version: string };

/**
 * Whether a project is a package workspace: its `fluidcad.json` holds a
 * `package` block (research §1 — having the block is what makes a workspace
 * a package; there is no `type` key). Read for the start screen's "Package"
 * badge, and its name grammar is what a New Package request is checked
 * against before the engine's `init --package` is asked to scaffold it.
 *
 * A reader of its own, beside the engine pin's (`engine/project-pin.ts`,
 * whose format is frozen to the one `engine` key and stays untouched): it
 * reads two strings and nothing else, and a missing, unreadable or malformed
 * block is simply no badge — the engine's own validator is what reports a
 * bad block, when the project opens.
 */
export class ProjectPackage {
  static readonly CONFIG_FILENAME = 'fluidcad.json';
  /**
   * `@handle/name`, the grammar the engine requires (K11, HD30; the engine's
   * `PackageName`): each part lowercase letters, digits and single dashes,
   * starting with a letter, the handle 2–39 characters and the name at most
   * 64. Anything else gets no badge, so the badge and the engine agree. The
   * start page keeps a copy (`ui/src/start/package-name.ts`), which
   * `tests/start-contract.test.ts` holds to this one.
   */
  static readonly NAME = /^@(?=[a-z0-9-]{2,39}\/)[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/(?=[a-z0-9-]{1,64}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

  /** Whether `name` is a scoped package name the engine would accept. */
  static isValidName(name: string): boolean {
    return ProjectPackage.NAME.test(name);
  }

  static read(workspacePath: string): ProjectPackageIdentity | null {
    let config: unknown;
    try {
      config = JSON.parse(fs.readFileSync(path.join(workspacePath, ProjectPackage.CONFIG_FILENAME), 'utf8'));
    } catch {
      return null;
    }
    const block = (config as { package?: unknown } | null)?.package;
    if (!block || typeof block !== 'object') {
      return null;
    }
    const { name, version } = block as { name?: unknown; version?: unknown };
    if (typeof name !== 'string' || !ProjectPackage.NAME.test(name) || typeof version !== 'string' || version === '') {
      return null;
    }
    return { name, version };
  }
}
