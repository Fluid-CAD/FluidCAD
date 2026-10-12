import fs from 'fs';
import path from 'path';
import { readProjectConfig } from '../project-config.ts';
import { PackageBuilder } from '../packages/package-builder.ts';
import { PackageName } from '../packages/package-name.ts';
import { Semver } from '../packages/semver.ts';
import {
  HubClient,
  type HubMe,
  type HubMedia,
  type HubMediaList,
  type HubPackageDetail,
  type HubPackageListing,
  type HubVersionStatus,
  type HubYankResult,
} from './hub-client.ts';
import { HubConfig } from './hub-config.ts';
import type { ResolvedHubCredential } from './hub-credentials.ts';
import { HubMaintainError } from './hub-maintain-error.ts';
import { HubRequestError } from './hub-request-error.ts';
import { HubTransport } from './hub-transport.ts';

/**
 * What a package's owner changes on the hub after the first publish (H12,
 * HD28): yank and unyank a version, deprecate the package, and the listing
 * the first-publish wizard set (screenshots, license, links, the open
 * version's release notes). `fluidcad yank`, `unyank`, `deprecate` and
 * `listing` are the terminal around it; the hub's Manage page does the same
 * in the browser.
 *
 * Every command names its package as `fluidcad publish` does: the public
 * name `@scope/name` when given, else the workspace's `package.name` as
 * written (H8d). Before any write the account is checked: signed in to this
 * hub, a handle that is the package's scope (a package under another handle
 * is refused here, before any request to it), and a token that may change
 * packages (the `publish` scope). The hub checks it all again, and refuses
 * with its own codes, which {@link HubMaintainError} words with their next
 * step.
 */

export type HubMaintainerOptions = {
  config: HubConfig;
  /** The token (`HubCredentials.read`); null when signed out. */
  credential: ResolvedHubCredential | null;
  /** This FluidCAD's version, for the user agent. */
  version: string;
  /** Defaults to a CLI transport. */
  transport?: HubTransport;
};

/** A package and one of its versions, as `fluidcad yank` names them. */
export type HubVersionRef = { name: string; version: string };

/** The listing as the owner reads it, with the open version the license and notes apply to. */
export type HubOwnerListing = {
  name: string;
  listing: HubPackageListing;
  /** The draft or the version in review, when there is one. */
  open: HubVersionStatus | null;
  latestVersion: string | null;
};

/** What a license change touched: the package's, and the open version's when there is one. */
export type HubListingChange = { listing: HubPackageListing; openVersion: HubVersionStatus | null };

/** The image types the hub takes, by their magic bytes (the hub's `ImageHeader` reads them the same way). */
type ImageType = 'image/png' | 'image/jpeg' | 'image/webp';

export class HubMaintainer {
  readonly config: HubConfig;
  private readonly credential: ResolvedHubCredential | null;
  private readonly transport: HubTransport;

  constructor(options: HubMaintainerOptions) {
    this.config = options.config;
    this.credential = options.credential;
    this.transport = options.transport ?? new HubTransport({ version: options.version, client: 'cli' });
  }

  // Naming the package

  /**
   * The package a command acts on: `spec` when given (a public name), else
   * the workspace's `package.name`. A name that isn't one, or a workspace
   * that isn't a package, is refused with the way to name it.
   */
  static packageName(spec: string | null | undefined, workspacePath: string): string {
    if (spec) {
      if (!PackageName.isValid(spec)) {
        throw HubMaintainError.local('bad-name', `${JSON.stringify(spec)} is not a package name: ${PackageName.RULE}.`);
      }
      return spec;
    }
    try {
      return PackageBuilder.packageOf(readProjectConfig(workspacePath)).name;
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw HubMaintainError.local('bad-name', `Name the package (@scope/name), or run this in its workspace. ${why}`);
    }
  }

