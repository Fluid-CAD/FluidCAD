import type { HubSearchRow, HubSort, HubOrder } from '../../api';

/** Why this FluidCAD can't run a package, as the panel says it. */
export type HubIncompatibility = { kind: 'engine' | 'older-sdk' | 'unknown'; text: string; tip: string };

/**
 * The Hub panel's words and numbers: counts, contents, dates, the sort
 * control's labels, and the one incompatibility message (H11 decision 3).
 */
export class HubText {
  static readonly SORT_LABELS: Readonly<Record<HubSort, string>> = Object.freeze({
    relevance: 'Best match',
    installs: 'Most installed',
    likes: 'Most liked',
    updated: 'Recently updated',
    newest: 'Newest',
  });

  /** The sorts in the dropdown's order. */
  static readonly SORTS: readonly HubSort[] = ['relevance', 'installs', 'likes', 'updated', 'newest'];

  /** What each direction of a sort lists first: the direction button's tooltip. */
  private static readonly DIRECTIONS: Readonly<Record<Exclude<HubSort, 'relevance'>, Record<HubOrder, string>>> = Object.freeze({
    installs: { desc: 'Most installed first', asc: 'Least installed first' },
    likes: { desc: 'Most liked first', asc: 'Least liked first' },
    updated: { desc: 'Latest update first', asc: 'Oldest update first' },
    newest: { desc: 'Newest first', asc: 'Oldest first' },
  });

  private static readonly NUMBER = new Intl.NumberFormat('en-US');

  static count(n: number): string {
    return HubText.NUMBER.format(n);
  }

  static plural(n: number, one: string, many = `${one}s`): string {
    return `${HubText.count(n)} ${n === 1 ? one : many}`;
  }

  /** `5 features · 2 parts · 1 assembly`, leaving out what it has none of. */
  static contents(counts: { features: number; parts: number; assemblies: number }): string {
    const parts: string[] = [];
    if (counts.features > 0) {
      parts.push(HubText.plural(counts.features, 'feature'));
    }
    if (counts.parts > 0) {
      parts.push(HubText.plural(counts.parts, 'part'));
    }
    if (counts.assemblies > 0) {
      parts.push(HubText.plural(counts.assemblies, 'assembly', 'assemblies'));
    }
    return parts.join(' · ');
  }

  /** `today`, `1 day ago`, `11 days ago`, `3 months ago`, `2 years ago`; empty for a date it can't read. */
  static ago(iso: string | null, now: number = Date.now()): string {
    const at = iso ? Date.parse(iso) : Number.NaN;
    if (!Number.isFinite(at)) {
      return '';
    }
    const days = Math.floor(Math.max(0, now - at) / 86_400_000);
    if (days === 0) {
      return 'today';
    }
    if (days < 31) {
      return `${HubText.plural(days, 'day')} ago`;
    }
    const months = Math.floor(days / 30.44);
    if (months < 12) {
      return `${HubText.plural(months, 'month')} ago`;
    }
    return `${HubText.plural(Math.floor(days / 365.25), 'year')} ago`;
  }

  /** How a row names its license: the SPDX id, "All rights reserved" for the hub's proprietary one, or "no license". */
  static license(id: string | null): string {
    if (!id) {
      return 'no license';
    }
    return id === 'LicenseRef-Proprietary' ? 'All rights reserved' : id;
  }

  /** The direction button's tooltip for `sort` running `order`. */
  static direction(sort: HubSort, order: HubOrder): string {
    if (sort === 'relevance') {
      return 'Best match lists the best match first';
    }
    return HubText.DIRECTIONS[sort][order];
  }

  /**
   * Why this FluidCAD (`engine`, its feature SDK `sdk`) can't run a row
   * the hub marked `compatible: false`, by `fluidcad search`'s rule
   * (`HubSearchText.incompatibility`):
   * - its `minEngine` is above this FluidCAD → "Requires FluidCAD X+"
   *   (`fluidcad pack` keeps `minEngine` at or above its SDK's first
   *   FluidCAD, so a package for a newer SDK lands here too);
   * - else it was packed for an older feature SDK → "Made for an older
   *   FluidCAD";
   * - else "Not compatible with this FluidCAD", never a guess.
   */
  static incompatibility(row: Pick<HubSearchRow, 'minEngine' | 'sdkVersion'>, engine: string | null, sdk: number | null): HubIncompatibility {
    if (engine && HubText.compareVersions(row.minEngine, engine) > 0) {
      return { kind: 'engine', text: `Requires FluidCAD ${row.minEngine}+`, tip: `This is FluidCAD ${engine}.` };
    }
    if (sdk !== null && typeof row.sdkVersion === 'number' && row.sdkVersion < sdk) {
      return {
        kind: 'older-sdk',
        text: 'Made for an older FluidCAD',
        tip: `It was packed for an older FluidCAD${engine ? `; this is FluidCAD ${engine}` : ''}, which can't load its features.`,
      };
    }
    return {
      kind: 'unknown',
      text: 'Not compatible with this FluidCAD',
      tip: `The hub says ${engine ? `FluidCAD ${engine}` : 'this FluidCAD'} can't run it.`,
    };
  }

  /**
   * Semver precedence (`1.0.0-beta < 1.0.0 < 1.0.1`); 0 when either isn't a
   * version, so nothing is claimed about one the panel can't read.
   */
  static compareVersions(a: string, b: string): number {
    const left = HubText.parse(a);
    const right = HubText.parse(b);
    if (!left || !right) {
      return 0;
    }
    for (let i = 0; i < 3; i++) {
      if (left.core[i] !== right.core[i]) {
        return left.core[i] > right.core[i] ? 1 : -1;
      }
    }
    if (left.pre.length === 0 || right.pre.length === 0) {
      return left.pre.length === right.pre.length ? 0 : left.pre.length === 0 ? 1 : -1;
    }
    for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
      const x = left.pre[i];
      const y = right.pre[i];
      if (x === undefined || y === undefined) {
        return x === undefined ? -1 : 1;
      }
      if (x === y) {
        continue;
      }
      const xNum = /^\d+$/.test(x);
      const yNum = /^\d+$/.test(y);
      if (xNum && yNum) {
        return Number(x) > Number(y) ? 1 : -1;
      }
      if (xNum !== yNum) {
        return xNum ? -1 : 1;
      }
      return x > y ? 1 : -1;
    }
    return 0;
  }

  private static parse(version: string): { core: [number, number, number]; pre: string[] } | null {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
    if (!match) {
      return null;
    }
    return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : [] };
  }
}
