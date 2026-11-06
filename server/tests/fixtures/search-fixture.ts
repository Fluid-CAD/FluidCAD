/**
 * Hub `SearchResponse`s for the bridge's tests (hub-plan H10): the shapes
 * the real hub answers (`hub/contract/src/schemas/search.ts`, as
 * `hub-api.generated.ts` types them), built from a few fields. FakeHub
 * serves them as they are; it has no search logic of its own.
 */

export type SearchRowOptions = {
  fullName?: string;
  version?: string;
  description?: string | null;
  /** The hub that serves the icons and the card image. */
  origin: string;
  /** Labels of up to three chips (ids are the labels, lower-cased). */
  chips?: string[];
  moreFeatures?: number;
  counts?: { features: number; parts: number; assemblies: number };
  likes?: number;
  installs?: number;
  license?: string | null;
  deprecated?: string | null;
  minEngine?: string;
  /** The feature SDK the row's version was built for (1 by default). */
  sdkVersion?: number;
  compatible?: boolean | null;
  /** A screenshot id for the card image; null for none. */
  cardId?: string | null;
  avatarUrl?: string | null;
};

export class SearchFixture {
  static row(options: SearchRowOptions): Record<string, unknown> {
    const fullName = options.fullName ?? '@acme/kit';
    const version = options.version ?? '0.2.0';
    const slash = fullName.indexOf('/');
    const scope = fullName.slice(1, slash);
    const chips = options.chips ?? ['Standoff'];
    return {
      fullName,
      scope,
      name: fullName.slice(slash + 1),
      version,
      description: options.description === undefined ? 'A test kit' : options.description,
      cardImageUrl: options.cardId ? `${options.origin}/api/v1/packages/${fullName}/media/${options.cardId}` : null,
      features: chips.map((label) => ({
        id: label.toLowerCase().replace(/\s+/g, '-'),
        label,
        iconUrl: `${options.origin}/api/v1/packages/${fullName}/versions/${version}/files/${label.toLowerCase().replace(/\s+/g, '-')}.svg`,
      })),
      moreFeatures: options.moreFeatures ?? 0,
      counts: options.counts ?? { features: chips.length, parts: 0, assemblies: 0 },
      likes: options.likes ?? 0,
      installs: options.installs ?? 0,
      publisher: { handle: scope, avatarUrl: options.avatarUrl === undefined ? 'https://avatars.example.com/a.png' : options.avatarUrl },
      updatedAt: '2026-10-10T00:00:00.000Z',
      license: options.license === undefined ? 'MIT' : options.license,
      deprecated: options.deprecated ?? null,
      minEngine: options.minEngine ?? '0.0.46',
      sdkVersion: options.sdkVersion ?? 1,
      compatible: options.compatible === undefined ? true : options.compatible,
    };
  }

  /** A whole answer around `results`; `total` defaults to their count. */
  static answer(results: Record<string, unknown>[], options: { total?: number; capped?: boolean; page?: number; limit?: number } = {}): Record<string, unknown> {
    const page = options.page ?? 1;
    const limit = options.limit ?? 20;
    return {
      request: { q: '', words: [], scopes: [], contents: [], keywords: [], units: [], licenses: [], engine: '0.0.46', sdk: 1, compatible: true, sort: 'installs', page, limit },
      total: options.total ?? results.length,
      capped: options.capped ?? false,
      page,
      limit,
      results,
      facets: {
        contents: { features: results.length, parts: 0, assemblies: 0 },
        keywords: [{ value: 'pcb', count: 1 }],
        units: { metric: results.length, imperial: 0 },
        licenses: [{ value: 'MIT', label: 'MIT License', count: results.length }],
        compatible: { count: results.length },
      },
    };
  }
}
