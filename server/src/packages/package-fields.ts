import { PackageLayout } from './package-manifest.ts';
import { PackageName } from './package-name.ts';
import { Semver } from './semver.ts';

/**
 * The `package` block of a workspace's `fluidcad.json` (research §1, K3):
 *
 * ```json
 * { "package": { "name": "@acme/gears", "version": "1.2.0" } }
 * ```
 *
 * Having the block is what makes a workspace a package; there is no `type`
 * key. `name` and `version` are required, the rest optional. The name is
 * the package's one name (HD30), `@<handle>/<name>` with the author's own
 * hub handle as its scope; a name without the scope is refused with a
 * sentence saying how to write it. The `dependencies` keys are package
 * names too. `minEngine` left out defaults at pack time to the engine pin,
 * else to the packing engine.
 *
 * There is no list of exports: the `features/`, `parts/` and `assemblies/`
 * folders decide what a package exports (`PackageLayout`, HD20), and a
 * block that still has `exports` is refused with a sentence saying so.
 */
export type PackageInfo = {
  name: string;
  version: string;
  description?: string;
  license?: string;
  author?: string;
  homepage?: string;
  keywords?: string[];
  minEngine?: string;
};

/**
 * One `dependencies` entry: the exact version a project uses and the hash
 * of that version's installed tree (K5). No ranges and no lock file — CAD
 * geometry must never change under the user.
 */
export type PackagePin = {
  version: string;
  /** `sha256-<base64>`: the dirhash of the installed tree. */
  integrity: string;
};

/** `fluidcad.json` `dependencies`: package name → pin. */
export type PackageDependencies = Record<string, PackagePin>;

/**
 * Validation for the `package` block and the `dependencies` map, shared by
 * the reader and the writers in `project-config.ts`. A parse returns either
 * the value or a `problem`: a clause the caller prefixes with its subject
 * (`fluidcad.json has a "package" …`), the shape `parseProjectMaterials`
 * uses. One bad field rejects the whole block or map, so a typo never
 * resolves half a package.
 *
 * Deliberately dependency-free beyond its sibling modules (node builtins
 * and import-free classes), for the same reason as `project-config.ts`:
 * the plain-JS CLI imports it compiled.
 */
export class PackageFields {
  /** The keys of the `package` block this engine reads, in the order the writer puts them. */
  static readonly INFO_KEYS: readonly (keyof PackageInfo)[] = [
    'name', 'version', 'description', 'license', 'author', 'homepage', 'keywords', 'minEngine',
  ];

  /**
   * Keys a block may no longer have: refused on read, and dropped by the
   * writer rather than kept as a newer engine's field. `exports` went when
   * the folders started deciding what a package exports (HD20).
   */
  static readonly RETIRED_KEYS: readonly string[] = ['exports'];

  /** `sha256-` and the base64 of a 32-byte digest. */
  private static readonly INTEGRITY_PATTERN = /^sha256-[A-Za-z0-9+/]{43}=$/;

  private static readonly OPTIONAL_STRINGS = ['description', 'license', 'author', 'homepage'] as const;

  private static readonly SEMVER_RULE = 'MAJOR.MINOR.PATCH, with an optional -prerelease';

  /**
   * The clause for a package name written without its scope
   * (`feature-tests`): `"name" "feature-tests" needs your hub handle as its
   * scope: write "@<your-handle>/feature-tests"` (HD30). The block's reader
   * prefixes it with `whose`; `package init` signed out says it as is.
   */
  static unscopedProblem(name: string): string {
    return `"name" ${JSON.stringify(name)} needs your hub handle as its scope: write ${JSON.stringify(`@<your-handle>/${name}`)}`;
  }

