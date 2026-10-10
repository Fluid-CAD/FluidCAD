import fs from 'fs';
import { Readable } from 'stream';
import JSZip from 'jszip';
import { FluidcadHome } from '../fluidcad-home.ts';
import { readProjectConfig } from '../project-config.ts';
import { packPackage, PackageBuilder, type PackPackageInputs, type PackPackageResult } from '../packages/package-builder.ts';
import type { PackageInfo } from '../packages/package-fields.ts';
import { PackageLayout, type PackageContents, type PackageManifest } from '../packages/package-manifest.ts';
import { PackageName } from '../packages/package-name.ts';
import { PackageScratch } from '../packages/package-scratch.ts';
import { Semver } from '../packages/semver.ts';
import { TreeHash } from '../packages/tree-hash.ts';
import { HubClient, type HubLimits, type HubMe, type HubMeta, type HubPackageStatus, type HubUploadResult, type HubVersionStatus } from './hub-client.ts';
import { HubConfig } from './hub-config.ts';
import type { ResolvedHubCredential } from './hub-credentials.ts';
import { HubPublishError } from './hub-publish-error.ts';
import { HubRequestError } from './hub-request-error.ts';
import { HubTransport } from './hub-transport.ts';

/**
 * `fluidcad publish` (HD10, HD26–HD28): the workspace's package, packed and
 * uploaded in one request. The hub re-checks everything; this class refuses
 * what it can already tell is going to be refused, before the engine boots
 * or a byte is sent, and words each refusal with its next step.
 *
 * In order:
 * 1. a token for this hub (`HubCredentials.read`, the env token first);
 * 2. `GET /api/v1`: this FluidCAD is not older than the hub's
 *    `minCliVersion` (null: no minimum);
 * 3. `GET /me`: a handle, that handle is the package's scope, the token
 *    can publish, the account is a publisher with a verified email;
 * 4. `GET /packages/@s/n`: the version is greater than every published one,
 *    and no other version is open (HD11); a draft of the same version is
 *    replaced;
 * 5. `packPackage` into a scratch directory under `FluidcadHome` (removed
 *    afterwards, whatever happens), the integrity from `TreeHash.ofFiles`,
 *    at least one part or assembly (HD20, `no-models`), and the hub's
 *    limits;
 * 6. the caller confirms what will be uploaded (not for a dry run);
 * 7. `PUT` with progress, then the hub's integrity must equal ours.
 *
 * The first version of a package becomes a `draft` the owner finishes in
 * the browser wizard; later versions go straight to `in_review`.
 */

export type HubPublisherOptions = {
  config: HubConfig;
  /** The token to publish with (`HubCredentials.read`); null when signed out. */
  credential: ResolvedHubCredential | null;
  /** This FluidCAD's version: the manifest's `engine`, and what the hub's `minCliVersion` is checked against. */
  version: string;
  /** Defaults to a CLI transport. */
  transport?: HubTransport;
  /** Defaults to {@link packPackage}; the CLI quiets the engine around it. */
  pack?: (inputs: PackPackageInputs) => Promise<PackPackageResult>;
};

export type HubPublishProgress =
  | { step: 'checking' }
  | { step: 'packing' }
  | { step: 'uploading'; sent: number; total: number }
  /** The last byte is sent; the hub checks the archive before it answers. */
  | { step: 'verifying' };

/** What is about to be uploaded, for the caller to confirm. */
export type HubPublishSummary = {
  hub: string;
  handle: string;
  name: string;
  version: string;
  /** The archive in bytes. */
  size: number;
  /** Files in the archive, `manifest.json` included. */
  files: number;
  integrity: string;
  contents: PackageContents;
  /** Feature ids that call raw OpenCascade. */
  usesOcct: string[];
  /** `draft` for a package's first version (finished in the browser), else `in_review`. */
  becomes: 'draft' | 'in_review';
  /** A draft of this version is on the hub: the upload replaces its archive, and the wizard keeps its edits. */
  replacesDraft: boolean;
  notes: string | null;
  dryRun: boolean;
};

export type HubPublishResult = { summary: HubPublishSummary; upload: HubUploadResult };

export type HubPublishRequest = {
  workspacePath: string;
  /** Release notes (`--notes`); else the hub takes the CHANGELOG section for the version. */
  notes?: string | null;
  /** `?dryRun=1`: the hub checks everything and stores nothing. */
  dryRun?: boolean;
  onProgress?: (progress: HubPublishProgress) => void;
  /** Asked before the upload, never for a dry run; false stops with nothing sent. */
  confirm?: (summary: HubPublishSummary) => Promise<boolean> | boolean;
};

