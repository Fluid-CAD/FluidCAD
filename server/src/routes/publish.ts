import { Router, type Request, type Response } from 'express';
import { HubBridge } from '../hub/hub-bridge.ts';
import {
  PublishRefusal,
  PublishSession,
  type HubAppPublishPackage,
  type HubAppPublishRefusal,
  type HubAppPublishRequest,
  type HubAppPublishState,
} from '../hub/hub-app-publish.ts';
import type { HubClientKind } from '../hub/hub-transport.ts';
import type { HubPublishStatus } from '../hub/hub-publisher.ts';
import type { HubVersionStatus } from '../hub/hub-client.ts';
import type { HubTransport } from '../hub/hub-transport.ts';
import { PackageAuthoring, type PackageVersionChange } from '../packages/package-authoring.ts';
import type { PackEngine, PackPackageInputs, PackPackageResult } from '../packages/package-builder.ts';

export type PublishRouterOptions = {
  /** The open workspace, whose package is published. */
  workspacePath: string;
  /** This engine's FluidCAD version. */
  engineVersion: string;
  /** The workspace's running engine: it evaluates the exports, as `POST /api/pack` packs. */
  engine?: PackEngine;
  /** Where the hub URL and the token are read; defaults to `process.env` (tests pass their own). */
  env?: NodeJS.ProcessEnv;
  /** Tests: a transport that doesn't wait between retries. */
  transport?: HubTransport;
  /** Tests: packs instead of the engine. */
  pack?: (inputs: PackPackageInputs) => Promise<PackPackageResult>;
  /** Tests: how long a session waits to be confirmed (defaults to ten minutes). */
  confirmTimeoutMs?: number;
  /** Tests: the session the routes drive, to stop one left waiting. */
  onSession?: (session: PublishSession) => void;
};

/** `GET /api/publish/package`: the dialog's header. */
export type PublishPackageResponse = HubAppPublishPackage;
/** `GET /api/publish/status`: where the package stands on the hub (`fluidcad publish --status`). */
export type PublishStatusResponse = HubPublishStatus;
/** `POST /api/publish`, `GET /api/publish`, `POST /api/publish/confirm`, `DELETE /api/publish`: the session (null when none has run). */
export type PublishSessionResponse = { publish: HubAppPublishState | null };
/** `POST /api/publish/withdraw`: the version that was withdrawn. */
export type PublishWithdrawResponse = { withdrawn: HubVersionStatus };
/** `POST /api/publish/version`: what the block's version became. */
export type PublishVersionResponse = PackageVersionChange;
/**
 * Every refusal: `{ error: <sentence>, code, details? }`, the shape the hub
 * routes answer (`HubRefusal`), with the codes {@link HubAppPublishRefusal}
 * lists; the status is the one its code calls for (401 `signed-out`, 409
 * `publish-running`, 503 `hub-unreachable`, …). The bump route's own
 * refusals are 400 `refused` with `PackageAuthoring.bumpVersion`'s
 * sentence; a body that isn't JSON is 415 `bad-request`, a body with the
 * wrong fields 400 `bad-request`.
 */
export type PublishRefusalResponse = { error: string; code: string; details?: unknown };

/**
 * Publishing from the app (ui-packages-plan N3): the Publish dialog's
 * routes over `PublishSession`, which runs `fluidcad publish`'s own
 * `HubPublisher` through this engine. The archive is packed once, through
 * the running engine; the hub and the credentials are read at each call,
 * so a sign-in from the Hub panel is seen at once.
 *
 * - `GET /api/publish/package` → `{ package: { name, version } | null,
 *   problem }`: the workspace's block for the dialog's header (U7: the
 *   problem sentence when the block can't be read).
 * - `GET /api/publish/status` → `HubPublishStatus` (`{ name, package,
 *   latest }`): the open version, the latest rejection, the latest
 *   published version; 401 `signed-out` when there are no credentials.
 * - `POST /api/publish { notes?, dryRun? }` → `{ publish }`: begins a
 *   session and answers it once the preflight is through (`packing`, or
 *   `failed` with the refusal's code). 409 `publish-running` while one
 *   runs.
 * - `GET /api/publish` → `{ publish }`: the session running or last
 *   ended (null for none), which the page follows until `done`,
 *   `declined` or `failed`.
 * - `POST /api/publish/confirm` → `{ publish }`: upload what an
 *   `awaiting-confirm` session packed; 409 `nothing-to-confirm` otherwise.
 * - `DELETE /api/publish` → `{ publish }`: cancel a session that hasn't
 *   sent anything (`declined`); an upload under way is answered as it is.
 * - `POST /api/publish/withdraw` → `{ withdrawn }`: withdraw the draft or
 *   the version in review (the page asked; no second confirmation); 409
 *   `nothing-open` when there is none.
 * - `POST /api/publish/version { spec }` → `PackageVersionChange`:
 *   `PackageAuthoring.bumpVersion` with `major`, `minor`, `patch` or a
 *   version; its refusals are 400 sentences.
 *
 * Every POST needs a JSON body, as the hub routes do: a page on another
 * site can't publish, withdraw or bump without CORS letting it.
 */