  /**
   * The version `fluidcad yank` and `unyank` act on: `@scope/name@version`,
   * or a version alone for the workspace's package.
   */
  static versionRef(spec: string, workspacePath: string): HubVersionRef {
    const at = spec.lastIndexOf('@');
    if (at > 0) {
      const name = spec.slice(0, at);
      const version = spec.slice(at + 1);
      if (!PackageName.isValid(name)) {
        throw HubMaintainError.local('bad-name', `${JSON.stringify(name)} is not a package name: ${PackageName.RULE}.`);
      }
      return { name, version: HubMaintainer.checkedVersion(version) };
    }
    if (PackageName.isValid(spec)) {
      throw HubMaintainError.local('bad-version', `Say which version of ${spec}: ${spec}@<version>, such as ${spec}@0.1.0.`);
    }
    return { name: HubMaintainer.packageName(null, workspacePath), version: HubMaintainer.checkedVersion(spec) };
  }

  private static checkedVersion(text: string): string {
    if (!Semver.isValid(text)) {
      throw HubMaintainError.local('bad-version', `${JSON.stringify(text)} is not a version: use MAJOR.MINOR.PATCH, such as 0.1.0.`);
    }
    return text;
  }

  // The lifecycle

  /** Yanks `ref.version` with `reason`: out of latest, search and installs by name; an exact install keeps working. */
  async yank(ref: HubVersionRef, reason: string): Promise<HubYankResult> {
    const text = reason.trim();
    if (text === '') {
      throw HubMaintainError.local('bad-request', 'Say why with --reason: installers see it as "Yanked: <reason>" beside the version.');
    }
    const client = await this.ownerClient(ref.name);
    return this.ask(client.yank(ref.name, ref.version, text));
  }

  async unyank(ref: HubVersionRef): Promise<HubYankResult> {
    const client = await this.ownerClient(ref.name);
    return this.ask(client.unyank(ref.name, ref.version));
  }

  /** Deprecates `name` with `message`, or clears its deprecation (null). */
  async deprecate(name: string, message: string | null): Promise<HubPackageListing> {
    const text = message === null ? null : message.trim();
    if (text === '') {
      throw HubMaintainError.local('bad-request', 'Write a message (what to use instead, or why), or pass --clear to clear the deprecation.');
    }
    const client = await this.ownerClient(name);
    return this.ask(client.editPackage(name, { deprecatedMessage: text }));
  }

  // The listing

  /** The package as its owner sees it: the listing and the open version. */
  async listing(name: string): Promise<HubOwnerListing> {
    const client = await this.ownerClient(name);
    const detail = await this.ownDetail(client, name);
    return { name, listing: detail.listing, open: HubMaintainer.openOf(detail), latestVersion: detail.latestVersion };
  }

  /**
   * Sets the package's license and links (null clears a link). A license
   * also goes on the open version, when there is one: it is what that
   * version is approved under, as the wizard's and the Manage page's
   * Details set it.
   */
  async setListing(name: string, change: { license?: string; homepageUrl?: string | null; repositoryUrl?: string | null }): Promise<HubListingChange> {
    if (change.license === undefined && change.homepageUrl === undefined && change.repositoryUrl === undefined) {
      throw HubMaintainError.local('bad-request', 'Pass --license, --homepage or --repository (an empty link clears it).');
    }
    const client = await this.ownerClient(name);
    let openVersion: HubVersionStatus | null = null;
    if (change.license !== undefined) {
      const open = HubMaintainer.openOf(await this.ownDetail(client, name));
      if (open) {
        openVersion = await this.ask(client.editVersion(name, open.version, { license: change.license }));
      }
    }
    const listing = await this.ask(client.editPackage(name, change));
    return { listing, openVersion };
  }

