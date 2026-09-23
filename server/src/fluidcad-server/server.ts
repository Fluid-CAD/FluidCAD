// FluidCadServer: owns the scene host, live buffers, renders, rollbacks and parameter overrides.

import { createHash } from 'crypto';
import { basename, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { readFile } from 'fs/promises';
import type { SceneHost } from '../host/scene-host.ts';
import { LocalSceneHost } from '../host/local-scene-host.ts';
import { normalizePath } from '../normalize-path.ts';
import { findLibIdentityMismatch } from '../lib-identity.ts';
import { detectKind, type FluidScriptKind } from '../file-kind.ts';
import { BreakpointHit } from '../../../lib/dist/common/breakpoint-hit.js';
import {
  createParamRegistry,
  getParamRegistry,
  setParamRegistry,
  type AssemblyExportOutcome,
  type AssemblyExportPose,
  type ImportReport,
  type InterferenceRequest,
  type ParamRegistry,
  type ParamVal,
  type RenderChangeTracker,
  type ResolveSelectionRequest,
  type ResolveSelectionResult,
  type SceneInterferenceOutcome,
  type SceneValidationOutcome,
  type ValidateSceneRequest,
} from '../../../lib/dist/index.js';
import { scanFileForParts, type PartScanResult } from '../part-catalog/scan.ts';
import { MeasureEntityResolver, type MeasureEntity } from '../measure-entities.ts';
import type { CompileError } from '../ws-protocol.ts';
import { PROJECT_CONFIG_FILENAME, readProjectConfig, type LengthUnit } from '../project-config.ts';
import { RenderInputs, type RenderFingerprint } from '../render-inputs.ts';
import type {
  FeatureGhostOutcome,
  FeatureGhostRequest,
  GhostSolid,
  SketchRegionPreview,
  SketchRegionsOutcome,
  SketchRegionsRequest,
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
import type { ObjectBuildError, RenderOptions, SceneRenderedData } from './render-types.ts';
import type { SceneManager } from './scene-manager.ts';
import type { SceneSummary, SceneSummaryObject, ShapeList, ShapeListEntry } from './scene-summary.ts';

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
  private renderInputs: RenderInputs;
  // Live buffers this server seeded from disk (no editor sent them), with the
  // hashes of what was seeded — a seed follows its file when the disk changes.
  private diskSeeds = new Map<string, { bufferHash: string; diskHash: string }>();
  private paramOverrides: Map<string, Map<string, any>> = new Map();
  // Per session, the default each `param()` was authored with as of the last
  // render — `label → the literal in the source`. An override is a delta over
  // that default, so when the file re-declares it the override is stale and
  // gets dropped instead of shadowing the value the code now asks for.
  private lastParamDefaults = new Map<string, Map<string, ParamVal>>();
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

  private currentFileName: string = '';
  private currentFilePath: string = '';
  private lastRollbackStop: number = -1;
  /** Part id of the last part-scoped rollback; null for global/full views. */
  private lastRollbackScopePartId: string | null = null;
  /**
   * Whether the last full render paused at a breakpoint. Rollbacks don't
   * re-run the module, so they carry this last known state — without it the
   * UI's breakpoint indicator can't survive a browser refresh whose replayed
   * scene message is a rollback broadcast.
   */
  private lastBreakpointHit = false;
  private compileError: CompileError | null = null;

  constructor(host: SceneHost = new LocalSceneHost()) {
    this.host = host;
    this.renderInputs = new RenderInputs(host);
  }

  getCurrentCode(): string | null {
    if (!this.currentFileName) return null;
    return this.host.getBuffer(this.currentFileName);
  }

  /** Param definitions from the last render — currentValue is override-aware. */
  getParamDefinitions(): { label: string; currentValue: unknown }[] {
    return getParamRegistry().getDefinitions();
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
    this.renderingCache.delete(sessionId);
    this.lastRendered.delete(sessionId);
    this.renderFingerprints.delete(sessionId);
    this.paramOverrides.delete(sessionId);
    this.lastParamDefaults.delete(sessionId);
    this.sessionFiles.delete(sessionId);
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
   * Re-read the project unit from `fluidcad.json` before every scene start.
   * The workspace's SceneManager seeds `projectUnit` once, from init.js —
   * without this a unit edited while the server runs (the unit chip's
   * "Project unit" menu) would only show up after a restart. Guarded for a
   * workspace engine that predates the field, and skipped for the hub path,
   * which installs its manager without a workspace and must keep whatever
   * unit it was built with.
   */
  private reseedProjectUnit(): void {
    if (!this.workspacePath || !this.sceneManager || !('projectUnit' in this.sceneManager)) {
      return;
    }
    (this.sceneManager as { projectUnit: LengthUnit }).projectUnit = readProjectConfig(this.workspacePath).unit ?? 'mm';
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
   * `fluidcad.json` before every render (`reseedProjectUnit`), and for the
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

      if (!ignoreCache) {
        const fromCache = this.renderingCache.get(sessionId);
        if (fromCache && this.isFingerprintCurrent(sessionId, fromCache.fingerprint)) {
          // Everything a render would have left behind: the stop, the
          // breakpoint state, and this file's params as the live registry.
          this.lastRollbackStop = fromCache.data.rollbackStop;
          this.lastRollbackScopePartId = null;
          this.lastBreakpointHit = fromCache.data.breakpointHit === true;
          this.compileError = null;
          setParamRegistry(fromCache.registry);
          return fromCache.data;
        }
      }

      try {
        this.reseedProjectUnit();
        let scene = sceneKind === 'assembly'
          ? this.sceneManager.startAssemblyScene()
          : this.sceneManager.startScene();
        this.sceneManager.setCurrentFile(normalizedFileName);
        this.host.invalidateModule();

        const registry = createParamRegistry();
        const overrides = this.paramOverrides.get(sessionId);
        if (overrides) {
          registry.setOverrides(overrides, this.lastParamDefaults.get(sessionId));
        }

        let breakpointHit = false;
        try {
          await this.host.loadModule(filePath);
        }
        catch (e) {
          if (e instanceof BreakpointHit) {
            breakpointHit = true;
          } else {
            throw e;
          }
        }

        // part() definitions are lazy — a part-kind entry scene materializes
        // every definition the module created but nothing exported or
        // inserted, so the open file stays WYSIWYG. Assembly scenes build
        // strictly via insert(). (Optional call: the workspace's fluidcad
        // install may predate lazy definitions.)
        if (sceneKind !== 'assembly') {
          try {
            (scene as { materializeLeftoverDefinitions?: () => void }).materializeLeftoverDefinitions?.();
          } catch (e) {
            if (e instanceof BreakpointHit) {
              breakpointHit = true;
            } else {
              throw e;
            }
          }
        }
        this.lastBreakpointHit = breakpointHit;

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
        this.settleParamOverrides(sessionId, registry);
        // After the overrides settled: a render can drop overrides the source
        // re-declared, and the fingerprint must describe what is in effect.
        const fingerprint = this.captureFingerprint(sessionId, normalizedFileName);
        this.renderFingerprints.set(sessionId, fingerprint);

        if (this.previousScenes.has(sessionId)) {
          const previousScene = this.previousScenes.get(sessionId);
          scene = this.sceneManager.compare(previousScene, scene, changes);
        }

        this.previousScenes.set(sessionId, scene);

        this.sceneManager.renderScene(scene);
        const result = scene.getRenderedObjects();
        const renderChanges = changes ? changes.summarize(scene) : undefined;

        for (const obj of result) {
          if (obj.sourceLocation) {
            obj.sourceLocation.filePath = obj.sourceLocation.filePath.replace('virtual:live-render:', '');
          }
        }

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
        }

        // Read after the module ran: a file's `unit()` statement declares the
        // unit during evaluation, and the scene resolves it lazily.
        const unit = FluidCadServer.sceneUnitOf(scene);
        const declaredUnit = FluidCadServer.sceneDeclaredUnitOf(scene);

        this.lastRollbackStop = result.length - 1;
        this.lastRollbackScopePartId = null;
        this.compileError = null;

        const data: SceneRenderedData = {
          absPath: normalizedFileName,
          sceneKind,
          unit,
          declaredUnit,
          projectUnit: this.projectUnitOf(),
          result,
          rollbackStop: result.length - 1,
          breakpointHit,
          params,
          objectErrors: FluidCadServer.collectObjectErrors(result),
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
        this.host.invalidateModule();
        console.log('Error processing file:', error);
        throw error;
      }
    });
  }

  /**
   * Fingerprint the render that just ran for this session: its module graph,
   * the project config, and whatever files the engine read while building
   * (optional call — the workspace's fluidcad install may predate it).
   */
  private captureFingerprint(sessionId: string, entryFile: string): RenderFingerprint | null {
    const extraFiles: string[] = [];
    if (this.workspacePath) {
      extraFiles.push(join(this.workspacePath, PROJECT_CONFIG_FILENAME));
    }
    const engineInputs = (this.sceneManager as { getRenderInputs?: () => string[] } | null)?.getRenderInputs?.();
    if (engineInputs) {
      extraFiles.push(...engineInputs);
    }
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

  /**
   * Close the loop on a render's param bookkeeping: remember what each
   * `param()` declared so the next render can tell an edited default from an
   * unchanged one, and forget the overrides this render found stale.
   *
   * Baselines merge rather than replace — a param that didn't run this pass
   * (breakpoint, untaken branch) keeps the default it last declared, so an
   * edit to *its* literal is still recognized later. Absence alone never
   * drops an override for the same reason: not running is not un-declaring.
   */
  private settleParamOverrides(sessionId: string, registry: ParamRegistry): void {
    const baselines = this.lastParamDefaults.get(sessionId) ?? new Map<string, ParamVal>();
    for (const [label, authored] of registry.getAuthoredDefaults()) {
      baselines.set(label, authored);
    }
    this.lastParamDefaults.set(sessionId, baselines);

    const discarded = registry.getDiscardedOverrides();
    const overrides = this.paramOverrides.get(sessionId);
    if (!overrides || discarded.length === 0) {
      return;
    }
    for (const label of discarded) {
      overrides.delete(label);
    }
    if (overrides.size === 0) {
      this.paramOverrides.delete(sessionId);
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
    if (cached && cached.paramsHash === paramsHash && this.isFingerprintCurrent(fileName, cached.fingerprint)) {
      this.compileError = null;
      this.currentFileName = fileName;
      this.currentFilePath = `virtual:live-render:${fileName}`;
      this.lastRollbackStop = cached.data.rollbackStop;
      this.lastRollbackScopePartId = null;
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
      return scanFileForParts(this.host, this.sceneManager, normalizePath(filePath), { projectUnit });
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
      objectErrors: FluidCadServer.collectObjectErrors(result),
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
      try {
        const result = this.sceneManager.buildFeatureGhost(scene, request);
        if (result?.ok) {
          return { status: 200, solids: (result.solids ?? []) as GhostSolid[] };
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

  synthesizeApplyFeature(
    refs: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } }[],
    feature: 'fillet' | 'chamfer' | 'shell' | 'sketch' | 'extrude' | 'sweep' | 'loft' | 'plane' | 'revolve' | 'wrap' | 'helix' | 'project' | 'offset' | 'connector' | 'expose',
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
        rotate?: { axis: 'x' | 'y' | 'z'; angle: number };
        offset?: [number, number, number];
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

  /**
   * Hover-time connector anchor suggestions for a picked face/edge: exact
   * anchor frames plus the synthesized source expression and a free default
   * name. Read-only over the rendered scene.
   */
  suggestConnectorAnchors(
    ref: { shapeId: string; sub: { type: 'edge' | 'face'; index: number } },
    options?: {
      namer?: (producers: { line: number; nameHint: string }[]) => (string | null)[];
      bindable?: (producer: { line: number; featureType?: string }) => boolean;
      params?: { name: string; value: number }[];
    },
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
    return this.sceneManager.suggestConnectorAnchors(scene, ref, options);
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

  exportShapes(
    shapeIds: string[],
    options: {
      format: 'step' | 'stl';
      includeColors?: boolean;
      resolution?: string;
      customLinearDeflection?: number;
      customAngularDeflectionDeg?: number;
    },
  ): { data: string | Uint8Array; fileName: string } | null {
    if (!this.sceneManager) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    return this.sceneManager.exportShapes(scene, shapeIds, options);
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
  ): AssemblyExportOutcome | null {
    if (!this.sceneManager) {
      return null;
    }
    const scene = this.previousScenes.get(this.currentFileName);
    if (!scene) {
      return null;
    }
    const name = basename(this.currentFileName).replace(/\.(assembly|part|fluid)?\.?js$/, '');
    return this.sceneManager.exportAssembly(scene, { ...options, name, livePoses });
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

  setParam(sessionId: string, label: string, value: any): void {
    sessionId = normalizePath(sessionId);
    if (!this.paramOverrides.has(sessionId)) {
      this.paramOverrides.set(sessionId, new Map());
    }
    this.paramOverrides.get(sessionId)!.set(label, value);
    this.lastRendered.delete(sessionId);
  }

  resetParams(sessionId: string): void {
    sessionId = normalizePath(sessionId);
    this.paramOverrides.delete(sessionId);
    this.lastRendered.delete(sessionId);
  }

  /**
   * Follow a label rename in the source. Both the override and the baseline
   * it was set against are keyed by label, so without this the renamed param
   * would come back at its declared default while a ghost entry kept holding
   * the value under the old name. Only ever called after the source edit
   * landed, and that edit refuses a rename onto a label the file already
   * declares — so anything sitting under `to` here belongs to a param that no
   * longer exists.
   */
  renameParam(sessionId: string, from: string, to: string): void {
    sessionId = normalizePath(sessionId);
    FluidCadServer.moveKey(this.paramOverrides.get(sessionId), from, to);
    FluidCadServer.moveKey(this.lastParamDefaults.get(sessionId), from, to);
    this.lastRendered.delete(sessionId);
  }

  /** Forget a deleted param's override and the baseline behind it. */
  forgetParam(sessionId: string, label: string): void {
    sessionId = normalizePath(sessionId);
    const overrides = this.paramOverrides.get(sessionId);
    overrides?.delete(label);
    if (overrides?.size === 0) {
      this.paramOverrides.delete(sessionId);
    }
    this.lastParamDefaults.get(sessionId)?.delete(label);
    this.lastRendered.delete(sessionId);
  }

  private static moveKey<T>(map: Map<string, T> | undefined, from: string, to: string): void {
    if (!map || !map.has(from)) {
      return;
    }
    map.set(to, map.get(from)!);
    map.delete(from);
  }

  getParamOverrides(sessionId: string): Record<string, any> {
    const map = this.paramOverrides.get(normalizePath(sessionId));
    if (!map) return {};
    return Object.fromEntries(map);
  }

  getCurrentFileName(): string {
    return this.currentFileName;
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
    const objects: SceneSummaryObject[] = rendered.map((r, index) => ({
      index,
      id: r.id,
      kind: r.type,
      uniqueKind: r.uniqueType,
      name: r.name,
      params: sanitizeParams(r.object),
      sourceLocation: r.sourceLocation,
      shapeIds: ((r.sceneShapes ?? []) as any[]).map((s) => s.shapeId),
      fromCache: !!r.fromCache,
      hasError: !!r.hasError,
      errorMessage: r.errorMessage,
      containerId: r.parentId ?? null,
      isContainer: !!r.isContainer,
      visible: r.visible !== false,
    }));
    return {
      schemaVersion: 1,
      file: this.currentFileName,
      unit: FluidCadServer.sceneUnitOf(scene),
      objects,
      rollbackStop: this.lastRollbackStop,
      ...(this.lastRollbackScopePartId ? { rollbackScopePartId: this.lastRollbackScopePartId } : {}),
      compileError: this.compileError,
    };
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
    const shapes: ShapeListEntry[] = [];
    for (const r of rendered) {
      const sceneShapes = (r.sceneShapes ?? []) as any[];
      for (const s of sceneShapes) {
        shapes.push({
          shapeId: s.shapeId,
          type: s.shapeType,
          sceneObjectId: r.id,
        });
      }
    }
    return { shapes };
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

  /** The session's param overrides in a canonical, order-independent form. */
  private overridesKey(sessionId: string): string {
    const overrides = this.paramOverrides.get(sessionId);
    const sortedEntries = overrides ? [...overrides.entries()].sort(([a], [b]) => a.localeCompare(b)) : [];
    return JSON.stringify(sortedEntries);
  }
}