/** Where a package stands on the hub, for `--status`. */
export type HubPublishStatus = {
  name: string;
  /** Null when the hub has no such package for this account (nothing uploaded yet). */
  package: HubPackageStatus | null;
  /** The latest published version, when there is one. */
  latest: HubVersionStatus | null;
};

/** A packed archive in the scratch directory, and what the checks need of it. */
type Packed = {
  manifest: PackageManifest;
  path: string;
  size: number;
  integrity: string;
  files: Record<string, Buffer>;
  entries: number;
};

export class HubPublisher {
  readonly config: HubConfig;
  private readonly credential: ResolvedHubCredential | null;
  private readonly version: string;
  private readonly transport: HubTransport;
  private readonly pack: (inputs: PackPackageInputs) => Promise<PackPackageResult>;

  constructor(options: HubPublisherOptions) {
    this.config = options.config;
    this.credential = options.credential;
    this.version = options.version;
    this.transport = options.transport ?? new HubTransport({ version: options.version, client: 'cli' });
    this.pack = options.pack ?? packPackage;
  }

  /**
   * The workspace's validated `package` block: its name and version, read
   * without packing. Throws `PackageBuildError` for a plain project or a
   * broken block.
   */
  static packageIn(workspacePath: string): PackageInfo {
    return PackageBuilder.packageOf(readProjectConfig(workspacePath));
  }

  /** Packs and uploads the workspace's package. Null when the caller declined at the confirmation. */
  async publish(request: HubPublishRequest): Promise<HubPublishResult | null> {
    const progress = request.onProgress ?? (() => {});
    const notes = request.notes?.trim() ? request.notes.trim() : null;
    const info = HubPublisher.packageIn(request.workspacePath);
    const client = this.client();

    progress({ step: 'checking' });
    const meta = await this.ask(client.meta());
    this.checkCli(meta);
    const me = await this.ask(client.me());
    const handle = this.checkAccount(me, info.name);
    const status = await this.ask(client.package(info.name));
    const replacesDraft = this.checkVersion(status, info.name, info.version);

    progress({ step: 'packing' });
    const scratch = PackageScratch.create(FluidcadHome.dir());
    try {
      const packed = await this.packInto(scratch, request.workspacePath);
      this.checkModels(packed.manifest);
      this.checkLimits(packed, meta.limits, notes);
      const summary: HubPublishSummary = {
        hub: this.config.origin,
        handle,
        name: packed.manifest.name,
        version: packed.manifest.version,
        size: packed.size,
        files: packed.manifest.files.length + 1,
        integrity: packed.integrity,
        contents: PackageLayout.contentsOf(packed.manifest),
        usesOcct: packed.manifest.features.filter((f) => f.usesOcct).map((f) => f.id),
        becomes: status?.highestVersion ? 'in_review' : 'draft',
        replacesDraft,
        notes,
        dryRun: Boolean(request.dryRun),
      };
      if (!summary.dryRun && request.confirm && !(await request.confirm(summary))) {
        return null;
      }

      const upload = await this.upload(client, packed, summary, progress);
      if (upload.integrity !== packed.integrity) {
        throw HubPublishError.local(
          'integrity-mismatch',
          `${this.config.origin} computed ${upload.integrity} for the archive, but it was packed as ${packed.integrity}: the upload was damaged on its way.`,
          { hub: upload.integrity, local: packed.integrity },
        );
      }
      return { summary, upload };
    } finally {
      scratch.dispose();
    }
  }

  /** The open version, the latest rejection and the latest published version of `name`. */
  async status(name: string): Promise<HubPublishStatus> {
    const client = this.client();
    const status = await this.ask(client.package(name));
    const latest = status?.latestVersion ? await this.ask(client.version(name, status.latestVersion)) : null;
    return { name, package: status, latest };
  }

  /**
   * Withdraws `name`'s open version (a draft or a version in review; the
   * hub deletes it). `confirm` is asked first; null when it declines.
   */
  async withdraw(name: string, options: { confirm?: (open: HubVersionStatus) => Promise<boolean> | boolean } = {}): Promise<HubVersionStatus | null> {
    const client = this.client();
    const status = await this.ask(client.package(name));
    const open = status?.openVersion;
    if (!open || (open.status !== 'draft' && open.status !== 'in_review')) {
      const what = open ? `${name}@${open.version} is being uploaded right now; try again in a moment.` : `${name} has no draft or version in review on ${this.config.origin} to withdraw.`;
      throw HubPublishError.local('nothing-open', what);
    }
    if (options.confirm && !(await options.confirm(open))) {
      return null;
    }
    await this.ask(client.withdraw(name, open.version));
    return open;
  }

  // The checks

