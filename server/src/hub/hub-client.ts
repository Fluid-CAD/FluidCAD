import type { components, paths } from './hub-api.generated.ts';
import { HubConfig } from './hub-config.ts';
import { HubRequestError } from './hub-request-error.ts';
import { HubTransport, type HubTransportRequest } from './hub-transport.ts';

/**
 * The hub's `/api/v1`, typed from `hub-api.generated.ts` (HD17; regenerate
 * with `npm run hub:types`). Each method is one route; a refusal is thrown
 * as a {@link HubRequestError} with the hub's status, code and sentence.
 */

type Schemas = components['schemas'];

export type HubMeta = Schemas['Meta'];
export type HubMe = Schemas['Me'];
export type HubCliTokenRequest = Schemas['CliTokenRequest'];
export type HubCliTokenResponse = Schemas['CliTokenResponse'];
export type HubLimits = Schemas['HubLimits'];
/**
 * `GET /packages/{scope}/{name}`: the package as its reader may see it
 * (`access`). The owner's publishing fields (`openVersion`,
 * `rejectedVersion`, …) are there for everyone, null for the public.
 */
export type HubPackageDetail = Schemas['PackageDetail'];
/** What `fluidcad publish` reads of {@link HubPackageDetail}: the same route, as its owner. */
export type HubPackageStatus = HubPackageDetail;
export type HubVersionStatus = Schemas['VersionStatus'];
/** `GET …/versions/{version}`: one version with its manifest and entries, a superset of {@link HubVersionStatus}. */
export type HubVersionDetail = Schemas['VersionDetail'];
export type HubVersionSummary = Schemas['VersionSummary'];

/** `?engine=&sdk=`: the engine a version would run on, so the hub says which versions it can run. */
export type HubEngineOffer = { engine?: string | null; sdk?: number | null };

/**
 * `GET /search`: one page of listed packages with the facets, the same for
 * every caller (the hub reads no token there). Install marks are the
 * engine's to add (`HubBridge`), never the hub's.
 */
export type HubSearchResponse = Schemas['SearchResponse'];
export type HubSearchResult = Schemas['SearchResult'];

/** How a file or screenshot read is sent: the caller's abort (a closed page). */
export type HubFileRequest = { signal?: AbortSignal };

/** How an archive download is sent: its total limit, and an abort (a stall watchdog, a closed window). */
export type HubArchiveRequest = { timeoutMs?: number; signal?: AbortSignal };
export type HubUploadResult = Schemas['UploadResult'];
/** `POST …/versions/{version}/yank` and `…/unyank` (H12): the version's yank and what installs by name get now. */
export type HubYankResult = Schemas['YankResult'];
/** The package's listing as its owner edits it: license, links, deprecation, screenshots. */
export type HubPackageListing = Schemas['PackageListing'];
/** `PATCH /packages/{scope}/{name}`: listing fields and the deprecation; null clears one. */
export type HubPackageEdit = Schemas['EditPackageRequest'];
/** `PATCH …/versions/{version}`: an open version's notes and license. */
export type HubVersionEdit = Schemas['EditVersionRequest'];
export type HubMedia = Schemas['Media'];
export type HubMediaList = Schemas['MediaList'];
/** `PUT`/`DELETE …/like` (H13): whether the token's account likes the package now, and its count after the change. */
export type HubLikeState = Schemas['LikeState'];
/** `GET …/me` (H13): what only the token's account sees about a package (liked, its lists, its Helpful marks). */
export type HubPackageSocialState = Schemas['PackageSocialState'];
/** `PATCH …/media/{id}`: a caption, a place in the order, or the card image. */
export type HubMediaEdit = Schemas['EditMediaRequest'];
/** A screenshot to add: its bytes, its type (the hub checks the bytes agree), and what the tile says. */
export type HubMediaUpload = { bytes: Uint8Array; contentType: string; fileName?: string; caption?: string };
type HubErrorBody = Schemas['ErrorBody'];

/** What an upload sends beside the archive (the hub's `PublishRules`). */
export type HubUploadOptions = {
  /** The archive's size: sent as `Content-Length`, which the hub requires. */
  size: number;
  /** The client's tree hash (`sha256-…`); the hub refuses an archive whose own differs. */
  integrity: string;
  /** Release notes; else the hub takes the CHANGELOG section for the version. */
  notes?: string | null;
  /** Validate everything and answer as an upload would, storing nothing. */
  dryRun?: boolean;
  /** The bytes sent so far, as the request takes them. */
  onProgress?: (sent: number) => void;
};

