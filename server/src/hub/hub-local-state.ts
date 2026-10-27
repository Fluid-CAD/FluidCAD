import { PackagePinError, PackagePins } from '../packages/package-pins.ts';
import { PackageRoots } from '../packages/package-roots.ts';
import { Semver } from '../packages/semver.ts';

/**
 * What this machine already has of a hub package (hub-plan H10): the marks
 * the engine adds to the hub's rows and detail, which the hub never knows.
 * - `installed`: every version installed where the open project resolves
 *   packages from (its `packages/` copy and the library; the library alone
 *   outside a project), oldest first;
 * - `pinned`: the version the open project pins, or null;
 * - `updateAvailable`: the version the hub offers this engine (what an
 *   install by name would get) when it is newer than the pin, or, without
 *   a pin, than the newest installed version; null when nothing of the
 *   package is here, or the hub offers nothing newer.
 */
export type HubLocalMarks = {
  installed: string[];
  pinned: string | null;
  updateAvailable: string | null;
};

export class HubLocalState {
  private constructor(
    /** Package name → its installed versions, oldest first. */
    private readonly installed: ReadonlyMap<string, string[]>,
    /** Package name → its pinned version. */
    private readonly pins: ReadonlyMap<string, string>,
  ) {}

  /**
   * Both roots and the pins of `project`, read once for a whole answer. A
   * pin map that can't be read (a broken `dependencies`) counts as no pins:
   * the marks are a courtesy, and the project's own warning says what is
   * wrong.
   */
  static read(project: string | null): HubLocalState {
    const installed = new Map<string, string[]>();
    for (const root of PackageRoots.rootsFor(project)) {
      for (const entry of PackageRoots.installedIn(root, project)) {
        const versions = installed.get(entry.name) ?? [];
        if (!versions.includes(entry.version)) {
          versions.push(entry.version);
        }
        installed.set(entry.name, versions);
      }
    }
    for (const versions of installed.values()) {
      versions.sort(HubLocalState.byPrecedence);
    }
    const pins = new Map<string, string>();
    if (project && PackagePins.isProject(project)) {
      try {
        for (const [name, pin] of Object.entries(PackagePins.of(project))) {
          pins.set(name, pin.version);
        }
      } catch (err) {
        if (!(err instanceof PackagePinError)) {
          throw err;
        }
      }
    }
    return new HubLocalState(installed, pins);
  }

  /** The marks for `name`, against `offered`: the version the hub would install here (null when it offers none this engine runs). */
  marks(name: string, offered: string | null): HubLocalMarks {
    const installed = [...(this.installed.get(name) ?? [])];
    const pinned = this.pins.get(name) ?? null;
    const current = pinned ?? installed.at(-1) ?? null;
    return { installed, pinned, updateAvailable: HubLocalState.newer(offered, current) };
  }

  /** `offered` when it is a version above `current`; null otherwise. */
  private static newer(offered: string | null, current: string | null): string | null {
    const next = Semver.parse(offered);
    const now = Semver.parse(current);
    if (!next || !now) {
      return null;
    }
    return Semver.compare(next, now) > 0 ? next.toString() : null;
  }

  private static byPrecedence(a: string, b: string): number {
    const left = Semver.parse(a);
    const right = Semver.parse(b);
    if (!left || !right) {
      return a < b ? -1 : a > b ? 1 : 0;
    }
    return Semver.compare(left, right);
  }
}
