// FluidCadServer: owns the scene host, live buffers, renders, rollbacks and parameter overrides.

import { createHash } from 'crypto';
import { basename, join, relative } from 'path';
import { existsSync, readFileSync, realpathSync } from 'fs';
import { readFile } from 'fs/promises';
import type { LoadModuleOptions, SceneHost } from '../host/scene-host.ts';
import { LocalSceneHost } from '../host/local-scene-host.ts';
import { normalizePath } from '../normalize-path.ts';
import { findLibIdentityMismatch } from '../lib-identity.ts';
import { detectKind, type FluidScriptKind } from '../file-kind.ts';
import { BreakpointHit } from '../../../lib/dist/common/breakpoint-hit.js';
import { DEFAULT_CONFIGURATION, type ConfigurationsSummary } from '../../../lib/dist/param-registry.js';
import { readWorkspaceConfiguration, rememberWorkspaceConfiguration } from '../routes/workspace-state.ts';
import { listBreakpoints, type BreakpointSite } from '../code-editor/index.ts';
import {
  createParamRegistry,
  getParamRegistry,
  listFeatureExports,
  getUnitRegistry,
  setParamRegistry,
  setUnitRegistry,
  type AssemblyExportOutcome,
  type AssemblyExportPose,
  type FeatureSlotRequest,
  type FeatureSlotSynthesis,
  type ImportReport,
  type InterferenceRequest,
  ParamKey,
  SessionParamOverrides,
  type ParamDefinition,
  type ParamRegistry,
  type ParamVal,
  type SessionParamOverride,
  type RenderChangeTracker,
  type ResolveSelectionRequest,
  type ResolveSelectionResult,
  type SceneInterferenceOutcome,
  type SceneValidationOutcome,
  type ValidateSceneRequest,
  FeatureKey,
} from '../../../lib/dist/index.js';
import { scanFileForParts, type PartScanResult } from '../part-catalog/scan.ts';
import { FeatureScanner, type FeatureScanResult } from '../feature-catalog/scan.ts';
import { FeatureModules } from '../feature-catalog/walk.ts';
import { FeatureRebuilds, type OwedRebuilds } from './feature-rebuilds.ts';
import { collectRenderedPartProperties, collectSceneProperties, type RenderedPartProperties } from './properties.ts';
import { MeasureEntityResolver, type MeasureEntity } from '../measure-entities.ts';
import type { CompileError, PackageProblem } from '../ws-protocol.ts';
import { PROJECT_CONFIG_FILENAME, readProjectConfig, writeProjectMaterials, type LengthUnit, type ProjectMaterial, type ProjectMaterials } from '../project-config.ts';
import { PartPropertiesAggregator, type PartProperties } from './part-properties.ts';
import { RenderInputs, type RenderFingerprint } from '../render-inputs.ts';
import type {
  CustomGhostRequest,
  FeatureGhostOutcome,
  FeatureGhostRequest,
  GhostFrame,
  KernelCustomGhostRequest,
  GhostSolid,
  SketchRegionPreview,
  SketchRegionsOutcome,
  SketchRegionsRequest,
  SketchOffsetPlanChain,
  SketchOffsetPlanOutcome,
  SketchOffsetPlanRequest,
} from './ghost-requests.ts';
import { sanitizeParams } from './params.ts';
import type {
  InterfereUnavailable,
  MeasureEntitiesOutcome,
  MeasureRef,
  ResolveSelectionUnavailable,
  SelectionBoundary,
  SelectionSynthesisOptions,
  ValidateUnavailable,
} from './query-types.ts';
import type { ObjectBuildError, ObjectBuildWarning, RenderOptions, SceneConfigurations, SceneConfigurationTable, SceneRenderedData, ScratchRender } from './render-types.ts';
import type { SceneManager } from './scene-manager.ts';
import type { SerializedAssembly } from './assembly-types.ts';
import { TimelineHistory } from './timeline-history.ts';
import { PackageRoots } from '../packages/package-roots.ts';
import { PackageManifests } from '../packages/package-manifests.ts';
import type { PackageResolveError, ResolvedPackage } from '../packages/resolver.ts';
import { AssemblySummary } from './scene-summary.ts';
import type { SceneSummary, SceneSummaryObject, SceneSummaryShape, ShapeList, ShapeListEntry } from './scene-summary.ts';
import { ShapeLabels } from '../../../lib/dist/rendering/shape-labels.js';
import { ShapeExportSelection, type ShapeExportRefusal, type ShapeSelection } from './shape-export-selection.ts';

/** How many synthesis answers one rendered scene keeps (see `synthesizeApplyFeatureCached`). */
const SYNTHESIS_MEMO_LIMIT = 32;

/**
 * `sessionId` is the per-renderer state key. In desktop mode it equals the
 * file path being edited (so per-file state survives switching files). In
 * hub mode it's a WebSocket connection UUID (so concurrent viewers stay
 * isolated). Map keys called `sessionId` accept either flavour.
 */

export class FluidCadServer {
  private host: SceneHost;
  private sceneManager: SceneManager | undefined;
  private initDiagnostic: string | null = null;
  /** Set by `init`; empty on the hub path, which has no workspace on disk. */
  private workspacePath = '';

  // Per-session render output, scene cache, and param overrides. Desktop's
  // sessionId is the normalized filePath; hub mode's sessionId is the WS
  // connection UUID. Maps must be cleared via `destroySession` on hub-side
  // disconnect to avoid leaks.
  private previousScenes: Map<string, any> = new Map();
  /**
   * Selector synthesis answers per rendered scene (see
   * {@link synthesizeApplyFeatureCached}). Keyed weakly by the scene object,
   * so a re-render — a new scene — starts empty and nothing outlives it.
   */
  private synthesisMemo = new WeakMap<object, Map<string, any>>();
  private readonly timelineHistory = new TimelineHistory();
  // A session's last complete render, served again on `process-file` — but
  // only while `fingerprint` (every file it was built from + the overrides it
  // ran with) still matches; see RenderInputs. `registry` is the param
  // registry that render populated, re-installed on a hit so the params the
  // server answers with are this file's, not the last rendered file's.
  private renderingCache = new Map<string, { data: SceneRenderedData; fingerprint: RenderFingerprint; registry: ParamRegistry }>();
  // Records the last successful render per session as `{ paramsHash, data }`.
  // Any subsequent render request short-circuits when the new params hash to
  // the same value — avoids redundant OCC work when desktop producers see the
  // same code+params, or hub clients re-emit the same param mutation. The
  // hash covers the entry's own text; `fingerprint` covers everything else
  // the render was built from.
  private lastRendered = new Map<string, { paramsHash: string; data: SceneRenderedData; fingerprint: RenderFingerprint }>();
  // The fingerprint of each session's last successful render, or null when
  // its inputs could not be enumerated (such a render is never re-served).
  private renderFingerprints = new Map<string, RenderFingerprint | null>();
  // The files the engine read during each session's last successful render
  // that no module import shows (a load()'s asset and its sidecars, a
  // text()'s workspace font), as the engine named them. The fingerprint holds
  // them too, mixed with the module graph; kept apart here for what a share
  // link carries (getRenderAssets).
  private renderAssets = new Map<string, readonly string[]>();
  private renderInputs: RenderInputs;
  // Live buffers this server seeded from disk (no editor sent them), with the
  // hashes of what was seeded — a seed follows its file when the disk changes.
  private diskSeeds = new Map<string, { bufferHash: string; diskHash: string }>();
  // Per session, the Parameters-panel values (never written to source) and
  // the bookkeeping behind them: keyed by part + label (`ParamKey`), with the
  // default each `param()` was authored with as of the last render — an
  // override is a delta over that default, so when the file re-declares it
  // the override is stale and gets dropped instead of shadowing the value
  // the code now asks for. See `SessionParamOverrides`.
  private paramSessions = new Map<string, SessionParamOverrides>();
  /**
   * The `configurations()` row each session shows, by name — absent means
   * `Default`, the literals (`docs/assembly-configurations-plan.md` §3.3).
   * Installed on the registry before every render; never written to source.
   * Desktop sessions remember it per file in `.fluidcad/editor-state.json`.
   */
  private activeConfigurations = new Map<string, string>();
  /** Sessions whose active configuration was read back from the editor state (or chosen explicitly) — seeded once. */
  private configurationSeeded = new Set<string>();
  /** The rows each session's last render declared, merged and per table — what `GET /api/configurations` answers between renders. */
  /**
   * Each session's parameter definitions as its last finished render
   * declared them. Requests read these rather than the live registry: a
   * render in progress (the one an edit's save just triggered) clears and
   * refills the registry between its awaits, and a request handled in
   * between would see half a model.
   */
  private lastParamDefinitions = new Map<string, ParamDefinition[]>();
  private lastConfigurations = new Map<string, Pick<ConfigurationsSummary, 'names' | 'rows'> & { tables: SceneConfigurationTable[] }>();
  // What file each session is rendering. For desktop, sessionId === filePath
  // (set lazily on first processFile call). For hub, set explicitly via
  // createSession with the bundle's manifest entry.
  private sessionFiles = new Map<string, string>();

  // Serializes OCC calls across all sessions. OCC isn't thread-safe and we
  // share one engine instance per host process; concurrent param edits from
  // multiple hub clients have to queue. Promise-chain pattern: each render
  // awaits the previous one's settlement before starting.
  private renderMutex: Promise<unknown> = Promise.resolve();

  // Monotonic ghost-request counter. Dialog previews arrive per keystroke and
  // queue behind the mutex; one whose successor already landed skips its OC
  // work rather than meshing geometry nobody will draw.
  private ghostGeneration = 0;

  /**
   * Custom feature builders loaded for ghosts, by module and export name.
   * Kept until a render or a scan re-evaluates the workspace modules, so a
   * dialog's keystrokes don't each load the feature's module again.
   */
  private ghostBuilders = new Map<string, Function>();
  /**
   * A feature module (or a module one imports) changed on disk since the
   * workspace modules were last evaluated: the next ghost evaluates them
   * again before it loads a builder, so it draws the saved code.
   */
  private ghostCodeStale = false;
  /** The custom features each session's cached scene was built with older code of. */
  private readonly featureRebuilds = new FeatureRebuilds();
  /**
   * The installed packages each session's cached scene was built with, by
   * name: when a render resolves another version or tree of one (a pin
   * switched), that package's features rebuild — their ids stay while
   * their code moved, so the compare would otherwise keep the old geometry.
   */
  private readonly sessionPackages = new Map<string, Map<string, ResolvedPackage>>();
  /** The package imports the last render refused (see {@link getPackageProblems}). */
  private packageProblems: PackageResolveError[] = [];
  /** Each installed package's own `materials` map (its reduced `fluidcad.json`), by directory. */
  private readonly packageMaterialMaps = new Map<string, ProjectMaterials | null>();

  private currentFileName: string = '';
  private currentFilePath: string = '';
  private lastRollbackStop: number = -1;
  /** Part id of the last part-scoped rollback; null for global/full views. */
  private lastRollbackScopePartId: string | null = null;
  /**
   * The project's `fluidcad.json` materials map as of the last scene start
   * (`reseedProjectConfig`); null for a project without one and for the hub
   * path, which has no workspace to read.
   */
  private projectMaterials: ProjectMaterials | null = null;
  /**
   * Whether the last full render paused at a breakpoint. Rollbacks don't
   * re-run the module, so they carry this last known state — without it the
   * UI's breakpoint indicator can't survive a browser refresh whose replayed
   * scene message is a rollback broadcast.
   */
  private lastBreakpointHit = false;
  /** The `breakpoint();` the last full render paused on, when it is in the rendered file. */
  private lastBreakpointAt: BreakpointSite | null = null;
  /** Every `breakpoint();` of the rendered file as of the last full render. */
  private lastBreakpoints: BreakpointSite[] = [];
  private compileError: CompileError | null = null;

  constructor(host: SceneHost = new LocalSceneHost()) {
    this.host = host;
    this.renderInputs = new RenderInputs(host);
  }

  getCurrentCode(): string | null {
    if (!this.currentFileName) return null;
    return this.host.getBuffer(this.currentFileName);
  }

  /**
   * The breakpoint statement the build is paused on, when the pause is in
   * the rendered file. Continue and an edit dialog's apply lift exactly this
   * one, leaving any stop further down the file pending.
   */
  getActiveBreakpoint(): BreakpointSite | null {
    return this.lastBreakpointHit ? this.lastBreakpointAt : null;
  }

  /** Where a pause landed in `fileName`, or null for a pause in another file (or an unlocated one). */
  private static breakpointSiteIn(hit: BreakpointHit, fileName: string): BreakpointSite | null {
    const loc = hit.sourceLocation;
    if (!loc || normalizePath(loc.filePath.replace('virtual:live-render:', '')) !== normalizePath(fileName)) {
      return null;
    }
    return { line: loc.line, column: loc.column };
  }

  /**
   * Param definitions from the current file's last finished render —
   * currentValue is override-aware, and sourceLocation addresses the
   * `param()` call that declared each one. Never a render still in
   * progress ({@link lastParamDefinitions}); the live registry only before
   * the file has rendered at all.
   */
  getParamDefinitions(): ParamDefinition[] {
    return this.lastParamDefinitions.get(normalizePath(this.currentFileName)) ?? getParamRegistry().getDefinitions();
  }