  /**
   * Validate a `package` block. `workspacePath`, when given, lets the
   * `exports` refusal name the layout folders the workspace already has.
   */
  static parseInfo(raw: unknown, workspacePath?: string): { info: PackageInfo } | { problem: string } {
    const block = PackageFields.asRecord(raw);
    if (block === null) {
      return { problem: 'that is not an object { name, version, … }' };
    }

    if (block.name === undefined) {
      return { problem: `without a "name" (${PackageName.RULE})` };
    }
    if (PackageName.isBare(block.name)) {
      return { problem: `whose ${PackageFields.unscopedProblem(block.name)}` };
    }
    if (!PackageName.isValid(block.name)) {
      return { problem: `whose "name" ${JSON.stringify(block.name)} is not a package name (${PackageName.RULE})` };
    }

    if (block.version === undefined) {
      return { problem: `without a "version" (${PackageFields.SEMVER_RULE})` };
    }
    if (!Semver.isValid(block.version)) {
      return {
        problem: `whose "version" ${JSON.stringify(block.version)} is not a semver version (${PackageFields.SEMVER_RULE})`,
      };
    }

    if (block.exports !== undefined) {
      return { problem: PackageFields.exportsProblem(workspacePath) };
    }

    const info: PackageInfo = { name: block.name, version: block.version };
    for (const key of PackageFields.OPTIONAL_STRINGS) {
      const value = block[key];
      if (value === undefined) {
        continue;
      }
      if (typeof value !== 'string') {
        return { problem: `whose "${key}" is not a string` };
      }
      info[key] = value;
    }

    if (block.keywords !== undefined) {
      if (!Array.isArray(block.keywords) || !block.keywords.every((k) => typeof k === 'string')) {
        return { problem: 'whose "keywords" is not a list of strings' };
      }
      info.keywords = [...block.keywords];
    }

    if (block.minEngine !== undefined) {
      if (!Semver.isValid(block.minEngine)) {
        return {
          problem: `whose "minEngine" ${JSON.stringify(block.minEngine)} is not a semver version (${PackageFields.SEMVER_RULE})`,
        };
      }
      info.minEngine = block.minEngine;
    }

    return { info };
  }

  /** Validate a `dependencies` map. */
  static parseDependencies(raw: unknown): { dependencies: PackageDependencies } | { problem: string } {
    const map = PackageFields.asRecord(raw);
    if (map === null) {
      return { problem: 'that is not a map of package name → { version, integrity }' };
    }
    const dependencies: PackageDependencies = {};
    for (const [name, value] of Object.entries(map)) {
      const pin = PackageFields.parsePin(name, value);
      if ('problem' in pin) {
        return pin;
      }
      dependencies[name] = pin.pin;
    }
    return { dependencies };
  }

  /** Validate one `dependencies` entry under its key. */
  static parsePin(name: string, raw: unknown): { pin: PackagePin } | { problem: string } {
    if (!PackageName.isValid(name)) {
      return { problem: `with a key ${JSON.stringify(name)} that is not a package name (${PackageName.RULE})` };
    }
    const entry = PackageFields.asRecord(raw);
    if (entry === null) {
      return { problem: `with an entry ${JSON.stringify(name)} that is not an object { version, integrity }` };
    }
    if (entry.version === undefined) {
      return { problem: `with an entry ${JSON.stringify(name)} without a "version"` };
    }
    if (!Semver.isValid(entry.version)) {
      return {
        problem:
          `with an entry ${JSON.stringify(name)} whose "version" ${JSON.stringify(entry.version)} is not an exact ` +
          `version (${PackageFields.SEMVER_RULE}; pins are exact, never ranges)`,
      };
    }
    if (typeof entry.integrity !== 'string' || !PackageFields.INTEGRITY_PATTERN.test(entry.integrity)) {
      return {
        problem: `with an entry ${JSON.stringify(name)} whose "integrity" is not a sha256-<base64> tree hash`,
      };
    }
    return { pin: { version: entry.version, integrity: entry.integrity } };
  }

  /**
   * The block as the writer stores it: the known keys in `INFO_KEYS` order,
   * then whatever keys of `existing` this engine does not read (a newer
   * engine's fields survive an older one's write). A known key `info`
   * leaves out is removed, and so is a retired one.
   */
  static mergeInfo(info: PackageInfo, existing: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of PackageFields.INFO_KEYS) {
      if (info[key] !== undefined) {
        out[key] = info[key];
      }
    }
    const previous = PackageFields.asRecord(existing) ?? {};
    for (const [key, value] of Object.entries(previous)) {
      if (!(PackageFields.INFO_KEYS as readonly string[]).includes(key) && !PackageFields.RETIRED_KEYS.includes(key)) {
        out[key] = value;
      }
    }
    return out;
  }

  /**
   * The refusal of a block that still lists `exports`: the folders decide
   * what a package exports now. Names the folders the workspace has, so the
   * author knows whether the modules still need moving.
   */
  private static exportsProblem(workspacePath: string | undefined): string {
    const sentence =
      `with an "exports" list, but a package exports its ${PackageLayout.describeFolders()} folders: remove "exports"`;
    if (workspacePath === undefined) {
      return sentence;
    }
    const folders = PackageLayout.foldersIn(workspacePath);
    if (folders.length === 0) {
      return `${sentence} (this workspace has none of them yet: move the modules "exports" lists into them)`;
    }
    return `${sentence} (this workspace has ${PackageLayout.describeFolders(folders)})`;
  }

  private static asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }
}
