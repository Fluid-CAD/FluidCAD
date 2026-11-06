import fs from 'fs';
import path from 'path';
import { normalizePath } from '../normalize-path.ts';
import { PackageIntegrity } from './package-integrity.ts';
import { PackageManifests } from './package-manifests.ts';
import { PackagePins, type PinnedPackage } from './package-pins.ts';
import { PackageTypeLinks } from './package-type-links.ts';

/** One file the in-page editor's language service is given. */
export type PackageTypeFile = {
  /** `file:///node_modules/@scope/name/<package path>`. */
  uri: string;
  content: string;
};

/** `GET /api/packages/types`. */
export type PackageTypesPayload = {
  /**
   * Which packages, at which directory and contents, the files describe:
   * the page registers the files again only when this changes.
   */
  key: string;
  files: PackageTypeFile[];
  /** Total bytes, so the page can log what it paid for. */
  bytes: number;
};

/**
 * The pinned packages' sources for the in-page editor (Monaco), the way
 * `GET /api/engine/types` gives it the engine's declarations: every `.js`
 * (and `.d.ts`, if a package ships any) file of each pin's installed
 * directory, published under `file:///node_modules/@scope/name/…`.
 *
 * That `node_modules` path exists only in the page's language service, so
 * it is harmless to Vite (research M1). It is what lets the package's own
 * `fluidcad/*` imports find the engine's declarations, which the page keeps
 * under `file:///node_modules/fluidcad`: `standoff(` then completes with
 * the types inferred from the package's JavaScript.
 *
 * Only pins count (K7): a library package the project doesn't pin isn't
 * importable, so it isn't typed. A pin installed nowhere has no files.
 */
export class PackageTypeLibs {
  /** Where the page's language service finds a package by its name. */
  static readonly LIB_ROOT = 'file:///node_modules';

  /** What a package contributes to the language service: its JavaScript, and any declarations. */
  private static readonly TYPED = /\.(?:js|mjs|d\.ts)$/;

  static of(project: string | null): PackageTypesPayload {
    const files: PackageTypeFile[] = [];
    const key: string[] = [];
    for (const pin of PackageTypeShims.installedPins(project)) {
      key.push(`${pin.name}@${pin.version}:${pin.directory}:${PackageTypeLibs.integrityOf(pin.directory!)}`);
      for (const rel of PackageTypeLibs.typedFiles(pin.directory!)) {
        try {
          files.push({
            uri: `${PackageTypeLibs.LIB_ROOT}/${pin.name}/${rel}`,
            content: fs.readFileSync(path.join(pin.directory!, rel), 'utf8'),
          });
        } catch {
          // A file that vanished mid-read just isn't offered.
        }
      }
    }
    return {
      key: key.join('\n'),
      files,
      bytes: files.reduce((sum, file) => sum + file.content.length, 0),
    };
  }

  /** The package-relative paths of the files the language service reads, sorted. Dot entries are skipped. */
  private static typedFiles(dir: string, prefix = ''): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(dir, prefix), { withFileTypes: true });
    } catch {
      return [];
    }
    const found: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        found.push(...PackageTypeLibs.typedFiles(dir, rel));
      } else if (entry.isFile() && PackageTypeLibs.TYPED.test(entry.name)) {
        found.push(rel);
      }
    }
    return found.sort();
  }

  private static integrityOf(directory: string): string {
    try {
      return PackageIntegrity.of(directory);
    } catch {
      return '';
    }
  }
}

/** What one {@link PackageTypeShims.sync} did, by package name (`skipped` by `@types` folder). */
export type PackageTypeShimSync = {
  /** Shims created or rewritten. */
  written: string[];
  /** Shims already as they should be. */
  kept: string[];
  /** Shims of packages the project no longer pins (or has installed nowhere), removed. */
  removed: string[];
  /** `@types` folders left alone: someone else's (no marker), or the link could not be made. */
  skipped: { folder: string; reason: string }[];
};