  /**
   * The instances the current file's last render inserted, each with the
   * `property()` values its part computed and the `insert()` call's
   * location — what a dialog's expression fields offer and the ghost reads
   * as `<binding>.properties.<name>`. Empty for a part file, or before any
   * render.
   */
  getRenderedInstances(): SerializedAssembly['instances'] {
    const scene = this.currentFileName ? this.previousScenes.get(this.currentFileName) : undefined;
    if (!scene || !this.sceneManager) {
      return [];
    }
    return this.sceneManager.getAssemblyData(scene)?.instances ?? [];
  }

  /**
   * The default variant of each `part()` definition the current file's
   * last render built, with the `property()` values it computed and the
   * `part()` call's location — what a dialog's expression fields offer and
   * the ghost reads as `<definition>.properties.<name>`. Empty before any
   * render.
   */
  getRenderedParts(): RenderedPartProperties[] {
    const scene = this.currentFileName ? this.previousScenes.get(this.currentFileName) : undefined;
    if (!scene) {
      return [];
    }
    return collectRenderedPartProperties(scene);
  }

  async init(workspacePath: string) {
    this.workspacePath = workspacePath;
    await this.host.init(workspacePath);

    const initFilePath = normalizePath(join(workspacePath, 'init.js'));
    if (!existsSync(initFilePath)) {
      // No engine to build with. Recorded rather than thrown so the server
      // still starts — the UI comes up, the file opens in the editor, and the
      // one thing that can't work says why. Reported by every render path;
      // see `describeMissingEngine`.
      this.initDiagnostic =
        'This workspace has no init.js, so there is no engine to build the model with. '
        + `Run \`npx fluidcad init\` in ${workspacePath}, then reload.`;
      return;
    }

    const { default: _sceneManager } = await this.host.loadModule(initFilePath);
    this.sceneManager = await _sceneManager;
    this.initDiagnostic = null;

    // Only meaningful once a workspace `init.js` has actually imported the
    // kernel — the hub path installs its manager via `setSceneManager` and
    // never comes through here. Deliberately fatal: the failure it catches
    // is silent, and a half-working session is worse than a clear stop.
    const mismatch = findLibIdentityMismatch(workspacePath, this.host.steeredEngineEntry?.() ?? null);
    if (mismatch) {
      throw new Error(mismatch.message);
    }
  }

  /**
   * Why this workspace cannot render anything, or null when it can.
   *
   * Every render path returns null when there is no `SceneManager`, and a null
   * that reaches the UI as *nothing at all* leaves it waiting on a spinner
   * forever. Callers turn this into a visible error instead.
   */
  describeMissingEngine(): string | null {
    return this.sceneManager ? null : this.initDiagnostic ?? 'This workspace has no FluidCAD engine loaded.';
  }

  /**
   * Capture an already-initialized SceneManager. Used by the hub-mode entry
   * after running the packed bundle once to materialize the engine globals.
   */
  setSceneManager(manager: SceneManager): void {
    this.sceneManager = manager;
  }

