import fs from 'fs';
import path from 'path';
import {
  PROJECT_CONFIG_FILENAME,
  isProjectConfigUnreadable,
  readProjectConfig,
  writePackageInfo,
  type PackageInfo,
  type ProjectConfig,
} from '../project-config.ts';
import { PackageFields } from './package-fields.ts';
import { PackageLayout } from './package-manifest.ts';
import { PackageName } from './package-name.ts';
import { Semver } from './semver.ts';

/** A refusal of `fluidcad package init` or `fluidcad version`, worded for the terminal. */
export class PackageAuthoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackageAuthoringError';
  }
}

/** What `fluidcad version` changed. */
export type PackageVersionChange = {
  name: string;
  from: string;
  to: string;
  configPath: string;
};

/**
 * The author's two commands on a workspace's `package` block (research §1):
 * `fluidcad package init` writes it and `fluidcad version` bumps it. The
 * block is the only place an author writes identity; packing never writes
 * it back.
 *
 * Kept in `server/` so the rules are typed and tested here, and the CLI in
 * `bin/` is a thin wrapper over the compiled class.
 */
export class PackageAuthoring {
  /** The version a new package starts at. */
  static readonly INITIAL_VERSION = '1.0.0';

  /** The refusal of a package command in a workspace without a `package` block. */
  static readonly NOT_A_PACKAGE = "This workspace isn't a package — run `fluidcad package init` first.";

  /**
   * The name `package init` writes (HD30): a package name (`@acme/kit`) as
   * it is; a name without its scope (`kit`) under the signed-in `handle`
   * (`@acme/kit`), or, signed out (`handle` null), refused with the
   * sentence saying to add the scope; anything else refused with the rule.
   * The CLI only finds the handle; the rule lives here.
   */
  static scopedName(name: string, handle: string | null): string {
    if (PackageName.isValid(name)) {
      return name;
    }
    if (PackageName.isBare(name)) {
      if (handle === null) {
        throw new PackageAuthoringError(`${PackageFields.unscopedProblem(name)}.`);
      }
      return PackageName.publicName(handle, name);
    }
    throw new PackageAuthoringError(`${JSON.stringify(name)} is not a package name: ${PackageName.RULE}.`);
  }

  /**
   * Why `name` can't name a new package, or null when it can: a name
   * without its scope (`kit`) gets the sentence saying to add the handle; a
   * name that follows neither grammar gets the rule. `init` and the package
   * scaffold (`PackageScaffold`) share it, so the rule lives once.
   */
  static nameProblem(name: string): string | null {
    if (PackageName.isBare(name)) {
      return `${PackageFields.unscopedProblem(name)}.`;
    }
    if (!PackageName.isValid(name)) {
      return `${JSON.stringify(name)} is not a package name: ${PackageName.RULE}.`;
    }
    return null;
  }

  /**
   * Write a new `package` block: the package's `name` (`@acme/feature-tests`,
   * the author's hub handle as its scope, HD30) and version `1.0.0`. What
   * the package exports is what its `features/`, `parts/` and `assemblies/`
   * folders hold (HD20), returned as `exports` so the command can say so.
   * Refuses a workspace that is already a package, so an existing identity
   * is never reset by accident.
   */
  static async init(
    workspacePath: string,
    name: string,
  ): Promise<{ info: PackageInfo; configPath: string; exports: string[] }> {
    const problem = PackageAuthoring.nameProblem(name);
    if (problem !== null) {
      throw new PackageAuthoringError(problem);
    }
    if (!PackageAuthoring.isWorkspace(workspacePath)) {
      throw new PackageAuthoringError(
        'This directory is not a FluidCAD workspace (no fluidcad.json or init.js). Run `fluidcad init` first.',
      );
    }
    const config = PackageAuthoring.readWritableConfig(workspacePath);
    if (config.package) {
      throw new PackageAuthoringError(
        `This workspace is already the package ${config.package.name} ${config.package.version}. ` +
          'Change its version with `fluidcad version`, or edit "package" in fluidcad.json.',
      );
    }
    if (config.problems?.package) {
      throw new PackageAuthoringError(
        `${config.problems.package} Fix it, or remove it and run \`fluidcad package init\` again.`,
      );
    }

    const info: PackageInfo = { name, version: PackageAuthoring.INITIAL_VERSION };
    const configPath = writePackageInfo(workspacePath, info);
    return { info, configPath, exports: PackageLayout.exportsOf(workspacePath) };
  }

  /**
   * Set `package.version` to the next `major`, `minor` or `patch` version,
   * or to an explicit version. Every other key of the block is kept.
   */
  static bumpVersion(workspacePath: string, spec: string): PackageVersionChange {
    const config = PackageAuthoring.readWritableConfig(workspacePath);
    if (config.problems?.package) {
      throw new PackageAuthoringError(`${config.problems.package} Fix it first.`);
    }
    if (!config.package) {
      throw new PackageAuthoringError(PackageAuthoring.NOT_A_PACKAGE);
    }

    const current = Semver.parse(config.package.version);
    const next = Semver.isBump(spec) ? current.bump(spec) : Semver.parse(spec);
    if (next === null) {
      throw new PackageAuthoringError(
        `${JSON.stringify(spec)} is not a version or a bump: use major, minor, patch, or a version such as 1.2.0.`,
      );
    }
    if (next.equals(current)) {
      throw new PackageAuthoringError(`${config.package.name} is already at ${current}.`);
    }

    const to = next.toString();
    const configPath = writePackageInfo(workspacePath, { ...config.package, version: to });
    return { name: config.package.name, from: config.package.version, to, configPath };
  }

  /**
   * The workspace's config, refused when its `fluidcad.json` can't be
   * parsed: every writer replaces an unparseable file with just its patch,
   * which here would drop the engine pin, the unit and the materials.
   */
  private static readWritableConfig(workspacePath: string): ProjectConfig {
    const config = readProjectConfig(workspacePath);
    if (isProjectConfigUnreadable(config)) {
      throw new PackageAuthoringError(`${config.error} Fix it before changing the package.`);
    }
    return config;
  }

  private static isWorkspace(workspacePath: string): boolean {
    return (
      fs.existsSync(path.join(workspacePath, PROJECT_CONFIG_FILENAME)) ||
      fs.existsSync(path.join(workspacePath, 'init.js'))
    );
  }
}