/** A route of the hub's API, without the `/api/v1` prefix the config adds. */
type WithoutApiPrefix<P> = P extends `/api/v1${infer Rest}` ? Rest : never;
type ApiPath = WithoutApiPrefix<keyof paths>;
/** An {@link ApiPath} with its parameters filled in by {@link HubClient.route}, so routes stay checked against `paths`. */
type FilledRoute = string & { readonly filledFrom: ApiPath };

export class HubClient {
  /** The upload's `Content-Type` (`PublishRules.CONTENT_TYPE`). */
  static readonly PACKAGE_TYPE = 'application/vnd.fluidcad.package+zip';
  static readonly INTEGRITY_HEADER = 'x-fluidcad-integrity';
  static readonly NOTES_HEADER = 'x-fluidcad-release-notes';
  /** An upload's total limit (hub-plan H6). The stall watchdog ends one that stops moving long before. */
  static readonly UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

  readonly config: HubConfig;
  readonly transport: HubTransport;
  private readonly token: string | null;

  constructor(config: HubConfig, transport: HubTransport, token: string | null = null) {
    this.config = config;
    this.transport = transport;
    this.token = token;
  }

  /** True when requests carry a token (signed in, or `FLUIDCAD_HUB_TOKEN`). */
  get hasToken(): boolean {
    return this.token !== null && this.token !== '';
  }

  /** The same hub and transport, sending `token`. */
  withToken(token: string | null): HubClient {
    return new HubClient(this.config, this.transport, token);
  }

  /** `GET /api/v1`: what this hub is, and its limits. */
  async meta(): Promise<HubMeta> {
    return this.json<HubMeta>('GET', '');
  }

  /** `GET /api/v1/me`: the account behind the token, and the token itself (`via: token`). */
  async me(): Promise<HubMe> {
    this.requireToken('me');
    return this.json<HubMe>('GET', '/me');
  }

  /** `POST /api/v1/cli/token`: trades a sign-in code and its PKCE verifier for a `cli` token. */
  async exchangeCliCode(request: HubCliTokenRequest): Promise<HubCliTokenResponse> {
    return this.json<HubCliTokenResponse>('POST', '/cli/token', request);
  }

  /** `DELETE /api/v1/me/tokens/current`: revokes the token this client sends. 401 when it is already revoked. */
  async revokeCurrentToken(): Promise<void> {
    this.requireToken('revokeCurrentToken');
    await this.json<void>('DELETE', '/me/tokens/current');
  }

  /**
   * `GET /api/v1/packages/{scope}/{name}[?engine=&sdk=]`: the package, its
   * latest version and its versions, plus where publishing stands for its
   * owner (or an admin), who also see open and rejected versions. With an
   * engine, `compatibility` says which version that engine should install.
   * Null when this reader can see no such package: the hub answers 404 alike
   * whether it doesn't exist or has nothing published this reader may see.
   * Anonymous when the client has no token.
   */
  async package(name: string, offer: HubEngineOffer = {}): Promise<HubPackageDetail | null> {
    const query = new URLSearchParams();
    if (offer.engine) {
      query.set('engine', offer.engine);
    }
    if (offer.sdk !== undefined && offer.sdk !== null) {
      query.set('sdk', String(offer.sdk));
    }
    const search = query.size > 0 ? `?${query}` : '';
    return this.orNull(this.json<HubPackageDetail>('GET', HubClient.route('/packages/{scope}/{name}', HubClient.partsOf(name), search)));
  }

  /**
   * `GET …/versions/{version}`: one version with its manifest, entries and
   * state; null when this reader can see none (unknown, or unpublished and
   * not theirs). A version the admins removed is thrown: 410
   * `version-removed`, with `details.reason`.
   */
  async version(name: string, version: string): Promise<HubVersionDetail | null> {
    return this.orNull(this.json<HubVersionDetail>('GET', HubClient.versionRoute(name, version)));
  }