/**
 * The tsserver half of the editor types (VS Code, Neovim): one shim per
 * pinned, installed package in the project's `node_modules/@types`
 * (`PackageTypeLinks` has the layout and why it links). {@link sync} makes
 * the folder match the pins: a new pin gets a shim, a pin whose package
 * moved (Copy into project, Use from library) gets its link re-pointed, and
 * a package the project stops pinning, or has installed nowhere, loses its
 * shim. Only marked folders are ever touched, and a shim's link is
 * unlinked, never followed, so removing one can't reach the package.
 *
 * Like the engine link this is a courtesy to the tools that read the
 * filesystem; rendering never reads it. The scene host keeps it in step:
 * at start, on every render, and when the project's `fluidcad.json`
 * changes.
 */
export class PackageTypeShims {
  /** A JavaScript identifier: what a manifest's `exportName` must be to be written into a declaration. */
  private static readonly IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

  static sync(project: string | null): PackageTypeShimSync {
    const result: PackageTypeShimSync = { written: [], kept: [], removed: [], skipped: [] };
    if (!project) {
      return result;
    }
    let pins: PinnedPackage[];
    try {
      pins = PackagePins.availability(project);
    } catch {
      // A broken pin map has its own warning; the shims stay as they are
      // until it reads again.
      return result;
    }
    const wanted = new Map<string, PinnedPackage>();
    for (const pin of pins) {
      const folder = PackageTypeLinks.folderName(pin.name);
      if (folder && pin.directory) {
        wanted.set(folder, pin);
      }
    }
    const root = PackageTypeLinks.typesRoot(project);
    for (const folder of PackageTypeShims.folders(root)) {
      const dir = path.join(root, folder);
      if (!wanted.has(folder) && PackageTypeLinks.isShim(dir)) {
        const name = PackageTypeShims.nameOf(dir) ?? folder;
        PackageTypeShims.remove(dir);
        result.removed.push(name);
      }
    }
    for (const [folder, pin] of wanted) {
      PackageTypeShims.ensure(root, folder, pin, result);
    }
    if (result.removed.length > 0) {
      // The `@types` folder the first shim created goes with the last one.
      try {
        fs.rmdirSync(root);
      } catch {
        // Something else lives there.
      }
    }
    return result;
  }

  /** The project's pins that are installed somewhere (the project copy first, then the library); none when the map is broken. */
  static installedPins(project: string | null): PinnedPackage[] {
    if (!project) {
      return [];
    }
    try {
      return PackagePins.availability(project).filter((pin) => pin.directory !== null);
    } catch {
      return [];
    }
  }

  /**
   * The shim's `index.d.ts`: the package entry's named re-exports (one line
   * per module, as `fluidcad pack` writes `index.js`), each from the module
   * itself through the link rather than through `index.js`, so a feature
   * sits one level nearer than `maxNodeModuleJsDepth` counts. A manifest
   * that can't be read, or names something that isn't an identifier or a
   * package path, falls back to re-exporting the entry whole.
   */
  static declaration(pin: Pick<PinnedPackage, 'name' | 'version'>, directory: string): string {
    const header = [
      `// Generated by FluidCAD so editors know ${pin.name} ${pin.version}, which this project pins.`,
      `// \`${PackageTypeLinks.LINK}\` links to the installed package; its modules are re-exported through it so their`,
      '// own `fluidcad` imports resolve from this project. Rewritten when the pins change; edits are lost.',
    ];
    const lines = PackageTypeShims.reExports(directory) ?? [`export * from ${JSON.stringify(`./${PackageTypeLinks.LINK}/index.js`)};`];
    return [...header, ...lines, ''].join('\n');
  }

  /** The named re-export lines, or null when the manifest can't name them safely. */
  private static reExports(directory: string): string[] | null {
    const manifest = PackageManifests.of(directory);
    if (!manifest) {
      return null;
    }
    const byModule = new Map<string, string[]>();
    for (const { module, exportName } of [...manifest.features, ...manifest.parts]) {
      if (!PackageTypeShims.IDENTIFIER.test(exportName) || PackageManifests.modulePathIn(directory, path.join(directory, module)) !== module) {
        return null;
      }
      byModule.set(module, [...(byModule.get(module) ?? []), exportName]);
    }
    if (byModule.size === 0) {
      return null;
    }
    return [...byModule.keys()].sort().map((module) => {
      const names = byModule.get(module)!.sort().join(', ');
      return `export { ${names} } from ${JSON.stringify(`./${PackageTypeLinks.LINK}/${module}`)};`;
    });
  }

