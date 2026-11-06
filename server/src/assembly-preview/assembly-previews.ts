// AssemblyPreviews: the server side of an assembly dialog's live preview (generators G4, P4, P7).

import { readFile } from 'fs/promises';
import type { FeatureEditDispatcher, DispatchRefusal } from '../edit-dispatch.ts';
import { detectKind } from '../file-kind.ts';
import type { FluidCadServer } from '../fluidcad-server/server.ts';
import type { GeneratedRenderReport } from '../../../lib/dist/index.js';
import { CompileErrors } from '../fluidcad-server/compile-errors.ts';
import { RenderClock } from '../fluidcad-server/render-clock.ts';
import type { SceneRenderedData } from '../fluidcad-server/render-types.ts';
import { scenePreviewFields, sceneStopFields, sceneUnitFields } from '../fluidcad-server/scene-summary.ts';
import { normalizePath } from '../normalize-path.ts';
import { PackageAdoption, type PackageAdoptionPlan } from '../packages/package-adoption.ts';
import type { PackageDependencies } from '../project-config.ts';
import type { RenderOutcome } from '../routes/render.ts';
import type { ServerToUIMessage, UIAssemblyPreviewEndedMessage } from '../ws-protocol.ts';
import { AssemblyPreviewRequest, type AssemblyPreviewBody } from './preview-request.ts';

/** What the previews read of the engine. */
export type PreviewEngine = Pick<FluidCadServer, 'renderPreview' | 'previewTokenOf' | 'getCurrentFileName' | 'getCurrentCode'>;

/** The render counter every render of the server shares (index.ts `renderVersion`). */
export type RenderVersions = {
  /** Take the next version: the render that takes it is the latest. */
  next(): number;
  /** Whether no render took a version after `version`. */
  isLatest(version: number): boolean;
};

export type AssemblyPreviewDeps = {
  engine: PreviewEngine;
  /** Applies a writer's spec in memory exactly as the editor's round trip will (`FeatureEditDispatcher.applyInMemory`). */
  edits: Pick<FeatureEditDispatcher, 'applyInMemory'>;
  /** The project (empty: no packages to pin). */
  workspacePath: string;
  /** Hand a message to every page; answers its size in bytes when it can (the core's broadcast). */
  broadcast: (msg: ServerToUIMessage) => number | void;
  versions: RenderVersions;
  /**
   * Render the file's own code as the session's scene — the render `/end`
   * runs; index.ts's `runLiveRender`, which takes a version, broadcasts the
   * scene (ending the preview) and answers its outcome.
   */
  renderSaved: (file: string, code: string) => Promise<RenderOutcome>;
};

/** An answer, as the route sends it. */
export type PreviewAnswer = { status: number; body: Record<string, unknown> };

/** Why a request was answered without its scene showing (`state: 'superseded'`). */
export type SupersededReason =
  /** A newer request of the same preview replaced it while it waited. */
  | 'newer-request'
  /** A render that started after it (another preview, the editor, `/end`) will speak instead. */
  | 'newer-render'
  /** Its preview is over: ended by `/end`, or taken over by another token. */
  | 'ended';

/** Where one preview's time went (P7). Milliseconds, to a tenth. */
export type PreviewTimings = {
  /** Request received → answered. */
  totalMs: number;
  /** Waiting in the preview slot behind the preview render in flight. */
  queueMs: number;
  /** Planning the edit and applying it in memory (with the pin plan on a package's first use). */
  editMs: number;
  /** Waiting for the engine: renders, scans and ghosts ahead of it. */
  waitMs: number;
  /** Evaluating the modules: the file, its imports, every generator's layout. */
  evaluateMs: number;
  /** Pairing against the previous scene. */
  compareMs: number;
  /** The engine's render pass: builds (generated templates included), triangulation, mesh extraction. */
  renderMs: number;
  /** Reading the rows and the assembly's records off the scene. */
  collectMs: number;
  /** Serializing the scene message and handing it to every page. */
  sendMs: number;
  /** The scene message's size. */
  payloadBytes: number;
};

/** One request, waiting for its answer. */
class PreviewJob {
  readonly receivedAt = performance.now();
  readonly answered: Promise<PreviewAnswer>;
  private resolveAnswer!: (answer: PreviewAnswer) => void;

  constructor(readonly request: AssemblyPreviewBody, readonly file: string) {
    this.answered = new Promise(resolve => {
      this.resolveAnswer = resolve;
    });
  }

  answer(answer: PreviewAnswer): void {
    this.resolveAnswer(answer);
  }
}

