import { SDK_VERSION } from '../../../lib/dist/sdk/version.js';
import { PackageArchive, type PackageInspection } from '../packages/package-archive.ts';
import { PackageIdentity } from '../packages/package-identity.ts';
import { PackageInstaller } from '../packages/package-installer.ts';
import { PackageName } from '../packages/package-name.ts';
import { PackagePins, type PinnedPackage } from '../packages/package-pins.ts';
import { PackageRoots, type PackageLocation } from '../packages/package-roots.ts';
import { ProjectPackages } from '../packages/project-packages.ts';
import { Semver } from '../packages/semver.ts';
import { TreeHash } from '../packages/tree-hash.ts';
import { HubClient, type HubLimits, type HubPackageDetail, type HubVersionDetail } from './hub-client.ts';
import { HubConfig } from './hub-config.ts';
import { HubDownload } from './hub-download.ts';
import { HubInstallError } from './hub-install-error.ts';
import { HubRequestError } from './hub-request-error.ts';
import { HubTransport } from './hub-transport.ts';

/**
 * `fluidcad install` from the hub (hub-plan H8; research "Install from the
 * hub"): which version, then the download, verified, ready for the
 * existing consent and install path (`ProjectPackages.installInspected`).
 * Nothing here installs or pins: package code never runs, and nothing
 * lands in a root, before the caller has the user's consent.
 *
 * 0. {@link choose}: where `fluidcad install <name>[@version]` takes the
 *    package from (an installed copy, or the hub), the rule both the CLI
 *    and the app follow.
 * 1. {@link resolve}: an exact version as asked (a yanked one with a note;
 *    an unpublished one only for its owner or an admin, whose token the
 *    hub sees); else the latest; else, when the latest needs a newer
 *    engine, the hub's `newestCompatible`, with a note. A name alone never
 *    picks a yanked, removed or unpublished version: the hub's `latest`
 *    and `compatibility` never name one.
 * 2. {@link fetch}: the archive downloaded under the stall watchdog
 *    ({@link HubDownload}), `PackageArchive.inspect`, then the inspection's
 *    tree hash must equal the hub's `x-fluidcad-integrity` and the pin's
 *    when there is one (`integrity-mismatch` names all three), and the
 *    archive must hold the package and version asked for.
 * 3. {@link missing}: every missing pin of a project, each at its pinned
 *    version and integrity, failures collected rather than thrown.
 *
 * An archive holds its author's bare name (`feature-tests`, HD29), and
 * installs under the hub's public name (`@acme/feature-tests`): the caller
 * passes `resolved.name` as the install's `as`. An `@local` name was
 * installed from a file and is never asked of the hub (`local-package`).
 *
 * Every read carries the token when there is one (owner and admin
 * installs). A token the hub refuses (401) is dropped for the rest of the
 * run and the reads go again anonymously, with a note, since published
 * packages need none.
 */

export type HubInstallerOptions = {
  config: HubConfig;
  /** The token to send (`HubCredentials.read`); null installs anonymously. */
  token: string | null;
  /** This engine's FluidCAD version: what `?engine=` asks about, and what `inspect` warns against. */
  engineVersion: string;
  /** This engine's `SDK_VERSION`; defaults to the lib's own. */
  sdkVersion?: number;
  /** Defaults to a CLI transport. */
  transport?: HubTransport;
  /** The download's stall limit; defaults to {@link HubDownload.STALL_MS}. */
  stallMs?: number;
  /** The download's total limit; defaults to {@link HubDownload.TIMEOUT_MS}. */
  downloadTimeoutMs?: number;
};

/** `@acme/gears`, or `@acme/gears@1.2.0`. */
export type HubInstallSpec = { name: string; version: string | null };

/** The version an install will download, and what to tell the user about it. */
export type ResolvedHubPackage = {
  hub: string;
  name: string;
  version: string;
  /** The tree hash the hub lists for it: the download's header must say the same. */
  integrity: string;
  /** The archive's size in bytes, when the hub listed it. */
  size: number | null;
  /** `published`, or an open state the owner or an admin may install by exact version. */
  status: string;
  access: 'public' | 'owner' | 'admin';
  yanked: { at: string; reason: string | null } | null;
  /** Sentences for the consent summary: a yanked or unpublished version, an older compatible one, a refused token. */
  notes: string[];
};

