import crypto from 'crypto';
import { readProjectConfig } from '../project-config.ts';
import { PackageAuthoringError } from '../packages/package-authoring.ts';
import { PackageBuildError, packPackage, type PackEngine, type PackPackageInputs, type PackPackageResult } from '../packages/package-builder.ts';
import type { HubUploadResult, HubVersionStatus } from './hub-client.ts';
import { HubConfig, HubConfigError } from './hub-config.ts';
import { HubCredentials } from './hub-credentials.ts';
import { HubPublishError, HubPublishMessages } from './hub-publish-error.ts';
import { HubPublisher, type HubPublishProgress, type HubPublishStatus, type HubPublishSummary } from './hub-publisher.ts';
import { HubRequestError } from './hub-request-error.ts';
import { HubTransport } from './hub-transport.ts';

/**
 * Publishing from the app (ui-packages-plan N3, U9/U10): the Publish
 * dialog runs `fluidcad publish`'s own `HubPublisher` through the engine,
 * with the same checks and the same sentences, and follows it as a
 * session, the way the Hub panel follows a sign-in (`HubAppLogin`):
 *
 * 1. {@link start} begins a publish and answers once the preflight is
 *    through: the hub's checks that need no archive (token, CLI version,
 *    handle and scope, publisher, the version rule, the open version)
 *    either refuse in the answer (`failed`, with the publisher's code) or
 *    the pack has begun (`packing`).
 * 2. The page follows {@link current}: `packing` → `awaiting-confirm`
 *    (the `summary`, what `fluidcad publish` prints before `Upload it?`)
 *    → {@link confirm} → `uploading` (with `progress`) → `verifying` →
 *    `done` (the hub's `result`: the wizard URL for a first version, the
 *    review URL after that). {@link cancel} while it waits → `declined`;
 *    nobody confirming within {@link CONFIRM_TIMEOUT_MS} → `declined` too
 *    (`confirm-timeout`). A dry run never waits: `packing` → `uploading`
 *    → `done` with `result.dryRun`.
 *
 * The archive is packed once: the publisher's `confirm` callback is
 * parked on a promise the page's confirm or cancel settles, and the
 * publisher's own `finally` removes the scratch directory when the
 * session ends, whichever way. Packing goes through the workspace's
 * running engine (`engine`, as `POST /api/pack` packs), so an unsaved
 * editor buffer is refused with the pack route's sentence
 * (`unsaved-changes`). One session at a time per engine: a second
 * {@link start} while one runs is refused (409 `publish-running`).
 *
 * The hub and the credentials are resolved at each call (`config()`,
 * `HubCredentials.read`), so a sign-in from the Hub panel is seen without
 * a restart. The transport names the app (`client: 'app'`).
 */

export type HubAppPublishStatus = 'checking' | 'packing' | 'awaiting-confirm' | 'uploading' | 'verifying' | 'done' | 'declined' | 'failed';

/** The statuses a session passes through before it ends; nothing else may start meanwhile. */
export const HUB_APP_PUBLISH_RUNNING: readonly HubAppPublishStatus[] = ['checking', 'packing', 'awaiting-confirm', 'uploading', 'verifying'];

