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

/** How an archive download is sent: its total limit, and an abort (a stall watchdog, a closed window). */
export type HubArchiveRequest = { timeoutMs?: number; signal?: AbortSignal };
export type HubUploadResult = Schemas['UploadResult'];
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

  /** A route of the generated `paths` with its `{param}`s filled in, each one encoded (the scope keeps its `@`), then `query`. */
  private static route(template: ApiPath, params: Record<string, string>, query = ''): FilledRoute {
    const filled = template.replace(/\{([a-z]+)\}/gi, (_match, key: string) => {
      const value = params[key];
      if (value === undefined) {
        throw new Error(`HubClient: no value for {${key}} in ${template}.`);
      }
      return encodeURIComponent(value).replace(/^%40/, '@');
    });
    return (filled + query) as FilledRoute;
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
