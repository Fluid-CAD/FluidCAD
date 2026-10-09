import { PackageName } from './package-name.ts';
import { Semver } from './semver.ts';

/**
 * The `package` block of a workspace's `fluidcad.json` (research §1, K3):
 *
 * ```json
 * { "package": { "name": "@acme/gears", "version": "1.2.0", "exports": ["gear.feature.js"] } }
 * ```
 *
 * Having the block is what makes a workspace a package; there is no `type`
 * key. `name`, `version` and `exports` are required, the rest optional.
 * `minEngine` left out defaults at pack time to the engine pin, else to the
 * packing engine.
 */
export type PackageInfo = {
  name: string;
  version: string;
  /** Workspace-relative `*.feature.js`, `*.part.js` or `*.assembly.js` modules whose exports are public. */
  exports: string[];
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
 * Deliberately dependency-free beyond its two sibling modules, for the same
 * reason as `project-config.ts`: the plain-JS CLI imports it compiled.
 */
export class PackageFields {
  /** The module kinds a package can make public. */
  static readonly EXPORT_SUFFIXES: readonly string[] = ['.feature.js', '.part.js', '.assembly.js'];

  /** The keys of the `package` block this engine reads, in the order the writer puts them. */
  static readonly INFO_KEYS: readonly (keyof PackageInfo)[] = [
    'name', 'version', 'description', 'exports', 'license', 'author', 'homepage', 'keywords', 'minEngine',
  ];

  /** `sha256-` and the base64 of a 32-byte digest. */
  private static readonly INTEGRITY_PATTERN = /^sha256-[A-Za-z0-9+/]{43}=$/;

  private static readonly OPTIONAL_STRINGS = ['description', 'license', 'author', 'homepage'] as const;

  private static readonly SEMVER_RULE = 'MAJOR.MINOR.PATCH, with an optional -prerelease';

  /** Validate a `package` block. */
  static parseInfo(raw: unknown): { info: PackageInfo } | { problem: string } {
    const block = PackageFields.asRecord(raw);
    if (block === null) {
      return { problem: 'that is not an object { name, version, exports, … }' };
    }

    if (block.name === undefined) {
      return { problem: `without a "name" (${PackageName.RULE})` };
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

    const exports = PackageFields.parseExports(block.exports);
    if ('problem' in exports) {
      return exports;
    }

    const info: PackageInfo = { name: block.name, version: block.version, exports: exports.exports };
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
   * leaves out is removed.
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
      if (!(PackageFields.INFO_KEYS as readonly string[]).includes(key)) {
        out[key] = value;
      }
    }
    return out;
  }

  /**
   * `exports`: a list of workspace-relative module paths, each a feature,
   * part or assembly module, none twice. Whether each file exists is the
   * packer's check, not the config's — a config is read before every render.
   */
  private static parseExports(raw: unknown): { exports: string[] } | { problem: string } {
    if (raw === undefined) {
      return {
        problem: `without "exports" (the ${PackageFields.EXPORT_SUFFIXES.map((s) => `*${s}`).join(', ')} modules the package makes public)`,
      };
    }
    if (!Array.isArray(raw)) {
      return { problem: 'whose "exports" is not a list of module paths' };
    }
    const seen = new Set<string>();
    for (const entry of raw) {
      if (typeof entry !== 'string' || entry.trim() === '') {
        return { problem: `whose "exports" has an entry ${JSON.stringify(entry)} that is not a module path` };
      }
      if (!PackageFields.isWorkspaceRelative(entry)) {
        return {
          problem:
            `whose "exports" entry ${JSON.stringify(entry)} is not a path inside the workspace ` +
            '(write it relative to the workspace root, with forward slashes)',
        };
      }
      if (!PackageFields.EXPORT_SUFFIXES.some((suffix) => entry.endsWith(suffix))) {
        return {
          problem:
            `whose "exports" entry ${JSON.stringify(entry)} is not a ` +
            `${PackageFields.EXPORT_SUFFIXES.map((s) => `*${s}`).join(', ')} module`,
        };
      }
      if (seen.has(entry)) {
        return { problem: `whose "exports" lists ${JSON.stringify(entry)} twice` };
      }
      seen.add(entry);
    }
    return { exports: [...raw] };
  }

  /** A relative POSIX path that stays inside the workspace: no root, drive, backslash, `.` or `..` segment. */
  private static isWorkspaceRelative(entry: string): boolean {
    if (entry.startsWith('/') || entry.includes('\\') || /^[A-Za-z]:/.test(entry)) {
      return false;
    }
    return entry.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
  }

  private static asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }
}