  /**
   * Run `fn` with exclusive access to the OCC engine. The mutex is process-
   * wide: in hub mode concurrent client sessions land here too. Order is
   * first-come, first-served via Promise chain.
   */
  private async serialized<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.renderMutex;
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => { release = resolve; });
    this.renderMutex = next;
    try {
      await prev;
      return await fn();
    } finally {
      release();
    }
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle (hub mode)
  // ---------------------------------------------------------------------------

  createSession(sessionId: string, entryFilePath: string): void {
    this.sessionFiles.set(sessionId, normalizePath(entryFilePath));
  }

  destroySession(sessionId: string): void {
    const scene = this.previousScenes.get(sessionId);
    if (scene) {
      this.sceneManager?.disposeScene?.(scene);
    }
    this.previousScenes.delete(sessionId);
    this.timelineHistory.delete(sessionId);
    this.renderingCache.delete(sessionId);
    this.lastRendered.delete(sessionId);
    this.renderFingerprints.delete(sessionId);
    this.renderAssets.delete(sessionId);
    this.paramSessions.delete(sessionId);
    this.activeConfigurations.delete(sessionId);
    this.configurationSeeded.delete(sessionId);
    this.lastConfigurations.delete(sessionId);
    this.lastParamDefinitions.delete(sessionId);
    this.sessionFiles.delete(sessionId);
    this.featureRebuilds.forget(sessionId);
    this.sessionPackages.delete(sessionId);
  }

  /**
   * Re-render the session's entry, ignoring caches. Hub clients call this
   * after editing a param. Returns the fresh render or null if no manager.
   */
  async recomputeForSession(sessionId: string): Promise<SceneRenderedData | null> {
    const filePath = this.sessionFiles.get(sessionId);
    if (!filePath) return null;
    this.renderingCache.delete(sessionId);
    this.lastRendered.delete(sessionId);
    return this.processFileInternal(sessionId, filePath, true);
  }

  // ---------------------------------------------------------------------------
  // Render — internal core used by both desktop and hub entry points
  // ---------------------------------------------------------------------------

  /**
   * Re-read `fluidcad.json` before every scene start: the project unit and
   * the project materials. The workspace's SceneManager seeds `projectUnit`
   * once, from init.js — without this a unit edited while the server runs
   * (the unit chip's "Project unit" menu) would only show up after a
   * restart; the materials map is the server's own (lib never reads it),
   * so a material added by hand is resolvable on the next render. The
   * file is part of the render fingerprint (`captureFingerprint`), so an
   * edit also misses the render cache. The unit seed is guarded for a
   * workspace engine that predates the field, and the hub path, which
   * installs its manager without a workspace, keeps whatever unit it was
   * built with and the built-in materials alone.
   */
  private reseedProjectConfig(): void {
    if (!this.workspacePath || !this.sceneManager) {
      return;
    }
    const config = readProjectConfig(this.workspacePath);
    this.projectMaterials = config.materials;
    if ('projectUnit' in this.sceneManager) {
      (this.sceneManager as { projectUnit: LengthUnit }).projectUnit = config.unit ?? 'mm';
    }
  }

  /**
   * The project's `materials` map as the last scene start read it (a fresh
   * read when no render has run yet), or null without one. What
   * `GET /api/materials` merges over the built-ins and what part rows
   * resolve their `.material(id)` against.
   */
  getProjectMaterials(): ProjectMaterials | null {
    if (this.projectMaterials === null && this.workspacePath) {
      this.projectMaterials = readProjectConfig(this.workspacePath).materials;
    }
    return this.projectMaterials;
  }

  /**
   * Re-read the project's `materials` map right away — after a write into
   * `fluidcad.json` — so `GET /api/materials` answers from the file even
   * when no render (the usual re-seed) follows.
   */
  reloadProjectMaterials(): void {
    this.projectMaterials = this.workspacePath ? readProjectConfig(this.workspacePath).materials : null;
  }

  /**
   * Copy one material into the project's `fluidcad.json` map (every other
   * key and entry kept) — what a pick of a global material does before the
   * part's source names its id. Answers the config path, or null without a
   * workspace to write into.
   */
  adoptProjectMaterial(id: string, entry: ProjectMaterial): string | null {
    if (!this.workspacePath) {
      return null;
    }
    const configPath = writeProjectMaterials(this.workspacePath, { ...(this.getProjectMaterials() ?? {}), [id]: entry });
    this.reloadProjectMaterials();
    return configPath;
  }

  /**
   * The unit a rendered scene's lengths are in. Optional read: the
   * workspace's fluidcad install may predate units, and a scene without the
   * accessor is an mm scene — exactly what every file was before units.
   */
  private static sceneUnitOf(scene: unknown): LengthUnit {
    return (scene as { unit?: LengthUnit } | null | undefined)?.unit ?? 'mm';
  }

  /**
   * What the scene's root file declared with `unit()`, or null when it
   * follows the project unit. Optional for the same reason as `sceneUnitOf`;
   * an engine without the accessor can't say, and "undeclared" is the
   * answer that keeps the chip's menu honest (no unit gets a false check).
   */
  private static sceneDeclaredUnitOf(scene: unknown): LengthUnit | null {
    return (scene as { declaredUnit?: LengthUnit | null } | null | undefined)?.declaredUnit ?? null;
  }

  /**
   * The project unit the scene manager is seeded with — re-read from
   * `fluidcad.json` before every render (`reseedProjectConfig`), and for the
   * hub whatever it was built with. An engine predating units is an mm
   * project.
   */
  private projectUnitOf(): LengthUnit {
    return (this.sceneManager as { projectUnit?: LengthUnit } | null)?.projectUnit ?? 'mm';
  }

  /**
   * The tracker for a render that asked for a change summary, or undefined
   * — for every other render, and for an engine that predates the summary.
   */
  private renderChangeTracker(options: RenderOptions | undefined): RenderChangeTracker | undefined {
    if (!options?.changes) {
      return undefined;
    }
    return this.sceneManager?.trackRenderChanges?.();
  }

  private async processFileInternal(
    sessionId: string,
    filePath: string,
    ignoreCache: boolean,
    changes?: RenderChangeTracker,
  ): Promise<SceneRenderedData | null> {
    return this.serialized(async () => {
      if (!this.sceneManager) {
        return null;
      }

      const normalizedFileName = filePath.replace('virtual:live-render:', '');
      this.currentFileName = normalizedFileName;
      this.currentFilePath = filePath;

      const sceneKind: FluidScriptKind = detectKind(normalizedFileName) ?? 'part';
      // Before the cache check: the configuration is part of what a cached
      // render was built with, and a reopened workspace shows what was left.
      this.seedActiveConfiguration(sessionId, normalizedFileName);

      // A session that owes a feature rebuild has a cached render built with
      // the old code, whatever its inputs hash to now.
      if (!ignoreCache && !this.featureRebuilds.owes(sessionId)) {
        const fromCache = this.renderingCache.get(sessionId);
        if (fromCache && this.isFingerprintCurrent(sessionId, fromCache.fingerprint)) {
          // Everything a render would have left behind: the stop, the
          // breakpoint state, and this file's params as the live registry.
          this.lastRollbackStop = fromCache.data.rollbackStop;
          this.lastRollbackScopePartId = fromCache.data.rollbackScopePartId ?? null;
          this.lastBreakpointHit = fromCache.data.breakpointHit === true;
          this.lastBreakpointAt = fromCache.data.breakpointAt ?? null;
          this.lastBreakpoints = fromCache.data.breakpoints ?? [];
          this.timelineHistory.setCurrent(sessionId, fromCache.data.timeline);
          this.compileError = null;
          setParamRegistry(fromCache.registry);
          return fromCache.data;
        }
      }

      // Taken before the modules load: a feature module saved from here on
      // is the next render's to rebuild, since this one may have read it
      // before the save.
      const owed = this.featureRebuilds.take(sessionId);
      let compared = false;
      try {
        const readTimelineSource = (path: string): string | null => {
          const buffer = this.host.getBuffer(path);
          if (buffer !== null) return buffer;
          try { return readFileSync(path, 'utf8'); } catch { return null; }
        };
        const timelineSources = new Map([normalizedFileName, ...this.timelineHistory.sourceFiles(sessionId)]
          .map(path => [path, readTimelineSource(path)]));
        this.reseedProjectConfig();
        let scene = sceneKind === 'assembly'
          ? this.sceneManager.startAssemblyScene()
          : this.sceneManager.startScene();
        this.sceneManager.setCurrentFile(normalizedFileName);
        this.invalidateModules();

        const registry = createParamRegistry();
        this.paramSessions.get(sessionId)?.install(registry);
        // The row `configurations()` installs as the layer under the
        // overrides; null is the literals.
        registry.setActiveConfiguration(this.activeConfigurations.get(sessionId) ?? null);

        let breakpointHit = false;
        let breakpointAt: BreakpointSite | null = null;
        try {
          await this.host.loadModule(filePath, FluidCadServer.entryExports(scene, normalizedFileName));
        }
        catch (e) {
          if (e instanceof BreakpointHit) {
            breakpointHit = true;
            breakpointAt = FluidCadServer.breakpointSiteIn(e, normalizedFileName);
          } else {
            throw e;
          }
        }

        // part() definitions are lazy — a part-kind entry scene materializes
        // the definitions the entry file declares but nothing exported or
        // inserted, so the open file stays WYSIWYG; parts other modules
        // declare are left out. Assembly scenes build strictly via insert().
        // (Optional call: the workspace's fluidcad install may predate lazy
        // definitions.)
        if (sceneKind !== 'assembly') {
          try {
            (scene as { materializeLeftoverDefinitions?: () => void }).materializeLeftoverDefinitions?.();
          } catch (e) {
            if (e instanceof BreakpointHit) {
              breakpointHit = true;
              breakpointAt = FluidCadServer.breakpointSiteIn(e, normalizedFileName);
            } else {
              throw e;
            }
          }
        }
        this.lastBreakpointHit = breakpointHit;
        this.lastBreakpointAt = breakpointAt;
        // Every stop the file holds — the paused one and the pending ones
        // after it — so the timeline can mark them all. A file the parser
        // can't read (mid-edit) keeps the previous list.
        const mainSource = timelineSources.get(normalizedFileName);
        if (typeof mainSource === 'string') {
          try {
            this.lastBreakpoints = await listBreakpoints(mainSource);
          } catch (error) {
            console.warn('Could not list the file\'s breakpoints:', error);
          }
        }

        // A bare `assembly('name', () => {...});` statement is a LAZY
        // definition nothing runs — without this check the render is a
        // silently empty scene. Skipped on a breakpoint hit (the file
        // stopped early, so an unrun definition is expected). (Optional
        // call: the workspace's fluidcad install may predate tracking.)
        const dangling: string[] | undefined = breakpointHit
          ? undefined
          : (scene as { getDanglingDefinitionNames?: () => string[] }).getDanglingDefinitionNames?.();
        if (dangling && dangling.length > 0) {
          const name = dangling[0];
          throw new Error(
            `assembly('${name}') is defined but never rendered — export a function returning it `
            + `(export const myAssembly = () => assembly('${name}', () => {...});) so this file `
            + `renders it standalone, or insert() it from another assembly.`,
          );
        }

        const params = getParamRegistry().getDefinitions();
        this.lastParamDefinitions.set(normalizePath(sessionId), params);
        this.paramSession(sessionId).settle(registry);
        const configurations = this.settleConfiguration(sessionId, normalizedFileName, registry, breakpointHit);
        // After the overrides settled: a render can drop overrides the source
        // re-declared (or fall back from a configuration the file no longer
        // declares), and the fingerprint must describe what is in effect.
        const engineInputs = this.engineRenderInputs();
        const fingerprint = this.captureFingerprint(sessionId, normalizedFileName, engineInputs);
        this.renderFingerprints.set(sessionId, fingerprint);
        this.renderAssets.set(sessionId, engineInputs);
        this.packageProblems = this.host.packageProblems?.() ?? [];
        const packages = this.host.resolvedPackages?.() ?? [];

        if (this.previousScenes.has(sessionId)) {
          const previousScene = this.previousScenes.get(sessionId);
          const rebuild = owed ? await this.featureIdsOwed(owed, fingerprint) : new Set<string>();
          for (const id of this.packageFeatureIdsChanged(sessionId, packages)) {
            rebuild.add(id);
          }
          scene = rebuild.size > 0
            ? this.sceneManager.compare(previousScene, scene, changes, { rebuild })
            : this.sceneManager.compare(previousScene, scene, changes);
        }
        compared = true;

        this.previousScenes.set(sessionId, scene);
        this.sessionPackages.set(sessionId, new Map(packages.map(pkg => [pkg.name, pkg])));

        this.sceneManager.renderScene(scene);
        const result = scene.getRenderedObjects();
        const renderChanges = changes ? changes.summarize(scene) : undefined;

        for (const obj of result) {
          if (obj.sourceLocation) {
            obj.sourceLocation.filePath = obj.sourceLocation.filePath.replace('virtual:live-render:', '');
          }
        }
        this.stampPackageRows(result);

        const assembly = this.sceneManager.getAssemblyData(scene);
        if (assembly) {
          for (const inst of assembly.instances) {
            if (inst.sourceLocation) {
              inst.sourceLocation.filePath = inst.sourceLocation.filePath.replace('virtual:live-render:', '');
            }
          }
          for (const mate of assembly.mates) {
            if (mate.sourceLocation) {
              mate.sourceLocation.filePath = mate.sourceLocation.filePath.replace('virtual:live-render:', '');
            }
          }
          for (const occ of assembly.occurrences ?? []) {
            if (occ.sourceLocation) {
              occ.sourceLocation.filePath = occ.sourceLocation.filePath.replace('virtual:live-render:', '');
            }
          }
          for (const connector of assembly.connectors ?? []) {
            if (connector.sourceLocation) {
              connector.sourceLocation.filePath = connector.sourceLocation.filePath.replace('virtual:live-render:', '');
            }
          }
          for (const replicate of assembly.replicates ?? []) {
            if (replicate.sourceLocation) {
              replicate.sourceLocation.filePath = replicate.sourceLocation.filePath.replace('virtual:live-render:', '');
            }
          }
          for (const relation of assembly.relations ?? []) {
            if (relation.sourceLocation) {
              relation.sourceLocation.filePath = relation.sourceLocation.filePath.replace('virtual:live-render:', '');
            }
          }
        }

        // Read after the module ran: a file's `unit()` statement declares the
        // unit during evaluation, and the scene resolves it lazily.
        const unit = FluidCadServer.sceneUnitOf(scene);
        const declaredUnit = FluidCadServer.sceneDeclaredUnitOf(scene);

        // The last row — or, paused inside a part, that part's paused row
        // (the rest of the file stays live). A workspace lib predating the
        // stop reports the last row.
        const { stop, scopePartId } = this.sceneManager.renderStop?.(scene)
          ?? { stop: result.length - 1, scopePartId: null };
        this.lastRollbackStop = stop;
        this.lastRollbackScopePartId = scopePartId;
        this.compileError = null;

        // Names and structure come from real evaluations. History never
        // retains meshes and never changes the live result or rollback indices.
        let timeline: SceneRenderedData['timeline'];
        this.timelineHistory.setCurrent(sessionId);
        if (sceneKind === 'part' && [...timelineSources].every(([path, text]) => readTimelineSource(path) === text)) {
          try {
            timeline = await this.timelineHistory.update(sessionId, result, breakpointHit,
              path => timelineSources.has(path) ? timelineSources.get(path)! : readTimelineSource(path));
          } catch (error) {
            // Presentation history must not turn a successful build into an
            // error (e.g. when a source cannot be parsed during an edit).
            console.warn('Could not retain timeline history:', error);
          }
        }

        const data: SceneRenderedData = {
          absPath: normalizedFileName,
          sceneKind,
          unit,
          declaredUnit,
          projectUnit: this.projectUnitOf(),
          result,
          rollbackStop: stop,
          ...(scopePartId ? { rollbackScopePartId: scopePartId } : {}),
          breakpointHit,
          ...(breakpointHit ? { breakpointStop: stop } : {}),
          ...(breakpointHit && breakpointAt ? { breakpointAt } : {}),
          breakpoints: this.lastBreakpoints,
          ...(timeline ? { timeline } : {}),
          params,
          configurations,
          // A part file's published values; an assembly's inserted parts
          // are not the assembly's own, so it lists none.
          ...(sceneKind === 'part' ? { properties: collectSceneProperties(scene) } : {}),
          objectErrors: FluidCadServer.collectObjectErrors(result),
          objectWarnings: this.collectObjectWarnings(result),
          ...(assembly ? { assembly } : {}),
        };

        // No other session's cache is touched: a dependent's cached render
        // is validated against this file's content when it is next asked
        // for, so viewing a file costs its dependents nothing and editing
        // one makes them miss.
        if (!filePath.startsWith('virtual:live-render') && fingerprint) {
          this.renderingCache.set(sessionId, { data, fingerprint, registry });
        } else {
          this.renderingCache.delete(sessionId);
        }

        // The change summary describes THIS render only — never the cached copy.
        return renderChanges ? { ...data, changes: renderChanges } : data;
      }
      catch (error) {
        // Read before the modules are invalidated: that starts the resolver over.
        this.packageProblems = this.host.packageProblems?.() ?? [];
        if (owed && !compared) {
          // The cached scene is still the one built with the old code.
          this.featureRebuilds.restore(sessionId, owed);
        }
        this.invalidateModules();
        console.log('Error processing file:', error);
        throw error;
      }
    });
  }

  /**
   * Mark every row a package file's statement made with that package's
   * name and version (`row.package`): installed packages are read-only
   * (K8), so the UI hides a row's edit affordances by it. A fork of a
   * package elsewhere in the workspace is ordinary code and stays unmarked.
   */
  private stampPackageRows(rows: any[]): void {
    const owners = new Map<string, { name: string; version: string } | null>();
    for (const row of rows) {
      const file = row?.sourceLocation?.filePath;
      if (typeof file !== 'string') {
        continue;
      }
      let owner = owners.get(file);
      if (owner === undefined) {
        const location = this.packageOwnerOf(file);
        owner = location ? { name: location.name, version: location.version } : null;
        owners.set(file, owner);
      }
      if (owner) {
        row.package = owner;
      } else if (row.package) {
        delete row.package;
      }
    }
  }

  /** The installed package that owns `file` in this workspace (`PackageRoots.owner`), or null; always null without a workspace. */
  packageOwnerOf(file: string) {
    if (!this.workspacePath) {
      return null;
    }
    return PackageRoots.owner(file, this.workspacePath);
  }

  /**
   * The feature ids of every package whose resolution changed since the
   * session's cached scene was built — another version, another tree, or
   * added or dropped — read from the packages' manifests, old and new.
   */
  private packageFeatureIdsChanged(sessionId: string, packages: ResolvedPackage[]): Set<string> {
    const ids = new Set<string>();
    const before = this.sessionPackages.get(sessionId) ?? new Map<string, ResolvedPackage>();
    const now = new Map(packages.map(pkg => [pkg.name, pkg]));
    for (const name of new Set([...before.keys(), ...now.keys()])) {
      const old = before.get(name);
      const current = now.get(name);
      if (old && current && old.directory === current.directory && old.integrity === current.integrity) {
        continue;
      }
      for (const pkg of [old, current]) {
        if (pkg) {
          for (const id of FluidCadServer.packageFeatureIds(pkg)) {
            ids.add(id);
          }
        }
      }
    }
    return ids;
  }

  /**
   * A package's feature keys (`@acme/feature-tests:standoff`): the plain ids
   * its `manifest.json` lists (`PackageManifests`), keyed by the name it is
   * installed as, as its scene objects are typed. None when it can't be read.
   */
  private static packageFeatureIds(pkg: ResolvedPackage): string[] {
    return PackageManifests.of(pkg.directory)?.features.map(feature => FeatureKey.of(pkg.name, feature.id)) ?? [];
  }

  /**
   * The package imports the last render refused — a package not pinned,
   * not installed, changed, or too new for this engine — one per package,
   * each with its sentence and, when it is about a pin, the pinned version.
   * Empty after a render that loaded every package it imports.
   */
  getPackageProblems(): PackageProblem[] {
    return this.packageProblems.map(problem => ({
      code: problem.code,
      name: problem.packageName,
      version: problem.version,
      message: problem.message,
    }));
  }

  /**
   * The feature ids a render owes a rebuild: those named directly, and
   * those each saved feature module defines — read from the module as this
   * render evaluated it (`fingerprint`: what it read). A module the render
   * no longer reads is left alone: nothing of it is in the scene, and
   * loading it would evaluate it into the live scene. Runs with the OCC
   * mutex held, after the modules loaded.
   */
  private async featureIdsOwed(owed: OwedRebuilds, fingerprint: RenderFingerprint | null): Promise<Set<string>> {
    const ids = new Set(owed.ids);
    if (owed.modules.size === 0 || !fingerprint || typeof this.host.loadModuleRaw !== 'function') {
      return ids;
    }
    for (const modulePath of owed.modules) {
      if (!fingerprint.files.has(modulePath)) {
        continue;
      }
      try {
        const namespace = await this.host.loadModuleRaw(modulePath);
        for (const { meta } of listFeatureExports(namespace)) {
          ids.add(meta.id);
        }
      } catch {
        // It loaded for this render, so it comes from the loader's cache;
        // should it not, its statements keep the cached build.
      }
    }
    return ids;
  }

  /**
   * The files the engine read while building the render that just ran
   * (optional call — the workspace's fluidcad install may predate it).
   */
  private engineRenderInputs(): string[] {
    return (this.sceneManager as { getRenderInputs?: () => string[] } | null)?.getRenderInputs?.() ?? [];
  }

  /**
   * Fingerprint the render that just ran for this session: its module graph,
   * the project config, and the files the engine read while building
   * ({@link engineRenderInputs}).
   */
  private captureFingerprint(sessionId: string, entryFile: string, engineInputs: readonly string[]): RenderFingerprint | null {
    const extraFiles: string[] = [];
    if (this.workspacePath) {
      extraFiles.push(join(this.workspacePath, PROJECT_CONFIG_FILENAME));
    }
    extraFiles.push(...engineInputs);
    return this.renderInputs.capture({ entryFile, extraFiles, params: this.overridesKey(sessionId) });
  }

  /**
   * Whether a cached render of this session is still what a render would
   * produce. Disk-seeded buffers among its inputs are brought up to date
   * first — the module loader serves the buffer, so a seed left behind its
   * file would validate (and render) against content nobody holds any more.
   */
  private isFingerprintCurrent(sessionId: string, fingerprint: RenderFingerprint): boolean {
    for (const file of fingerprint.files.keys()) {
      this.refreshDiskSeed(file);
    }
    return this.renderInputs.isCurrent(fingerprint, this.overridesKey(sessionId));
  }

  /** The session's override state, created on first use. */
  private paramSession(sessionId: string): SessionParamOverrides {
    let session = this.paramSessions.get(sessionId);
    if (!session) {
      session = new SessionParamOverrides();
      this.paramSessions.set(sessionId, session);
    }
    return session;
  }

  /**
   * Close the loop on a render's configuration: remember the rows it
   * declared, and when the row the session asked for is not among them (the
   * row was deleted or renamed in source) fall back to Default for good —
   * the registry already rendered the literals — and say so in the payload.
   * A render a breakpoint paused may have stopped before the
   * `configurations()` statement, so it keeps the name and reports what ran.
   */
  private settleConfiguration(
    sessionId: string,
    fileName: string,
    registry: ParamRegistry,
    breakpointHit: boolean,
  ): SceneConfigurations {
    const summary = registry.getConfigurations();
    const tables = FluidCadServer.configurationTables(registry);
    this.lastConfigurations.set(sessionId, { names: summary.names, rows: summary.rows, tables });
    const wanted = this.activeConfigurations.get(sessionId);
    let notice: string | undefined;
    if (wanted !== undefined && !breakpointHit && !summary.names.includes(wanted)) {
      this.activeConfigurations.delete(sessionId);
      this.persistActiveConfiguration(sessionId, fileName);
      notice = summary.names.length > 0
        ? `Configuration '${wanted}' is no longer declared — showing Default. Declared: ${summary.names.map(n => `'${n}'`).join(', ')}.`
        : `Configuration '${wanted}' is no longer declared — showing Default.`;
    }
    return {
      active: summary.active,
      names: summary.names,
      rows: summary.rows,
      tables,
      modified: this.isModified(sessionId),
      ...(notice ? { notice } : {}),
    };
  }

  /** The render's tables, each under the body that declares it — `SceneConfigurations.tables`. */
  /**
   * An entry render's export hook: once the module's exports are resolved,
   * the scene refuses the parts of `file` the module does not export (lib
   * `PartRules` — every part is exported). Optional on the scene: an engine
   * predating the rule has no `refuseUnexportedParts`.
   */
  private static entryExports(scene: unknown, file: string): LoadModuleOptions {
    return {
      onExports: (exports) => {
        (scene as { refuseUnexportedParts?: (exports: [string, unknown][], file: string) => void })
          .refuseUnexportedParts?.(exports, file);
      },
    };
  }

  private static configurationTables(registry: ParamRegistry): SceneConfigurationTable[] {
    return registry.getConfigurationTables().map((table) => ({
      body: table.definition,
      names: table.names.slice(),
      rows: table.rows,
    }));
  }

  /** Whether the session's override layer holds anything — tweaks on top of the active row. */
  private isModified(sessionId: string): boolean {
    return (this.paramSessions.get(sessionId)?.size ?? 0) > 0;
  }

  /** `fileName` as the editor state keys it: workspace-relative, forward slashes. */
  private workspaceRelative(fileName: string): string {
    return normalizePath(relative(this.workspacePath, fileName.replace('virtual:live-render:', '')));
  }

  /**
   * The first render of a desktop session reads back the configuration the
   * workspace remembers for the file. Hub sessions have no workspace on disk
   * and start on Default; an explicit {@link selectConfiguration} counts as
   * seeded, so a later render never overwrites the choice.
   */
  private seedActiveConfiguration(sessionId: string, fileName: string): void {
    if (this.configurationSeeded.has(sessionId)) {
      return;
    }
    this.configurationSeeded.add(sessionId);
    if (!this.workspacePath) {
      return;
    }
    const remembered = readWorkspaceConfiguration(this.workspacePath, this.workspaceRelative(fileName));
    if (remembered !== null && remembered !== DEFAULT_CONFIGURATION) {
      this.activeConfigurations.set(sessionId, remembered);
    }
  }

  /** Write the session's active configuration (or its absence) to the workspace's editor state. */
  private persistActiveConfiguration(sessionId: string, fileName: string): void {
    if (!this.workspacePath) {
      return;
    }
    try {
      rememberWorkspaceConfiguration(
        this.workspacePath,
        this.workspaceRelative(fileName),
        this.activeConfigurations.get(sessionId) ?? null,
      );
    } catch (error) {
      // Forgetting which row was showing is a papercut — a read-only
      // workspace still switches fine.
      console.warn('Could not remember the active configuration:', error);
    }
  }

  // ---------------------------------------------------------------------------
  // Desktop API — sessionId is implicit (filePath)
  // ---------------------------------------------------------------------------

  async processFile(filePath: string, ignoreCache = false): Promise<SceneRenderedData | null> {
    filePath = normalizePath(filePath);
    const sessionId = filePath.replace('virtual:live-render:', '');
    this.sessionFiles.set(sessionId, sessionId);
    await this.seedLiveBufferFromDisk(sessionId);
    return this.processFileInternal(sessionId, filePath, ignoreCache);
  }

  /**
   * A raw-path render (the save-triggered `process-file`, the in-page host's
   * file open) runs the file from disk, but every reader of "the current
   * code" — `getCurrentCode`: feature/parse, the edit preflight, the side-ref
   * resolvers — only knows the live-render overlay. Until the editor's first
   * live-update for the file the current code was null, so the timeline's
   * double-click refused with "No live code buffer" and only worked on the
   * second try (the breakpoint the first gesture inserted pushed a
   * live-update). Seed the overlay with the disk content this render is
   * about to run; a buffer the editor already sent stays — the module loader
   * serves it for the raw path too, so disk never masks it. A seed is not an
   * editor buffer, though: it follows its file (see `refreshDiskSeed`).
   */
  private async seedLiveBufferFromDisk(fileName: string): Promise<void> {
    if (this.host.getBuffer(fileName) !== null) {
      this.refreshDiskSeed(fileName);
      return;
    }
    let code: string;
    try {
      code = await readFile(fileName, 'utf8');
    } catch {
      // Unreadable: the render reports that itself.
      return;
    }
    this.seedBuffer(fileName, code);
  }

  private seedBuffer(fileName: string, code: string): void {
    this.host.setBuffer(`virtual:live-render:${fileName}`, code);
    const diskHash = this.renderInputs.diskHash(fileName);
    if (diskHash !== null) {
      this.diskSeeds.set(fileName, { bufferHash: RenderInputs.hashOf(code), diskHash });
    }
  }

  /**
   * Re-seed a buffer this server read from disk once the file changed on disk
   * underneath it (a git checkout, an agent writing files) — otherwise the
   * seed would mask the new content from every later render. A buffer an
   * editor has since replaced is the editor's: left alone, and forgotten here.
   */
  private refreshDiskSeed(fileName: string): void {
    const seed = this.diskSeeds.get(fileName);
    if (!seed) {
      return;
    }
    const buffer = this.host.getBuffer(fileName);
    if (buffer === null || RenderInputs.hashOf(buffer) !== seed.bufferHash) {
      this.diskSeeds.delete(fileName);
      return;
    }
    const diskHash = this.renderInputs.diskHash(fileName);
    if (diskHash === null || diskHash === seed.diskHash) {
      return;
    }
    try {
      this.seedBuffer(fileName, readFileSync(fileName, 'utf8'));
    } catch {
      // Vanished between the stat and the read: the render reports that itself.
    }
  }

  async updateLiveCode(fileName: string, code: string, options?: RenderOptions): Promise<SceneRenderedData | null> {
    fileName = normalizePath(fileName);
    const changes = this.renderChangeTracker(options);

    // Dedup against the last successful render. Multiple producers (editor
    // live-update, save-triggered process-file, watcher, MCP /api/render)
    // commonly hand us identical content; without this short-circuit each
    // would trigger a redundant OCC pass. paramsHash mixes code content with
    // current param overrides so a param change invalidates the cache.
    const paramsHash = this.computeParamsHash(fileName, code);
    const cached = this.lastRendered.get(fileName);
    // The live-render buffer takes the new code whether or not the render is
    // deduped. The module loader serves this overlay for the raw file path
    // too (save-triggered process-file), so skipping the update would leave
    // a stale overlay from an earlier broken live-update — the next save
    // would then compile the old broken code and report its error even
    // though editor and disk both hold valid content. It also has to land
    // before the fingerprint check below, which reads the entry through it.
    const id = `virtual:live-render:${fileName}`;
    this.host.setBuffer(id, code);
    // The hash vouches for the entry's own text; the fingerprint for every
    // file it imports — an edited part or helper module makes this miss.
    if (cached && cached.paramsHash === paramsHash && this.isFingerprintCurrent(fileName, cached.fingerprint)
      && !this.featureRebuilds.owes(fileName)) {
      this.compileError = null;
      this.currentFileName = fileName;
      this.currentFilePath = `virtual:live-render:${fileName}`;
      this.lastRollbackStop = cached.data.rollbackStop;
      this.lastRollbackScopePartId = cached.data.rollbackScopePartId ?? null;
      this.lastBreakpointHit = cached.data.breakpointHit === true;
      this.lastBreakpointAt = cached.data.breakpointAt ?? null;
      this.lastBreakpoints = cached.data.breakpoints ?? [];
      this.timelineHistory.setCurrent(fileName, cached.data.timeline);
      // A deduplicated render built nothing: the summary says so rather
      // than leaving the caller to guess from a missing field.
      const scene = changes ? this.previousScenes.get(fileName) : undefined;
      if (changes && scene) {
        return { ...cached.data, changes: changes.summarizeUnchanged(scene) };
      }
      return cached.data;
    }

    this.renderingCache.delete(fileName);
    this.sessionFiles.set(fileName, fileName);
    const result = await this.processFileInternal(fileName, id, true, changes);
    if (result) {
      // Re-hash after the render, not before: a render can drop param
      // overrides the source re-declared, and a key cut from the pre-render
      // overrides would never match again — every later keystroke on
      // identical code would re-render.
      // The change summary describes THIS render; a deduplicated later one
      // built nothing, so the cached data never carries it.
      const { changes: _changes, ...unchanged } = result;
      const fingerprint = this.renderFingerprints.get(fileName);
      if (fingerprint) {
        this.lastRendered.set(fileName, {
          paramsHash: this.computeParamsHash(fileName, code),
          data: result.changes ? unchanged : result,
          fingerprint,
        });
      } else {
        this.lastRendered.delete(fileName);
      }
    }
    return result;
  }

  /**
   * Fold an edited DEPENDENCY's code in — a part file rewritten by a
   * cross-file edit (the assembly mate dialog's connector flows) while an
   * assembly is being viewed — and re-render the CURRENT file against it.
   * The updated file gets the same live-buffer overlay `updateLiveCode`
   * would set; the current file's dedup entries are dropped so this render
   * (and any later identical live-update) sees the new dependency; the
   * current scene/file identity is left untouched.
   */
  async updateDependencyCode(fileName: string, code: string, options?: RenderOptions): Promise<SceneRenderedData | null> {
    fileName = normalizePath(fileName);
    this.host.setBuffer(`virtual:live-render:${fileName}`, code);
    this.lastRendered.delete(fileName);
    const current = this.currentFileName;
    if (!current) {
      return null;
    }
    this.renderingCache.delete(current);
    this.lastRendered.delete(current);
    return this.processFileInternal(current, this.currentFilePath ?? current, true, this.renderChangeTracker(options));
  }

  async rollbackFromUI(index: number, scope?: 'part'): Promise<SceneRenderedData | null> {
    return this.rollback(this.currentFileName, index, scope);
  }

  /**
   * Evaluate one candidate file and inspect its exports for insertable parts
   * (Insert dialog). Serialized with renders on the OCC mutex; the scan runs
   * in throwaway scenes and touches neither the session caches nor the
   * compare baselines, so the live session's incremental rebuilds are
   * unaffected. Returns null before init.
   */
  async scanPartsInFile(filePath: string, projectUnit: LengthUnit = 'mm'): Promise<PartScanResult | null> {
    return this.serialized(async () => {
      if (!this.sceneManager) {
        return null;
      }
      // The scan re-evaluates the workspace modules.
      this.forgetGhostBuilders();
      return scanFileForParts(this.host, this.sceneManager, normalizePath(filePath), { projectUnit });
    });
  }

  /**
   * Evaluate one `*.feature.js` module and snapshot the feature builders it
   * exports (the feature catalog). Serialized with renders on the OCC
   * mutex, in a throwaway scene, like the part scan. Returns null before
   * init.
   */
  async scanFeaturesInFile(filePath: string): Promise<FeatureScanResult | null> {
    return this.serialized(async () => {
      if (!this.sceneManager) {
        return null;
      }
      // The scan re-evaluates the workspace modules.
      this.forgetGhostBuilders();
      return FeatureScanner.scanFile(this.host, this.sceneManager, normalizePath(filePath));
    });
  }

  /**
   * The unit the current file's last render is in — what every length the
   * measure/properties commands return is expressed in. `mm` before the
   * first render, matching what those commands' callers assumed pre-units.
   */
  getSceneUnit(): LengthUnit {
    return FluidCadServer.sceneUnitOf(this.previousScenes.get(this.currentFileName));
  }

  /**
   * Whether the host holds a live editor buffer overlaying this file — such
   * files must never be served from a disk-mtime-keyed scan cache, and their
   * candidate prefilter should read the buffer, not the disk.
   */
  hasLiveBuffer(filePath: string): boolean {
    return this.host.getBuffer(normalizePath(filePath)) !== null;
  }

  /** The live buffer's content for a file, if the host holds one. */
  getLiveBuffer(filePath: string): string | null {
    return this.host.getBuffer(normalizePath(filePath));
  }

  async recomputeCurrentFile(forceFullRebuild = false, options?: RenderOptions): Promise<SceneRenderedData | null> {
    if (!this.currentFilePath) {
      return null;
    }
    const sessionId = this.currentFileName;
    this.renderingCache.delete(sessionId);
    this.lastRendered.delete(sessionId);
    const changes = this.renderChangeTracker(options);
    if (forceFullRebuild) {
      // Drop the incremental-compare baseline so every object is rebuilt from
      // scratch instead of being carried over as cached. Without this, an
      // unchanged file compares equal at every index, the whole scene is
      // marked cached, and the render reuses all geometry — so the explicit
      // "Recompute scene" action does no visible work and reports no build
      // timings (buildDurationMs is only recorded for objects that rebuild).
      // Param edits keep the baseline so slider drags stay fast.
      const staleScene = this.previousScenes.get(sessionId);
      if (staleScene) {
        // No compare will run, so the summary's "before" side is captured
        // here, while the scene is still alive: nothing matched, everything
        // the next render builds pairs with what this one had.
        if (changes) {
          changes.captureBefore(staleScene, new Map());
        }
        this.sceneManager?.disposeScene?.(staleScene);
      }
      this.previousScenes.delete(sessionId);
    }
    return this.processFileInternal(sessionId, this.currentFilePath, true, changes);
  }

  /**
   * View-only rollback re-emission. `scope: 'part'` asks for a part-scoped
   * view: only the target index's enclosing part is truncated, everything
   * else keeps its full render (falls back to the classic global prefix
   * when the index lands outside any part). The scene manager owns the
   * clamp, the scope derivation, and the echoed stop (normalized to the
   * scene tip when a scoped rollback hides nothing).
   */
  async rollback(fileName: string, index: number, scope?: 'part'): Promise<SceneRenderedData | null> {
    if (!this.sceneManager) {
      return null;
    }

    const scene = this.previousScenes.get(fileName);
    if (!scene) {
      return null;
    }

    // The manager may come from an older workspace install whose
    // rollbackScene returns the scene and knows no options — that renders
    // the classic global prefix, so report it as one.
    const rollbackResult = this.sceneManager.rollbackScene(scene, index, { partScoped: scope === 'part' });
    const { stop, scopePartId } = typeof rollbackResult?.stop === 'number'
      ? rollbackResult as { stop: number; scopePartId: string | null }
      : { stop: index, scopePartId: null };
    const result = scene.getRenderedObjects();
    this.stampPackageRows(result);
    const assembly = this.sceneManager.getAssemblyData(scene);

    this.lastRollbackStop = stop;
    this.lastRollbackScopePartId = scopePartId;

    return {
      absPath: fileName,
      sceneKind: detectKind(fileName) ?? 'part',
      unit: FluidCadServer.sceneUnitOf(scene),
      declaredUnit: FluidCadServer.sceneDeclaredUnitOf(scene),
      projectUnit: this.projectUnitOf(),
      result,
      rollbackStop: stop,
      ...(scopePartId ? { rollbackScopePartId: scopePartId } : {}),
      // A rollback doesn't re-run the module — the paused state persists.
      breakpointHit: this.lastBreakpointHit,
      ...(this.lastBreakpointHit ? { breakpointStop: this.sceneManager.renderStop?.(scene)?.stop ?? result.length - 1 } : {}),
      ...(this.lastBreakpointHit && this.lastBreakpointAt ? { breakpointAt: this.lastBreakpointAt } : {}),
      breakpoints: this.lastBreakpoints,
      ...(this.timelineHistory.get(fileName) ? { timeline: this.timelineHistory.get(fileName) } : {}),
      objectErrors: FluidCadServer.collectObjectErrors(result),
      objectWarnings: this.collectObjectWarnings(result),
      ...(assembly ? { assembly } : {}),
    };
  }

  async importFile(workspacePath: string, fileName: string, data: string): Promise<ImportReport | void> {
    if (!this.sceneManager) {
      throw new Error('SceneManager not initialized');
    }

    const binaryData = Buffer.from(data, 'base64');
    // Older lib installs return nothing here; the import route tolerates that.
    return await this.sceneManager.importFile(workspacePath, fileName, binaryData);
  }

  getShapeProperties(shapeId: string): any {
    if (!this.sceneManager) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.getShapeProperties(scene, shapeId);
  }

  /**
   * The mass properties of the part row `partId` summed over its final
   * solids, with mass when its material resolves — see
   * `PartPropertiesAggregator.compute`. Null without a scene or when no
   * part row carries that id. In an assembly the id is the template part's
   * row id (`SerializedInstance.partId`); every instance of it shares the
   * numbers, in the part's own frame.
   */
  getPartProperties(partId: string): PartProperties | null {
    if (!this.sceneManager) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    const manager = this.sceneManager;
    return PartPropertiesAggregator.compute(
      scene.getRenderedObjects(),
      partId,
      (shapeId) => manager.getShapeProperties(scene, shapeId),
      this.getProjectMaterials(),
      this.getSceneUnit(),
      (file) => this.packageMaterialsFor(file),
    );
  }

  /** The render's non-fatal notices — see `PartPropertiesAggregator.collectWarnings`. */
  private collectObjectWarnings(result: any[]): ObjectBuildWarning[] {
    return PartPropertiesAggregator.collectWarnings(result, this.getProjectMaterials(), (file) => this.packageMaterialsFor(file));
  }

  /**
   * The materials a part defined in `file` resolves against when an
   * installed package owns the file: that package's own `fluidcad.json`
   * map (null when it has none — the built-ins alone), never the project's.
   * Undefined for a file no package owns. Read once per package directory.
   */
  packageMaterialsFor(file: string): ProjectMaterials | null | undefined {
    const owner = this.packageOwnerOf(file);
    if (!owner) {
      return undefined;
    }
    if (!this.packageMaterialMaps.has(owner.directory)) {
      this.packageMaterialMaps.set(owner.directory, readProjectConfig(owner.directory).materials);
    }
    return this.packageMaterialMaps.get(owner.directory) ?? null;
  }

  getFaceProperties(shapeId: string, faceIndex: number): any {
    if (!this.sceneManager) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.getFaceProperties(scene, shapeId, faceIndex);
  }

  /** The features whose buckets hold a face or an edge of a rendered solid, oldest first; null without a scene or a manager that answers. */
  getShapeOwners(shapeId: string, sub: { type: 'face' | 'edge'; index: number }): { id: string; type: string; uniqueType: string; name: string }[] | null {
    if (!this.sceneManager?.getShapeOwners) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.getShapeOwners(scene, shapeId, sub);
  }

  getEdgeProperties(shapeId: string, edgeIndex: number): any {
    if (!this.sceneManager) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.getEdgeProperties(scene, shapeId, edgeIndex);
  }

  measure(refs: MeasureRef[]): any {
    if (!this.sceneManager) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.measure(scene, refs);
  }

  /**
   * Measure entities named by index refs or by filter expressions, mixed.
   * Filter entities resolve through `resolveSelection` first — one match
   * each, or a refusal listing the candidates — and the measured entity
   * carries where it came from (`expression`, `sceneObjectId`, `part`).
   */
  measureEntities(entities: MeasureEntity[]): MeasureEntitiesOutcome {
    const resolved = MeasureEntityResolver.resolve(entities, request => this.resolveSelection(request));
    if (resolved.ok === false) {
      return resolved;
    }
    const result = this.measure(resolved.refs);
    if (!result) {
      return { ok: false, code: 'no-match', error: 'Entity not found' };
    }
    const measured = Array.isArray(result.entities) ? result.entities : [];
    for (let i = 0; i < measured.length; i++) {
      const provenance = resolved.provenance[i];
      if (provenance) {
        Object.assign(measured[i], provenance);
      }
    }
    return { ok: true, result };
  }

  /**
   * Evaluate a filter expression (or explicit picks) against the current
   * scene at the requested scope and statement boundary — the lib's
   * SelectionResolver owns the scoping rule. With synthesis options the
   * result also carries the selector the language would write for the
   * matches. `no-scene` before the first render, `unsupported` on a
   * workspace engine that predates the resolver.
   */
  resolveSelection(
    request: ResolveSelectionRequest,
    synthesis?: SelectionSynthesisOptions,
  ): ResolveSelectionResult | ResolveSelectionUnavailable {
    if (!this.sceneManager) {
      return { ok: false, code: 'no-scene', reason: this.describeMissingEngine() ?? 'No engine loaded' };
    }
    if (!this.sceneManager.resolveSelection) {
      return { ok: false, code: 'unsupported', reason: 'This workspace engine predates filter-expression resolution; update its fluidcad install.' };
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return { ok: false, code: 'no-scene', reason: 'No rendered scene — open and render a file first.' };
    }
    return this.sceneManager.resolveSelection(scene, request, synthesis);
  }

  /**
   * Kernel soundness of the shapes the current scene renders — the lib's
   * SceneValidator owns the checks and the addressing. `no-scene` before
   * the first render, `unsupported` on a workspace engine that predates it.
   */
  validate(request: ValidateSceneRequest): SceneValidationOutcome | ValidateUnavailable {
    if (!this.sceneManager) {
      return { kind: 'refused', code: 'no-scene', reason: this.describeMissingEngine() ?? 'No engine loaded' };
    }
    if (!this.sceneManager.validate) {
      return { kind: 'refused', code: 'unsupported', reason: 'This workspace engine predates geometry validation; update its fluidcad install.' };
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return { kind: 'refused', code: 'no-scene', reason: 'No rendered scene — open and render a file first.' };
    }
    return this.sceneManager.validate(scene, request);
  }

  /**
   * Shared volume between bodies of the current scene — the lib's
   * SceneInterference owns the pairing rule and the verdict. `no-scene`
   * before the first render, `unsupported` on a workspace engine that
   * predates it.
   */
  interfere(request: InterferenceRequest): SceneInterferenceOutcome | InterfereUnavailable {
    if (!this.sceneManager) {
      return { kind: 'refused', code: 'no-scene', reason: this.describeMissingEngine() ?? 'No engine loaded' };
    }
    if (!this.sceneManager.interfere) {
      return { kind: 'refused', code: 'unsupported', reason: 'This workspace engine predates interference checking; update its fluidcad install.' };
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return { kind: 'refused', code: 'no-scene', reason: 'No rendered scene — open and render a file first.' };
    }
    return this.sceneManager.interfere(scene, request);
  }

  explainSelection(
    refs: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } }[],
    before?: SelectionBoundary,
  ): any {
    if (!this.sceneManager) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.explainSelection(scene, refs, before);
  }

  /**
   * Mesh the geometry an open feature dialog would produce, for the client
   * that asked. A side channel by design: it reads the live scene and writes
   * nothing back — no code, no scene state, no `scene-rendered` broadcast, no
   * mesh cached onto a scene shape — and the shapes it builds are freed
   * before it answers.
   *
   * All of that runs under `serialized`, so a render can't interleave with
   * the OCC calls. Requests arrive per keystroke: one that finds a newer
   * request already accepted drops out before doing any geometry work, and
   * the client discards its answer anyway.
   */
  async featureGhost(request: FeatureGhostRequest): Promise<FeatureGhostOutcome> {
    const generation = ++this.ghostGeneration;
    return this.serialized(async () => {
      if (generation !== this.ghostGeneration) {
        return { status: 200, reason: 'Superseded by a newer preview.' };
      }
      if (!this.sceneManager?.buildFeatureGhost) {
        return { status: 422, reason: 'This workspace kernel has no live geometry preview.' };
      }
      const scene = this.previousScenes.get(this.currentFileName);
      if (!scene) {
        return { status: 422, reason: 'No rendered scene' };
      }
      const kernelRequest = request.feature === 'custom' ? await this.customGhostRequest(request) : request;
      if ('error' in kernelRequest) {
        return { status: 422, reason: kernelRequest.error };
      }
      try {
        const result = this.sceneManager.buildFeatureGhost(scene, kernelRequest);
        if (result?.ok) {
          return {
            status: 200,
            solids: (result.solids ?? []) as GhostSolid[],
            ...(result.frames?.length ? { frames: result.frames as GhostFrame[] } : {}),
            ...(result.derived && Object.keys(result.derived).length ? { derived: { ...result.derived } } : {}),
          };
        }
        if (result?.paused === true) {
          // Not a failure: the build ran, slower than a live preview may.
          return { status: 200, reason: result.reason, paused: true };
        }
        return {
          status: 422,
          reason: result?.reason ?? 'Could not build the preview geometry.',
          surface: result?.surface === true || undefined,
        };
      } catch (err: any) {
        // A profile OCC can't sweep at the current values is an ordinary
        // mid-typing state — the dialog just shows no ghost.
        return { status: 200, reason: err?.message ?? 'Could not build the preview geometry.' };
      }
    });
  }

  /**
   * A custom feature's ghost as the kernel takes it: its builder in place of
   * the module and export that name it — the module loaded through the
   * workspace loader (see FeatureScanner.loadBuilder), once per render.
   * Runs with the OCC mutex held.
   */
  private async customGhostRequest(request: CustomGhostRequest): Promise<KernelCustomGhostRequest | { error: string }> {
    if (this.ghostCodeStale) {
      // A feature module was saved since the modules were last evaluated:
      // the loader's copy is the old code.
      this.invalidateModules();
    }
    const key = `${normalizePath(request.modulePath)}#${request.exportName}`;
    let builder = this.ghostBuilders.get(key);
    if (!builder) {
      const loaded = await FeatureScanner.loadBuilder(this.host, this.sceneManager!, request.modulePath, request.exportName);
      if (typeof loaded !== 'function') {
        return loaded;
      }
      builder = loaded;
      this.ghostBuilders.set(key, builder);
    }
    const { modulePath: _modulePath, exportName: _exportName, ...rest } = request;
    return { ...rest, builder };
  }

  /** Mark the workspace modules stale for the next load, and the builders loaded from them. */
  private invalidateModules(): void {
    this.forgetGhostBuilders();
    this.host.invalidateModule();
  }

  /** The workspace modules are about to be evaluated again: every builder a ghost loaded from them is stale. */
  private forgetGhostBuilders(): void {
    this.ghostBuilders.clear();
    this.ghostCodeStale = false;
  }

  /**
   * The region picker's faces for a profile — every closed region, keyed and
   * meshed, the dialog's current picks marked. Read-only over the rendered
   * scene, serialized against renders like the ghost; the answer goes back
   * to the one client that asked.
   */
  async sketchRegions(request: SketchRegionsRequest): Promise<SketchRegionsOutcome> {
    return this.serialized(async () => {
      if (!this.sceneManager?.buildSketchRegions) {
        return { status: 422, reason: 'This workspace kernel has no region picker.' };
      }
      const scene = this.previousScenes.get(this.currentFileName);
      if (!scene) {
        return { status: 422, reason: 'No rendered scene' };
      }
      try {
        const result = this.sceneManager.buildSketchRegions(scene, request);
        if (result?.ok) {
          return { status: 200, regions: (result.regions ?? []) as SketchRegionPreview[] };
        }
        return { status: 422, reason: result?.reason ?? 'Could not build the sketch regions.' };
      } catch (err: any) {
        return { status: 200, reason: err?.message ?? 'Could not build the sketch regions.' };
      }
    });
  }

  /**
   * The sketcher's constrained Offset plan: the picked edges offset by OCCT,
   * each result edge as the primitive the tool writes, plus the meshed
   * wires as the dialog's ghost. Read-only over the rendered scene,
   * serialized against renders like the ghost.
   */
  async sketchOffsetPlan(request: SketchOffsetPlanRequest): Promise<SketchOffsetPlanOutcome> {
    return this.serialized(async () => {
      if (!this.sceneManager?.planSketchOffset) {
        return { status: 422, reason: 'This workspace kernel has no constrained offset.' };
      }
      const scene = this.previousScenes.get(this.currentFileName);
      if (!scene) {
        return { status: 422, reason: 'No rendered scene' };
      }
      try {
        const result = this.sceneManager.planSketchOffset(scene, request);
        if (result?.ok) {
          const meshes = (result.meshes ?? []) as any[][];
          return {
            status: 200,
            chains: (result.chains ?? []) as SketchOffsetPlanChain[],
            solids: meshes.map(m => ({ meshes: m })),
          };
        }
        return { status: 422, reason: result?.reason ?? 'Could not plan the offset.' };
      } catch (err: any) {
        return { status: 200, reason: err?.message ?? 'Could not plan the offset.' };
      }
    });
  }

  synthesizeApplyFeature(
    refs: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } }[],
    feature: 'fillet' | 'chamfer' | 'shell' | 'sketch' | 'extrude' | 'sweep' | 'loft' | 'plane' | 'revolve' | 'wrap' | 'helix' | 'project' | 'offset' | 'connector' | 'expose' | 'hole' | 'color',
    value: number | string | undefined,
    chains: {
      seed: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } };
      members: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } }[];
    }[] = [],
    options?: {
      namer?: (producers: { line: number; nameHint: string }[]) => (string | null)[];
      bindable?: (producer: { line: number; featureType?: string }) => boolean;
      params?: { name: string; value: number }[];
      connector?: {
        anchor?: { kind: string; mode?: string; value?: number };
        rotate?: { axis: 'x' | 'y' | 'z' | { expr: string } | { ref: string }; angle: number | string };
        offset?: [number | string, number | string, number | string];
        instance?: { instanceId: string };
      };
    },
    before?: SelectionBoundary,
  ): any {
    if (!this.sceneManager) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.synthesizeApplyFeature(scene, refs, feature, value, chains, options, before);
  }

  /**
   * The selectors a custom feature's picked values write, every geometry
   * slot in one pass and checked against its picker — kind-agnostic, so no
   * feature names its own arm here. An edit's picks resolve against the
   * world before its statement. Null without a scene; a refusal on a
   * workspace kernel that predates custom feature pickers.
   */
  synthesizeFeatureSlots(
    request: FeatureSlotRequest,
    options?: SelectionSynthesisOptions,
    before?: SelectionBoundary,
  ): FeatureSlotSynthesis | { ok: false; reason: string } | null {
    if (!this.sceneManager) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    if (!this.sceneManager.synthesizeFeatureSlots) {
      return { ok: false, reason: "This workspace's FluidCAD version predates custom feature pickers — update its fluidcad dependency." };
    }
    return this.sceneManager.synthesizeFeatureSlots(scene, request, options, before);
  }

  /**
   * {@link synthesizeApplyFeature}, remembered for the rendered scene it ran
   * against. A dialog's preview and its Apply synthesize the same picks with
   * the same options over the same scene — on a large part that is a second
   * filter search of the whole model for the answer the preview already
   * holds. `optionsKey` stands for the function-valued options
   * (namer/bindable/params), which cannot be compared: callers pass the
   * `key` `makeSynthesisOptionsForFile` returns with them, or null to skip
   * the memo. Callers must treat the result as read-only.
   */
  synthesizeApplyFeatureCached(
    optionsKey: string | null,
    refs: Parameters<FluidCadServer['synthesizeApplyFeature']>[0],
    feature: Parameters<FluidCadServer['synthesizeApplyFeature']>[1],
    value: number | string | undefined,
    chains: Parameters<FluidCadServer['synthesizeApplyFeature']>[3] = [],
    options?: Parameters<FluidCadServer['synthesizeApplyFeature']>[4],
    before?: SelectionBoundary,
  ): any {
    const scene = this.sceneManager ? this.previousScenes.get(this.currentFileName) : undefined;
    if (!scene || optionsKey === null) {
      return this.synthesizeApplyFeature(refs, feature, value, chains, options, before);
    }
    const key = JSON.stringify([
      optionsKey, refs, feature, value ?? null, chains, options?.connector ?? null, before ?? null,
    ]);
    let entries = this.synthesisMemo.get(scene);
    if (!entries) {
      entries = new Map();
      this.synthesisMemo.set(scene, entries);
    }
    if (entries.has(key)) {
      return entries.get(key);
    }
    const result = this.synthesizeApplyFeature(refs, feature, value, chains, options, before);
    // A scene lives until the next render, while a session can preview many
    // picks against it — keep the most recent answers only.
    if (entries.size >= SYNTHESIS_MEMO_LIMIT) {
      entries.delete(entries.keys().next().value!);
    }
    entries.set(key, result);
    return result;
  }

  /**
   * Consumer-side pick resolution: the picked geometry's enclosing part and
   * that part's matching exposure, for the cross-part reference flow.
   * Read-only over the rendered scene. Null when there is no scene or the
   * workspace kernel predates the query — callers fall back to the ordinary
   * same-part flow.
   */
  resolvePickExposure(
    ref: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } },
  ): any {
    if (!this.sceneManager || !this.sceneManager.resolvePickExposure) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.resolvePickExposure(scene, ref);
  }

  /**
   * The part whose body holds the statement at `loc` — the consumer side of
   * a cross-part reference (the sketch a projection lands in), in the same
   * scene-captured terms as a pick's donor. Null when there is no scene, the
   * statement lies outside every part, or the workspace kernel predates the
   * query — callers fall back to the ordinary same-part flow.
   */
  resolveStatementPart(
    loc: { filePath: string; line: number; column?: number },
  ): { partName: string; filePath: string; line: number; column: number } | null {
    if (!this.sceneManager || !this.sceneManager.resolveStatementPart) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.resolveStatementPart(scene, loc) ?? null;
  }

  /**
   * Whether the part at `from` builds from the part at `to`: the chain of
   * part names between them (`from` first, `to` last), or null when it does
   * not — also when there is no scene, either site is not a rendered part,
   * or the workspace kernel predates the query. The consumer-side guard of
   * a cross-part pick: a donor that already builds from the consumer must
   * not be read by it, or the two parts would depend on each other.
   */
  resolvePartDependency(
    from: { filePath: string; line: number; column?: number },
    to: { filePath: string; line: number; column?: number },
  ): string[] | null {
    if (!this.sceneManager || !this.sceneManager.resolvePartDependency) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.resolvePartDependency(scene, from, to) ?? null;
  }

  /**
   * Tangent-mate pick resolution: exposure find-or-create data plus the
   * picked face/edge's contact classification (seed + G1 chain + bounds).
   * Read-only over the rendered scene; null when there is no scene or the
   * workspace kernel predates the query.
   */
  resolveContactPick(
    ref: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } },
  ): any {
    if (!this.sceneManager || !this.sceneManager.resolveContactPick) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.resolveContactPick(scene, ref);
  }

  /** Whether the workspace kernel answers synthesis-free hover anchors ({@link suggestConnectorFrames}). */
  hasConnectorFrames(): boolean {
    return typeof this.sceneManager?.suggestConnectorFrames === 'function';
  }

  /**
   * Hover-time connector anchors for a picked face/edge: exact anchor frames,
   * a free default name and the file a committed statement lands in — no
   * selector synthesis. Null when there is no rendered scene; callers check
   * {@link hasConnectorFrames} first.
   */
  suggestConnectorFrames(
    ref: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } },
    purpose: 'connector' | 'hole' = 'connector',
  ): any {
    if (!this.sceneManager?.suggestConnectorFrames) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.suggestConnectorFrames(scene, ref, purpose);
  }

  /**
   * Connector anchor suggestions for a picked face/edge: exact anchor frames
   * plus the synthesized source expression and a free default name. A
   * `'hole'` purpose also suggests anchors outside a part. Read-only over the
   * rendered scene.
   */
  suggestConnectorAnchors(
    ref: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } },
    options?: {
      namer?: (producers: { line: number; nameHint: string }[]) => (string | null)[];
      bindable?: (producer: { line: number; featureType?: string }) => boolean;
      params?: { name: string; value: number }[];
    },
    purpose: 'connector' | 'hole' = 'connector',
  ): any {
    if (!this.sceneManager) {
      return null;
    }
    if (!this.sceneManager.suggestConnectorAnchors) {
      // Workspace kernel predates connector anchor suggestions.
      return { ok: false, reason: 'the workspace fluidcad version does not support connector suggestions — update fluidcad' };
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.suggestConnectorAnchors(scene, ref, options, purpose);
  }

  /** 2D branch: synthesize a sketch-body statement for picked sketch edges. */
  synthesizeSketchApplyFeature(
    refs: { shapeId: string }[],
    feature: 'fillet' | 'offset' | 'text' | 'copy' | 'mirror',
    value: number | string | undefined,
    options?: {
      namer?: (producers: { line: number; nameHint: string }[]) => (string | null)[];
      bindable?: (producer: { line: number; featureType?: string }) => boolean;
      params?: { name: string; value: number }[];
      /** Copy: one pick per edge-picked direction, in direction order. Mirror: the single line pick. */
      axisRefs?: { shapeId: string }[];
      /** Offset only: the dialog's `.close()` chain. */
      offset?: { close: boolean };
      /** Slot only: the dialog's Remove-original toggle (`deleteSource`). */
      slot?: { removeOriginal: boolean };
    },
  ): any {
    if (!this.sceneManager?.synthesizeSketchApplyFeature) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.synthesizeSketchApplyFeature(scene, refs, feature, value, options);
  }

  /**
   * Resolve a 2D statement's parsed target arguments onto the active
   * sketch's edges — the offset edit dialog's seed/highlight.
   */
  resolveSketchStatementTargets(descriptors: unknown[]): any {
    if (!this.sceneManager?.resolveSketchStatementTargets) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.resolveSketchStatementTargets(scene, descriptors);
  }

  /**
   * Glyph outlines laid along a picked path geometry — the text dialogs'
   * preview. Null without a scene; a `reason` result when the workspace's
   * fluidcad predates the preview builder or the layout refuses.
   */
  buildTextPathPreview(request: {
    shapeId: string;
    text: string;
    font?: string;
    weight: number;
    italic: boolean;
    size: number;
    align: string;
    lineSpacing: number;
    letterSpacing: number;
    offset?: number;
    startAt?: number;
    flip?: boolean;
  }): { polylines: number[][] } | { reason: string } | null {
    if (!this.sceneManager?.buildTextPathPreview) {
      return { reason: "the workspace's FluidCAD version does not support the text path preview — update its fluidcad dependency" };
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.buildTextPathPreview(scene, request);
  }

  expandTangentChain(
    ref: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } },
    before?: SelectionBoundary,
  ): any {
    if (!this.sceneManager) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.expandTangentChain(scene, ref, before);
  }

  expandBucket(
    ref: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } },
    before?: SelectionBoundary,
  ): any {
    if (!this.sceneManager) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.expandBucket(scene, ref, before);
  }

  listSelectionGroups(
    ref: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } },
    before?: SelectionBoundary,
  ): any {
    if (!this.sceneManager) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.listSelectionGroups(scene, ref, before);
  }

  /** Current sources of the statement at `before`, for edit-dialog seeding. */
  featureSources(before: SelectionBoundary): any {
    if (!this.sceneManager) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.resolveFeatureSources(scene, before);
  }

  /**
   * Export a shapes selection (see {@link ShapeExportSelection}) of the
   * current scene — or, given a {@link ScratchRender}, of that render:
   * `'all'` is every solid the render builds; listed ids are the live
   * scene's and are mapped onto the render's bodies (same lineage, else the
   * same statement and position), since every render mints shape ids
   * afresh. Null when nothing is rendered; a refusal when the selection
   * names nothing the exported scene has.
   */
  exportShapes(
    selection: ShapeSelection,
    options: {
      format: 'step' | 'stl';
      includeColors?: boolean;
      resolution?: string;
      customLinearDeflection?: number;
      customAngularDeflectionDeg?: number;
    },
    scratch?: Extract<ScratchRender, { ok: true }>,
  ): { data: string | Uint8Array; fileName: string } | ShapeExportRefusal | null {
    if (!this.sceneManager) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    const target = scratch ? { scene: scratch.scene, configuration: scratch.configurations.active } : undefined;
    const resolved = ShapeExportSelection.resolve(scene, selection, target);
    if ('reason' in resolved) {
      return resolved;
    }
    return this.sceneManager.exportShapes(target?.scene ?? scene, resolved.shapeIds, options);
  }

  /**
   * Export the current assembly — every instance where it sits. `livePoses`
   * are the browser's solved placements (the engine only knows the statement
   * poses); absent, the statement configuration is written and the outcome
   * says so. Null when nothing is rendered; a refusal (`reason`) when the
   * current scene is not an assembly or the poses do not cover it.
   */
  exportAssembly(
    options: {
      format: 'step' | 'stl';
      includeColors?: boolean;
      resolution?: string;
      customLinearDeflection?: number;
      customAngularDeflectionDeg?: number;
      scaleTo?: 'mm' | 'document';
    },
    livePoses?: AssemblyExportPose[],
    scratch?: Extract<ScratchRender, { ok: true }>,
  ): AssemblyExportOutcome | null {
    if (!this.sceneManager) {
      return null;
    }
    const scene = scratch?.scene ?? this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    const name = basename(this.currentFileName).replace(/\.(assembly|part|fluid)?\.?js$/, '');
    return this.sceneManager.exportAssembly(scene, { ...options, name, livePoses });
  }

  /**
   * Render the current file with the configuration row `name` active — a
   * scratch render for an export that must not disturb the session
   * (`docs/assembly-configurations-plan.md` §3.7): no override layer, no
   * session state touched (active name, override map, dedup cache, render
   * cache, the live scene the viewer shows, the timeline), nothing
   * broadcast. The caller exports from `scene` and then `dispose()`s it.
   *
   * `'Default'` renders the literals. A name the file's last render did not
   * declare — or that this render does not — answers `ok: false` with the
   * declared names; null means there is no scene to render.
   */
  async renderWithConfiguration(sessionId: string, name: string): Promise<ScratchRender | null> {
    sessionId = normalizePath(sessionId);
    const filePath = this.sessionFiles.get(sessionId) ?? sessionId;
    if (!this.sceneManager || !this.previousScenes.has(sessionId)) {
      return null;
    }
    const declared = this.lastConfigurations.get(sessionId)?.names ?? [];
    if (name !== DEFAULT_CONFIGURATION && !declared.includes(name)) {
      return { ok: false, reason: FluidCadServer.unknownConfiguration(name, declared), names: declared };
    }
    return this.serialized(async () => {
      const manager = this.sceneManager!;
      const normalizedFileName = filePath.replace('virtual:live-render:', '');
      const sceneKind: FluidScriptKind = detectKind(normalizedFileName) ?? 'part';
      // Everything a render leaves behind on the engine side, captured to be
      // put back (as the part-catalog scan does): the param and unit
      // registries the live scene's queries read, and the manager's current
      // scene / file / render inputs that `startScene` replaces.
      const liveRegistry = getParamRegistry();
      const liveUnits = getUnitRegistry();
      const managerState = manager as unknown as { currentScene?: unknown; currentFile?: string; renderInputs?: unknown };
      const liveScene = managerState.currentScene;
      const liveFile = managerState.currentFile;
      const liveInputs = managerState.renderInputs;
      let scene: any = null;
      try {
        this.reseedProjectConfig();
        scene = sceneKind === 'assembly' ? manager.startAssemblyScene() : manager.startScene();
        manager.setCurrentFile(normalizedFileName);
        this.host.invalidateModule();
        const registry = createParamRegistry();
        registry.setActiveConfiguration(name === DEFAULT_CONFIGURATION ? null : name);
        // A breakpoint() stops the scratch render where it stops the live
        // one: what ran before it is the export, as on screen.
        try {
          await this.host.loadModule(filePath, FluidCadServer.entryExports(scene, normalizedFileName));
          if (sceneKind !== 'assembly') {
            (scene as { materializeLeftoverDefinitions?: () => void }).materializeLeftoverDefinitions?.();
          }
        } catch (e) {
          if (!(e instanceof BreakpointHit)) {
            throw e;
          }
        }
        const summary = registry.getConfigurations();
        if (name !== DEFAULT_CONFIGURATION && !summary.names.includes(name)) {
          manager.disposeScene?.(scene);
          return { ok: false, reason: FluidCadServer.unknownConfiguration(name, summary.names), names: summary.names };
        }
        manager.renderScene(scene);
        const rendered = scene;
        scene = null;
        return {
          ok: true,
          scene: rendered,
          configurations: summary,
          dispose: () => manager.disposeScene?.(rendered),
        };
      } catch (error) {
        if (scene) {
          manager.disposeScene?.(scene);
        }
        throw error;
      } finally {
        // The module cache now holds the scratch evaluation; drop it so the
        // next render (which always reloads) cannot see it, and put the
        // live file's registry back for the params the server answers with.
        this.host.invalidateModule();
        setParamRegistry(liveRegistry);
        setUnitRegistry(liveUnits);
        if (liveFile !== undefined) {
          manager.setCurrentFile(liveFile);
        }
        if (liveScene !== undefined) {
          managerState.currentScene = liveScene;
        }
        if (liveInputs !== undefined) {
          managerState.renderInputs = liveInputs;
        }
      }
    });
  }

  private static unknownConfiguration(name: string, names: string[]): string {
    return names.length > 0
      ? `Unknown configuration '${name}'. Declared: ${names.map(n => `'${n}'`).join(', ')} (and Default).`
      : `Unknown configuration '${name}': the file declares no configurations() table (only Default).`;
  }

  hitTest(
    shapeId: string,
    rayOrigin: [number, number, number],
    rayDir: [number, number, number],
    edgeThreshold: number,
  ): any {
    if (!this.sceneManager) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.hitTest(scene, shapeId, rayOrigin, rayDir, edgeThreshold);
  }

  hitTestForSession(
    sessionId: string,
    shapeId: string,
    rayOrigin: [number, number, number],
    rayDir: [number, number, number],
    edgeThreshold: number,
  ): any {
    if (!this.sceneManager) {
      return null;
    }
    const scene = this.previousScenes.get(sessionId);
    if (!scene) {
      return null;
    }
    return this.sceneManager.hitTest(scene, shapeId, rayOrigin, rayDir, edgeThreshold);
  }

  setCompileError(err: CompileError | null): void {
    this.compileError = err;
  }

  getCompileError(): CompileError | null {
    return this.compileError;
  }

  /**
   * Override a parameter's value for the session (the source is never
   * touched). `body` names the part (or assembly) whose `label` it is — the
   * `body` of the definition the render listed. Without it the label must
   * name one body's parameter in the last render: a label two parts declare
   * is refused, and the refusal's text returned (null when set). A label no
   * render has declared yet is kept by label and applies once it renders.
   */
  setParam(sessionId: string, label: string, value: any, body?: string): string | null {
    sessionId = normalizePath(sessionId);
    const session = this.paramSession(sessionId);
    const resolved = session.keyFor(label, body);
    if ('error' in resolved) {
      return resolved.error;
    }
    session.set(resolved.key, value);
    this.lastRendered.delete(sessionId);
    return null;
  }

  resetParams(sessionId: string): void {
    sessionId = normalizePath(sessionId);
    this.paramSessions.get(sessionId)?.clear();
    this.lastRendered.delete(sessionId);
  }

  /**
   * Put a session's overrides back as {@link getParamOverrides} reported
   * them — for a route that switched the configuration for one capture
   * (`selectConfiguration` drops the overrides) and restores the session
   * afterwards, or one that re-selects a renamed row with its tweaks.
   * Internal to those round trips: not a public route.
   */
  restoreParamOverrides(sessionId: string, overrides: Record<string, any>): void {
    sessionId = normalizePath(sessionId);
    this.paramSession(sessionId).restore(overrides);
    this.lastRendered.delete(sessionId);
    this.renderingCache.delete(sessionId);
  }

  /**
   * Show the configuration row `name` (`'Default'` for the literals) on the
   * session's next render. The session's overrides go with the switch — they
   * were tweaks on the row that was showing — and the choice is remembered
   * in the workspace's editor state. A name the file does not declare is
   * accepted here (the render is what knows the table) and falls back to
   * Default with a notice when it renders; see `settleConfiguration`.
   */
  selectConfiguration(sessionId: string, name: string): void {
    sessionId = normalizePath(sessionId);
    if (name === DEFAULT_CONFIGURATION) {
      this.activeConfigurations.delete(sessionId);
    } else {
      this.activeConfigurations.set(sessionId, name);
    }
    this.configurationSeeded.add(sessionId);
    this.paramSessions.get(sessionId)?.clear();
    this.lastRendered.delete(sessionId);
    this.renderingCache.delete(sessionId);
    this.persistActiveConfiguration(sessionId, this.sessionFiles.get(sessionId) ?? sessionId);
  }

  /** The configuration the session renders: a row name, or `'Default'`. */
  getActiveConfiguration(sessionId: string): string {
    return this.activeConfigurations.get(normalizePath(sessionId)) ?? DEFAULT_CONFIGURATION;
  }

  /**
   * What the session's last render declared and which row is showing — the
   * `scene-rendered` payload's `configurations`, answerable between renders.
   * Before any render: no rows, Default.
   */
  getConfigurations(sessionId: string): SceneConfigurations {
    sessionId = normalizePath(sessionId);
    const last = this.lastConfigurations.get(sessionId) ?? { names: [], rows: {}, tables: [] };
    const wanted = this.activeConfigurations.get(sessionId);
    return {
      active: wanted !== undefined && last.names.includes(wanted) ? wanted : DEFAULT_CONFIGURATION,
      names: last.names,
      rows: last.rows,
      tables: last.tables,
      modified: this.isModified(sessionId),
    };
  }

  /**
   * The parameter a declaration edit addresses — `label` as declared at
   * `filePath`:`line` — keyed by its body: the definition the last render
   * listed for that call, else the one body declaring the label, else the
   * label alone (a parameter that has not rendered, or an older override).
   */
  paramKeyOf(sessionId: string, label: string, filePath?: string, line?: number): ParamKey {
    const site = (def: ParamDefinition): boolean => {
      const loc = def.sourceLocation;
      if (!loc) {
        return false;
      }
      return (filePath === undefined || normalizePath(loc.filePath.replace('virtual:live-render:', '')) === normalizePath(filePath))
        && (line === undefined || loc.line === line);
    };
    const declared = this.getParamDefinitions().filter(def => def.kind !== 'global' && def.label === label && site(def));
    if (declared.length === 1) {
      return ParamKey.ofDefinition(declared[0]);
    }
    const resolved = this.paramSession(normalizePath(sessionId)).keyFor(label);
    return 'key' in resolved ? resolved.key : ParamKey.of(null, label);
  }

  /**
   * Follow a label rename in the source. Both the override and the baseline
   * it was set against are keyed by part + label, so without this the
   * renamed param would come back at its declared default while a ghost
   * entry kept holding the value under the old name. Only ever called after
   * the source edit landed, and that edit refuses a rename onto a label the
   * body already declares — so anything sitting under the new key belongs
   * to a param that no longer exists.
   */
  renameParam(sessionId: string, key: ParamKey, to: string): void {
    sessionId = normalizePath(sessionId);
    this.paramSessions.get(sessionId)?.rename(key, to);
    this.lastRendered.delete(sessionId);
  }

  /** Forget a deleted param's override and the baseline behind it. */
  forgetParam(sessionId: string, key: ParamKey): void {
    sessionId = normalizePath(sessionId);
    this.paramSessions.get(sessionId)?.forget(key);
    this.lastRendered.delete(sessionId);
  }

  /**
   * The session's overrides as a plain record: each under its label while
   * one part declares that label — a single-part file's record is the
   * label-keyed one it always was — else under its `ParamKey.id`.
   * {@link restoreParamOverrides} and {@link setParam}'s label rule read
   * both forms back.
   */
  getParamOverrides(sessionId: string): Record<string, any> {
    return this.paramSessions.get(normalizePath(sessionId))?.toRecord() ?? {};
  }

  /** The session's overrides, each with the parameter it sets. */
  getParamOverrideEntries(sessionId: string): SessionParamOverride[] {
    return this.paramSessions.get(normalizePath(sessionId))?.entries() ?? [];
  }

  getCurrentFileName(): string {
    return this.currentFileName;
  }

  /**
   * The files the current file's last successful render read that no module
   * import shows — a `load()`'s imported `.brep` and its sidecars, a
   * `text()`'s workspace font, in an inserted part's body as much as in the
   * file itself — as absolute paths.
   * Each is listed whether or not it exists: the engine notes a sidecar it
   * looked for and did not find. Empty while nothing has rendered. A share
   * link carries the ones that exist beside the module closure (see
   * `collectEntryFiles`).
   */
  getRenderAssets(): string[] {
    return [...(this.renderAssets.get(this.currentFileName) ?? [])];
  }

  /**
   * Whether a change to `absPath` on disk left the current file's render
   * behind what it was built from: the file is an input of that render other
   * than the current file itself — a module it imports, directly or through
   * another (a `*.feature.js`, a helper, the part file an assembly inserts),
   * `fluidcad.json`, a file the engine read — and the inputs no longer match
   * the render. The current file's own edits reach the server through its
   * editor host, so they never count here.
   *
   * A render that failed keeps the inputs of the last one that succeeded, so
   * fixing a module that broke it renders again. While the current file does
   * not compile, a change to any workspace script retries it too: the import
   * that failed may be the file that just appeared. A render that owes a
   * feature rebuild (see {@link noteFileChange}) is behind, whatever its
   * inputs hash to.
   */
  isRenderBehind(absPath: string): boolean {
    const current = this.currentFileName;
    if (!current) {
      return false;
    }
    const candidates = FluidCadServer.pathForms(absPath);
    if (candidates.includes(current)) {
      return false;
    }
    // Built with a feature's old code: behind, though its inputs may hash as
    // current — a render that ran between the save and the watcher's word
    // read the new file, yet matched the feature's statements to their old
    // builds.
    if (this.featureRebuilds.owes(current)) {
      return true;
    }
    const fingerprint = this.renderFingerprints.get(current) ?? null;
    if (fingerprint && candidates.some(file => fingerprint.files.has(file))) {
      return !this.isFingerprintCurrent(current, fingerprint);
    }
    return this.compileError !== null && /\.[cm]?[jt]s$/.test(candidates[0]);
  }

  /**
   * A workspace file changed on disk. When it is feature code — a
   * `*.feature.js` module, or a workspace module one imports — the features
   * built with the old code rebuild: every session whose last render read
   * that module rebuilds the statements of the features it defines on its
   * next render (see {@link FeatureRebuilds}), though their values are
   * unchanged, and the next ghost loads the saved code. Answers whether it
   * was feature code. Any other file changes nothing here, so a render costs
   * nothing more until feature code is saved.
   *
   * The workspace watcher calls this for every change, whichever host saved
   * the file (the in-page editor, VS Code, Neovim, any other program); an
   * unsaved editor buffer of a feature module reaches no render.
   */
  noteFileChange(absPath: string): boolean {
    const modules = this.featureModulesChangedBy(absPath);
    if (modules.size === 0) {
      return false;
    }
    this.ghostBuilders.clear();
    this.ghostCodeStale = true;
    for (const [sessionId, fingerprint] of this.renderFingerprints) {
      if (!fingerprint || !this.previousScenes.has(sessionId)) {
        continue;
      }
      for (const modulePath of modules) {
        if (fingerprint.files.has(modulePath)) {
          this.featureRebuilds.noteModule(sessionId, modulePath);
        }
      }
    }
    return true;
  }

  /**
   * The project's pins may have changed (its `fluidcad.json` was saved):
   * bring the editors' package types in line now, rather than at the next
   * render (`SceneHost.refreshEditorTypes`).
   */
  refreshEditorTypes(): void {
    this.host.refreshEditorTypes?.();
  }

  /**
   * Rebuild every statement of these features on each session's next
   * render, though their values are unchanged — for a feature whose code
   * changed without a workspace module being saved (an installed package
   * upgraded: its ids stay while its modules move). Render again afterwards
   * (`recomputeCurrentFile`) for the open model to show it.
   */
  rebuildFeatures(ids: Iterable<string>): void {
    const list = [...ids];
    for (const sessionId of this.previousScenes.keys()) {
      for (const id of list) {
        this.featureRebuilds.noteId(sessionId, id);
      }
    }
  }

  /**
   * The feature modules a change to `absPath` reaches: the file itself when
   * it is one, and every one that imports it, directly or through another,
   * as the module graph knows them.
   */
  private featureModulesChangedBy(absPath: string): Set<string> {
    const modules = new Set<string>();
    for (const file of FluidCadServer.pathForms(absPath)) {
      if (FeatureModules.isModule(file)) {
        modules.add(file);
      }
      for (const importer of this.host.getModuleImporters?.(file) ?? []) {
        if (FeatureModules.isModule(importer)) {
          modules.add(importer);
        }
      }
    }
    return modules;
  }

  /** A changed path as the watcher names it, and through its symlinks, as the module graph does. */
  private static pathForms(absPath: string): string[] {
    const file = normalizePath(absPath);
    try {
      const real = normalizePath(realpathSync(file));
      return real === file ? [file] : [file, real];
    } catch {
      return [file];
    }
  }

  /**
   * Forget the current file: the scene it produced was closed and nothing
   * took its place. Every "current code" reader answers null afterwards, and
   * a recompute has nothing to re-run until a file is opened again.
   */
  closeCurrentFile(): void {
    this.currentFileName = '';
    this.currentFilePath = '';
    this.compileError = null;
  }

  /**
   * Test-only seam: stage a scene under the given file name so the inspection
   * accessors can read it without running the vite pipeline. Production code
   * never calls this — `processFile` populates the same map.
   */
  _setSceneForTesting(fileName: string, scene: any, rollbackStop: number = -1): void {
    this.currentFileName = fileName;
    this.previousScenes.set(fileName, scene);
    this.lastRollbackStop = rollbackStop;
    this.lastRollbackScopePartId = null;
  }

  /**
   * Pull the per-object build failures out of a render result.
   *
   * A feature whose `build()` throws does NOT abort the render: the renderer
   * catches it, records the message on that object, and carries on with the
   * rest of the scene. So "the render resolved" says nothing about whether the
   * model is right — every caller that reports a render outcome has to fold
   * these in, or it reports success over a scene that is missing features.
   */
  static collectObjectErrors(result: any[]): ObjectBuildError[] {
    const errors: ObjectBuildError[] = [];
    for (let index = 0; index < result.length; index++) {
      const obj = result[index];
      if (!obj?.hasError) {
        continue;
      }
      errors.push({
        index,
        id: obj.id,
        name: obj.name,
        uniqueKind: obj.uniqueType,
        message: obj.errorMessage || 'Build failed.',
        sourceLocation: obj.sourceLocation,
      });
    }
    return errors;
  }

  getSceneSummary(): SceneSummary | null {
    if (!this.currentFileName) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    const rendered = scene.getRenderedObjects() as any[];
    const warningsByIndex = new Map<number, string[]>();
    for (const warning of this.collectObjectWarnings(rendered)) {
      const list = warningsByIndex.get(warning.index);
      if (list) {
        list.push(warning.message);
      } else {
        warningsByIndex.set(warning.index, [warning.message]);
      }
    }
    const labels = ShapeLabels.labelsFor(rendered);
    const objects: SceneSummaryObject[] = rendered.map((r, index) => ({
      index,
      id: r.id,
      kind: r.type,
      uniqueKind: r.uniqueType,
      name: r.name,
      ...(r.hasCustomName ? { hasCustomName: true } : {}),
      params: sanitizeParams(r.object),
      sourceLocation: r.sourceLocation,
      shapeIds: ((r.sceneShapes ?? []) as any[]).map((s) => s.shapeId),
      shapes: ((r.sceneShapes ?? []) as any[]).map((s) => FluidCadServer.summaryShape(s, labels)),
      fromCache: !!r.fromCache,
      hasError: !!r.hasError,
      errorMessage: r.errorMessage,
      ...(warningsByIndex.has(index) ? { warnings: warningsByIndex.get(index) } : {}),
      ...(r.type === 'part' ? {
        material: typeof r.object?.material === 'string' ? r.object.material : null,
        appearance: typeof r.object?.appearance === 'string' ? r.object.appearance : null,
      } : {}),
      containerId: r.parentId ?? null,
      isContainer: !!r.isContainer,
      visible: r.visible !== false,
    }));
    const assembly = this.sceneManager?.getAssemblyData(scene) ?? null;
    return {
      schemaVersion: 1,
      file: this.currentFileName,
      unit: FluidCadServer.sceneUnitOf(scene),
      objects,
      rollbackStop: this.lastRollbackStop,
      ...(this.lastRollbackScopePartId ? { rollbackScopePartId: this.lastRollbackScopePartId } : {}),
      compileError: this.compileError,
      ...(assembly ? AssemblySummary.fields(assembly, this.sceneManager?.getInstanceShapeIds?.(scene) ?? null) : {}),
    };
  }

  /**
   * Every id a screenshot can address in the current render: the shape ids
   * its rendered objects carry (the ones `getShapesList` lists, which the page
   * draws, an assembly's inserted parts included) and, in an assembly, its
   * instance ids. Null with no rendered scene, when there is nothing to check
   * an id against.
   */
  getSceneTargetIds(): Set<string> | null {
    if (!this.currentFileName || !this.sceneManager) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    const ids = new Set<string>();
    for (const r of scene.getRenderedObjects() as any[]) {
      for (const s of (r.sceneShapes ?? []) as any[]) {
        ids.add(s.shapeId);
      }
    }
    for (const instance of this.sceneManager.getAssemblyData(scene)?.instances ?? []) {
      ids.add(instance.instanceId);
    }
    return ids;
  }

  getShapesList(): ShapeList | null {
    if (!this.currentFileName) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    const rendered = scene.getRenderedObjects() as any[];
    const labels = ShapeLabels.labelsFor(rendered);
    const shapes: ShapeListEntry[] = [];
    for (const r of rendered) {
      const sceneShapes = (r.sceneShapes ?? []) as any[];
      for (const s of sceneShapes) {
        shapes.push({ ...FluidCadServer.summaryShape(s, labels), sceneObjectId: r.id });
      }
    }
    return { shapes };
  }

  /**
   * One rendered shape as the summary and the shape list report it: its id
   * and type, the Shapes panel's `<Type> <n>` label and part (none on a meta
   * shape, which has no row) and, for a solid, its lineage key.
   */
  private static summaryShape(shape: any, labels: ReadonlyMap<string, { label: string; part: string | null }>): SceneSummaryShape {
    const labelled = labels.get(shape.shapeId);
    return {
      shapeId: shape.shapeId,
      type: shape.shapeType,
      ...(labelled ? { label: labelled.label, part: labelled.part } : {}),
      ...(typeof shape.lineageKey === 'string' ? { lineageKey: shape.lineageKey } : {}),
      ...(shape.isMetaShape ? { isMetaShape: true as const } : {}),
    };
  }

  /**
   * Compose a stable cache key over the rendering inputs: the source bytes
   * being rendered plus the param overrides currently in effect for the
   * session. Param changes flip the hash so cached entries don't shadow a
   * recompute, even when the code text is byte-identical.
   */
  private computeParamsHash(sessionId: string, codeOrBundle: string): string {
    const normalized = codeOrBundle.replace(/\r\n/g, '\n');
    return createHash('sha1')
      .update(normalized)
      .update('\0')
      .update(this.overridesKey(sessionId))
      .digest('hex');
  }

  /**
   * The session's param overrides in a canonical, order-independent form,
   * under the configuration they sit on — switching rows changes what a
   * render produces as surely as an override does.
   */
  private overridesKey(sessionId: string): string {
    const sortedEntries = this.paramSessions.get(sessionId)?.fingerprint() ?? [];
    return JSON.stringify([this.activeConfigurations.get(sessionId) ?? null, sortedEntries]);
  }
}
