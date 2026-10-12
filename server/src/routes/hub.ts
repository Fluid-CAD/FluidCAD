import { Router, type Request, type Response } from 'express';
import { loadPreferences } from '../preferences.ts';
import { PackageArchiveError } from '../packages/package-archive.ts';
import { PackageRoots, type PackageTarget } from '../packages/package-roots.ts';
import { HubAppLogin } from '../hub/hub-app-login.ts';
import { HubBridge, HubBridgeError, type HubProxiedFile } from '../hub/hub-bridge.ts';
import { HubClient } from '../hub/hub-client.ts';
import { HubConfigError } from '../hub/hub-config.ts';
import type { HubFileCache } from '../hub/hub-file-cache.ts';
import { HubInstallError } from '../hub/hub-install-error.ts';
import { HubLogout } from '../hub/hub-logout.ts';
import { HubRequestError } from '../hub/hub-request-error.ts';
import { HubSearchQuery } from '../hub/hub-search-query.ts';
import { HubTransport } from '../hub/hub-transport.ts';

export type HubRouterOptions = {
  /** The open project; empty when the server runs without one (no project marks, no project target). */
  workspacePath: string;
  /** This engine's FluidCAD version: what every search and download asks about. */
  engineVersion: string;
  /** This engine's `SDK_VERSION`; defaults to the lib's. */
  sdkVersion?: number;
  /** Where the hub URL and the token are read; defaults to `process.env` (tests pass their own). */
  env?: NodeJS.ProcessEnv;
  /** Tests: a transport that doesn't wait between retries. */
  transport?: HubTransport;
  /** Defaults to `$FLUIDCAD_HOME/cache/hub`. */
  cache?: HubFileCache;
  /** Tests: how long a sign-in waits for the browser (defaults to the hub request's five minutes). */
  loginTimeoutMs?: number;
  /** Tests: the sign-in the routes drive, to stop one left waiting. */
  onLogin?: (login: HubAppLogin) => void;
};

/**
 * The hub bridge (hub-plan H10, HD15): everything the app's Hub panel
 * needs from the hub, through the engine, since the UI never calls the hub
 * itself. `HubBridge` holds the rules; these routes are its HTTP face.
 *
 * - `GET /api/hub/status` → `{ hubUrl, reachable, signedIn: { handle } | null, engine, sdk }`.
 * - `GET /api/hub/search?q=&contents=&units=&license=&sort=&order=&page=&limit=`:
 *   the hub's `SearchResponse` for this engine (every package; one this
 *   FluidCAD can't run comes `compatible: false`), each row with `local`
 *   marks, its images on the proxy paths and no avatar.
 *   `Cache-Control: no-store`: the marks change with every install.
 * - `GET /api/hub/packages/@scope/name`: the detail, with `local` and the
 *   proxy paths.
 * - `GET /api/hub/packages/@scope/name/versions/<version>`: one version's
 *   manifest (its features' metadata with every image on the file proxy),
 *   notes and README path, for the Hub panel's Features and Readme tabs.
 * - `GET /api/hub/files/@scope/name/<version>/<path…>` and
 *   `GET /api/hub/media/@scope/name/<id>`: a version's file and a
 *   screenshot, through the disk cache (`$FLUIDCAD_HOME/cache/hub`), with
 *   the hub's type and the policy that keeps an SVG inert.
 * - `POST /api/hub/inspect { name, version?, target? }`: download, verify
 *   and inspect; answers the `PackageInspection` the consent dialog shows
 *   (plus `notes` and `source`), whose token `POST /api/packages/install`
 *   takes. `target` defaults to the "New packages go to" setting.
 * - `POST /api/hub/login` (a JSON body, `{}`), `GET /api/hub/login`,
 *   `DELETE /api/hub/login`: signing in from the app (`HubAppLogin`). The
 *   POST answers `{ login, resumed }` with the page to open in the browser
 *   (the one already waiting when there is one); the GET answers
 *   `{ login }`, the sign-in waiting or last ended (null for none), which
 *   the page follows until it is `signed-in`, `denied`, `expired`,
 *   `cancelled` or `failed`; the DELETE cancels the waiting one. The
 *   credentials go where `fluidcad login` writes them, and
 *   `GET /api/hub/status` reads them.
 * - `POST /api/hub/logout` (a JSON body, `{}`): signing out from the app,
 *   `fluidcad logout`'s own `HubLogout`: the saved token is revoked on the
 *   hub, then forgotten. Answers `{ logout }` (`HubLogoutResult`) whatever
 *   the hub said: `revoked`, `already-revoked`, `not-revoked` (forgotten
 *   here, but the hub couldn't be reached or refused, with why) or
 *   `not-signed-in`, and whether `FLUIDCAD_HUB_TOKEN` still signs requests.
 *
 * Refusals answer `{ error: <sentence>, code, details? }`: the hub can't be
 * reached (or fails on its side) → 503 `hub-unreachable`; the hub's own
 * refusals keep their status and code (a 400 keeps its sentence).
 */
