import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';

/**
 * An in-process stand-in for the hub, so FluidCAD's tests never touch a
 * network (hub-plan "Tests never touch remote resources"). It mirrors the
 * real hub's shapes and error codes (`/Users/marwan/projects/hub/contract`):
 *
 * - `GET /api/v1`, `GET /api/v1/me` (bearer only), `POST /api/v1/cli/token`
 *   (camelCase body, PKCE S256, `invalid-grant` refusals),
 *   `DELETE /api/v1/me/tokens/current` (204, then 401 `unauthorized`);
 * - `GET /cli/authorize?…` redirects straight back to the loopback with a
 *   code, `state` and `request`, as an approving user would, or with
 *   `error=access_denied` when told to deny;
 * - `GET /cli/done?request=<id>` records the visit and answers a page.
 *
 * Tell it what to do next with {@link FakeHub.mode}: `approve` (default),
 * `deny`, `expire` (approves, then refuses the exchange as expired), `fail`
 * (approves, then the exchange answers 500), or `tamper-state` (approves
 * with a state the CLI never sent).
 */

export type FakeHubMode = 'approve' | 'deny' | 'expire' | 'fail' | 'tamper-state';

export type FakeHubUser = { id: string; handle: string | null; name: string; email: string };

type IssuedToken = { id: string; token: string; kind: 'cli' | 'personal'; scopes: string[]; user: FakeHubUser; revoked: boolean };

type Authorization = {
  id: string;
  challenge: string;
  redirectUri: string;
  state: string;
  code: string | null;
  collected: boolean;
  query: Record<string, string>;
};

export type FakeHubRequest = { method: string; path: string; headers: http.IncomingHttpHeaders; body: string };

export class FakeHub {
  static readonly CLIENT_ID = 'fluidcad-cli';
  static readonly DEFAULT_USER: FakeHubUser = {
    id: '6f0d1a52-3c55-4a8e-9a1e-6a1e2f0b7c11',
    handle: 'acme',
    name: 'acme',
    email: 'acme@example.com',
  };
  private static readonly TOKEN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

  mode: FakeHubMode = 'approve';
  /** How long `POST /cli/token` takes to answer. */
  exchangeDelayMs = 0;
  user: FakeHubUser = { ...FakeHub.DEFAULT_USER };
  /** Every request, in order. */
  readonly requests: FakeHubRequest[] = [];
  /** The `request` of every `/cli/done` visit. */
  readonly doneVisits: string[] = [];
  readonly authorizations = new Map<string, Authorization>();
  private readonly tokens = new Map<string, IssuedToken>();
  /** Statuses to answer the next requests to a path with, before answering for real. */
  private readonly failures = new Map<string, number[]>();
  private readonly server = http.createServer((req, res) => void this.handle(req, res));

  private constructor() {}

  static async start(): Promise<FakeHub> {
    const hub = new FakeHub();
    await new Promise<void>((resolve) => hub.server.listen(0, '127.0.0.1', () => resolve()));
    return hub;
  }