  /**
   * `GET …/versions/{version}/archive`: the `.fluidpkg` as a streaming
   * response, with its `Content-Length` and the hub's tree hash in
   * `x-fluidcad-integrity`. The caller reads (and meters) the body; a
   * refusal (404, 410 `version-removed`, 429 `rate-limited`) is thrown
   * before any body is read. The token goes along when there is one, so
   * the owner and admins can download an unpublished version.
   */
  async archive(name: string, version: string, request: HubArchiveRequest = {}): Promise<Response> {
    const route = HubClient.route('/packages/{scope}/{name}/versions/{version}/archive', { ...HubClient.partsOf(name), version });
    const response = await this.transport.send(this.config.api(route), {
      method: 'GET',
      headers: { ...this.authorization(), accept: `${HubClient.PACKAGE_TYPE}, application/json` },
      timeoutMs: request.timeoutMs,
      signal: request.signal,
    });
    if (response.ok) {
      return response;
    }
    throw this.errorOf(response, HubClient.parse(await response.text()));
  }

  /**
   * `GET /search?…`: `query` as the hub names its parameters (repeated keys
   * for the lists). Always anonymous: the answer depends on nothing but the
   * query, so a token would only travel for nothing.
   */
  async search(query: URLSearchParams, request: HubFileRequest = {}): Promise<HubSearchResponse> {
    const search = query.size > 0 ? `?${query}` : '';
    return this.anonymous().json<HubSearchResponse>('GET', HubClient.route('/search', {}, search), undefined, { signal: request.signal });
  }

  /**
   * `GET …/versions/{version}/files/{path}`: one file from inside a
   * version's archive, as the hub serves it (its safe type, its
   * `Cache-Control`: immutable for a published version, `private, no-store`
   * for the owner's unpublished one). `path` may hold `/`; each segment is
   * encoded on its own. A refusal is thrown before any body is read.
   */
  async file(name: string, version: string, path: string, request: HubFileRequest = {}): Promise<Response> {
    return this.raw(HubClient.fileRoute(name, version, path), request);
  }

  /**
   * `GET /packages/{scope}/{name}/media/{id}`: a screenshot (a search row's
   * card image), immutable once the package is public. A refusal is thrown
   * before any body is read.
   */
  async media(name: string, id: string, request: HubFileRequest = {}): Promise<Response> {
    return this.raw(HubClient.mediaRoute(name, id), request);
  }

  /** The route {@link file} reads (without `/api/v1`): what a cache keys it by, with the hub's `api()`. */
  static fileRoute(name: string, version: string, path: string): string {
    return HubClient.route('/packages/{scope}/{name}/versions/{version}/files/{path}', { ...HubClient.partsOf(name), version, path });
  }

  /** The route {@link media} reads (without `/api/v1`). */
  static mediaRoute(name: string, id: string): string {
    return HubClient.route('/packages/{scope}/{name}/media/{id}', { ...HubClient.partsOf(name), id });
  }

  /**
   * `PUT …/versions/{version}`: uploads the archive in one streamed request
   * (`duplex: 'half'`), with an explicit `Content-Length`, a 10-minute total
   * limit and the transport's stall watchdog. Never retried.
   */
  async uploadVersion(name: string, version: string, body: ReadableStream<Uint8Array>, options: HubUploadOptions): Promise<HubUploadResult> {
    this.requireToken('uploadVersion');
    const headers: Record<string, string> = {
      'content-type': HubClient.PACKAGE_TYPE,
      'content-length': String(options.size),
      [HubClient.INTEGRITY_HEADER]: options.integrity,
    };
    if (options.notes) {
      headers[HubClient.NOTES_HEADER] = encodeURIComponent(options.notes);
    }
    const route = HubClient.versionRoute(name, version, options.dryRun ? '?dryRun=1' : '');
    return this.json<HubUploadResult>('PUT', route, undefined, {
      headers,
      body,
      timeoutMs: HubClient.UPLOAD_TIMEOUT_MS,
      onBodyProgress: options.onProgress,
    });
  }

  /** `DELETE …/versions/{version}`: withdraws a draft or in-review version (the hub deletes it). */
  async withdraw(name: string, version: string): Promise<void> {
    this.requireToken('withdraw');
    await this.json<void>('DELETE', HubClient.versionRoute(name, version));
  }

  // The owner's lifecycle and listing edits (H12)

  /** `POST …/versions/{version}/yank`: hides a published version from latest, search and installs by name. */
  async yank(name: string, version: string, reason: string): Promise<HubYankResult> {
    this.requireToken('yank');
    const route = HubClient.route('/packages/{scope}/{name}/versions/{version}/yank', { ...HubClient.partsOf(name), version });
    return this.json<HubYankResult>('POST', route, { reason });
  }