/**
 * Why a session ended `failed` or `declined`, and how every publish route
 * refuses: `{ message, code, details? }`, the sentence in the app's words
 * (the CLI's hints become the dialog's), the code the UI acts on:
 *
 * - `signed-out` (401): no credentials for this hub, or a token the hub
 *   refused (`details.reason`: `no-credentials` | `token-refused`), the
 *   same shape as the Hub panel's refusals, so the dialog's Sign in state
 *   is the panel's;
 * - `forbidden` (403): no handle yet, a package under another handle's
 *   scope (`details.scope`, `details.name`), or a token without the
 *   publish scope; `email-unverified`, `publishing-closed` (403): not a
 *   publisher;
 * - `version-exists`, `version-not-greater` (409): the version is not
 *   above the latest published one (`details.highest`): bump it;
 * - `in-review`, `open-version-exists` (409): another version is open on
 *   the hub (`details.version`, `details.status`: `draft` | `in_review` |
 *   `uploading`): withdraw it or finish it; `package-unavailable` (409);
 * - `cli-too-old` (409): this FluidCAD is below the hub's minimum
 *   (`details.minCliVersion`);
 * - `not-a-package`, `bad-config` (400): no `package` block, or a
 *   `fluidcad.json` whose block, pin, unit or materials can't be read;
 *   `unsaved-changes` (400): a shipped file with unsaved edits, save it
 *   first; `no-models` (400): nothing in `parts/` or `assemblies/`; the
 *   other pack refusals keep the `PackageBuildError` code;
 * - `archive-too-large`, `too-many-entries`, `unpacked-too-large`,
 *   `sources-too-large` (413), `bad-manifest`, `bad-params`,
 *   `notes-too-long` (400): the hub's limits;
 * - `nothing-open` (409): a withdraw with no draft or version in review;
 *   `integrity-mismatch` (409): the hub stored other bytes;
 * - `hub-unreachable` (503): no answer from the hub, or a failure on its
 *   side (`details.hub`, `details.cause`); any other hub refusal keeps
 *   its status and code;
 * - `cancelled`, `confirm-timeout`: why a session is `declined`;
 * - `publish-running` (409): a start while a session runs
 *   (`details.id`, `details.status`); `nothing-to-confirm` (409): a
 *   confirm with nothing waiting; `hub-config` (500): a bad hub URL.
 */
export type HubAppPublishRefusal = { message: string; code: string; details?: unknown };

/** `GET /api/publish`: one publish, as the page follows it. */
export type HubAppPublishState = {
  /** Tells one publish from the next. */
  id: string;
  /** The hub's origin. */
  hub: string;
  status: HubAppPublishStatus;
  dryRun: boolean;
  /** The release notes sent, trimmed; null for none. */
  notes: string | null;
  startedAt: string;
  /** While `awaiting-confirm`: when it is declined on its own; null otherwise. */
  confirmBy: string | null;
  /** From `awaiting-confirm` on (a dry run: from `uploading` on): what is, or was, uploaded. */
  summary: HubPublishSummary | null;
  /** While `uploading`: the bytes sent so far; null otherwise. */
  progress: { sent: number; total: number } | null;
  /** `done`: the hub's answer (`status`, `wizardUrl`, `reviewUrl`, `integrity`, `replaced`, `dryRun`); null otherwise. */
  result: HubUploadResult | null;
  /** `failed`: the refusal; `declined`: why (`cancelled`, `confirm-timeout`); null otherwise. */
  error: HubAppPublishRefusal | null;
};

/** `POST /api/publish`'s body. */
export type HubAppPublishRequest = {
  /** Release notes for a version that goes to review; else the hub takes the CHANGELOG section. */
  notes?: string | null;
  /** The hub checks everything and stores nothing; no confirmation is asked. */
  dryRun?: boolean;
};

/** `GET /api/publish/package`: the dialog's header (U7: a broken block is still a package workspace, with its problem as the first refusal). */
export type HubAppPublishPackage = {
  /** The `package` block's identity, when it reads. */
  package: { name: string; version: string } | null;
  /** The block's problem sentence when `fluidcad.json` has a `package` key the server can't read; null otherwise. */
  problem: string | null;
};

export type HubAppPublishOptions = {
  /** The open workspace: whose package is published. */
  workspacePath: string;
  /** Which hub, resolved at each call (the bridge's own `config()`); a bad URL throws `HubConfigError`. */
  config: () => HubConfig;
  /** This FluidCAD's version: the manifest's `engine`, the user agent, the hub's `minCliVersion` check. */
  version: string;
  /** Where the token is read (`HubCredentials.read`); defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** The workspace's running engine, which evaluates the exports (and refuses an unsaved buffer); omitted, one boots in process. */
  engine?: PackEngine;
  /** Tests: packs instead of {@link packPackage}. */
  pack?: (inputs: PackPackageInputs) => Promise<PackPackageResult>;
  /** Tests: a transport that doesn't wait between retries. */
  transport?: HubTransport;
  /** How long a session waits to be confirmed; defaults to {@link PublishSession.CONFIRM_TIMEOUT_MS}. */
  confirmTimeoutMs?: number;
};