  /** `http://127.0.0.1:<port>`. */
  get origin(): string {
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** A token the hub would accept, as a personal token made on the web would be. */
  issueToken(options: { kind?: 'cli' | 'personal'; scopes?: string[]; user?: FakeHubUser } = {}): IssuedToken {
    const issued: IssuedToken = {
      id: crypto.randomUUID(),
      token: FakeHub.newToken(),
      kind: options.kind ?? 'personal',
      scopes: options.scopes ?? ['account', 'publish'],
      user: options.user ?? this.user,
      revoked: false,
    };
    this.tokens.set(issued.token, issued);
    return issued;
  }

  /** The token record for a token string, revoked or not. */
  tokenOf(token: string): IssuedToken | undefined {
    return this.tokens.get(token);
  }

  /** Answers the next `count` requests to `path` (e.g. `/api/v1`) with `status`. */
  failNext(path: string, status: number, count = 1): void {
    this.failures.set(path, [...(this.failures.get(path) ?? []), ...Array(count).fill(status)]);
  }

  requestsTo(path: string): FakeHubRequest[] {
    return this.requests.filter((request) => request.path === path);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.origin);
    const body = await FakeHub.readBody(req);
    this.requests.push({ method: req.method ?? 'GET', path: url.pathname, headers: req.headers, body });

    const queued = this.failures.get(url.pathname);
    if (queued && queued.length > 0) {
      const status = queued.shift()!;
      res.writeHead(status, { 'content-type': 'text/html' });
      res.end(`<html><body>${status}</body></html>`);
      return;
    }

    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case 'GET /api/v1':
        return FakeHub.json(res, 200, FakeHub.meta());
      case 'GET /api/v1/me':
        return this.me(req, res);
      case 'POST /api/v1/cli/token':
        if (this.exchangeDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.exchangeDelayMs));
        }
        return this.exchange(body, res);
      case 'DELETE /api/v1/me/tokens/current':
        return this.revokeCurrent(req, res);
      case 'GET /cli/authorize':
        return this.authorize(url, res);
      case 'GET /cli/done':
        this.doneVisits.push(url.searchParams.get('request') ?? '');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><title>Signed in</title><p>Done.</p>');
        return;
      default:
        return FakeHub.error(res, 404, 'not-found', 'No such route.');
    }
  }

  private me(req: http.IncomingMessage, res: http.ServerResponse): void {
    const token = this.bearer(req);
    if (!token) {
      return FakeHub.error(res, 401, 'unauthorized', 'This API token is not valid. Sign in again with `fluidcad login`.');
    }
    FakeHub.json(res, 200, {
      account: {
        id: token.user.id,
        handle: token.user.handle,
        name: token.user.name,
        email: token.user.email,
        emailVerified: true,
        githubLogin: null,
        image: null,
        role: 'user',
        canPublish: false,
        handleLocked: false,
        createdAt: '2026-10-10T00:00:00.000Z',
      },
      via: 'token',
      token: { id: token.id, kind: token.kind, scopes: token.scopes, suffix: token.token.slice(-4) },
    });
  }

  private revokeCurrent(req: http.IncomingMessage, res: http.ServerResponse): void {
    const token = this.bearer(req);
    if (!token) {
      return FakeHub.error(res, 401, 'unauthorized', 'This API token is not valid. Sign in again with `fluidcad login`.');
    }
    token.revoked = true;
    res.writeHead(204);
    res.end();
  }

  /** As an approving (or denying) user would: straight back to the loopback. */
  private authorize(url: URL, res: http.ServerResponse): void {
    const query = Object.fromEntries(url.searchParams);
    const redirectUri = query.redirect_uri ?? '';
    const valid =
      query.response_type === 'code' &&
      query.client_id === FakeHub.CLIENT_ID &&
      /^http:\/\/(127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}\/callback$/.test(redirectUri) &&
      query.code_challenge_method === 'S256' &&
      /^[A-Za-z0-9_-]{43}$/.test(query.code_challenge ?? '') &&
      (query.state ?? '') !== '';
    if (!valid) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('This sign-in link is not valid.');
      return;
    }
    const authorization: Authorization = {
      id: crypto.randomBytes(16).toString('base64url'),
      challenge: query.code_challenge,
      redirectUri,
      state: query.state,
      code: null,
      collected: false,
      query,
    };
    this.authorizations.set(authorization.id, authorization);
    const back = new URLSearchParams();
    if (this.mode === 'deny') {
      back.set('error', 'access_denied');
    } else {
      authorization.code = crypto.randomBytes(32).toString('base64url');
      back.set('code', authorization.code);
    }
    back.set('state', this.mode === 'tamper-state' ? `${query.state}x` : query.state);
    back.set('request', authorization.id);
    res.writeHead(302, { location: `${redirectUri}?${back}` });
    res.end();
  }

  private exchange(body: string, res: http.ServerResponse): void {
    let request: Record<string, string>;
    try {
      request = JSON.parse(body);
    } catch {
      return FakeHub.error(res, 400, 'bad-request', 'The body is not JSON.');
    }
    if (request.clientId !== FakeHub.CLIENT_ID) {
      return FakeHub.error(res, 400, 'invalid-grant', "This client can't exchange codes on this hub.");
    }
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(request.codeVerifier ?? '')) {
      return FakeHub.error(res, 400, 'invalid-grant', 'The code verifier is not valid.');
    }
    const authorization = [...this.authorizations.values()].find((a) => a.code !== null && a.code === request.code);
    if (!authorization) {
      return FakeHub.error(res, 400, 'invalid-grant', 'This code is not valid.');
    }
    if (this.mode === 'fail') {
      return FakeHub.error(res, 500, 'internal', 'Something went wrong on the hub.');
    }
    if (this.mode === 'expire') {
      return FakeHub.error(res, 400, 'invalid-grant', 'This sign-in request expired. Run `fluidcad login` again.');
    }
    if (authorization.collected) {
      return FakeHub.error(res, 400, 'invalid-grant', 'This code was already used. Run `fluidcad login` again.');
    }
    if (request.redirectUri !== authorization.redirectUri) {
      return FakeHub.error(res, 400, 'invalid-grant', "The redirect URI doesn't match the one this request was made with.");
    }
    const challenge = crypto.createHash('sha256').update(request.codeVerifier).digest('base64url');
    if (challenge !== authorization.challenge) {
      return FakeHub.error(res, 400, 'invalid-grant', "The code verifier doesn't match the code challenge.");
    }
    authorization.collected = true;
    const issued = this.issueToken({ kind: 'cli', scopes: ['publish'] });
    FakeHub.json(res, 200, {
      token: issued.token,
      tokenId: issued.id,
      user: { handle: issued.user.handle, name: issued.user.name, email: issued.user.email },
    });
  }

  private bearer(req: http.IncomingMessage): IssuedToken | null {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer (\S+)$/.exec(header);
    if (!match) {
      return null;
    }
    const token = this.tokens.get(match[1]);
    return token && !token.revoked ? token : null;
  }

  private static meta(): Record<string, unknown> {
    return {
      name: 'FluidCAD Hub',
      apiVersion: 'v1',
      openapi: '/api/v1/openapi.json',
      limits: {
        archiveBytes: 26214400,
        unpackedBytes: 104857600,
        entries: 2000,
        entryBytes: 26214400,
        readmeBytes: 524288,
        releaseNotesChars: 280,
        commentChars: 4000,
        listTitleChars: 60,
        versionsPerPackagePerDay: 20,
        screenshotsPerPackage: 6,
        screenshotBytes: 2097152,
        screenshotMaxSidePx: 2560,
        screenshotTypes: ['image/png', 'image/jpeg', 'image/webp'],
        openVersionsPerPackage: 1,
        draftDays: 30,
        manifestBytes: 1048576,
        modelsPerVersion: 50,
        paramsPerModel: 100,
        sourcesBytes: 5242880,
      },
    };
  }

  /** `fch_` + 43 base62 characters, the hub's `TokenRules.PATTERN`. */
  private static newToken(): string {
    const bytes = crypto.randomBytes(43);
    let body = '';
    for (const byte of bytes) {
      body += FakeHub.TOKEN_ALPHABET[byte % FakeHub.TOKEN_ALPHABET.length];
    }
    return `fch_${body}`;
  }

  private static json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private static error(res: http.ServerResponse, status: number, code: string, message: string): void {
    FakeHub.json(res, status, { error: { code, message } });
  }

  private static readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }
}