export type HubFetchOptions = {
  /** The root the package will install into; the download and the inspection use its `.tmp`. */
  root: string;
  /** The project's pinned integrity for this version, when it pins one. */
  pin?: string | null;
  signal?: AbortSignal;
  onProgress?: (received: number, total: number | null) => void;
};

/**
 * Where an install by name comes from ({@link HubInstaller.choose}):
 * - `installed`: a copy already in a root the install resolves from, used
 *   as is. `resolved` is the hub's answer it matched (same version, same
 *   integrity), or null when the hub wasn't asked (an exact or pinned
 *   version) or couldn't be reached. `notes` are the sentences to show
 *   (the hub's resolution notes, or why the hub wasn't used).
 * - `hub`: download `resolved` ({@link HubInstaller.fetch}).
 */
export type HubInstallChoice =
  | { source: 'installed'; location: PackageLocation; resolved: ResolvedHubPackage | null; notes: string[] }
  | { source: 'hub'; resolved: ResolvedHubPackage };

/** A downloaded, verified package waiting for consent: `inspection.token` goes to `ProjectPackages.installInspected`. */
export type HubFetched = { resolved: ResolvedHubPackage; inspection: PackageInspection };

export type HubMissingOptions = {
  root: string;
  signal?: AbortSignal;
  /** Before each pin is resolved and downloaded. */
  onStart?: (pin: PinnedPackage) => void;
  onProgress?: (pin: PinnedPackage, received: number, total: number | null) => void;
};

export type HubMissingResult = {
  fetched: HubFetched[];
  failed: { name: string; version: string; error: Error }[];
};

export class HubInstaller {
  readonly config: HubConfig;
  private client: HubClient;
  private readonly engineVersion: string;
  private readonly sdkVersion: number;
  private readonly stallMs: number | undefined;
  private readonly downloadTimeoutMs: number | undefined;
  private limits: HubLimits | null = null;
  /** The note a refused token leaves on every package resolved after it. */
  private tokenNote: string | null = null;

  constructor(options: HubInstallerOptions) {
    this.config = options.config;
    const transport = options.transport ?? new HubTransport({ version: options.engineVersion, client: 'cli' });
    this.client = new HubClient(options.config, transport, options.token || null);
    this.engineVersion = options.engineVersion;
    this.sdkVersion = options.sdkVersion ?? SDK_VERSION;
    this.stallMs = options.stallMs;
    this.downloadTimeoutMs = options.downloadTimeoutMs;
  }

  /**
   * Where `spec` installs from, for the roots `project` resolves from (the
   * project copy and the library; the library alone outside a project):
   * - **An exact version** (asked, else the one `project` pins): the
   *   installed copy when there is one, without asking the hub; else the
   *   hub's.
   * - **A name alone** asks the hub first: its latest version this engine
   *   runs ({@link resolve}). A copy of that version installed with the
   *   hub's integrity is used without a download; anything else downloads.
   *   - The hub couldn't be reached (no connection, a timeout, a stall, a
   *     5xx): the newest installed version, with a note saying so; with
   *     none installed, the hub's error.
   *   - The hub doesn't know the package (404): refused, even with a copy
   *     installed, naming the exact-version install that takes that copy
   *     without the hub.
   *   - Any other refusal (nothing published, nothing compatible) as is.
   */
  async choose(spec: HubInstallSpec, options: { project?: string | null } = {}): Promise<HubInstallChoice> {
    const project = options.project ?? null;
    const exact = spec.version ?? (project ? PackagePins.of(project)[spec.name]?.version ?? null : null);
    if (exact) {
      const location = PackageRoots.locate(spec.name, exact, project);
      if (location) {
        return { source: 'installed', location, resolved: null, notes: [] };
      }
      return { source: 'hub', resolved: await this.resolve({ name: spec.name, version: exact }) };
    }
    if (PackageIdentity.isLocal(spec.name)) {
      // The hub never has an @local package: the newest installed copy, or the file install.
      const newest = ProjectPackages.newestInstalled(spec.name, project);
      if (!newest) {
        throw HubInstaller.localRefusal(spec.name, null);
      }
      return { source: 'installed', location: newest, resolved: null, notes: [] };
    }
    let resolved: ResolvedHubPackage;
    try {
      resolved = await this.resolve({ name: spec.name, version: null });
    } catch (err) {
      return this.chooseWithoutHub(spec.name, project, err);
    }
    const location = PackageRoots.locate(resolved.name, resolved.version, project);
    if (location && (await TreeHash.ofDirectory(location.directory)) === resolved.integrity) {
      return { source: 'installed', location, resolved, notes: resolved.notes };
    }
    return { source: 'hub', resolved };
  }