/** A session method called out of turn: a start while one runs, a confirm with nothing waiting. */
export class PublishSessionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'PublishSessionError';
  }
}

/** Thrown through the publisher by a pack that finished after the page cancelled, so nothing is uploaded. */
class PublishCancelled extends Error {
  constructor() {
    super('Publish cancelled.');
    this.name = 'PublishCancelled';
  }
}

type Run = {
  state: HubAppPublishState;
  /** Settles the parked `confirm` callback, while it waits. */
  decide: ((confirmed: boolean) => void) | null;
  timer: NodeJS.Timeout | null;
  /** The page cancelled; a pack still running must not be followed by an upload. */
  cancelled: boolean;
  /** Resolved when the preflight is through (packing began, or the publish ended before it). */
  leftChecking: () => void;
  /** Resolved when the publisher has returned and its scratch is gone. */
  finished: Promise<void>;
};

export class PublishSession {
  /** A session nobody confirms within this long is declined, and its scratch removed. */
  static readonly CONFIRM_TIMEOUT_MS = 10 * 60_000;

  private run: Run | null = null;

  constructor(private readonly options: HubAppPublishOptions) {}

  /**
   * The workspace's package identity for the dialog's header, read as the
   * packages overview reads it (`ProjectPackages.identity`): the block's
   * name and version, else its problem sentence, neither for a plain
   * project.
   */
  static packageIn(workspacePath: string): HubAppPublishPackage {
    const config = readProjectConfig(workspacePath);
    if (config.package) {
      return { package: { name: config.package.name, version: config.package.version }, problem: null };
    }
    return { package: null, problem: config.problems?.package ?? null };
  }

  /**
   * Begin a publish. Answers once the preflight is through: `packing`, or
   * an ended state when a check refused before the pack (`failed` with the
   * refusal's code, the way `fluidcad publish` refuses in a fraction of a
   * second). Throws `PublishSessionError` 409 `publish-running` while a
   * session runs, and `HubConfigError` for a bad hub URL.
   */
  async start(request: HubAppPublishRequest = {}): Promise<HubAppPublishState> {
    const running = this.run;
    if (running && PublishSession.isRunning(running.state)) {
      throw new PublishSessionError(
        409,
        'publish-running',
        `A publish is already running (${running.state.status}): wait for it to end, or cancel it first.`,
        { id: running.state.id, status: running.state.status },
      );
    }
    const config = this.options.config();
    const notes = request.notes?.trim() ? request.notes.trim() : null;
    let leftChecking = () => {};
    const preflight = new Promise<void>((resolve) => {
      leftChecking = resolve;
    });
    const run: Run = {
      state: {
        id: crypto.randomUUID(),
        hub: config.origin,
        status: 'checking',
        dryRun: Boolean(request.dryRun),
        notes,
        startedAt: new Date().toISOString(),
        confirmBy: null,
        summary: null,
        progress: null,
        result: null,
        error: null,
      },
      decide: null,
      timer: null,
      cancelled: false,
      leftChecking,
      finished: Promise.resolve(),
    };
    run.finished = this.execute(run, config).finally(() => run.leftChecking());
    this.run = run;
    await preflight;
    return { ...run.state };
  }

  /** The publish running or last ended in this engine, or null when there was none. */
  current(): HubAppPublishState | null {
    return this.run ? { ...this.run.state } : null;
  }

