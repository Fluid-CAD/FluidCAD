import fs from 'fs';
import path from 'path';
import { PackageLayout, type PackageManifest, type PackageManifestFeature, type PackageManifestPart } from './package-manifest.ts';

/**
 * The `manifest.json` of an installed package, read back: what the
 * catalogs, the resolver's engine checks and the rebuild of a switched
 * package read about a package without evaluating it.
 *
 * The installer checked the manifest's identity and file list when it
 * placed the tree (`PackageArchive.inspect`), and the tree is read-only
 * after that, so a read only guards the shape the readers rely on: a
 * manifest without its lists reads as none. Each directory's answer is
 * cached by the manifest's size and mtime, so a replaced install
 * (`fluidcad install --replace`) is read again.
 */
export class PackageManifests {
  private static readonly cache = new Map<string, { stamp: string; manifest: PackageManifest | null }>();

  /** The manifest of the package installed at `directory`; null when it is missing, unreadable or malformed. */
  static of(directory: string): PackageManifest | null {
    const file = path.join(directory, PackageLayout.MANIFEST);
    let stamp: string;
    try {
      const stat = fs.statSync(file);
      stamp = `${stat.size}:${stat.mtimeMs}`;
    } catch {
      PackageManifests.cache.delete(directory);
      return null;
    }
    const cached = PackageManifests.cache.get(directory);
    if (cached && cached.stamp === stamp) {
      return cached.manifest;
    }
    const manifest = PackageManifests.read(file);
    PackageManifests.cache.set(directory, { stamp, manifest });
    return manifest;
  }

  /** The package-relative path of `file` inside `directory`, or null when it isn't inside. */
  static modulePathIn(directory: string, file: string): string | null {
    const relative = path.relative(directory, file).replace(/\\/g, '/');
    if (relative === '' || relative.startsWith('../') || relative === '..' || path.isAbsolute(relative)) {
      return null;
    }
    return relative;
  }

  /**
   * Whether the package's entry (`index.js`) re-exports `exportName` from
   * `module` (package-relative): what makes the module reachable by the
   * package's bare name. The entry is generated from the manifest's
   * features and parts, one named re-export each, so the manifest answers.
   */
  static exports(manifest: PackageManifest, module: string, exportName: string): boolean {
    return manifest.features.some((feature) => feature.module === module && feature.exportName === exportName)
      || manifest.parts.some((part) => part.module === module && part.exportName === exportName);
  }

  /** The module the entry re-exports `exportName` from, package-relative; null when it exports no such name. */
  static moduleOf(manifest: PackageManifest, exportName: string): string | null {
    const found: PackageManifestFeature | PackageManifestPart | undefined =
      manifest.features.find((feature) => feature.exportName === exportName)
      ?? manifest.parts.find((part) => part.exportName === exportName);
    return found?.module ?? null;
  }

  /** Drop every cached manifest (tests). */
  static forget(): void {
    PackageManifests.cache.clear();
  }

  private static read(file: string): PackageManifest | null {
    let parsed: any;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.name !== 'string' || typeof parsed.version !== 'string') {
      return null;
    }
    if (!Array.isArray(parsed.features) || !Array.isArray(parsed.parts)) {
      return null;
    }
    const features = parsed.features.filter((feature: any) =>
      feature && typeof feature.id === 'string' && typeof feature.exportName === 'string'
      && typeof feature.module === 'string' && feature.meta && typeof feature.meta === 'object');
    const parts = parsed.parts.filter((part: any) =>
      part && typeof part.exportName === 'string' && typeof part.module === 'string');
    return { ...parsed, features, parts } as PackageManifest;
  }
}