/** The preview that owns the slot: its token, its file, whether its scene is on screen, and its package pins as planned. */
class ActivePreview {
  /** Whether the pages show its scene (a scene of the file's own code replaces it). */
  showing = false;
  /** Each library package's pin as planned for its first use (`name@version` → plan), kept for the preview's life. */
  readonly pins = new Map<string, PackageAdoptionPlan>();

  constructor(readonly token: string, readonly file: string) {}
}

/**
 * The live preview of an assembly dialog (G4): `POST /api/assembly-preview`
 * renders the file on screen with the dialog's edit applied **in memory** —
 * the edit its Apply would write, planned by the writer's own planner
 * ({@link AssemblyPreviewRequest}) and applied as the editor's round trip
 * applies it — as the session's scene, opaque, in its own appearance; the
 * editor's buffer, the disk and `fluidcad.json` are never touched. A
 * library package the definition comes from resolves through the very pin
 * Apply writes, held in memory for the preview's renders
 * (`PackageAdoption.planForUse`, `SceneHost.setRenderOverlay`).
 *
 * The rules:
 * - **One preview per session**, owned by a token. A request with another
 *   token supersedes the one showing (`assembly-preview-ended`,
 *   `superseded`); that token's late requests are answered `superseded`.
 * - **Latest wins** (P4): at most one preview render runs and at most one
 *   waits; a newer request replaces the waiting one, which is answered
 *   `superseded` at once (`newer-request`). The edit is applied when the
 *   render starts, onto the editor's code as it is then.
 * - A preview render takes a render version like every render: one that a
 *   later render (the editor, a save, `/end`) overtook is never shown
 *   (`newer-render`), and its `render-version` pings go out as any
 *   render's do.
 * - Its scene goes to the pages with `preview: { token }` and without the
 *   panels' `params`/`properties`/`configurations`; the editor hosts never
 *   receive it.
 * - **A scene that isn't the preview's ends it showing** — any
 *   `scene-rendered` without its token, or `scene-closed` — announced as
 *   `assembly-preview-ended` (`replaced` / `closed`) before that scene goes
 *   out ({@link noteBroadcast}). A replaced preview may ask again.
 * - `POST /api/assembly-preview/end` ends it (`end`) and, when its scene is
 *   the session's, renders the file's own code again — the template cache
 *   brings back what the preview replaced.
 * - Every answer carries timings (P7): the server's phases and the
 *   engine's generated-part report.
 */
export class AssemblyPreviews {
  /** Tokens ended by `/end` or taken over: their late requests are refused, never shown. Bounded. */
  static readonly ENDED_TOKENS_KEPT = 64;

  private active: ActivePreview | null = null;
  private running: PreviewJob | null = null;
  private waiting: PreviewJob | null = null;
  private readonly endedTokens = new Set<string>();

  constructor(private readonly deps: AssemblyPreviewDeps) {}

  /** The token whose preview owns the slot, or null. */
  get activeToken(): string | null {
    return this.active?.token ?? null;
  }

  /** `POST /api/assembly-preview`: render the dialog's edit as the session's scene (see the class). */
  async request(body: unknown): Promise<PreviewAnswer> {
    const request = AssemblyPreviewRequest.parse(body);
    if (!request) {
      return { status: 400, body: { error: 'Invalid request body' } };
    }
    const file = this.deps.engine.getCurrentFileName();
    if (!file) {
      return { status: 404, body: { error: 'No active scene' } };
    }
    if (normalizePath(request.filePath) !== normalizePath(file)) {
      return { status: 422, body: { success: false, reason: `${request.filePath} is not the file on screen — open it to preview an edit of it.` } };
    }
    if (detectKind(file) !== 'assembly') {
      return { status: 422, body: { success: false, reason: 'A preview shows an assembly — open a *.assembly.js file first.' } };
    }
    if (this.endedTokens.has(request.token)) {
      return AssemblyPreviews.superseded(request.token, 'ended');
    }
    if (this.active && this.active.token !== request.token) {
      this.finish('superseded');
    }
    if (!this.active || this.active.file !== file) {
      // A new preview — or the same dialog over another file on screen,
      // whose package pins are planned again for it.
      this.active = new ActivePreview(request.token, file);
    }
    const job = new PreviewJob(request, file);
    if (this.running) {
      this.waiting?.answer(AssemblyPreviews.superseded(this.waiting.request.token, 'newer-request'));
      this.waiting = job;
    } else {
      void this.run(job);
    }
    return job.answered;
  }