  /**
   * Upload what the session is waiting to upload. Throws
   * `PublishSessionError` 409 `nothing-to-confirm` unless the session is
   * `awaiting-confirm`.
   */
  confirm(): HubAppPublishState {
    const run = this.run;
    if (!run || run.state.status !== 'awaiting-confirm' || !run.decide) {
      throw new PublishSessionError(
        409,
        'nothing-to-confirm',
        run ? `The publish is ${run.state.status}, not waiting to be confirmed.` : 'No publish is waiting to be confirmed.',
      );
    }
    const decide = run.decide;
    PublishSession.unpark(run);
    // The publisher reports the first byte in a moment; the page must never see the wait again meanwhile.
    run.state = { ...run.state, status: 'uploading', confirmBy: null, progress: { sent: 0, total: run.state.summary?.size ?? 0 } };
    decide(true);
    return { ...run.state };
  }

  /**
   * Stop the session before anything is sent: while it checks, packs or
   * waits to be confirmed, it ends `declined` (a pack still running
   * finishes on its own, and nothing follows it). An upload under way
   * can't be stopped, and an ended session is answered as it is.
   */
  cancel(): HubAppPublishState | null {
    const run = this.run;
    if (run && PublishSession.isStoppable(run.state)) {
      run.cancelled = true;
      const decide = run.decide;
      PublishSession.unpark(run);
      PublishSession.end(run, { status: 'declined', error: { code: 'cancelled', message: 'Publish cancelled. Nothing was uploaded.' } });
      decide?.(false);
    }
    return this.current();
  }

  /** The current session's work is over: the publisher has returned and its scratch is gone (tests, shutdown). */
  async settled(): Promise<HubAppPublishState | null> {
    if (this.run) {
      await this.run.finished;
    }
    return this.current();
  }

  /** Stop a waiting session (the engine's shutdown, tests). */
  dispose(): void {
    this.cancel();
  }

  /** Where the package stands on the hub (`fluidcad publish --status`), for the dialog's status line. */
  async status(name: string): Promise<HubPublishStatus> {
    return this.publisher(this.options.config()).status(name);
  }

  /** Withdraw the package's draft or version in review (`fluidcad publish --withdraw`); the page asked, so no confirm. */
  async withdraw(name: string): Promise<HubVersionStatus> {
    const withdrawn = await this.publisher(this.options.config()).withdraw(name);
    if (!withdrawn) {
      // Without a `confirm` the publisher never declines; typed so.
      throw new PublishSessionError(409, 'nothing-open', `${name} has nothing open to withdraw.`);
    }
    return withdrawn;
  }

  // The run

  private async execute(run: Run, config: HubConfig): Promise<void> {
    try {
      const publisher = this.publisher(config, async (inputs) => {
        const result = await this.pack(inputs);
        if (run.cancelled) {
          throw new PublishCancelled();
        }
        return result;
      });
      const result = await publisher.publish({
        workspacePath: this.options.workspacePath,
        notes: run.state.notes,
        dryRun: run.state.dryRun,
        onProgress: (progress) => PublishSession.advance(run, progress),
        confirm: (summary) => this.park(run, summary),
      });
      if (result === null) {
        PublishSession.end(run, { status: 'declined', error: { code: 'cancelled', message: 'Publish cancelled. Nothing was uploaded.' } });
      } else {
        PublishSession.end(run, { status: 'done', summary: result.summary, result: result.upload });
      }
    } catch (err) {
      if (err instanceof PublishCancelled) {
        PublishSession.end(run, { status: 'declined', error: { code: 'cancelled', message: 'Publish cancelled. Nothing was uploaded.' } });
        return;
      }
      PublishSession.end(run, { status: 'failed', error: PublishRefusal.describe(err, config).refusal });
    }
  }

