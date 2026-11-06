import type { InstalledPackage, PackageManifest, PackagesClient, PackagesOverview, PinnedPackage } from '../../api';

type Listener = (overview: PackagesOverview | null) => void;

/**
 * What the page knows of the packages — `GET /api/packages`: the user
 * library, the open project's copy and its pins, the missing ones and the
 * library-folder copy offer. Settings → Packages, the project's Packages
 * dialog and the top bar's mark all read this one copy. Nothing broadcasts
 * after an install or a removal (the CLI in another process included), so
 * whoever changes something calls {@link refresh}; opening a package
 * surface refreshes too.
 */
export class PackagesState {
  current: PackagesOverview | null = null;
  private readonly listeners = new Set<Listener>();
  /** The latest refresh — an older one's answer is dropped. */
  private ticket = 0;

  constructor(readonly client: PackagesClient) {}

  async refresh(): Promise<PackagesOverview | null> {
    const ticket = ++this.ticket;
    const overview = await this.client.overview();
    if (ticket !== this.ticket) {
      return this.current;
    }
    this.current = overview;
    for (const fn of this.listeners) {
      fn(overview);
    }
    return overview;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The pins installed in neither the project copy nor the library. */
  get missing(): PinnedPackage[] {
    return (this.current?.pins ?? []).filter((pin) => pin.availability === 'missing');
  }

  /** Whether a project is open (the project target and the pins exist only then). */
  get hasProject(): boolean {
    return this.current?.project != null;
  }

  /**
   * Whether the open workspace is itself a package: its `fluidcad.json` has
   * a `package` block, readable or not. A block the engine can't read still
   * counts, so the top bar shows Publish and the dialog can say what is
   * wrong with it, never Share.
   */
  get isPackageWorkspace(): boolean {
    return this.current?.package != null || this.current?.packageProblem !== undefined;
  }

  /** The workspace's own package, when its block reads. */
  get package(): { name: string; version: string } | null {
    return this.current?.package ?? null;
  }

  /** Why the workspace's `package` block can't be read, when it can't. */
  get packageProblem(): string | null {
    return this.current?.packageProblem ?? null;
  }
}

/** How the package UI words a package: its name and version, its contents, its size. */
export class PackageText {
  /** `@acme/gears 1.2.0`. */
  static label(name: string, version: string | null): string {
    return version ? `${name} ${version}` : name;
  }

  /** `5 features, 2 parts`; `no features or parts` for an empty manifest. */
  static contents(manifest: Pick<PackageManifest, 'features' | 'parts'> | null): string {
    if (!manifest) {
      return 'unreadable manifest';
    }
    const parts: string[] = [];
    const features = manifest.features?.length ?? 0;
    const partCount = (manifest.parts ?? []).filter((p) => p.kind !== 'assembly').length;
    const assemblies = (manifest.parts ?? []).length - partCount;
    if (features > 0) {
      parts.push(PackageText.count(features, 'feature'));
    }
    if (partCount > 0) {
      parts.push(PackageText.count(partCount, 'part'));
    }
    if (assemblies > 0) {
      parts.push(PackageText.count(assemblies, 'assembly', 'assemblies'));
    }
    return parts.length > 0 ? parts.join(', ') : 'no features or parts';
  }

  /** `48.6 kB`, `812 B`, `2.4 MB`. */
  static bytes(bytes: number): string {
    if (bytes < 1000) {
      return `${bytes} B`;
    }
    if (bytes < 1_000_000) {
      return `${(bytes / 1000).toFixed(1)} kB`;
    }
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
  }

  /** One library row's details: contents and size, or why its manifest can't be read. */
  static installed(entry: InstalledPackage): string {
    return entry.manifest
      ? `${PackageText.contents(entry.manifest)} · ${PackageText.bytes(entry.bytes)}`
      : entry.problem ?? 'Its manifest.json can\'t be read.';
  }

  /** `needs FluidCAD 0.0.45 or newer (packed on 0.0.46)`. */
  static engine(manifest: Pick<PackageManifest, 'minEngine' | 'engine'>): string {
    return manifest.engine && manifest.engine !== manifest.minEngine
      ? `Needs FluidCAD ${manifest.minEngine} or newer (packed on ${manifest.engine}).`
      : `Needs FluidCAD ${manifest.minEngine} or newer.`;
  }

  private static count(n: number, one: string, many = `${one}s`): string {
    return `${n} ${n === 1 ? one : many}`;
  }
}