  /** Create or correct one shim. */
  private static ensure(root: string, folder: string, pin: PinnedPackage, result: PackageTypeShimSync): void {
    const dir = path.join(root, folder);
    if (fs.existsSync(dir) && !PackageTypeLinks.isShim(dir)) {
      result.skipped.push({ folder, reason: `${normalizePath(dir)} is not FluidCAD's (no ${PackageTypeLinks.MARKER}), so it was left alone` });
      return;
    }
    const directory = pin.directory!;
    const declaration = PackageTypeShims.declaration(pin, directory);
    const marker = PackageTypeShims.markerText(pin.name);
    const link = path.join(dir, PackageTypeLinks.LINK);
    const linkOk = PackageTypeShims.linksTo(link, directory);
    if (linkOk && PackageTypeShims.read(path.join(dir, PackageTypeLinks.DECLARATION)) === declaration
      && PackageTypeShims.read(path.join(dir, PackageTypeLinks.MARKER)) === marker) {
      result.kept.push(pin.name);
      return;
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      // The marker first: a shim half-written by a crash is still ours to fix.
      fs.writeFileSync(path.join(dir, PackageTypeLinks.MARKER), marker);
      if (!linkOk) {
        PackageTypeShims.unlinkIfPresent(link);
        // A junction on Windows, like the engine link: no privileges needed.
        fs.symlinkSync(directory, link, 'junction');
      }
      fs.writeFileSync(path.join(dir, PackageTypeLinks.DECLARATION), declaration);
      result.written.push(pin.name);
    } catch (err: any) {
      // A read-only workspace, or a filesystem without links (issue #66):
      // the editors just don't know the package. Nothing half-made stays.
      PackageTypeShims.remove(dir);
      result.skipped.push({ folder, reason: err?.message ?? String(err) });
    }
  }

  /**
   * Remove a shim: its link is unlinked, never followed, so nothing of the
   * installed package is touched; then its own files, then the folder if
   * that leaves it empty.
   */
  private static remove(dir: string): void {
    PackageTypeShims.unlinkIfPresent(path.join(dir, PackageTypeLinks.LINK));
    for (const name of [PackageTypeLinks.DECLARATION, PackageTypeLinks.MARKER]) {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch {
        // Not there.
      }
    }
    try {
      fs.rmdirSync(dir);
    } catch {
      // Something else was put there; it stays.
    }
  }

  /** Unlink `link` when it is a link or a stray file (a real directory there is left alone). */
  private static unlinkIfPresent(link: string): void {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(link);
    } catch {
      return;
    }
    if (stat.isSymbolicLink() || stat.isFile()) {
      fs.unlinkSync(link);
    }
  }

  /** Whether `link` is a link that lands on `directory`. */
  private static linksTo(link: string, directory: string): boolean {
    try {
      if (!fs.lstatSync(link).isSymbolicLink()) {
        return false;
      }
      return fs.realpathSync(link) === fs.realpathSync(directory);
    } catch {
      return false;
    }
  }

  private static markerText(name: string): string {
    return `${name}\n` +
      'This folder tells editors (tsserver) the types of a package this project pins. It is kept by the\n' +
      'FluidCAD server and removed when the project stops pinning the package.\n';
  }

  /** The package name a shim's marker records. */
  private static nameOf(dir: string): string | null {
    const first = PackageTypeShims.read(path.join(dir, PackageTypeLinks.MARKER))?.split('\n')[0] ?? '';
    return first.startsWith('@') ? first : null;
  }

  private static folders(root: string): string[] {
    try {
      return fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  private static read(file: string): string | null {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }
}