  /** The publisher's `confirm`: the page's confirm or cancel decides, or the timeout declines. */
  private park(run: Run, summary: HubPublishSummary): Promise<boolean> {
    if (run.cancelled) {
      return Promise.resolve(false);
    }
    const timeoutMs = this.options.confirmTimeoutMs ?? PublishSession.CONFIRM_TIMEOUT_MS;
    run.state = { ...run.state, status: 'awaiting-confirm', summary, confirmBy: new Date(Date.now() + timeoutMs).toISOString() };
    run.leftChecking();
    return new Promise<boolean>((resolve) => {
      run.decide = resolve;
      run.timer = setTimeout(() => {
        run.decide = null;
        run.timer = null;
        PublishSession.end(run, {
          status: 'declined',
          error: { code: 'confirm-timeout', message: `Nothing was uploaded: the upload wasn't confirmed within ${PublishSession.minutes(timeoutMs)}.` },
        });
        resolve(false);
      }, timeoutMs);
      run.timer.unref?.();
    });
  }

  /** The publisher's `onProgress`, into the state; nothing after the session ended. */
  private static advance(run: Run, progress: HubPublishProgress): void {
    if (!PublishSession.isRunning(run.state)) {
      return;
    }
    switch (progress.step) {
      case 'checking':
        run.state = { ...run.state, status: 'checking' };
        return;
      case 'packing':
        run.state = { ...run.state, status: 'packing' };
        run.leftChecking();
        return;
      case 'uploading':
        run.state = { ...run.state, status: 'uploading', confirmBy: null, progress: { sent: progress.sent, total: progress.total } };
        return;
      case 'verifying':
        run.state = { ...run.state, status: 'verifying', progress: null };
        return;
    }
  }

  /** The first ending counts. */
  private static end(run: Run, outcome: Partial<HubAppPublishState>): void {
    if (!PublishSession.isRunning(run.state)) {
      return;
    }
    run.state = { ...run.state, ...outcome, confirmBy: null, progress: null };
  }

  private static unpark(run: Run): void {
    if (run.timer) {
      clearTimeout(run.timer);
      run.timer = null;
    }
    run.decide = null;
  }

  private static isRunning(state: HubAppPublishState): boolean {
    return HUB_APP_PUBLISH_RUNNING.includes(state.status);
  }

  /** Nothing has been sent yet. */
  private static isStoppable(state: HubAppPublishState): boolean {
    return state.status === 'checking' || state.status === 'packing' || state.status === 'awaiting-confirm';
  }

  private static minutes(ms: number): string {
    const minutes = Math.round(ms / 60_000);
    if (minutes < 1) {
      return `${Math.round(ms / 1000)} seconds`;
    }
    return minutes === 1 ? '1 minute' : `${minutes} minutes`;
  }

  /** `fluidcad publish`'s publisher, as the app makes it: the credentials read now, the app's transport, this engine's pack. */
  private publisher(config: HubConfig, pack?: (inputs: PackPackageInputs) => Promise<PackPackageResult>): HubPublisher {
    return new HubPublisher({
      config,
      credential: HubCredentials.read(config.origin, this.options.env),
      version: this.options.version,
      transport: this.options.transport ?? new HubTransport({ version: this.options.version, client: 'app' }),
      pack,
    });
  }

  /** Packing with the workspace's running engine, as `POST /api/pack` packs. */
  private pack(inputs: PackPackageInputs): Promise<PackPackageResult> {
    if (this.options.pack) {
      return this.options.pack(inputs);
    }
    return packPackage({ ...inputs, engine: this.options.engine });
  }
}

/**
 * How a publish refusal is answered, as a session's `error` and as a
 * route's `{ error, code, details? }` body ({@link HubAppPublishRefusal}
 * lists the codes): the publisher's code with the status it calls for,
 * the CLI's hints reworded for the dialog, the hub's own refusals with
 * their status, no answer from the hub as the hub routes' 503.
 */
export class PublishRefusal {
  /** The publisher's local codes, by the status they answer; 400 otherwise. */
  private static readonly LOCAL_STATUS: Record<string, number> = {
    forbidden: 403,
    'email-unverified': 403,
    'publishing-closed': 403,
    'version-exists': 409,
    'version-not-greater': 409,
    'in-review': 409,
    'open-version-exists': 409,
    'package-unavailable': 409,
    'cli-too-old': 409,
    'nothing-open': 409,
    'integrity-mismatch': 409,
    'archive-too-large': 413,
    'too-many-entries': 413,
    'unpacked-too-large': 413,
    'sources-too-large': 413,
  };