  /** Which version `spec` installs, with its listed integrity and the notes the consent summary shows. */
  async resolve(spec: HubInstallSpec): Promise<ResolvedHubPackage> {
    if (PackageIdentity.isLocal(spec.name)) {
      throw HubInstaller.localRefusal(spec.name, spec.version);
    }
    const resolved = spec.version === null ? await this.resolveLatest(spec.name) : await this.resolveExact(spec.name, spec.version);
    if (this.tokenNote) {
      resolved.notes.push(this.tokenNote);
    }
    return resolved;
  }

  /**
   * Downloads `resolved` and inspects it into `root`'s scratch. The
   * inspection's tree hash must equal the download's header and `pin`;
   * otherwise the inspection is discarded and `integrity-mismatch` names
   * all three.
   */
  async fetch(resolved: ResolvedHubPackage, options: HubFetchOptions): Promise<HubFetched> {
    const at = `${resolved.name}@${resolved.version}`;
    if (options.pin && options.pin !== resolved.integrity) {
      throw HubInstallError.local(
        'integrity-mismatch',
        `${resolved.hub} lists ${at} as ${resolved.integrity}, but this project pins it as ${options.pin}: these aren't the files the project was built with. Nothing was downloaded.`,
        { hub: resolved.integrity, pin: options.pin },
      );
    }
    const limits = await this.hubLimits();
    const download = new HubDownload({ client: this.client, root: options.root, stallMs: this.stallMs, timeoutMs: this.downloadTimeoutMs });
    const downloaded = await download.archive({
      name: resolved.name,
      version: resolved.version,
      expectIntegrity: resolved.integrity,
      maxBytes: limits.archiveBytes,
      signal: options.signal,
      onProgress: options.onProgress,
    });
    const inspection = await PackageArchive.inspect(downloaded.bytes, { root: options.root, engineVersion: this.engineVersion });
    try {
      // The archive holds the author's bare name (HD29); the hub's name adds the publisher.
      const { name, version } = inspection.manifest;
      if (name !== PackageName.bareOf(resolved.name) || version !== resolved.version) {
        throw HubInstallError.local('wrong-package', `${resolved.hub} answered ${at} with an archive of ${name}@${version}.`, { name, version });
      }
      const pinDiffers = Boolean(options.pin) && inspection.integrity !== options.pin;
      if (inspection.integrity !== downloaded.integrity || pinDiffers) {
        const pin = options.pin ? `, and this project pins ${options.pin}` : '';
        throw HubInstallError.local(
          'integrity-mismatch',
          `The downloaded ${at} hashes to ${inspection.integrity}, but ${resolved.hub} says ${downloaded.integrity}${pin}.`,
          { computed: inspection.integrity, hub: downloaded.integrity, pin: options.pin ?? null },
        );
      }
    } catch (err) {
      PackageArchive.discard(inspection.token);
      throw err;
    }
    return { resolved, inspection };
  }

  /**
   * Every pin in `pins` (a project's missing ones) resolved at its version
   * and fetched against its integrity, one after another. A failure is
   * collected with its pin and the rest go on.
   */
  async missing(pins: readonly PinnedPackage[], options: HubMissingOptions): Promise<HubMissingResult> {
    const result: HubMissingResult = { fetched: [], failed: [] };
    for (const pin of pins) {
      options.onStart?.(pin);
      try {
        const resolved = await this.resolve({ name: pin.name, version: pin.version });
        result.fetched.push(await this.fetch(resolved, {
          root: options.root,
          pin: pin.integrity,
          signal: options.signal,
          onProgress: (received, total) => options.onProgress?.(pin, received, total),
        }));
      } catch (err) {
        if (!(err instanceof Error)) {
          throw err;
        }
        result.failed.push({ name: pin.name, version: pin.version, error: err });
      }
    }
    return result;
  }