  /** `POST …/versions/{version}/unyank`: brings a yanked version back. */
  async unyank(name: string, version: string): Promise<HubYankResult> {
    this.requireToken('unyank');
    const route = HubClient.route('/packages/{scope}/{name}/versions/{version}/unyank', { ...HubClient.partsOf(name), version });
    return this.json<HubYankResult>('POST', route);
  }

  /** `PATCH /packages/{scope}/{name}`: the license, links and deprecation (null clears one); answers the listing. */
  async editPackage(name: string, change: HubPackageEdit): Promise<HubPackageListing> {
    this.requireToken('editPackage');
    return this.json<HubPackageListing>('PATCH', HubClient.route('/packages/{scope}/{name}', HubClient.partsOf(name)), change);
  }

  /** `PATCH …/versions/{version}`: an open version's release notes and license. */
  async editVersion(name: string, version: string, change: HubVersionEdit): Promise<HubVersionStatus> {
    this.requireToken('editVersion');
    return this.json<HubVersionStatus>('PATCH', HubClient.versionRoute(name, version), change);
  }

  /** `GET /packages/{scope}/{name}/media`: the screenshots in order (the owner sees an unpublished package's). */
  async mediaList(name: string): Promise<HubMediaList> {
    return this.json<HubMediaList>('GET', HubClient.route('/packages/{scope}/{name}/media', HubClient.partsOf(name)));
  }

  /**
   * `POST /packages/{scope}/{name}/media`: adds a screenshot, the raw image
   * with its `Content-Type` and an explicit `Content-Length` (the hub checks
   * both, then the bytes, before it keeps anything).
   */
  async addMedia(name: string, upload: HubMediaUpload): Promise<HubMedia> {
    this.requireToken('addMedia');
    const query = new URLSearchParams();
    if (upload.fileName) {
      query.set('fileName', upload.fileName);
    }
    if (upload.caption) {
      query.set('caption', upload.caption);
    }
    const route = HubClient.route('/packages/{scope}/{name}/media', HubClient.partsOf(name), query.size > 0 ? `?${query}` : '');
    const body = new Blob([new Uint8Array(upload.bytes)]).stream() as ReadableStream<Uint8Array>;
    return this.json<HubMedia>('POST', route, undefined, {
      headers: { 'content-type': upload.contentType, 'content-length': String(upload.bytes.length) },
      body,
    });
  }

  /** `PATCH /packages/{scope}/{name}/media/{id}`. */
  async editMedia(name: string, id: string, change: HubMediaEdit): Promise<HubMedia> {
    this.requireToken('editMedia');
    return this.json<HubMedia>('PATCH', HubClient.route('/packages/{scope}/{name}/media/{id}', { ...HubClient.partsOf(name), id }), change);
  }

  /** `DELETE /packages/{scope}/{name}/media/{id}`. */
  async deleteMedia(name: string, id: string): Promise<void> {
    this.requireToken('deleteMedia');
    await this.json<void>('DELETE', HubClient.route('/packages/{scope}/{name}/media/{id}', { ...HubClient.partsOf(name), id }));
  }

  // The signed-in account's own state on a package (H13)

  /**
   * `PUT …/like` (`liked`) or `DELETE …/like`: idempotent, answers whether
   * the account likes it now and the package's count after the change.
   * Needs a token with the `social` scope: a CLI sign-in older than it is
   * refused 403 with `details.signInAgain`.
   */
  async setLiked(name: string, liked: boolean): Promise<HubLikeState> {
    this.requireToken('setLiked');
    return this.json<HubLikeState>(liked ? 'PUT' : 'DELETE', HubClient.route('/packages/{scope}/{name}/like', HubClient.partsOf(name)));
  }

  /** `GET …/me`: whether the account likes the package, its lists and its Helpful marks (`private, no-store`). */
  async socialState(name: string): Promise<HubPackageSocialState> {
    this.requireToken('socialState');
    return this.json<HubPackageSocialState>('GET', HubClient.route('/packages/{scope}/{name}/me', HubClient.partsOf(name)));
  }

  private static versionRoute(name: string, version: string, query = ''): FilledRoute {
    return HubClient.route('/packages/{scope}/{name}/versions/{version}', { ...HubClient.partsOf(name), version }, query);
  }

