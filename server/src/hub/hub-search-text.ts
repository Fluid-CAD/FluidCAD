import { Semver } from '../packages/semver.ts';
import type { HubBridgeSearchResponse, HubBridgeSearchResult } from './hub-bridge.ts';

/** The engine a search asked about (the answer's echoed `request`: this engine's version and `SDK_VERSION`). */
type AskedEngine = Pick<HubBridgeSearchResponse['request'], 'engine' | 'sdk'>;

/**
 * `fluidcad search`'s terminal output (hub-plan H10, from the user's search
 * design of 2026-10-11). Each row:
 *
 * ```
 * @acme/feature-tests 0.1.1 · installed · pinned 0.1.0 · update available
 *   The custom-feature test bench: standoff, bolt circle, boss, fastener…
 *   Bolt circle, Boss, Fastener hole +2 · 5 features, 5 parts, 1 assembly · 0 likes · 0 installs · MIT
 * ```
 *
 * The marks: `installed` (the row's version is here; other versions are
 * named), `pinned` (with the version when it isn't the row's) and `update
 * available` from the engine's local marks; why this FluidCAD can't run it,
 * only when the hub says so (`compatible === false`): `needs FluidCAD X+`,
 * or `needs feature SDK N (this FluidCAD has M)` (see
 * {@link incompatible}); and `deprecated: <message>`. The footer pages:
 * `1–20 of 134 · --page 2 for more`, with `1,000+` when the hub capped the
 * count.
 */
export class HubSearchText {
  /** A description longer than this is cut, with an ellipsis. */
  static readonly DESCRIPTION_CHARS = 120;
  private static readonly NUMBER = new Intl.NumberFormat('en-US');

  /** Every line of the output, the footer last. */
  static lines(answer: HubBridgeSearchResponse): string[] {
    const lines: string[] = [];
    for (const row of answer.results) {
      lines.push(...HubSearchText.row(row, answer.request), '');
    }
    lines.push(HubSearchText.footer(answer));
    return lines;
  }

  /** One row's three lines (two when it has no description); `asked` is the engine the search named. */
  static row(row: HubBridgeSearchResult, asked: AskedEngine): string[] {
    const head = [`${row.fullName} ${row.version}`, ...HubSearchText.marks(row, asked)].join(' · ');
    const lines = [head];
    const description = HubSearchText.oneLine(row.description);
    if (description) {
      lines.push(`  ${description}`);
    }
    const facts = [
      HubSearchText.chips(row),
      HubSearchText.contents(row.counts),
      HubSearchText.count(row.likes, 'like'),
      HubSearchText.count(row.installs, 'install'),
      row.license ?? 'no license',
    ].filter((part): part is string => part !== null && part !== '');
    lines.push(`  ${facts.join(' · ')}`);
    return lines;
  }

  /** The marks after the name and version, in order; `asked` is the engine the search named. */
  static marks(row: HubBridgeSearchResult, asked: AskedEngine): string[] {
    const marks: string[] = [];
    const { installed, pinned, updateAvailable } = row.local;
    if (installed.length > 0) {
      const others = installed.filter((version) => version !== row.version);
      marks.push(installed.includes(row.version) && others.length === 0 ? 'installed' : `installed ${installed.join(', ')}`);
    }
    if (pinned) {
      marks.push(pinned === row.version ? 'pinned' : `pinned ${pinned}`);
    }
    if (updateAvailable) {
      marks.push('update available');
    }
    if (row.compatible === false) {
      marks.push(HubSearchText.incompatible(row, asked));
    }
    if (row.deprecated) {
      marks.push(`deprecated: ${HubSearchText.oneLine(row.deprecated)}`);
    }
    return marks;
  }

  /**
   * `1–20 of 134 · --page 2 for more`; `1–20 of 1,000+ · …` when capped;
   * `1–3 of 3` on the last page; "No packages match." when nothing does.
   */
  static footer(answer: HubBridgeSearchResponse): string {
    const total = answer.capped ? `${HubSearchText.NUMBER.format(answer.total)}+` : HubSearchText.NUMBER.format(answer.total);
    if (answer.total === 0) {
      return 'No packages match.';
    }
    if (answer.results.length === 0) {
      return `Nothing on page ${answer.page}: ${total} in all.`;
    }
    const first = (answer.page - 1) * answer.limit + 1;
    const last = first + answer.results.length - 1;
    const range = `${HubSearchText.NUMBER.format(first)}–${HubSearchText.NUMBER.format(last)} of ${total}`;
    return last < answer.total ? `${range} · --page ${answer.page + 1} for more` : range;
  }

  /**
   * Why the engine that asked can't run a row, by HD13's two rules in
   * order: `needs FluidCAD 0.0.99+` when the row's `minEngine` is above that
   * engine; else `needs feature SDK 2 (this FluidCAD has 1)` when the row's
   * `sdkVersion` isn't that engine's SDK. When neither explains it (the
   * echo lacks what the hub compared, the row's `minEngine` isn't a
   * version, or a hub older than the H10 follow-up sent no `sdkVersion`),
   * the mark names no reason: `not compatible with this FluidCAD`.
   */
  private static incompatible(row: HubBridgeSearchResult, asked: AskedEngine): string {
    const needed = Semver.parse(row.minEngine);
    const engine = Semver.parse(asked.engine);
    if (needed && engine && Semver.compare(needed, engine) > 0) {
      return `needs FluidCAD ${row.minEngine}+`;
    }
    if (asked.sdk !== null && typeof row.sdkVersion === 'number' && row.sdkVersion !== asked.sdk) {
      return `needs feature SDK ${row.sdkVersion} (this FluidCAD has ${asked.sdk})`;
    }
    return 'not compatible with this FluidCAD';
  }

  /** Up to three feature labels, then `+N` for the rest; null without features. */
  private static chips(row: HubBridgeSearchResult): string | null {
    if (row.features.length === 0) {
      return null;
    }
    const labels = row.features.map((chip) => chip.label).join(', ');
    return row.moreFeatures > 0 ? `${labels} +${row.moreFeatures}` : labels;
  }

  /** `5 features, 5 parts, 1 assembly`, leaving out what it has none of. */
  private static contents(counts: HubBridgeSearchResult['counts']): string | null {
    const parts = [
      counts.features > 0 ? HubSearchText.count(counts.features, 'feature') : null,
      counts.parts > 0 ? HubSearchText.count(counts.parts, 'part') : null,
      counts.assemblies > 0 ? HubSearchText.count(counts.assemblies, 'assembly', 'assemblies') : null,
    ].filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join(', ') : null;
  }

  private static count(value: number, one: string, many = `${one}s`): string {
    return `${HubSearchText.NUMBER.format(value)} ${value === 1 ? one : many}`;
  }

  /** Whitespace collapsed to single spaces, cut at {@link DESCRIPTION_CHARS}. */
  private static oneLine(text: string | null): string {
    const flat = (text ?? '').replace(/\s+/g, ' ').trim();
    if (flat.length <= HubSearchText.DESCRIPTION_CHARS) {
      return flat;
    }
    return `${flat.slice(0, HubSearchText.DESCRIPTION_CHARS - 1).trimEnd()}…`;
  }
}