  /** The open version's release notes; refused when nothing is open (a published version's notes are fixed). */
  async notes(name: string, text: string): Promise<HubVersionStatus> {
    const client = await this.ownerClient(name);
    const open = HubMaintainer.openOf(await this.ownDetail(client, name));
    if (!open) {
      throw HubMaintainError.local(
        'nothing-open',
        `${name} has no draft or version in review on ${this.config.origin}: a version's release notes are fixed once it is approved. ` +
          'The next version takes them from `fluidcad publish --notes "…"`.',
      );
    }
    return this.ask(client.editVersion(name, open.version, { notes: text }));
  }

  // Screenshots

  async screenshots(name: string): Promise<HubMediaList> {
    const client = await this.ownerClient(name);
    return this.ask(client.mediaList(name));
  }

  /**
   * Adds each file as a screenshot, in order, after checking each one is a
   * PNG, JPEG or WebP image by its own bytes (the hub checks again, with
   * its size limits). Stops at the first refusal; the ones before it stay.
   */
  async addScreenshots(name: string, files: readonly string[], options: { caption?: string } = {}): Promise<HubMedia[]> {
    if (files.length === 0) {
      throw HubMaintainError.local('bad-request', 'Name the image files to add.');
    }
    const images = files.map((file) => HubMaintainer.image(file));
    const client = await this.ownerClient(name);
    const added: HubMedia[] = [];
    for (const image of images) {
      added.push(await this.ask(client.addMedia(name, { bytes: image.bytes, contentType: image.type, fileName: image.fileName, caption: options.caption })));
    }
    return added;
  }

  /** Deletes the screenshot `ref` names (an id, an id's first characters, or its place in the list). */
  async removeScreenshot(name: string, ref: string): Promise<HubMedia> {
    const client = await this.ownerClient(name);
    const media = HubMaintainer.mediaOf(name, (await this.ask(client.mediaList(name))).media, ref);
    await this.ask(client.deleteMedia(name, media.id));
    return media;
  }

  /** Makes the screenshot `ref` names the card image. */
  async cardScreenshot(name: string, ref: string): Promise<HubMedia> {
    const client = await this.ownerClient(name);
    const media = HubMaintainer.mediaOf(name, (await this.ask(client.mediaList(name))).media, ref);
    return this.ask(client.editMedia(name, media.id, { isCard: true }));
  }

  /**
   * Puts the screenshots `refs` names first, in that order; the others keep
   * their order after them. One move per screenshot, each to its place.
   */
  async orderScreenshots(name: string, refs: readonly string[]): Promise<HubMediaList> {
    if (refs.length === 0) {
      throw HubMaintainError.local('bad-request', 'Name the screenshots in the order you want them (ids, or their places in the list).');
    }
    const client = await this.ownerClient(name);
    const media = (await this.ask(client.mediaList(name))).media;
    const chosen = refs.map((ref) => HubMaintainer.mediaOf(name, media, ref));
    const ids = new Set<string>();
    for (const item of chosen) {
      if (ids.has(item.id)) {
        throw HubMaintainError.local('bad-request', `Each screenshot goes in the order once: ${item.id} is named twice.`);
      }
      ids.add(item.id);
    }
    for (const [position, item] of chosen.entries()) {
      await this.ask(client.editMedia(name, item.id, { position }));
    }
    return this.ask(client.mediaList(name));
  }

  /**
   * The screenshot `ref` names among `media`: its id, a unique start of its
   * id (four characters at least), or its 1-based place in the list
   * (`listing screenshots list` numbers them).
   */
  static mediaOf(name: string, media: readonly HubMedia[], ref: string): HubMedia {
    const text = ref.trim().toLowerCase();
    if (/^\d{1,2}$/.test(text)) {
      const found = media[Number(text) - 1];
      if (!found) {
        throw HubMaintainError.local('not-found', `${name} has ${media.length} screenshot${media.length === 1 ? '' : 's'}: there is no number ${text}.`);
      }
      return found;
    }
    const matches = text.length >= 4 ? media.filter((item) => item.id.toLowerCase().startsWith(text)) : [];
    if (matches.length === 1) {
      return matches[0];
    }
    if (matches.length > 1) {
      throw HubMaintainError.local('bad-request', `${ref} starts ${matches.length} screenshots' ids: give more of it.`);
    }
    throw HubMaintainError.local('not-found', `${name} has no screenshot ${ref}. \`fluidcad listing screenshots list\` lists them with their ids.`);
  }

