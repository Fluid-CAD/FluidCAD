import type { components, paths } from './hub-api.generated.ts';
import { HubConfig } from './hub-config.ts';
import { HubRequestError } from './hub-request-error.ts';
import { HubTransport } from './hub-transport.ts';

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
type HubErrorBody = Schemas['ErrorBody'];

/** A route of the hub's API, without the `/api/v1` prefix the config adds. */
type WithoutApiPrefix<P> = P extends `/api/v1${infer Rest}` ? Rest : never;
type ApiPath = WithoutApiPrefix<keyof paths>;

export class HubClient {
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

  private requireToken(method: string): void {
    if (!this.token) {
      throw new Error(`HubClient.${method}() needs a token.`);
    }
  }

  private async json<T>(method: string, route: ApiPath, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    const response = await this.transport.send(this.config.api(route), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
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
