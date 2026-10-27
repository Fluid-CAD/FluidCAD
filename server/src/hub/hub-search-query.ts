/**
 * A hub search as the app's Hub panel and `fluidcad search` ask for it
 * (hub-plan H10, from the user's search design of 2026-10-11, changed by
 * the user's decisions on the H11 mock, 2026-10-12), and the hub's
 * `GET /api/v1/search` parameters it becomes.
 *
 * The fields are the hub's own names: `q`, then the repeated `contents`,
 * `units` and `license`, then `sort`, `order`, `page` and `limit`. The
 * bridge validates none of their values: the hub does, and its 400 comes
 * back with its sentence.
 *
 * *(2026-10-12, user: keywords only feed search matching)* No `keyword`
 * filter is sent, whoever asks for one: a package's keywords count only
 * where the hub matches the typed words against them. The hub keeps its
 * `keyword` parameter and facet, which FluidCAD doesn't use.
 *
 * What the bridge adds is the engine:
 * - `engine` (this FluidCAD's version) and `sdk` (its `SDK_VERSION`) are
 *   always sent, so every row says whether this FluidCAD runs it;
 * - **every package is listed** (H11 decision 2): no `compatible` filter is
 *   sent, and a row this FluidCAD can't run comes marked
 *   `compatible: false`;
 * - no `sort` or `order` unless asked for, so the hub's defaults apply
 *   (`relevance` with words; without them `installs`, then `likes` from
 *   H13; each sort in its own direction, and Best match in its only one).
 */

export type HubSearchList = 'contents' | 'units' | 'license';

export type HubSearchFields = {
  /** The words, with `@handle` for a publisher (`@acme standoff`); empty for none. */
  q: string;
  contents: string[];
  units: string[];
  license: string[];
  /** `relevance`, `installs`, `likes`, `updated` or `newest`; null leaves it to the hub. */
  sort: string | null;
  /** `asc` or `desc`; null leaves it to the hub (each sort's own direction; Best match has only one). */
  order: string | null;
  /** As given (the hub refuses one that isn't a whole number from 1); null for the first page. */
  page: string | null;
  /** As given (at most 50; the hub clamps a larger one); null for the hub's 20. */
  limit: string | null;
};

export class HubSearchQuery {
  /** The repeated parameters, in the order they are sent. */
  static readonly LISTS: readonly HubSearchList[] = ['contents', 'units', 'license'];
  /** The single-valued parameters, in the order they are sent. */
  static readonly SINGLES = ['sort', 'order', 'page', 'limit'] as const;

  readonly fields: HubSearchFields;

  private constructor(fields: HubSearchFields) {
    this.fields = fields;
  }

  /** From fields (the CLI's flags); what is left out is the hub's default. */
  static from(fields: Partial<HubSearchFields> = {}): HubSearchQuery {
    return new HubSearchQuery({
      q: (fields.q ?? '').trim(),
      contents: HubSearchQuery.values(fields.contents),
      units: HubSearchQuery.values(fields.units),
      license: HubSearchQuery.values(fields.license),
      sort: HubSearchQuery.single(fields.sort),
      order: HubSearchQuery.single(fields.order),
      page: HubSearchQuery.single(fields.page),
      limit: HubSearchQuery.single(fields.limit),
    });
  }

  /**
   * From the bridge's query string (`GET /api/hub/search?…`): the hub's
   * names, the lists as repeated keys. Any other parameter (`engine`, `sdk`,
   * `compatible` and `keyword` included) is ignored: the engine sends its
   * own, lists every package and filters by no keyword.
   */
  static fromParams(params: URLSearchParams): HubSearchQuery {
    return HubSearchQuery.from({
      q: params.get('q') ?? '',
      contents: params.getAll('contents'),
      units: params.getAll('units'),
      license: params.getAll('license'),
      sort: params.get('sort'),
      order: params.get('order'),
      page: params.get('page'),
      limit: params.get('limit'),
    });
  }

  /** `GET /api/v1/search`'s parameters for this engine: the fields, then `engine` and `sdk`. */
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
    for (const key of HubSearchQuery.SINGLES) {
      const value = fields[key];
      if (value !== null) {
        params.set(key, value);
      }
    }
    params.set('engine', engine);
    params.set('sdk', String(sdk));
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