  /**
   * `POST /api/assembly-preview/end`: the dialog closed without writing
   * (Cancel). The token is done; when the session's scene is its preview's
   * (the render in flight lands first), the file's own code renders again
   * and that render's outcome answers. A token whose preview isn't the
   * scene any more answers `inactive` and renders nothing.
   */
  async end(body: unknown): Promise<PreviewAnswer> {
    const token = (body as { token?: unknown } | null | undefined)?.token;
    if (typeof token !== 'string' || !AssemblyPreviewRequest.TOKEN.test(token)) {
      return { status: 400, body: { error: 'Invalid request body' } };
    }
    if (this.active?.token === token) {
      this.finish('end');
    } else {
      this.rememberEnded(token);
    }
    // The render in flight may be this preview's: it lands (unshown) before
    // the scene is checked, so it is never left standing as the session's.
    await this.running?.answered;
    const file = this.deps.engine.getCurrentFileName();
    if (!file || this.deps.engine.previewTokenOf(file) !== token) {
      return { status: 200, body: { state: 'inactive', token } };
    }
    const code = this.deps.engine.getCurrentCode() ?? await readFile(file, 'utf8').catch((): null => null);
    if (code === null) {
      return { status: 404, body: { error: `${file} can't be read.` } };
    }
    const outcome = await this.deps.renderSaved(file, code);
    return { status: 200, body: { ...outcome, token } };
  }

  /**
   * Every message for the pages passes here first (index.ts's broadcast):
   * a scene that isn't the showing preview's — or the scene closing — ends
   * it showing, announced before that scene goes out.
   */
  noteBroadcast(msg: ServerToUIMessage): void {
    const active = this.active;
    if (!active) {
      return;
    }
    if (msg.type === 'scene-closed') {
      this.finish('closed');
      return;
    }
    if (msg.type === 'scene-rendered' && active.showing && msg.preview?.token !== active.token) {
      active.showing = false;
      this.announceEnded(active.token, 'replaced');
    }
  }

  /** Run `job` in the slot; the waiting one runs after it. */
  private async run(job: PreviewJob): Promise<void> {
    this.running = job;
    try {
      job.answer(await this.render(job));
    } catch (error: any) {
      job.answer({ status: 500, body: { error: error?.message ?? String(error) } });
    } finally {
      this.running = null;
      const next = this.waiting;
      this.waiting = null;
      if (next) {
        void this.run(next);
      }
    }
  }

  /** Plan, apply and render one request; answer how it went. */
  private async render(job: PreviewJob): Promise<PreviewAnswer> {
    const { request } = job;
    const active = this.active;
    if (!active || active.token !== request.token) {
      return AssemblyPreviews.superseded(request.token, 'ended');
    }
    const startedAt = performance.now();
    const queueMs = startedAt - job.receivedAt;
    const planned = await this.edited(request, active);
    if ('status' in planned) {
      return { status: planned.status, body: { success: false, reason: planned.reason, ...(planned.code ? { code: planned.code } : {}), token: request.token } };
    }
    const editMs = performance.now() - startedAt;
    if (this.active !== active) {
      return AssemblyPreviews.superseded(request.token, 'ended');
    }

    const version = this.deps.versions.next();
    this.deps.broadcast({ type: 'render-version', version, state: 'start' });
    const clock = new RenderClock();
    const rendered = await this.deps.engine.renderPreview({
      token: request.token,
      code: planned.code,
      pins: planned.pins,
      detail: request.detail,
      clock,
    });
    if (!rendered) {
      return { status: 503, body: { error: 'The engine is not running.', token: request.token } };
    }
    if (!this.deps.versions.isLatest(version)) {
      return AssemblyPreviews.superseded(request.token, 'newer-render');
    }
    if (this.active !== active) {
      return AssemblyPreviews.superseded(request.token, 'ended');
    }
    const timings = (sendMs: number, payloadBytes: number): PreviewTimings => ({
      totalMs: RenderClock.round(performance.now() - job.receivedAt),
      queueMs: RenderClock.round(queueMs),
      editMs: RenderClock.round(editMs),
      waitMs: RenderClock.round(clock.get('wait')),
      evaluateMs: RenderClock.round(clock.get('evaluate')),
      compareMs: RenderClock.round(clock.get('compare')),
      renderMs: RenderClock.round(clock.get('render')),
      collectMs: RenderClock.round(clock.get('collect')),
      sendMs: RenderClock.round(sendMs),
      payloadBytes,
    });
    if (rendered.ok === false) {
      const compileError = CompileErrors.describe(job.file, rendered.error, rendered.packageProblems);
      this.deps.broadcast({ type: 'render-version', version, state: 'error', absPath: compileError.filePath });
      return { status: 200, body: { state: 'compile-error', token: request.token, version, compileError, timings: timings(0, 0) } };
    }
    const { data } = rendered;
    const sendStart = performance.now();
    const bytes = this.deps.broadcast(AssemblyPreviews.sceneMessage(data));
    const sendMs = performance.now() - sendStart;
    this.deps.broadcast({ type: 'render-version', version, state: 'end', absPath: data.absPath });
    active.showing = true;
    return {
      status: 200,
      body: {
        state: data.objectErrors.length > 0 ? 'build-error' : 'rendered',
        token: request.token,
        version,
        absPath: data.absPath,
        ...(data.objectErrors.length > 0 ? { objectErrors: data.objectErrors } : {}),
        timings: timings(sendMs, typeof bytes === 'number' ? bytes : 0),
        generated: rendered.generated satisfies GeneratedRenderReport | null,
      },
    };
  }