  /** A file to upload as a screenshot: its bytes and its type from its own first bytes. */
  static image(file: string): { bytes: Uint8Array; type: ImageType; fileName: string } {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(file);
    } catch (err) {
      throw HubMaintainError.local('bad-request', `Can't read ${file}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}.`);
    }
    const type = HubMaintainer.imageType(bytes);
    if (type === null) {
      throw HubMaintainError.local('image-type-mismatch', `${path.basename(file)} isn't a PNG, JPEG or WebP image: export it as one of those, then add it.`);
    }
    return { bytes, type, fileName: path.basename(file) };
  }

  /** PNG, JPEG or WebP by the magic bytes, or null. */
  static imageType(bytes: Uint8Array): ImageType | null {
    const at = (offset: number, magic: number[]) => magic.every((byte, i) => bytes[offset + i] === byte);
    if (bytes.length >= 8 && at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
      return 'image/png';
    }
    if (bytes.length >= 3 && at(0, [0xff, 0xd8, 0xff])) {
      return 'image/jpeg';
    }
    if (bytes.length >= 12 && at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) {
      return 'image/webp';
    }
    return null;
  }

  // The account

  /**
   * A client for `name`'s owner: signed in to this hub, a handle that is
   * the package's scope, a token with the `publish` scope. Each refusal is
   * decided here, before anything is sent about the package.
   */
  private async ownerClient(name: string): Promise<HubClient> {
    if (!this.credential) {
      throw HubMaintainError.local('signed-out', `Not signed in to ${this.config.origin}. Run \`fluidcad login\` first.`);
    }
    const client = new HubClient(this.config, this.transport, this.credential.token);
    const me: HubMe = await this.ask(client.me());
    const handle = me.account.handle;
    if (!handle) {
      throw HubMaintainError.local('forbidden', `Your account on ${this.config.origin} has no handle yet: claim one on the hub.`);
    }
    const scope = PackageName.scope(name);
    if (scope !== handle) {
      throw HubMaintainError.local(
        'forbidden',
        `${name} is under @${scope}, but you are signed in to ${this.config.origin} as @${handle}, and only its owner can change it: sign in as @${scope}.`,
        { scope: `@${handle}`, name },
      );
    }
    if (me.token && !me.token.scopes.includes('publish')) {
      const from = this.credential.source === 'env' ? 'FLUIDCAD_HUB_TOKEN' : 'this machine';
      throw HubMaintainError.local('forbidden', `The token from ${from} can't change packages (it lacks the publish scope): run \`fluidcad login\`, or make a token with the publish scope.`);
    }
    return client;
  }

  /** The package as its owner reads it; the hub's 404 is `not-found` (nothing uploaded under that name). */
  private async ownDetail(client: HubClient, name: string): Promise<HubPackageDetail> {
    const detail = await this.ask(client.package(name));
    if (!detail) {
      throw HubMaintainError.local('not-found', `${name} isn't on ${this.config.origin}. \`fluidcad publish\` uploads its first version.`);
    }
    return detail;
  }

  private static openOf(detail: HubPackageDetail): HubVersionStatus | null {
    const open = detail.openVersion;
    return open && (open.status === 'draft' || open.status === 'in_review') ? open : null;
  }

  /** A hub request whose refusal becomes a {@link HubMaintainError} with its next step. */
  private async ask<T>(request: Promise<T>): Promise<T> {
    try {
      return await request;
    } catch (err) {
      if (err instanceof HubRequestError) {
        throw HubMaintainError.fromHub(err, this.config.origin);
      }
      throw err;
    }
  }
}
