import { readProjectConfig } from '../project-config.ts';
import { PackageManifests } from './package-manifests.ts';
import type { PackageManifest } from './package-manifest.ts';
import { PackageResolveError, PackageResolver } from './resolver.ts';
import { PackageRoots } from './package-roots.ts';

/**
 * Where a catalog entry from a package comes from (K7): a package the
 * project pins (`dependency`), or the newest version in the user library of
 * one it doesn't pin yet (`library`) — using that one pins it first.
 */
export type PackageOfferAvailability = 'dependency' | 'library';

/** The package a catalog entry belongs to, as the catalogs' payloads carry it. */
export type PackageRef = { name: string; version: string; availability: PackageOfferAvailability };

/** One installed package a project's catalogs offer features and parts from. */
export type PackageOffer = PackageRef & {
  /** The installed directory, `<root>/@scope/name/<version>`. */
  directory: string;
  manifest: PackageManifest;
  /**
   * Why the package can't be used here — its files differ from the pin,
   * or this engine is too old or speaks another SDK — worded as the render
   * would refuse it. Its features are offered as error entries, so the
   * toolbar says why instead of leaving them out unexplained.
   */
  problem?: string;
};

/**
 * The packages a project's feature and part catalogs list (research §5,
 * K7), read from their manifests — nothing is evaluated:
 *
 * - every package the project pins, at the pinned version, wherever the
 *   resolver finds it (the project copy first, then the library). A pin
 *   installed nowhere offers nothing: there is no manifest to list, and the
 *   project's missing-package problem says so;
 * - for each package in the user library the project doesn't pin, its
 *   newest version — except the package the open workspace is itself (a
 *   package's author tries its own modules, not an installed copy).
 */
export class PackageOffers {
  /** The offers of `project`, pins first (by name), then the library's (by name); none without a project. */
  static of(project: string | null, resolver: PackageResolver = new PackageResolver({ project })): PackageOffer[] {
    if (!project) {
      return [];
    }
    const config = readProjectConfig(project);
    const pins = config.problems?.dependencies ? {} : config.dependencies ?? {};
    const offers: PackageOffer[] = [];
    for (const name of Object.keys(pins).sort()) {
      const offer = PackageOffers.pinned(name, pins[name].version, resolver, project);
      if (offer) {
        offers.push(offer);
      }
    }
    const own = config.package?.name ?? null;
    for (const location of PackageOffers.newestInLibrary(project)) {
      if (location.name === own || Object.prototype.hasOwnProperty.call(pins, location.name)) {
        continue;
      }
      const manifest = PackageManifests.of(location.directory);
      if (!manifest) {
        continue;
      }
      const refusal = resolver.engineRefusal(location.name, location.version, manifest);
      offers.push({
        name: location.name,
        version: location.version,
        availability: 'library',
        directory: location.directory,
        manifest,
        ...(refusal ? { problem: refusal.message } : {}),
      });
    }
    return offers;
  }

  /** A pinned package's offer: the resolved one, or the pinned version's manifest with the resolver's refusal. */
  private static pinned(name: string, version: string, resolver: PackageResolver, project: string): PackageOffer | null {
    const resolved = resolver.resolve(name, null);
    if (resolved !== null && !(resolved instanceof PackageResolveError)) {
      const manifest = PackageManifests.of(resolved.directory);
      return manifest ? { name, version, availability: 'dependency', directory: resolved.directory, manifest } : null;
    }
    const location = PackageRoots.locate(name, version, project);
    const manifest = location ? PackageManifests.of(location.directory) : null;
    if (!location || !manifest) {
      return null;
    }
    const problem = resolved instanceof PackageResolveError ? resolved.message : `\`${name}\` ${version} can't be loaded.`;
    return { name, version, availability: 'dependency', directory: location.directory, manifest, problem };
  }

  /** The newest installed version of each package in the user library. */
  private static newestInLibrary(project: string): ReturnType<typeof PackageRoots.installedIn> {
    const installed = PackageRoots.installedIn({ target: 'library', root: PackageRoots.libraryPath() }, project);
    const newest = new Map<string, (typeof installed)[number]>();
    for (const location of installed) {
      // installedIn sorts each name's versions by precedence, so the last one wins.
      newest.set(location.name, location);
    }
    return [...newest.values()];
  }
}
