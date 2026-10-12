/**
 * A hub search as the app's Hub panel and `fluidcad search` ask for it
 * (hub-plan H10, from the user's search design of 2026-10-11), and the
 * hub's `GET /api/v1/search` parameters it becomes.
 *
 * The fields are the hub's own names: `q`, then the repeated `contents`,
 * `keyword`, `units` and `license`, then `sort`, `page` and `limit`. The
 * bridge validates none of their values: the hub does, and its 400 comes
 * back with its sentence. What the bridge adds is the engine:
 * - `engine` (this FluidCAD's version) and `sdk` (its `SDK_VERSION`) are
 *   always sent, so every row says whether this FluidCAD runs it;
 * - `compatible=true` is sent unless `includeIncompatible` is set:
 *   **compatible-only is the default**;
 * - no `sort` unless one was asked for, so the hub's default applies
 *   (`relevance` with words; without them `installs`, then `likes` from H13).
 */

export type HubSearchList = 'contents' | 'keyword' | 'units' | 'license';

export type HubSearchFields = {
  /** The words, with `@handle` for a publisher (`@acme standoff`); empty for none. */
  q: string;
  contents: string[];
  keyword: string[];
  units: string[];
  license: string[];
  /** `relevance`, `installs`, `likes`, `updated` or `newest`; null leaves it to the hub. */
  sort: string | null;
  /** As given (the hub refuses one that isn't a whole number from 1); null for the first page. */
  page: string | null;
  /** As given (at most 50; the hub clamps a larger one); null for the hub's 20. */
  limit: string | null;
  /** Also list packages this FluidCAD can't run (they come marked `compatible: false`). */
  includeIncompatible: boolean;
};

export class HubSearchQuery {
  /** The repeated parameters, in the order they are sent. */
  static readonly LISTS: readonly HubSearchList[] = ['contents', 'keyword', 'units', 'license'];
  /** The bridge's own parameter (the UI's "Works with my FluidCAD" turned off). */
  static readonly INCLUDE_INCOMPATIBLE = 'includeIncompatible';
  private static readonly YES: ReadonlySet<string> = new Set(['1', 'true', 'yes']);

  readonly fields: HubSearchFields;

  private constructor(fields: HubSearchFields) {
    this.fields = fields;
  }

  /** From fields (the CLI's flags); what is left out is the hub's default. */
  static from(fields: Partial<HubSearchFields> = {}): HubSearchQuery {
    return new HubSearchQuery({
      q: (fields.q ?? '').trim(),
      contents: HubSearchQuery.values(fields.contents),
      keyword: HubSearchQuery.values(fields.keyword),
      units: HubSearchQuery.values(fields.units),
      license: HubSearchQuery.values(fields.license),
      sort: HubSearchQuery.single(fields.sort),
      page: HubSearchQuery.single(fields.page),
      limit: HubSearchQuery.single(fields.limit),
      includeIncompatible: fields.includeIncompatible === true,
    });
  }

  /**
   * From the bridge's query string (`GET /api/hub/search?…`): the hub's
   * names, the lists as repeated keys, and `includeIncompatible=1`. Any
   * other parameter, `engine`, `sdk` and `compatible` included, is ignored:
   * the engine sends its own.
   */
  static fromParams(params: URLSearchParams): HubSearchQuery {
    const include = params.get(HubSearchQuery.INCLUDE_INCOMPATIBLE);
    return HubSearchQuery.from({
      q: params.get('q') ?? '',
      contents: params.getAll('contents'),
      keyword: params.getAll('keyword'),
      units: params.getAll('units'),
      license: params.getAll('license'),
      sort: params.get('sort'),
      page: params.get('page'),
      limit: params.get('limit'),
      includeIncompatible: include !== null && HubSearchQuery.YES.has(include.trim().toLowerCase()),
    });
  }

  /** `GET /api/v1/search`'s parameters for this engine: the fields, then `engine`, `sdk` and (by default) `compatible=true`. */
  hubParams(engine: string, sdk: number): URLSearchParams {
    const params = new URLSearchParams();
    const { fields } = this;
    if (fields.q !== '') {
      params.set('q', fields.q);
    }
    for (const list of HubSearchQuery.LISTS) {
      for (const value of fields[list]) {
        params.append(list, value);
      }
    }
    for (const key of ['sort', 'page', 'limit'] as const) {
      const value = fields[key];
      if (value !== null) {
        params.set(key, value);
      }
    }
    params.set('engine', engine);
    params.set('sdk', String(sdk));
    if (!fields.includeIncompatible) {
      params.set('compatible', 'true');
    }
    return params;
  }

  /** Trimmed, blank values dropped, first spelling of each kept. */
  private static values(list: readonly string[] | undefined): string[] {
    const seen: string[] = [];
    for (const raw of list ?? []) {
      const value = raw.trim();
      if (value !== '' && !seen.includes(value)) {
        seen.push(value);
      }
    }
    return seen;
  }

  private static single(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  }
}
