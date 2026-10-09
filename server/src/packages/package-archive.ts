import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { SDK_VERSION } from '../../../lib/dist/sdk/version.js';
import { BlockedImports } from '../host/blocked-imports.ts';
import { PackageName } from './package-name.ts';
import { PackageLayout, type PackageManifest } from './package-manifest.ts';
import { PackageScratch } from './package-scratch.ts';
import { Semver } from './semver.ts';
import { TreeHash } from './tree-hash.ts';

export type PackageArchiveErrorCode =
  | 'not-a-zip'
  | 'unsafe-path'
  | 'too-large'
  | 'no-manifest'
  | 'model-archive'
  | 'newer-manifest'
  | 'bad-manifest'
  | 'files-mismatch'
  | 'blocked-import';

/** A refusal to inspect an archive, worded for whoever is installing it. */
export class PackageArchiveError extends Error {
  constructor(readonly code: PackageArchiveErrorCode, message: string) {
    super(message);
    this.name = 'PackageArchiveError';
  }
}

export type PackageWarningCode = 'uses-occt' | 'min-engine' | 'sdk-version';

/** Something the consent summary says before an install (research §3, "The install flow"). */
export type PackageWarning = { code: PackageWarningCode; message: string };

/** What an inspected archive is: everything the consent summary shows. */
export type PackageInspection = {
  /** Hands the extracted tree to `PackageInstaller.install`; valid in this process only. */
  token: string;
  manifest: PackageManifest;
  /** The tree hash of the extracted files (K5), what a project pin records. */
  integrity: string;
  warnings: PackageWarning[];
  /** The bytes the installed tree takes. */
  bytes: number;
};

/** An inspected archive waiting for its install: the extracted tree in its scratch directory. */
export type PendingPackage = {
  inspection: PackageInspection;
  scratch: PackageScratch;
  /** `<scratch>/tree`, which the install renames into place. */
  tree: string;
  /** The root whose `.tmp` holds the scratch directory. */
  root: string;
};

export type PackageInspectOptions = {
  /** The root to extract under (`<root>/.tmp/<pid>-<uuid>`): the one the package will most likely install into. */
  root: string;
  /** The running engine's version, compared with the manifest's `minEngine`. */
  engineVersion: string;
};

/**
 * The first step of every install (research §3): open a `.fluidpkg`, check
 * it, and extract it into scratch, so the consent summary describes exactly
 * the files the install then renames into place.
 *
 * Refused: anything that isn't a zip; an entry path that is absolute,
 * climbs out with `..`, or is a link; an archive without `manifest.json`;
 * the old model packer's archive (its manifest has `schemaVersion`, not
 * `manifestVersion`), which `fluidcad publish` still writes; a manifest a
 * newer FluidCAD wrote, or one whose identity or file list doesn't hold up;
 * and any `.js` file importing a blocked Node built-in.
 */
export class PackageArchive {
  /** The most an archive may unpack to; a package is source files and small images. */
  static readonly MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
  static readonly MAX_ENTRIES = 10_000;
  /** How long an inspected archive waits for its install before its scratch is dropped. */
  static readonly PENDING_TTL_MS = 30 * 60 * 1000;

  private static readonly MODEL_ARCHIVE =
    'This is a model archive, not a package: it was made by `fluidcad publish`, and only `fluidcad pack` makes packages.';

  private static readonly pending = new Map<string, { entry: PendingPackage; timer: NodeJS.Timeout }>();

  static async inspect(zipBytes: Uint8Array, options: PackageInspectOptions): Promise<PackageInspection> {
    const zip = await PackageArchive.open(zipBytes);
    const scratch = PackageScratch.create(options.root);
    try {
      const tree = scratch.file('tree');
      const { files, bytes } = await PackageArchive.extract(zip, tree);
      const manifest = PackageArchive.readManifest(tree, files);
      PackageArchive.scanImports(tree, files);
      const integrity = await TreeHash.ofDirectory(tree);
      const inspection: PackageInspection = {
        token: crypto.randomUUID(),
        manifest,
        integrity,
        warnings: PackageArchive.warnings(manifest, options.engineVersion),
        bytes,
      };
      PackageArchive.hold({ inspection, scratch, tree, root: options.root });
      return inspection;
    } catch (err) {
      scratch.dispose();
      throw err;
    }
  }

  /** The inspection behind `token`, left pending: what an install checks before it takes the tree. */
  static peek(token: string): PackageInspection | null {
    return PackageArchive.pending.get(token)?.entry.inspection ?? null;
  }