  /** `@acme/gears` → `{ scope: '@acme', name: 'gears' }`, the hub's path parameters. */
  private static partsOf(name: string): { scope: string; name: string } {
    const slash = name.indexOf('/');
    if (!name.startsWith('@') || slash < 2 || slash === name.length - 1) {
      throw new Error(`HubClient: ${JSON.stringify(name)} is not a package name.`);
    }
    return { scope: name.slice(0, slash), name: name.slice(slash + 1) };
  }

  /**
   * A route of the generated `paths` with its `{param}`s filled in, each one
   * encoded (the scope keeps its `@`), then `query`. `{path}` (a file inside
   * an archive) keeps its `/`s: each of its segments is encoded alone, and
   * an empty, `.` or `..` segment is refused, so a file path can never climb
   * to another route.
   */
  private static route(template: ApiPath, params: Record<string, string>, query = ''): FilledRoute {
    const filled = template.replace(/\{([a-z]+)\}/gi, (_match, key: string) => {
      const value = params[key];
      if (value === undefined) {
        throw new Error(`HubClient: no value for {${key}} in ${template}.`);
      }
      if (key === 'path') {
        return HubClient.segments(value);
      }
      return encodeURIComponent(value).replace(/^%40/, '@');
    });
    return (filled + query) as FilledRoute;
  }

  /** `features/standoff.svg` → each segment encoded, the `/`s kept; a segment that is empty, `.` or `..` is refused. */
  private static segments(path: string): string {
    const parts = path.split('/');
    if (parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('\\'))) {
      throw new Error(`HubClient: ${JSON.stringify(path)} is not a file path inside an archive.`);
    }
    return parts.map((part) => encodeURIComponent(part)).join('/');
  }

  /** The same hub and transport, sending no token. */
  private anonymous(): HubClient {
    return this.token ? this.withToken(null) : this;
  }

  /** A GET whose body the caller reads (a file, an image); a refusal is thrown before any body is read. */
  private async raw(route: string, request: HubFileRequest): Promise<Response> {
    const response = await this.transport.send(this.config.api(route), {
      method: 'GET',
      headers: { ...this.authorization(), accept: '*/*' },
      signal: request.signal,
    });
    if (response.ok) {
      return response;
    }
    throw this.errorOf(response, HubClient.parse(await response.text()));
  }

  /** The hub's 404 `not-found` as null; any other refusal is thrown. */
  private async orNull<T>(request: Promise<T>): Promise<T | null> {
    try {
      return await request;
    } catch (err) {
      if (err instanceof HubRequestError && err.status === 404 && err.code === 'not-found') {
        return null;
      }
      throw err;
    }
  }

  private requireToken(method: string): void {
    if (!this.token) {
      throw new Error(`HubClient.${method}() needs a token.`);
    }
  }

  /**
   * One request whose answer is JSON. `body` is sent as JSON; `raw` sends
   * its own body and headers instead (an upload).
   */
  private async json<T>(method: string, route: ApiPath | FilledRoute, body?: unknown, raw?: HubTransportRequest): Promise<T> {
    const headers: Record<string, string> = { ...raw?.headers, ...this.authorization() };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    const response = await this.transport.send(this.config.api(route), {
      ...raw,
      method,
      headers,
      body: body === undefined ? raw?.body : JSON.stringify(body),
    });
    if (response.status === 204) {
      return undefined as T;
    }
    const text = await response.text();
    const parsed = HubClient.parse(text);
    if (response.ok && parsed !== undefined) {
      return parsed as T;
    }
    throw this.errorOf(response, parsed);
  }

  /** The bearer header, when the client has a token. */
  private authorization(): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }

  /** The hub's `{ error: { code, message, details? } }`, or `unexpected-response` for anything else. */
  private errorOf(response: Response, parsed: unknown): HubRequestError {
    const error = (parsed as HubErrorBody | undefined)?.error;
    if (error && typeof error.code === 'string' && typeof error.message === 'string') {
      return new HubRequestError(response.status, error.code, error.message, { details: error.details });
    }
    const what = response.ok ? 'an answer that is not JSON' : `HTTP ${response.status}`;
    return new HubRequestError(response.status, HubRequestError.UNEXPECTED, `${this.config.origin} answered with ${what}.`);
  }

  private static parse(text: string): unknown {
    if (text === '') {
      return undefined;
    }
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }
}