  /** The CLI's next steps, as the dialog says them (it has the buttons the CLI names commands for). */
  private static readonly APP_HINTS: readonly [string, string][] = [
    [HubPublishMessages.STATUS_HINT, 'Withdraw it, or finish it on the hub, then publish again.'],
    [HubPublishMessages.BUMP_HINT, 'Bump the version, then publish again.'],
    [HubPublishMessages.LOGIN_HINT, 'Sign in again, then publish again.'],
  ];

  static describe(err: unknown, config: HubConfig | null): { status: number; refusal: HubAppPublishRefusal } {
    if (err instanceof HubPublishError) {
      return PublishRefusal.publish(err, config);
    }
    if (err instanceof PublishSessionError) {
      return { status: err.status, refusal: PublishRefusal.refusal(err.message, err.code, err.details) };
    }
    if (err instanceof PackageBuildError) {
      return { status: 400, refusal: PublishRefusal.refusal(err.message, err.code) };
    }
    if (err instanceof PackageAuthoringError) {
      return { status: 400, refusal: PublishRefusal.refusal(err.message, 'refused') };
    }
    if (err instanceof HubRequestError) {
      return PublishRefusal.hub(err, err.message, err.code, err.details, config);
    }
    if (err instanceof HubConfigError) {
      return { status: 500, refusal: PublishRefusal.refusal(err.message, 'hub-config') };
    }
    return { status: 500, refusal: PublishRefusal.refusal((err as Error)?.message ?? String(err), 'internal') };
  }

  private static publish(err: HubPublishError, config: HubConfig | null): { status: number; refusal: HubAppPublishRefusal } {
    const hub = config?.origin ?? 'the hub';
    if (err.code === 'signed-out') {
      return { status: 401, refusal: PublishRefusal.refusal(`Not signed in to ${hub}. Sign in to publish.`, 'signed-out', { reason: 'no-credentials' }) };
    }
    const cause = err.cause instanceof HubRequestError ? err.cause : null;
    if (cause) {
      if (cause.unauthorized) {
        return { status: 401, refusal: PublishRefusal.refusal(PublishRefusal.appWording(err.message), 'signed-out', { reason: 'token-refused' }) };
      }
      return PublishRefusal.hub(cause, PublishRefusal.appWording(err.message), err.code, err.details, config);
    }
    return { status: PublishRefusal.LOCAL_STATUS[err.code] ?? 400, refusal: PublishRefusal.refusal(PublishRefusal.appWording(err.message), err.code, err.details) };
  }

  /** A hub request's refusal: no answer (or a failure on its side) → 503 `hub-unreachable`; else its status and code. */
  private static hub(cause: HubRequestError, message: string, code: string, details: unknown, config: HubConfig | null): { status: number; refusal: HubAppPublishRefusal } {
    if ((cause.unreachable && cause.code !== HubRequestError.ABORTED) || cause.status >= 500) {
      return { status: 503, refusal: PublishRefusal.refusal(message, 'hub-unreachable', { hub: config?.origin ?? null, cause: cause.code }) };
    }
    return { status: cause.status >= 400 ? cause.status : 502, refusal: PublishRefusal.refusal(message, code, details) };
  }

  /** The publisher's sentence with the CLI's hint swapped for the dialog's. */
  static appWording(message: string): string {
    for (const [cli, app] of PublishRefusal.APP_HINTS) {
      if (message.endsWith(cli)) {
        return `${message.slice(0, -cli.length)}${app}`;
      }
    }
    return message.replace(/check with `fluidcad publish --status`/, 'check its status');
  }

  private static refusal(message: string, code: string, details?: unknown): HubAppPublishRefusal {
    return details === undefined || details === null ? { message, code } : { message, code, details };
  }
}