  /** The inspected archive behind `token`, handed over once: null when it is unknown, taken or expired. */
  static take(token: string): PendingPackage | null {
    const held = PackageArchive.pending.get(token);
    if (!held) {
      return null;
    }
    clearTimeout(held.timer);
    PackageArchive.pending.delete(token);
    return held.entry;
  }

  /** Drop an inspected archive the user declined. */
  static discard(token: string): void {
    PackageArchive.take(token)?.scratch.dispose();
  }

  private static hold(entry: PendingPackage): void {
    const timer = setTimeout(() => PackageArchive.discard(entry.inspection.token), PackageArchive.PENDING_TTL_MS);
    timer.unref?.();
    PackageArchive.pending.set(entry.inspection.token, { entry, timer });
  }

  private static async open(zipBytes: Uint8Array): Promise<JSZip> {
    try {
      return await JSZip.loadAsync(zipBytes);
    } catch {
      throw new PackageArchiveError('not-a-zip', `This file isn't a package archive (${PackageLayout.EXTENSION}): it can't be read as a zip.`);
    }
  }

  /** Write every file entry under `tree`, refusing the paths that could land anywhere else. */
  private static async extract(zip: JSZip, tree: string): Promise<{ files: string[]; bytes: number }> {
    const entries = Object.values(zip.files);
    if (entries.length > PackageArchive.MAX_ENTRIES) {
      throw new PackageArchiveError('too-large', `The archive holds ${entries.length} entries; a package may hold at most ${PackageArchive.MAX_ENTRIES}.`);
    }
    fs.mkdirSync(tree, { recursive: true });
    const files: string[] = [];
    let bytes = 0;
    for (const entry of entries) {
      const original = entry.unsafeOriginalName ?? entry.name;
      PackageArchive.checkPath(original);
      if (entry.dir) {
        continue;
      }
      if (PackageArchive.isLink(entry.unixPermissions)) {
        throw new PackageArchiveError('unsafe-path', `The archive entry ${JSON.stringify(original)} is a link; a package holds files only.`);
      }
      const rel = original.replace(/^\.\//, '');
      const target = path.join(tree, ...rel.split('/'));
      const inside = path.relative(tree, target);
      if (inside.startsWith('..') || path.isAbsolute(inside)) {
        throw new PackageArchiveError('unsafe-path', `The archive entry ${JSON.stringify(original)} points outside the package.`);
      }
      const data = await entry.async('uint8array');
      bytes += data.byteLength;
      if (bytes > PackageArchive.MAX_UNPACKED_BYTES) {
        throw new PackageArchiveError('too-large', `The archive unpacks to more than ${PackageArchive.MAX_UNPACKED_BYTES / (1024 * 1024)} MB.`);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
      files.push(rel);
    }
    return { files: files.sort(), bytes };
  }

  /** A relative POSIX path that stays inside the package. */
  private static checkPath(original: string): void {
    const segments = original.split('/');
    const unsafe =
      original.length === 0 ||
      original.includes('\\') ||
      original.includes('\u0000') ||
      original.startsWith('/') ||
      /^[A-Za-z]:/.test(original) ||
      segments.includes('..');
    if (unsafe) {
      throw new PackageArchiveError('unsafe-path', `The archive entry ${JSON.stringify(original)} is not a path inside the package, so nothing was installed.`);
    }
  }

  private static isLink(unixPermissions: number | string | null | undefined): boolean {
    if (unixPermissions === null || unixPermissions === undefined) {
      return false;
    }
    const mode = typeof unixPermissions === 'string' ? parseInt(unixPermissions, 8) : unixPermissions;
    return (mode & 0o170000) === 0o120000;
  }

  private static readManifest(tree: string, files: string[]): PackageManifest {
    if (!files.includes(PackageLayout.MANIFEST)) {
      throw new PackageArchiveError('no-manifest', `This archive has no ${PackageLayout.MANIFEST}, so it isn't a FluidCAD package.`);
    }
    let raw: any;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(tree, PackageLayout.MANIFEST), 'utf8'));
    } catch {
      throw new PackageArchiveError('bad-manifest', `The package's ${PackageLayout.MANIFEST} isn't valid JSON.`);
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new PackageArchiveError('bad-manifest', `The package's ${PackageLayout.MANIFEST} isn't an object.`);
    }
    if (raw.manifestVersion === undefined) {
      throw new PackageArchiveError('model-archive', PackageArchive.MODEL_ARCHIVE);
    }
    if (raw.manifestVersion !== PackageLayout.MANIFEST_VERSION) {
      if (typeof raw.manifestVersion === 'number' && raw.manifestVersion > PackageLayout.MANIFEST_VERSION) {
        throw new PackageArchiveError('newer-manifest',
          `This package was made by a newer FluidCAD (manifest version ${raw.manifestVersion}); update FluidCAD to install it.`);
      }
      throw new PackageArchiveError('bad-manifest', `The package's manifestVersion ${JSON.stringify(raw.manifestVersion)} isn't one FluidCAD knows.`);
    }
    if (!PackageName.isValid(raw.name)) {
      throw new PackageArchiveError('bad-manifest', `The package's name ${JSON.stringify(raw.name)} is not a package name: ${PackageName.RULE}.`);
    }
    for (const key of ['version', 'minEngine'] as const) {
      if (!Semver.isValid(raw[key])) {
        throw new PackageArchiveError('bad-manifest', `${raw.name}'s ${key} ${JSON.stringify(raw[key])} is not a version.`);
      }
    }
    if (typeof raw.sdkVersion !== 'number' || !Number.isInteger(raw.sdkVersion)) {
      throw new PackageArchiveError('bad-manifest', `${raw.name}'s sdkVersion ${JSON.stringify(raw.sdkVersion)} is not a whole number.`);
    }
    for (const key of ['features', 'parts', 'files'] as const) {
      if (!Array.isArray(raw[key])) {
        throw new PackageArchiveError('bad-manifest', `${raw.name}'s ${PackageLayout.MANIFEST} has no "${key}" list.`);
      }
    }
    PackageArchive.checkFiles(raw as PackageManifest, files);
    return raw as PackageManifest;
  }

  /** The archive holds exactly the files its manifest lists, plus the manifest, and the entry among them. */
  private static checkFiles(manifest: PackageManifest, files: string[]): void {
    const listed = new Set(manifest.files);
    const shipped = files.filter((file) => file !== PackageLayout.MANIFEST);
    const unlisted = shipped.filter((file) => !listed.has(file));
    const absent = manifest.files.filter((file) => !shipped.includes(file));
    if (unlisted.length > 0 || absent.length > 0) {
      const detail = unlisted.length > 0 ? `${unlisted[0]} isn't listed in it` : `${absent[0]} is listed but missing`;
      throw new PackageArchiveError('files-mismatch', `${manifest.name} ${manifest.version} doesn't match its ${PackageLayout.MANIFEST}: ${detail}.`);
    }
    if (!listed.has(PackageLayout.ENTRY)) {
      throw new PackageArchiveError('files-mismatch', `${manifest.name} ${manifest.version} has no ${PackageLayout.ENTRY}, so nothing could import it.`);
    }
  }

  /** Every `.js` file of the package, scanned like a workspace module (research M5). */
  private static scanImports(tree: string, files: string[]): void {
    for (const file of files) {
      if (!/\.(?:js|mjs|cjs)$/.test(file)) {
        continue;
      }
      const blocked = BlockedImports.firstIn(fs.readFileSync(path.join(tree, ...file.split('/')), 'utf8'));
      if (blocked) {
        throw new PackageArchiveError('blocked-import', `${file} imports "${blocked}", so the package wasn't installed. ${BlockedImports.refusal(blocked)}`);
      }
    }
  }

  private static warnings(manifest: PackageManifest, engineVersion: string): PackageWarning[] {
    const warnings: PackageWarning[] = [];
    const raw = manifest.features.filter((feature) => feature?.usesOcct === true).map((feature) => feature.id);
    if (raw.length > 0) {
      warnings.push({
        code: 'uses-occt',
        message: `Uses raw OpenCascade: ${raw.join(', ')}. A mistake there can crash the engine or corrupt its geometry kernel.`,
      });
    }
    const running = Semver.parse(engineVersion);
    const needed = Semver.parse(manifest.minEngine)!;
    if (running && Semver.compare(needed, running) > 0) {
      warnings.push({
        code: 'min-engine',
        message: `Needs FluidCAD ${manifest.minEngine} or newer; this is ${engineVersion}, so it won't load until you upgrade.`,
      });
    }
    if (manifest.sdkVersion !== SDK_VERSION) {
      const which = manifest.sdkVersion > SDK_VERSION ? 'a newer' : 'an older';
      warnings.push({
        code: 'sdk-version',
        message: `Built against ${which} feature SDK (version ${manifest.sdkVersion}); this engine has version ${SDK_VERSION}.`,
      });
    }
    return warnings;
  }
}