  /**
   * The refusal of an `@local` package: installed from a file, so the hub
   * never has it (`PackageIdentity.localSentence`). Nothing is asked.
   */
  static localRefusal(name: string, version: string | null): HubInstallError {
    return HubInstallError.local('local-package', PackageIdentity.localSentence(name, version), { name, version });
  }

  /**
   * The refusal of a bare name that is no file (`fluidcad install
   * feature-tests`): two publishers can each have a `feature-tests`, so the
   * hub needs the handle.
   */
  static noPublisherRefusal(bare: string): HubInstallError {
    return HubInstallError.local('no-publisher', `Name the publisher: \`fluidcad install @<handle>/${bare}\`.`, { name: bare });
  }

  /** Drops what {@link missing} fetched but won't install (the user declined). */
  static discard(fetched: readonly HubFetched[]): void {
    for (const entry of fetched) {
      PackageArchive.discard(entry.inspection.token);
    }
  }

  // Resolving

  /** A name alone the hub didn't resolve: the newest installed copy when the hub couldn't be reached, else the refusal. */
  private chooseWithoutHub(name: string, project: string | null, err: unknown): HubInstallChoice {
    if (!(err instanceof HubInstallError)) {
      throw err;
    }
    const newest = ProjectPackages.newestInstalled(name, project);
    if (!newest) {
      throw err;
    }
    if (err.hubUnreachable) {
      const where = PackageInstaller.describe(newest.target);
      const note = `Couldn't reach ${this.config.origin}, so this uses ${name} ${newest.version} from ${where}, the newest version there; the hub may have a newer one.`;
      return { source: 'installed', location: newest, resolved: null, notes: [note] };
    }
    if (err.code === 'not-found') {
      const where = PackageInstaller.describe(newest.target);
      throw HubInstallError.local(
        'not-found',
        `${err.message} ${where.charAt(0).toUpperCase()}${where.slice(1)} has a local copy, ${name} ${newest.version}: ` +
          `\`fluidcad install ${name}@${newest.version}\` installs it by its exact version, without the hub.`,
        { installed: newest.version, target: newest.target },
      );
    }
    throw err;
  }

  /** An exact version: as asked, whatever its state, if this reader may see it and it has an archive. */
  private async resolveExact(name: string, version: string): Promise<ResolvedHubPackage> {
    const at = `${name}@${version}`;
    let detail: HubVersionDetail | null;
    try {
      detail = await this.read(() => this.client.version(name, version));
    } catch (err) {
      if (err instanceof HubInstallError && err.code === 'version-removed') {
        throw HubInstallError.local('version-removed', `${at} was removed from ${this.config.origin} by its admins${HubInstaller.reasonOf(err.details)}, and can't be installed.`, err.details);
      }
      throw err;
    }
    if (!detail) {
      throw HubInstallError.local('not-found', `${at} isn't on ${this.config.origin}.${this.signInHint()}`);
    }
    if (!detail.integrity || !detail.archiveUrl) {
      const why = detail.status === 'rejected' ? 'was rejected, and its archive is gone' : 'is still being uploaded';
      throw HubInstallError.local('not-installable', `${at} ${why}: there is nothing to install.`, { status: detail.status });
    }
    const notes: string[] = [];
    if (detail.status !== 'published') {
      const state = HubInstaller.STATE_WORDS[detail.status] ?? detail.status;
      notes.push(`${at} isn't published: it is ${state}, and you can install it as its ${detail.access === 'admin' ? 'reviewer' : 'owner'}.`);
    }
    if (detail.yanked) {
      notes.push(`${at} was yanked${detail.yanked.reason ? ` (${detail.yanked.reason})` : ''}: it installs because you asked for this version, but an install by name never picks it.`);
    }
    return {
      hub: this.config.origin,
      name,
      version,
      integrity: detail.integrity,
      size: detail.size,
      status: detail.status,
      access: detail.access,
      yanked: detail.yanked,
      notes,
    };
  }