export function createHubRouter(options: HubRouterOptions): Router {
  const router = Router();
  const project = options.workspacePath || null;
  const bridge = new HubBridge({
    project,
    engineVersion: options.engineVersion,
    sdkVersion: options.sdkVersion,
    env: options.env,
    client: 'app',
    transport: options.transport,
    cache: options.cache,
  });
  const login = new HubAppLogin({
    config: () => bridge.config(),
    version: options.engineVersion,
    transport: options.transport,
    timeoutMs: options.loginTimeoutMs,
  });
  options.onLogin?.(login);

  router.get('/hub/status', async (_req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await bridge.status());
    } catch (err) {
      HubRefusal.send(res, err, bridge);
    }
  });

  router.get('/hub/search', async (req, res) => {
    const abort = HubRoutes.abortOnClose(res);
    try {
      const query = HubSearchQuery.fromParams(HubRoutes.params(req));
      const answer = await bridge.search(query, { signal: abort.signal });
      res.setHeader('Cache-Control', 'no-store');
      res.json(answer);
    } catch (err) {
      HubRefusal.send(res, err, bridge);
    }
  });

  router.get('/hub/packages/:scope/:name', async (req, res) => {
    try {
      const answer = await bridge.package(`${req.params.scope}/${req.params.name}`);
      res.setHeader('Cache-Control', 'no-store');
      res.json(answer);
    } catch (err) {
      HubRefusal.send(res, err, bridge);
    }
  });

  router.get('/hub/packages/:scope/:name/versions/:version', async (req, res) => {
    try {
      const answer = await bridge.version(`${req.params.scope}/${req.params.name}`, req.params.version);
      res.setHeader('Cache-Control', 'no-store');
      res.json(answer);
    } catch (err) {
      HubRefusal.send(res, err, bridge);
    }
  });

  router.get('/hub/files/:scope/:name/:version/*path', async (req, res) => {
    try {
      const path = HubRoutes.rest(req.params.path);
      HubRoutes.sendFile(res, await bridge.file(`${req.params.scope}/${req.params.name}`, req.params.version, path));
    } catch (err) {
      HubRefusal.send(res, err, bridge);
    }
  });

  router.get('/hub/media/:scope/:name/:id', async (req, res) => {
    try {
      HubRoutes.sendFile(res, await bridge.media(`${req.params.scope}/${req.params.name}`, req.params.id));
    } catch (err) {
      HubRefusal.send(res, err, bridge);
    }
  });

  router.post('/hub/inspect', async (req, res) => {
    const { name, version, target } = req.body ?? {};
    if (typeof name !== 'string' || (version !== undefined && version !== null && typeof version !== 'string') || (target !== undefined && target !== null && !PackageRoots.isTarget(target))) {
      res.status(400).json({ error: 'Expected { name: "@scope/name", version?: "1.2.0", target?: "library" | "project" }.', code: 'bad-request' });
      return;
    }
    const abort = HubRoutes.abortOnClose(res);
    try {
      const chosen: PackageTarget = target ?? (await HubRoutes.preferredTarget(project));
      res.json(await bridge.inspect({ name, version: version ?? null, target: chosen }, { signal: abort.signal }));
    } catch (err) {
      HubRefusal.send(res, err, bridge);
    }
  });

  router.post('/hub/login', async (req, res) => {
    // A JSON body: a page on another site can't start a sign-in without CORS letting it.
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'Send a JSON body ({}).', code: 'bad-request' });
      return;
    }
    try {
      const started = await login.start();
      res.setHeader('Cache-Control', 'no-store');
      res.json(started);
    } catch (err) {
      HubRefusal.send(res, err, bridge);
    }
  });

  router.get('/hub/login', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ login: login.current() });
  });

  router.delete('/hub/login', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ login: login.cancel() });
  });

  router.post('/hub/logout', async (req, res) => {
    // A JSON body, as for signing in: another site can't sign this machine out without CORS letting it.
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'Send a JSON body ({}).', code: 'bad-request' });
      return;
    }
    try {
      const config = bridge.config();
      const transport = options.transport ?? new HubTransport({ version: options.engineVersion, client: 'app' });
      const logout = await HubLogout.run({ config, client: new HubClient(config, transport), env: options.env });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ logout });
    } catch (err) {
      HubRefusal.send(res, err, bridge);
    }
  });

  return router;
}

/** What the routes share: the raw query, a wildcard's segments, files, the install target, aborts. */
class HubRoutes {
  /** The query string as sent: repeated keys stay repeated, whatever Express's query parser does. */
  static params(req: Request): URLSearchParams {
    const at = req.originalUrl.indexOf('?');
    return new URLSearchParams(at === -1 ? '' : req.originalUrl.slice(at + 1));
  }