export function createPublishRouter(options: PublishRouterOptions): Router {
  const router = Router();
  const bridge = new HubBridge({
    project: options.workspacePath || null,
    engineVersion: options.engineVersion,
    env: options.env,
    client: PublishRoutes.CLIENT,
    transport: options.transport,
  });
  const session = new PublishSession({
    workspacePath: options.workspacePath,
    config: () => bridge.config(),
    version: options.engineVersion,
    env: options.env,
    engine: options.engine,
    pack: options.pack,
    transport: options.transport,
    confirmTimeoutMs: options.confirmTimeoutMs,
  });
  options.onSession?.(session);

  router.get('/publish/package', (_req, res) => {
    try {
      PublishRoutes.answer(res, PublishSession.packageIn(options.workspacePath) satisfies PublishPackageResponse);
    } catch (err) {
      PublishRoutes.refuse(res, err, bridge);
    }
  });

  router.get('/publish/status', async (_req, res) => {
    try {
      const { package: info, problem } = PublishSession.packageIn(options.workspacePath);
      if (!info) {
        PublishRoutes.notAPackage(res, problem);
        return;
      }
      PublishRoutes.answer(res, (await session.status(info.name)) satisfies PublishStatusResponse);
    } catch (err) {
      PublishRoutes.refuse(res, err, bridge);
    }
  });

  router.post('/publish', async (req, res) => {
    if (!PublishRoutes.jsonBody(req, res)) {
      return;
    }
    const request = PublishRoutes.publishRequest(req.body);
    if (!request) {
      res.status(400).json({ error: 'Expected { notes?: string | null, dryRun?: boolean }.', code: 'bad-request' } satisfies PublishRefusalResponse);
      return;
    }
    try {
      PublishRoutes.answer(res, { publish: await session.start(request) } satisfies PublishSessionResponse);
    } catch (err) {
      PublishRoutes.refuse(res, err, bridge);
    }
  });

  router.get('/publish', (_req, res) => {
    PublishRoutes.answer(res, { publish: session.current() } satisfies PublishSessionResponse);
  });

  router.post('/publish/confirm', (req, res) => {
    if (!PublishRoutes.jsonBody(req, res)) {
      return;
    }
    try {
      PublishRoutes.answer(res, { publish: session.confirm() } satisfies PublishSessionResponse);
    } catch (err) {
      PublishRoutes.refuse(res, err, bridge);
    }
  });

  router.delete('/publish', (_req, res) => {
    PublishRoutes.answer(res, { publish: session.cancel() } satisfies PublishSessionResponse);
  });

  router.post('/publish/withdraw', async (req, res) => {
    if (!PublishRoutes.jsonBody(req, res)) {
      return;
    }
    try {
      const { package: info, problem } = PublishSession.packageIn(options.workspacePath);
      if (!info) {
        PublishRoutes.notAPackage(res, problem);
        return;
      }
      PublishRoutes.answer(res, { withdrawn: await session.withdraw(info.name) } satisfies PublishWithdrawResponse);
    } catch (err) {
      PublishRoutes.refuse(res, err, bridge);
    }
  });

  router.post('/publish/version', (req, res) => {
    if (!PublishRoutes.jsonBody(req, res)) {
      return;
    }
    const spec = req.body?.spec;
    if (typeof spec !== 'string' || spec.trim() === '') {
      res.status(400).json({ error: 'Expected { spec: "major" | "minor" | "patch" | "1.2.0" }.', code: 'bad-request' } satisfies PublishRefusalResponse);
      return;
    }
    try {
      PublishRoutes.answer(res, PackageAuthoring.bumpVersion(options.workspacePath, spec.trim()) satisfies PublishVersionResponse);
    } catch (err) {
      PublishRoutes.refuse(res, err, bridge);
    }
  });

  return router;
}

/** What the routes share: the JSON-body guard, the body's shape, the answers and the refusals. */
class PublishRoutes {
  /** The publishing FluidCAD, in the user agent. */
  static readonly CLIENT: HubClientKind = 'app';

  /** A JSON body on every POST: a page on another site can't publish without CORS letting it. */
  static jsonBody(req: Request, res: Response): boolean {
    if (req.is('application/json')) {
      return true;
    }
    res.status(415).json({ error: 'Send a JSON body ({}).', code: 'bad-request' } satisfies PublishRefusalResponse);
    return false;
  }

  /** `{ notes?, dryRun? }`, or null for anything else. */
  static publishRequest(body: unknown): HubAppPublishRequest | null {
    if (body === undefined || body === null) {
      return {};
    }
    if (typeof body !== 'object' || Array.isArray(body)) {
      return null;
    }
    const { notes, dryRun } = body as Record<string, unknown>;
    if (notes !== undefined && notes !== null && typeof notes !== 'string') {
      return null;
    }
    if (dryRun !== undefined && typeof dryRun !== 'boolean') {
      return null;
    }
    return { notes: (notes as string | null | undefined) ?? null, dryRun: dryRun === true };
  }

  static answer(res: Response, body: unknown): void {
    res.setHeader('Cache-Control', 'no-store');
    res.json(body);
  }

  /** The status and withdraw routes outside a package workspace: the pack's own codes, so the dialog reads one rule. */
  static notAPackage(res: Response, problem: string | null): void {
    const body: PublishRefusalResponse = problem
      ? { error: `${problem} Fix it, then try again.`, code: 'bad-config' }
      : { error: PackageAuthoring.NOT_A_PACKAGE, code: 'not-a-package' };
    res.setHeader('Cache-Control', 'no-store');
    res.status(400).json(body);
  }

  /** `{ error, code, details? }` with the status the refusal calls for ({@link PublishRefusal}). */
  static refuse(res: Response, err: unknown, bridge: HubBridge): void {
    if (res.headersSent || res.destroyed) {
      return;
    }
    let config = null;
    try {
      config = bridge.config();
    } catch {
      // A bad hub URL: the refusal says so without it.
    }
    const { status, refusal } = PublishRefusal.describe(err, config);
    const body: PublishRefusalResponse = refusal.details === undefined ? { error: refusal.message, code: refusal.code } : { error: refusal.message, code: refusal.code, details: refusal.details };
    res.setHeader('Cache-Control', 'no-store');
    res.status(status).json(body);
  }
}