  /** A name alone: the latest version, else the newest this engine runs (`compatibility.newestCompatible`). */
  private async resolveLatest(name: string): Promise<ResolvedHubPackage> {
    const detail = await this.read(() => this.client.package(name, { engine: this.engineVersion, sdk: this.sdkVersion }));
    if (!detail) {
      throw HubInstallError.local('not-found', `${name} isn't on ${this.config.origin}.${this.signInHint()}`);
    }
    const latest = detail.latest;
    if (!latest || !detail.latestVersion) {
      const open = detail.openVersion ? ` Install ${detail.openVersion.version}, which isn't published yet, by its exact version: \`fluidcad install ${name}@${detail.openVersion.version}\`.` : '';
      throw HubInstallError.local('nothing-published', `${name} has no published version on ${this.config.origin} yet.${open}`);
    }
    const compatibility = detail.compatibility;
    if (!compatibility || compatibility.latestCompatible) {
      return this.resolvedFrom(detail, latest.version, latest.integrity, latest.size, []);
    }
    const needs = this.needsOf(latest.minEngine, latest.sdkVersion);
    if (!compatibility.newestCompatible) {
      throw HubInstallError.local(
        'incompatible',
        `No published version of ${name} runs on this FluidCAD (${this.engineVersion}, feature SDK ${this.sdkVersion}): the latest, ${latest.version}, needs ${needs}.`,
        { latest: latest.version, minEngine: latest.minEngine, sdkVersion: latest.sdkVersion },
      );
    }
    const chosen = detail.versions.find((v) => v.version === compatibility.newestCompatible && v.status === 'published');
    if (!chosen?.integrity) {
      throw HubInstallError.local('unexpected-response', `${this.config.origin} named ${name}@${compatibility.newestCompatible} for this FluidCAD but doesn't list it.`);
    }
    const note = `The latest ${name}, ${latest.version}, needs ${needs}; this FluidCAD is ${this.engineVersion}, so this installs ${chosen.version}, the newest version it runs.`;
    return this.resolvedFrom(detail, chosen.version, chosen.integrity, chosen.size, [note]);
  }

  private resolvedFrom(detail: HubPackageDetail, version: string, integrity: string, size: number | null, notes: string[]): ResolvedHubPackage {
    return {
      hub: this.config.origin,
      name: detail.name,
      version,
      integrity,
      size,
      status: 'published',
      access: detail.access,
      yanked: null,
      notes,
    };
  }

  /** `FluidCAD 0.0.50 or newer`, with the feature SDK when it isn't this engine's. */
  private needsOf(minEngine: string, sdkVersion: number): string {
    const parts: string[] = [];
    const min = Semver.parse(minEngine);
    const mine = Semver.parse(this.engineVersion);
    if (!min || !mine || min.compareTo(mine) > 0) {
      parts.push(`FluidCAD ${minEngine} or newer`);
    }
    if (sdkVersion !== this.sdkVersion) {
      parts.push(`feature SDK version ${sdkVersion} (this FluidCAD has ${this.sdkVersion})`);
    }
    return parts.length > 0 ? parts.join(' and ') : `FluidCAD ${minEngine} or newer`;
  }

  private signInHint(): string {
    return this.client.hasToken ? '' : " If it's yours or you review it and it isn't published yet, sign in with `fluidcad login` first.";
  }

  private static readonly STATE_WORDS: Record<string, string> = { draft: 'a draft', in_review: 'in review', uploading: 'being uploaded' };

  private static reasonOf(details: unknown): string {
    const reason = (details as { reason?: unknown } | undefined)?.reason;
    return typeof reason === 'string' && reason.trim() !== '' ? ` (${reason.trim()})` : '';
  }

  // Requests

  /** `GET /api/v1`'s limits, read once. */
  private async hubLimits(): Promise<HubLimits> {
    if (!this.limits) {
      this.limits = (await this.read(() => this.client.meta())).limits;
    }
    return this.limits;
  }

  /**
   * A hub read whose refusal becomes a {@link HubInstallError}. A token the
   * hub refuses is dropped and the read goes again anonymously.
   */
  private async read<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (err) {
      if (err instanceof HubRequestError && err.unauthorized && this.client.hasToken) {
        this.client = this.client.withToken(null);
        this.tokenNote = `${this.config.origin} refused your saved token (revoked or expired), so this ran signed out: run \`fluidcad login\` to sign in again.`;
        return this.read(request);
      }
      if (err instanceof HubRequestError) {
        throw HubInstallError.fromHub(err);
      }
      throw err;
    }
  }
}