  /** Step 2: the hub's oldest accepted CLI. */
  private checkCli(meta: HubMeta): void {
    const minimum = meta.minCliVersion ? Semver.parse(meta.minCliVersion) : null;
    const mine = Semver.parse(this.version);
    if (!minimum || !mine || mine.compareTo(minimum) >= 0) {
      return;
    }
    throw HubPublishError.local(
      'cli-too-old',
      `This FluidCAD is ${this.version}, and ${this.config.origin} takes uploads from ${meta.minCliVersion} or newer: update FluidCAD, then publish again.`,
      { minCliVersion: meta.minCliVersion, version: this.version },
    );
  }

  /** Step 3: who is publishing, under which scope. Answers the handle. */
  private checkAccount(me: HubMe, name: string): string {
    const { account } = me;
    const scope = PackageName.scope(name);
    if (!account.handle) {
      throw HubPublishError.local('forbidden', `Your account on ${this.config.origin} has no handle yet: claim one on the hub, since it is the scope you publish under.`);
    }
    if (scope !== account.handle) {
      throw HubPublishError.local(
        'forbidden',
        `${name} is under @${scope}, but you are signed in to ${this.config.origin} as @${account.handle}, and you can only publish under your own scope.`,
        { scope: `@${account.handle}` },
      );
    }
    if (me.token && !me.token.scopes.includes('publish')) {
      const from = this.credential?.source === 'env' ? 'FLUIDCAD_HUB_TOKEN' : 'this machine';
      throw HubPublishError.local('forbidden', `The token from ${from} can't publish (it lacks the publish scope): run \`fluidcad login\`, or make a token with the publish scope.`);
    }
    if (!account.emailVerified) {
      throw HubPublishError.local('email-unverified', `Verify your email address on ${this.config.origin} before you publish.`);
    }
    if (!account.canPublish) {
      throw HubPublishError.local('publishing-closed', `Publishing on ${this.config.origin} is invite-only for now, and @${account.handle} is not a publisher yet.`);
    }
    return account.handle;
  }

  /** HD20: the hub shows a package through its models, so it needs one. */
  private checkModels(manifest: PackageManifest): void {
    if (PackageLayout.modelCount(manifest) > 0) {
      return;
    }
    throw HubPublishError.local(
      'no-models',
      `${manifest.name} has no parts or assemblies. The hub shows a package through the models in its parts/ and assemblies/ folders, ` +
        'so it needs at least one to publish: add a part to parts/ or an assembly to assemblies/. It still packs and installs without one.',
    );
  }

  /** The hub's limits (`GET /api/v1`), checked on what was packed. */
  private checkLimits(packed: Packed, limits: HubLimits, notes: string | null): void {
    if (packed.size > limits.archiveBytes) {
      throw HubPublishError.local('archive-too-large', `The archive is ${HubPublisher.megabytes(packed.size)}; ${this.config.origin} takes at most ${HubPublisher.megabytes(limits.archiveBytes)}.`);
    }
    if (packed.entries > limits.entries) {
      throw HubPublishError.local('too-many-entries', `The archive holds ${packed.entries} entries; ${this.config.origin} takes at most ${limits.entries}.`);
    }
    let unpacked = 0;
    for (const [path, bytes] of Object.entries(packed.files)) {
      unpacked += bytes.length;
      if (bytes.length > limits.entryBytes) {
        throw HubPublishError.local('unpacked-too-large', `${path} is ${HubPublisher.megabytes(bytes.length)}; ${this.config.origin} takes files of at most ${HubPublisher.megabytes(limits.entryBytes)}.`);
      }
    }
    if (unpacked > limits.unpackedBytes) {
      throw HubPublishError.local('unpacked-too-large', `The package is ${HubPublisher.megabytes(unpacked)} unpacked; ${this.config.origin} takes at most ${HubPublisher.megabytes(limits.unpackedBytes)}.`);
    }
    const manifestBytes = packed.files[PackageLayout.MANIFEST]?.length ?? 0;
    if (manifestBytes > limits.manifestBytes) {
      throw HubPublishError.local('bad-manifest', `manifest.json is ${HubPublisher.megabytes(manifestBytes)}; ${this.config.origin} takes at most ${HubPublisher.megabytes(limits.manifestBytes)}.`);
    }
    const models = PackageLayout.modelCount(packed.manifest);
    if (models > limits.modelsPerVersion) {
      throw HubPublishError.local('bad-manifest', `The package has ${models} parts and assemblies; ${this.config.origin} takes at most ${limits.modelsPerVersion} in a version.`);
    }
    for (const part of packed.manifest.parts) {
      if (part.params.length > limits.paramsPerModel) {
        throw HubPublishError.local(
          'bad-params',
          `${part.module}: '${part.exportName}' has ${part.params.length} parameters; ${this.config.origin} takes at most ${limits.paramsPerModel} for a part or assembly.`,
        );
      }
    }
    if (notes && notes.length > limits.releaseNotesChars) {
      throw HubPublishError.local('notes-too-long', `The release notes are ${notes.length} characters; ${this.config.origin} takes at most ${limits.releaseNotesChars}.`);
    }
  }