  /**
   * The code `request` previews — the editor's code as it is now with the
   * writer's edit applied in memory — and the pins it resolves through;
   * or why the writer (or the pin its Apply writes) would refuse it.
   */
  private async edited(request: AssemblyPreviewBody, active: ActivePreview): Promise<{ code: string; pins: PackageDependencies } | DispatchRefusal> {
    const plan = AssemblyPreviewRequest.plan(request, active.file, this.deps.workspacePath);
    if ('status' in plan) {
      return plan;
    }
    let code: string | null;
    if (plan.spec) {
      const applied = await this.deps.edits.applyInMemory(plan.spec);
      if ('status' in applied) {
        return applied;
      }
      code = applied.code;
    } else {
      code = this.deps.engine.getCurrentCode();
      if (code === null) {
        return { status: 404, reason: 'No live code buffer for the file on screen.' };
      }
    }
    const pins: PackageDependencies = {};
    for (const owner of plan.adoptions) {
      if (!this.deps.workspacePath) {
        break;
      }
      const key = `${owner.name}@${owner.version}`;
      let pin = active.pins.get(key);
      if (!pin) {
        try {
          pin = await PackageAdoption.planForUse(this.deps.workspacePath, owner.name, owner.version);
        } catch (err) {
          const refusal = PackageAdoption.refusal(err);
          if (refusal) {
            return refusal;
          }
          throw err;
        }
        active.pins.set(key, pin);
      }
      if (pin.pin === 'pin') {
        pins[pin.name] = { version: pin.version, integrity: pin.integrity };
      }
    }
    return { code, pins };
  }

  /** End the preview owning the slot: its waiting request is answered, the pages are told, and (but for `replaced`) its token is done. */
  private finish(reason: UIAssemblyPreviewEndedMessage['reason']): void {
    const active = this.active;
    if (!active) {
      return;
    }
    this.active = null;
    if (reason !== 'replaced') {
      this.rememberEnded(active.token);
    }
    if (this.waiting) {
      this.waiting.answer(AssemblyPreviews.superseded(this.waiting.request.token, 'ended'));
      this.waiting = null;
    }
    this.announceEnded(active.token, reason);
  }

  private announceEnded(token: string, reason: UIAssemblyPreviewEndedMessage['reason']): void {
    this.deps.broadcast({ type: 'assembly-preview-ended', token, reason });
  }

  private rememberEnded(token: string): void {
    this.endedTokens.delete(token);
    this.endedTokens.add(token);
    while (this.endedTokens.size > AssemblyPreviews.ENDED_TOKENS_KEPT) {
      this.endedTokens.delete(this.endedTokens.values().next().value!);
    }
  }

  /**
   * The preview's scene as the pages get it: the scene fields every render
   * carries and `preview: { token }`, without the panels' params,
   * properties and configurations — those keep describing the editor's code.
   */
  private static sceneMessage(data: SceneRenderedData): ServerToUIMessage {
    return {
      type: 'scene-rendered',
      result: data.result,
      absPath: data.absPath,
      sceneKind: data.sceneKind,
      ...sceneUnitFields(data),
      ...sceneStopFields(data),
      breakpointHit: data.breakpointHit,
      objectWarnings: data.objectWarnings,
      ...(data.assembly ? { assembly: data.assembly } : {}),
      ...scenePreviewFields(data),
    };
  }

  private static superseded(token: string, reason: SupersededReason): PreviewAnswer {
    return { status: 200, body: { state: 'superseded', token, reason } };
  }
}
