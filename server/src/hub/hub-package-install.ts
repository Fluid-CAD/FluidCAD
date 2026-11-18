import { PackageArchive } from '../packages/package-archive.ts';
import type { PackageInstallStatus } from '../packages/package-installer.ts';
import type { PackageManifest } from '../packages/package-manifest.ts';
import { PackageManifests } from '../packages/package-manifests.ts';
import { PackagePins } from '../packages/package-pins.ts';
import { PackageRoots, type PackageTarget } from '../packages/package-roots.ts';
import { ProjectPackages } from '../packages/project-packages.ts';
import { TreeHash } from '../packages/tree-hash.ts';
import type { HubInstallChoice, HubInstaller } from './hub-installer.ts';

/**
 * A whole install from the hub in one call, for whoever can't hold an
 * inspection token between two requests: an agent, through
 * `POST /api/hub/install` (docs/agent-hub-plan.md). It is `fluidcad install
 * <name>[@version]` without the terminal:
 *
 * - {@link HubInstaller.choose} decides where the package comes from: an
 *   exact version (asked for, else the one the project pins) from an
 *   installed copy when there is one, else the hub; a name alone asks the
 *   hub for its latest first and uses an installed copy with the hub's
 *   contents (the newest installed one when the hub can't be reached).
 * - An installed copy is pinned into the open project, and copied into its
 *   `packages/` folder for the `project` target. Outside a project nothing
 *   is pinned.
 * - A download is verified against the hub's hash and the project's pin
 *   (`HubInstaller.fetch`), installed into `target` and pinned. An install
 *   that fails after the download discards its scratch.
 *
 * A pin never moves by itself: the project pinning another version refuses
 * (`version-change`) before anything is downloaded, unless `upgrade` is
 * true and the version is newer. With `upgrade` and no version, the hub's
 * latest is what the pin moves to (a name alone otherwise means the pinned
 * version).
 *
 * There is no `replace`: the same version installed with other contents is
 * refused (`conflict`), and the user decides (`fluidcad install --replace`).
 */

export type HubPackageInstallRequest = {
  /** `@scope/name`, already checked. */
  name: string;
  /** Null: the pinned version, else the latest this engine runs. */
  version: string | null;
  /** Where a download installs; with `project`, an installed library copy is copied in too. */
  target: PackageTarget;
  /** Let the project's pin move up to the version installed. */
  upgrade?: boolean;
  signal?: AbortSignal;
};

export type HubPackageInstallOutcome = {
  name: string;
  version: string;
  /** `hub`: downloaded now. `installed`: a copy already on this machine was used. */
  source: 'hub' | 'installed';
  /** What happened to the files: new, already there, or (never from here) replaced. */
  status: PackageInstallStatus;
  /** Where the project resolves the package from now. */
  target: PackageTarget;
  directory: string;
  integrity: string;
  /** The project's pin: written, already there, or null outside a project. */
  pin: 'pinned' | 'unchanged' | null;
  /** The version the pin moved up from; null when it didn't move. */
  upgradedFrom: string | null;
  /** The hub's word on the version (deprecated, an older one picked, the hub unreachable), then the archive's warnings. */
  notes: string[];
  /** The installed package's manifest; null only when an installed copy's can't be read. */
  manifest: PackageManifest | null;
};

export class HubPackageInstall {
  private readonly installer: HubInstaller;
  private readonly project: string | null;

  constructor(options: { installer: HubInstaller; project: string | null }) {
    this.installer = options.installer;
    this.project = options.project || null;
  }

  async run(request: HubPackageInstallRequest): Promise<HubPackageInstallOutcome> {
    const pinnedBefore = this.project && PackagePins.isProject(this.project)
      ? PackagePins.of(this.project)[request.name]?.version ?? null
      : null;
    const choice = request.upgrade === true && request.version === null && pinnedBefore
      ? await this.chooseLatest(request.name)
      : await this.installer.choose({ name: request.name, version: request.version }, { project: this.project });
    const outcome = choice.source === 'installed'
      ? await this.useInstalled(choice, request)
      : await this.download(choice, request);
    const moved = outcome.pin === 'pinned' && pinnedBefore !== null && pinnedBefore !== outcome.version;
    return { ...outcome, upgradedFrom: moved ? pinnedBefore : null };
  }

  /** `choose` for an upgrade by name: the hub's latest, whatever the project pins. */
  private async chooseLatest(name: string): Promise<HubInstallChoice> {
    const resolved = await this.installer.resolve({ name, version: null });
    const location = PackageRoots.locate(resolved.name, resolved.version, this.project);
    if (location && (await TreeHash.ofDirectory(location.directory)) === resolved.integrity) {
      return { source: 'installed', location, resolved, notes: resolved.notes, unreachable: false };
    }
    return { source: 'hub', resolved };
  }

  /** A copy already on this machine: pinned (and, for the `project` target, copied in) in a project; left as it is outside one. */
  private async useInstalled(
    choice: Extract<HubInstallChoice, { source: 'installed' }>,
    request: HubPackageInstallRequest,
  ): Promise<Omit<HubPackageInstallOutcome, 'upgradedFrom'>> {
    const { name, version } = choice.location;
    const notes = [...choice.notes];
    if (!this.project) {
      return {
        name,
        version,
        source: 'installed',
        status: 'unchanged',
        target: choice.location.target,
        directory: choice.location.directory,
        integrity: await TreeHash.ofDirectory(choice.location.directory),
        pin: null,
        notes,
        manifest: PackageManifests.of(choice.location.directory),
      };
    }
    const used = await ProjectPackages.useInstalled(`${name}@${version}`, this.project, {
      copy: request.target === 'project',
      upgrade: request.upgrade === true,
    });
    return {
      name,
      version,
      source: 'installed',
      status: used.copied?.status ?? 'unchanged',
      target: used.location.target,
      directory: used.location.directory,
      integrity: used.integrity,
      pin: used.pin,
      notes,
      manifest: PackageManifests.of(used.location.directory),
    };
  }

  /** A download: the pin checked first, then fetched and verified, installed and pinned. */
  private async download(
    choice: Extract<HubInstallChoice, { source: 'hub' }>,
    request: HubPackageInstallRequest,
  ): Promise<Omit<HubPackageInstallOutcome, 'upgradedFrom'>> {
    const { resolved } = choice;
    const { name, version } = resolved;
    const upgrade = request.upgrade === true;
    const project = this.project;
    let pinned: string | null = null;
    if (project) {
      // A pin that would change refuses before anything is downloaded.
      PackagePins.check(project, name, version, resolved.integrity, { upgrade });
      const pin = PackagePins.of(project)[name];
      pinned = pin && pin.version === version ? pin.integrity : null;
    }
    const { inspection } = await this.installer.fetch(resolved, {
      root: PackageRoots.rootFor(request.target, project),
      pin: pinned,
      signal: request.signal,
    });
    try {
      const installed = await ProjectPackages.installInspected({
        token: inspection.token,
        target: request.target,
        project,
        pin: project !== null,
        upgrade,
      });
      return {
        name,
        version,
        source: 'hub',
        status: installed.status,
        target: installed.target,
        directory: installed.directory,
        integrity: installed.integrity,
        pin: installed.pin,
        notes: [...resolved.notes, ...inspection.warnings.map((warning) => warning.message)],
        manifest: inspection.manifest,
      };
    } catch (err) {
      PackageArchive.discard(inspection.token);
      throw err;
    }
  }
}