  /**
   * Step 4, HD11: greater than every published version, and no other open
   * version. Answers true when the upload replaces a draft of this version.
   */
  private checkVersion(status: HubPackageStatus | null, name: string, version: string): boolean {
    if (!status) {
      return false;
    }
    if (status.status !== 'active') {
      throw HubPublishError.local('package-unavailable', `${name} is ${status.status} by the hub's admins and takes no uploads.`);
    }
    const mine = Semver.parse(version);
    const highest = status.highestVersion ? Semver.parse(status.highestVersion) : null;
    if (mine && highest) {
      const order = mine.compareTo(highest);
      if (order === 0) {
        throw HubPublishError.local('version-exists', `${name}@${version} is already published, and a published version never changes.`, { highest: status.highestVersion });
      }
      if (order < 0) {
        throw HubPublishError.local(
          'version-not-greater',
          `${version} is not greater than ${status.highestVersion}, the highest version of ${name} published so far.`,
          { highest: status.highestVersion },
        );
      }
    }
    const open = status.openVersion;
    if (!open) {
      return false;
    }
    const at = `${name}@${open.version}`;
    if (open.version === version && open.status === 'draft') {
      return true;
    }
    if (open.version === version && open.status === 'in_review') {
      throw HubPublishError.local('in-review', `${at} is in review: withdraw it first to upload it again.`, { version: open.version, status: open.status });
    }
    if (open.version === version) {
      // The hub's code for it, without the bump hint: waiting is the fix.
      throw new HubPublishError('version-exists', `${at} is being uploaded right now: try again in a moment.`);
    }
    const state = HubPublisher.STATE_WORDS[open.status] ?? open.status;
    throw HubPublishError.local(
      'open-version-exists',
      `${at} is ${state}: submit, withdraw or finish it before you upload another version.`,
      { version: open.version, status: open.status },
    );
  }

  private static readonly STATE_WORDS: Record<string, string> = { uploading: 'being uploaded', draft: 'a draft', in_review: 'in review' };

  // Packing and uploading

  /** Step 5: the archive in `scratch`, its integrity and its zip entry count. */
  private async packInto(scratch: PackageScratch, workspacePath: string): Promise<Packed> {
    const result = await this.pack({ workspacePath, fluidcadVersion: this.version });
    const path = scratch.file(PackageLayout.archiveName(result.manifest.name, result.manifest.version));
    fs.writeFileSync(path, result.zip);
    const zip = await JSZip.loadAsync(result.zip);
    return {
      manifest: result.manifest,
      path,
      size: result.zip.length,
      integrity: TreeHash.ofFiles(result.files),
      files: result.files,
      entries: Object.keys(zip.files).length,
    };
  }

  /** Step 7: the archive streamed from the scratch file. */
  private async upload(client: HubClient, packed: Packed, summary: HubPublishSummary, progress: (p: HubPublishProgress) => void): Promise<HubUploadResult> {
    const body = Readable.toWeb(fs.createReadStream(packed.path)) as ReadableStream<Uint8Array>;
    progress({ step: 'uploading', sent: 0, total: packed.size });
    return this.ask(
      client.uploadVersion(summary.name, summary.version, body, {
        size: packed.size,
        integrity: packed.integrity,
        notes: summary.notes,
        dryRun: summary.dryRun,
        onProgress: (sent) => {
          progress({ step: 'uploading', sent, total: packed.size });
          if (sent >= packed.size) {
            progress({ step: 'verifying' });
          }
        },
      }),
    );
  }

  private client(): HubClient {
    if (!this.credential) {
      throw HubPublishError.local('signed-out', `Not signed in to ${this.config.origin}. Run \`fluidcad login\` first.`);
    }
    return new HubClient(this.config, this.transport, this.credential.token);
  }

  /** A hub request whose refusal becomes a {@link HubPublishError} with its hint. */
  private async ask<T>(request: Promise<T>): Promise<T> {
    try {
      return await request;
    } catch (err) {
      if (err instanceof HubRequestError) {
        throw HubPublishError.fromHub(err, this.config.origin);
      }
      throw err;
    }
  }

  /** `24.1 kB`, `3.2 MB`. */
  static megabytes(bytes: number): string {
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} kB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
