import fs from 'fs';
import { PackageArchive } from '../../src/packages/package-archive.ts';
import { PackageRoots, type PackageTarget } from '../../src/packages/package-roots.ts';
import { ProjectPackages, type InstallOutcome } from '../../src/packages/project-packages.ts';
import { ArchiveFixture } from './archive-fixture.ts';

export type LibrarySeedOptions = {
  /** `library` (the default) or `project`. */
  target?: PackageTarget;
  /** The open project: needed for the `project` target and for a pin. */
  project?: string | null;
  /** Pin into `project` as well (a project target always pins). */
  pin?: boolean;
  replace?: boolean;
  /** The engine version the archive is inspected as. */
  engineVersion?: string;
};

/**
 * Puts a package into a library or a project copy in-process, as the hub
 * download does after its checks (`PackageArchive.inspect`, then
 * `ProjectPackages.installInspected`). Packages install only from the hub
 * (HD31), so a test that needs a library seeds it here instead of running
 * `fluidcad install <file>`; a test about the hub installs from FakeHub.
 */
export class LibrarySeed {
  /** Seed an archive's bytes (a `.fluidpkg`, or a path to one). */
  static async install(archive: Uint8Array | string, options: LibrarySeedOptions = {}): Promise<InstallOutcome> {
    const target = options.target ?? 'library';
    const project = options.project ?? null;
    const bytes = typeof archive === 'string' ? fs.readFileSync(archive) : archive;
    const inspection = await PackageArchive.inspect(bytes, {
      root: PackageRoots.rootFor(target, project),
      engineVersion: options.engineVersion ?? ArchiveFixture.ENGINE,
    });
    return ProjectPackages.installInspected({
      token: inspection.token,
      target,
      project,
      pin: options.pin === true,
      replace: options.replace === true,
    });
  }

  /** Seed a hand-made archive (`ArchiveFixture.zip`'s options: `@acme/kit` 0.1.0 by default). */
  static async archive(options: Parameters<typeof ArchiveFixture.zip>[0] = {}, seed: LibrarySeedOptions = {}): Promise<InstallOutcome> {
    return LibrarySeed.install(await ArchiveFixture.zip(options), seed);
  }
}