  /** `*path`: Express 5 hands the segments as an array. */
  static rest(value: unknown): string {
    return Array.isArray(value) ? value.join('/') : String(value ?? '');
  }

  /**
   * A file or screenshot with the hub's type, and the policy the engine's
   * own feature images get: an SVG opened on its own stays inert.
   * `no-cache`: the disk cache answers again in a moment, and a hub switch
   * (`FLUIDCAD_HUB_URL`) must not leave the browser holding another hub's
   * bytes under the same path.
   */
  static sendFile(res: Response, file: HubProxiedFile): void {
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Security-Policy', file.headers['content-security-policy'] ?? "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', file.headers['content-disposition'] ?? 'inline');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-FluidCAD-Hub-Cache', file.cache);
    res.send(file.body);
  }

  /** The "New packages go to" setting; the project only when one is open. */
  static async preferredTarget(project: string | null): Promise<PackageTarget> {
    const preferred = (await loadPreferences()).packageInstallTarget;
    return preferred === 'project' && project ? 'project' : 'library';
  }

  /** Aborted when the page goes away before the answer (a stale search, a closed window): the hub request stops too. */
  static abortOnClose(res: Response): AbortController {
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    });
    return controller;
  }
}

/**
 * How the hub routes answer a refusal, `{ error, code, details? }`:
 * - no answer from the hub, or a failure on its side (5xx) → 503
 *   `hub-unreachable`;
 * - the hub's refusal → its status and code;
 * - the installer's own → the status its code calls for;
 * - the bridge's own → its status;
 * - a downloaded archive that can't be installed → 422.
 */
class HubRefusal {
  /** The installer's own codes, by the status they answer. */
  private static readonly INSTALL_STATUS: Record<string, number> = {
    'not-found': 404,
    'nothing-published': 404,
    'version-removed': 410,
    incompatible: 409,
    'not-installable': 409,
    'no-publisher': 400,
    'too-large': 413,
    truncated: 502,
    'integrity-mismatch': 409,
    'wrong-package': 502,
    'unexpected-response': 502,
  };

  static send(res: Response, err: unknown, bridge: HubBridge): void {
    if (res.headersSent || res.destroyed) {
      return;
    }
    const answer = HubRefusal.answer(err, bridge);
    res.setHeader('Cache-Control', 'no-store');
    res.status(answer.status).json(answer.body);
  }

  private static answer(err: unknown, bridge: HubBridge): { status: number; body: Record<string, unknown> } {
    if (err instanceof HubRequestError) {
      if (HubRefusal.unreachable(err)) {
        return HubRefusal.unreachableAnswer(err, bridge);
      }
      if (err.code === HubRequestError.ABORTED) {
        return { status: 499, body: HubRefusal.body(err.message, err.code) };
      }
      // A validation refusal's sentence names the fields it refused (`sentence`).
      return { status: err.status >= 400 ? err.status : 502, body: HubRefusal.body(err.sentence, err.code, err.details) };
    }
    if (err instanceof HubInstallError) {
      if (err.hubUnreachable) {
        return HubRefusal.unreachableAnswer(err, bridge);
      }
      const cause = err.cause instanceof HubRequestError ? err.cause : null;
      const status = cause ? (cause.code === HubRequestError.ABORTED ? 499 : cause.status) : HubRefusal.INSTALL_STATUS[err.code] ?? 400;
      return { status, body: HubRefusal.body(err.message, err.code, err.details) };
    }
    if (err instanceof HubBridgeError) {
      return { status: err.status, body: HubRefusal.body(err.message, err.code, err.details) };
    }
    if (err instanceof PackageArchiveError) {
      return { status: 422, body: HubRefusal.body(err.message, err.code) };
    }
    if (err instanceof HubConfigError) {
      return { status: 500, body: HubRefusal.body(err.message, 'hub-config') };
    }
    return { status: 500, body: HubRefusal.body((err as Error)?.message ?? String(err), 'internal') };
  }

  /** No answer at all (not the page's own abort), or the hub failing on its side. */
  private static unreachable(err: HubRequestError): boolean {
    return (err.unreachable && err.code !== HubRequestError.ABORTED) || err.status >= 500;
  }

  private static unreachableAnswer(err: Error, bridge: HubBridge): { status: number; body: Record<string, unknown> } {
    let hub: string | null = null;
    try {
      hub = bridge.config().origin;
    } catch {
      // Unreachable before the configuration was even read: say so without it.
    }
    const cause = err instanceof HubRequestError ? err : err.cause instanceof HubRequestError ? err.cause : null;
    return { status: 503, body: HubRefusal.body(err.message, 'hub-unreachable', { hub, cause: cause?.code ?? null }) };
  }

  private static body(message: string, code: string, details?: unknown): Record<string, unknown> {
    return details === undefined || details === null ? { error: message, code } : { error: message, code, details };
  }
}
