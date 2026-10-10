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
export type HubPackageStatus = Schemas['PackageStatus'];
export type HubVersionStatus = Schemas['VersionStatus'];
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
   * `GET /api/v1/packages/{scope}/{name}`: where publishing stands, for the
   * package's owner (or an admin). Null when the hub has no such package
   * for this account: the hub answers 404 alike whether it doesn't exist or
   * belongs to someone else.
   */
  async package(name: string): Promise<HubPackageStatus | null> {
    this.requireToken('package');
    return this.orNull(this.json<HubPackageStatus>('GET', HubClient.route('/packages/{scope}/{name}', HubClient.partsOf(name))));
  }

  /** `GET …/versions/{version}`: one version as its owner sees it; null when there is none. */
  async version(name: string, version: string): Promise<HubVersionStatus | null> {
    this.requireToken('version');
    const route = HubClient.route('/packages/{scope}/{name}/versions/{version}', { ...HubClient.partsOf(name), version });
    return this.orNull(this.json<HubVersionStatus>('GET', route));
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
    const route = HubClient.route('/packages/{scope}/{name}/versions/{version}', { ...HubClient.partsOf(name), version }, options.dryRun ? '?dryRun=1' : '');
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
    const route = HubClient.route('/packages/{scope}/{name}/versions/{version}', { ...HubClient.partsOf(name), version });
    await this.json<void>('DELETE', route);
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
    const headers: Record<string, string> = { ...raw?.headers };
    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }
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
