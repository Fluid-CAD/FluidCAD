/**
 * A package version: semver 2.0 without build metadata (research §1) —
 * `MAJOR.MINOR.PATCH` with an optional `-prerelease`. Ordered by semver
 * precedence, which is what a publish and an "update available" check
 * compare.
 *
 * Deliberately dependency-free (no imports at all): `project-config.ts`
 * validates `package.version` and every `dependencies` pin with it, and the
 * plain-JS CLI in `bin/` bumps versions with it as compiled JS out of
 * `server/dist`.
 */

/** What `fluidcad version` takes besides an explicit version. */
export type SemverBump = 'major' | 'minor' | 'patch';

export class Semver {
  static readonly BUMPS: readonly SemverBump[] = ['major', 'minor', 'patch'];

  /**
   * The semver.org grammar with the `+build` part removed: no leading zeros
   * in a numeric part or a numeric prerelease identifier, identifiers of
   * `[0-9A-Za-z-]`.
   */
  private static readonly PATTERN =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

  private constructor(
    readonly major: number,
    readonly minor: number,
    readonly patch: number,
    /** The dot-separated prerelease identifiers; empty for a release. */
    readonly prerelease: readonly string[],
  ) {}

  /** The version `text` spells, or null when it isn't one (ranges, `v1.2.3`, build metadata included). */
  static parse(text: unknown): Semver | null {
    if (typeof text !== 'string') {
      return null;
    }
    const match = Semver.PATTERN.exec(text);
    if (!match) {
      return null;
    }
    const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (!parts.every(Number.isSafeInteger)) {
      return null;
    }
    return new Semver(parts[0], parts[1], parts[2], match[4] ? match[4].split('.') : []);
  }

  static isValid(text: unknown): text is string {
    return Semver.parse(text) !== null;
  }

  static isBump(value: unknown): value is SemverBump {
    return (Semver.BUMPS as readonly unknown[]).includes(value);
  }

  /** Negative, zero or positive as `a` sorts before, with or after `b` — semver precedence. */
  static compare(a: Semver, b: Semver): number {
    return a.compareTo(b);
  }

  get isPrerelease(): boolean {
    return this.prerelease.length > 0;
  }

  compareTo(other: Semver): number {
    const core = this.major - other.major || this.minor - other.minor || this.patch - other.patch;
    if (core !== 0) {
      return Math.sign(core);
    }
    // A release outranks every prerelease of the same core version.
    if (!this.isPrerelease || !other.isPrerelease) {
      return Number(other.isPrerelease) - Number(this.isPrerelease);
    }
    const length = Math.max(this.prerelease.length, other.prerelease.length);
    for (let i = 0; i < length; i++) {
      const order = Semver.compareIdentifiers(this.prerelease[i], other.prerelease[i]);
      if (order !== 0) {
        return order;
      }
    }
    return 0;
  }

  equals(other: Semver): boolean {
    return this.compareTo(other) === 0;
  }

  /**
   * The next version of `kind`, the way `npm version` counts: a prerelease
   * is released by the bump that names its own core (`1.3.0-beta` + minor →
   * `1.3.0`, `2.0.0-rc.1` + major → `2.0.0`), and every other bump resets the
   * parts below it and drops the prerelease.
   */
  bump(kind: SemverBump): Semver {
    if (kind === 'major') {
      if (this.isPrerelease && this.minor === 0 && this.patch === 0) {
        return new Semver(this.major, 0, 0, []);
      }
      return new Semver(this.major + 1, 0, 0, []);
    }
    if (kind === 'minor') {
      if (this.isPrerelease && this.patch === 0) {
        return new Semver(this.major, this.minor, 0, []);
      }
      return new Semver(this.major, this.minor + 1, 0, []);
    }
    if (this.isPrerelease) {
      return new Semver(this.major, this.minor, this.patch, []);
    }
    return new Semver(this.major, this.minor, this.patch + 1, []);
  }

  toString(): string {
    const core = `${this.major}.${this.minor}.${this.patch}`;
    return this.isPrerelease ? `${core}-${this.prerelease.join('.')}` : core;
  }

  /**
   * One prerelease identifier against another: numeric ones compare as
   * numbers and sort before alphanumeric ones, which compare in ASCII order;
   * a shorter list that is a prefix of a longer one sorts first.
   */
  private static compareIdentifiers(a: string | undefined, b: string | undefined): number {
    if (a === undefined || b === undefined) {
      return Number(a !== undefined) - Number(b !== undefined);
    }
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      // The grammar forbids leading zeros, so the longer digit string is the
      // larger number — exact at any length, unlike Number().
      if (a.length !== b.length) {
        return a.length < b.length ? -1 : 1;
      }
    }
    if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1;
    }
    if (a === b) {
      return 0;
    }
    return a < b ? -1 : 1;
  }
}
