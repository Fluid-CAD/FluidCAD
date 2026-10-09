import fs from 'fs';
import path from 'path';
import { normalizePath } from '../normalize-path.ts';
import { FeatureModules } from '../feature-catalog/walk.ts';
import {
  PROJECT_CONFIG_FILENAME,
  isProjectConfigUnreadable,
  readProjectConfig,
  writePackageInfo,
  type PackageInfo,
  type ProjectConfig,
} from '../project-config.ts';
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
  static readonly INITIAL_VERSION = '0.1.0';

  /**
   * Write a new `package` block: `name`, version `0.1.0`, and `exports`
   * prefilled with every feature module in the workspace. Refuses a
   * workspace that is already a package, so an existing identity is never
   * reset by accident.
   */
  static async init(workspacePath: string, name: string): Promise<{ info: PackageInfo; configPath: string }> {
    if (!PackageName.isValid(name)) {
      throw new PackageAuthoringError(`${JSON.stringify(name)} is not a package name: ${PackageName.RULE}.`);
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

    const info: PackageInfo = {
      name,
      version: PackageAuthoring.INITIAL_VERSION,
      exports: await PackageAuthoring.featureExports(workspacePath),
    };
    const configPath = writePackageInfo(workspacePath, info);
    return { info, configPath };
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
      throw new PackageAuthoringError("This workspace isn't a package — run `fluidcad package init` first.");
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

  /**
   * Every `*.feature.js` in the workspace, workspace-relative, except those
   * inside an installed project copy of another package
   * (`packages/@scope/name/<version>/` holding `manifest.json`): those are
   * that package's modules, not this one's.
   */
  private static async featureExports(workspacePath: string): Promise<string[]> {
    const root = normalizePath(workspacePath);
    const modules = await FeatureModules.list(workspacePath);
    return modules
      .map((abs) => normalizePath(path.relative(root, abs)))
      .filter((rel) => !PackageAuthoring.isInsideInstalledCopy(workspacePath, rel));
  }

  private static isInsideInstalledCopy(workspacePath: string, rel: string): boolean {
    const match = /^packages\/(@[^/]+\/[^/]+\/[^/]+)\//.exec(rel);
    if (!match) {
      return false;
    }
    return fs.existsSync(path.join(workspacePath, 'packages', match[1], 'manifest.json'));
  }
}
