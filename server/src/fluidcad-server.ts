import { createHash } from 'crypto';
import { join } from 'path';
import { existsSync } from 'fs';
import type { SceneHost } from './host/scene-host.ts';
import { LocalSceneHost } from './host/local-scene-host.ts';
import { normalizePath } from './normalize-path.ts';
import { detectKind } from './file-kind.ts';
import type { FluidScriptKind } from './file-kind.ts';
import { BreakpointHit } from '../../lib/dist/common/breakpoint-hit.js';
import { createParamRegistry, getParamRegistry } from '../../lib/dist/index.js';
import type { ParamDefinition } from '../../lib/dist/index.js';
import type { CompileError } from './ws-protocol.ts';

export type SerializedAssembly = {
  instances: Array<{
    instanceId: string;
    partId: string;
    partName: string;
    position: { x: number; y: number; z: number };
    quaternion: { x: number; y: number; z: number; w: number };
    grounded: boolean;
    name: string;
    sourceLocation?: { filePath: string; line: number; column: number };
  }>;
  mates: Array<{
    mateId: string;
    type: 'fastened' | 'revolute' | 'slider' | 'cylindrical' | 'planar' | 'parallel' | 'pin-slot';
    connectorA: { instanceId: string; connectorId: string };
    connectorB: { instanceId: string; connectorId: string };
    status: 'satisfied' | 'redundant' | 'inconsistent';
    options?: { rotate?: number; flip?: boolean; offset?: [number, number, number] };
    sourceLocation?: { filePath: string; line: number; column: number };
  }>;
};

type SceneManager = {
  startScene(): any;
  startAssemblyScene(): any;
  renderScene(scene: any): any;
  getAssemblyData(scene: any): SerializedAssembly | null;
  rollbackScene(scene: any, rollbackIndex: number): any;
  compare(previousScene: any, currentScene: any): any;
  setCurrentFile(filePath: string): void;
  importFile(workspacePath: string, fileName: string, data: Uint8Array): any;
  getShapeProperties(scene: any, shapeId: string): any;
  getFaceProperties(scene: any, shapeId: string, faceIndex: number): any;
  getEdgeProperties(scene: any, shapeId: string, edgeIndex: number): any;
  hitTest(
    scene: any,
    shapeId: string,
    rayOrigin: [number, number, number],
    rayDir: [number, number, number],
    edgeThreshold: number,
  ): any;
  exportShapes(
    scene: any,
    shapeIds: string[],
    options: {
      format: 'step' | 'stl';
      includeColors?: boolean;
      resolution?: string;
      customLinearDeflection?: number;
      customAngularDeflectionDeg?: number;
    },
  ): { data: string | Uint8Array; fileName: string };
};

export type SceneRenderedData = {
  absPath: string;
  sceneKind: FluidScriptKind;
  result: any[];
  rollbackStop: number;
  breakpointHit?: boolean;
  assembly?: SerializedAssembly;
  params?: ParamDefinition[];
};

export type SceneSummaryObject = {
  index: number;
  id: string;
  kind: string;
  uniqueKind: string;
  name: string;
  params: any;
  sourceLocation?: { filePath: string; line: number; column: number };
  shapeIds: string[];
  fromCache: boolean;
  hasError: boolean;
  errorMessage?: string;
  containerId: string | null;
  isContainer: boolean;
  visible: boolean;
};

export type SceneSummary = {
  schemaVersion: 1;
  file: string;
  objects: SceneSummaryObject[];
  rollbackStop: number;
  compileError: CompileError | null;
};

export type ShapeListEntry = {
  shapeId: string;
  type: string;
  sceneObjectId: string;
};

export type ShapeList = {
  shapes: ShapeListEntry[];
};

/**
 * `sessionId` is the per-renderer state key. In desktop mode it equals the
 * file path being edited (so per-file state survives switching files). In
 * hub mode it's a WebSocket connection UUID (so concurrent viewers stay
 * isolated). Map keys called `sessionId` accept either flavour.
 */

export class FluidCadServer {
  private host: SceneHost;
  private sceneManager: SceneManager | undefined;

  // Per-session render output, scene cache, and param overrides. Desktop's
  // sessionId is the normalized filePath; hub mode's sessionId is the WS
  // connection UUID. Maps must be cleared via `destroySession` on hub-side
  // disconnect to avoid leaks.
  private previousScenes: Map<string, any> = new Map();
  private renderingCache = new Map<string, { result: any[]; assembly?: SerializedAssembly }>();
  // Records the last successful render per session as `{ paramsHash, data }`.
  // Any subsequent render request short-circuits when the new params hash to
  // the same value — avoids redundant OCC work when desktop producers see the
  // same code+params, or hub clients re-emit the same param mutation.
  private lastRendered = new Map<string, { paramsHash: string; data: SceneRenderedData }>();
  private paramOverrides: Map<string, Map<string, any>> = new Map();
  // What file each session is rendering. For desktop, sessionId === filePath
  // (set lazily on first processFile call). For hub, set explicitly via
  // createSession with the bundle's manifest entry.
  private sessionFiles = new Map<string, string>();

  // Serializes OCC calls across all sessions. OCC isn't thread-safe and we
  // share one engine instance per host process; concurrent param edits from
  // multiple hub clients have to queue. Promise-chain pattern: each render
  // awaits the previous one's settlement before starting.
  private renderMutex: Promise<unknown> = Promise.resolve();

  private currentFileName: string = '';
  private currentFilePath: string = '';
  private lastRollbackStop: number = -1;
  private compileError: CompileError | null = null;

  constructor(host: SceneHost = new LocalSceneHost()) {
    this.host = host;
  }

  getCurrentCode(): string | null {
    if (!this.currentFileName) return null;
    return this.host.getBuffer(this.currentFileName);
  }

  async init(workspacePath: string) {
    await this.host.init(workspacePath);

    const initFilePath = normalizePath(join(workspacePath, 'init.js'));
    if (existsSync(initFilePath)) {
      const { default: _sceneManager } = await this.host.loadModule(initFilePath);
      this.sceneManager = await _sceneManager;
    }
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
    this.previousScenes.delete(sessionId);
    this.renderingCache.delete(sessionId);
    this.lastRendered.delete(sessionId);
    this.paramOverrides.delete(sessionId);
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

  private async processFileInternal(
    sessionId: string,
    filePath: string,
    ignoreCache: boolean,
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
        if (fromCache) {
          this.lastRollbackStop = fromCache.result.length - 1;
          this.compileError = null;
          return {
            absPath: normalizedFileName,
            sceneKind,
            result: fromCache.result,
            rollbackStop: fromCache.result.length - 1,
            ...(fromCache.assembly ? { assembly: fromCache.assembly } : {}),
          };
        }
      }

      try {
        let scene = sceneKind === 'assembly'
          ? this.sceneManager.startAssemblyScene()
          : this.sceneManager.startScene();
        this.sceneManager.setCurrentFile(normalizedFileName);
        this.host.invalidateModule();

        const registry = createParamRegistry();
        const overrides = this.paramOverrides.get(sessionId);
        if (overrides) {
          registry.setOverrides(overrides);
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

        const params = getParamRegistry().getDefinitions();

        if (this.previousScenes.has(sessionId)) {
          const previousScene = this.previousScenes.get(sessionId);
          scene = this.sceneManager.compare(previousScene, scene);
        }

        this.previousScenes.set(sessionId, scene);

        this.sceneManager.renderScene(scene);
        const result = scene.getRenderedObjects();

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
        }

        if (!filePath.startsWith('virtual:live-render')) {
          this.renderingCache.set(sessionId, assembly ? { result, assembly } : { result });
        }

        this.lastRollbackStop = result.length - 1;
        this.compileError = null;

        return {
          absPath: normalizedFileName,
          sceneKind,
          result,
          rollbackStop: result.length - 1,
          breakpointHit,
          params,
          ...(assembly ? { assembly } : {}),
        };
      }
      catch (error) {
        this.host.invalidateModule();
        console.log('Error processing file:', error);
        throw error;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Desktop API — sessionId is implicit (filePath)
  // ---------------------------------------------------------------------------

  async processFile(filePath: string, ignoreCache = false): Promise<SceneRenderedData | null> {
    filePath = normalizePath(filePath);
    const sessionId = filePath.replace('virtual:live-render:', '');
    this.sessionFiles.set(sessionId, sessionId);
    return this.processFileInternal(sessionId, filePath, ignoreCache);
  }

  async updateLiveCode(fileName: string, code: string): Promise<SceneRenderedData | null> {
    fileName = normalizePath(fileName);

    // Dedup against the last successful render. Multiple producers (editor
    // live-update, save-triggered process-file, watcher, MCP /api/render)
    // commonly hand us identical content; without this short-circuit each
    // would trigger a redundant OCC pass. paramsHash mixes code content with
    // current param overrides so a param change invalidates the cache.
    const paramsHash = this.computeParamsHash(fileName, code);
    const cached = this.lastRendered.get(fileName);
    if (cached && cached.paramsHash === paramsHash) {
      this.compileError = null;
      this.currentFileName = fileName;
      this.currentFilePath = `virtual:live-render:${fileName}`;
      this.lastRollbackStop = cached.data.rollbackStop;
      return cached.data;
    }

    const id = `virtual:live-render:${fileName}`;
    this.host.setBuffer(id, code);
    this.renderingCache.delete(fileName);
    this.sessionFiles.set(fileName, fileName);
    const result = await this.processFileInternal(fileName, id, true);
    if (result) {
      this.lastRendered.set(fileName, { paramsHash, data: result });
    }
    return result;
  }

  async rollbackFromUI(index: number): Promise<SceneRenderedData | null> {
    return this.rollback(this.currentFileName, index);
  }

  async recomputeCurrentFile(): Promise<SceneRenderedData | null> {
    if (!this.currentFilePath) {
      return null;
    }
    const sessionId = this.currentFileName;
    this.renderingCache.delete(sessionId);
    this.lastRendered.delete(sessionId);
    return this.processFileInternal(sessionId, this.currentFilePath, true);
  }

  async rollback(fileName: string, index: number): Promise<SceneRenderedData | null> {
    if (!this.sceneManager) {
      return null;
    }

    const scene = this.previousScenes.get(fileName);
    if (!scene) {
      return null;
    }

    const totalObjects = scene.getAllSceneObjects().length;

    const rollbackIndex = index >= totalObjects - 1 ? totalObjects - 1 : index;
    this.sceneManager.rollbackScene(scene, rollbackIndex);
    const result = scene.getRenderedObjects();
    const assembly = this.sceneManager.getAssemblyData(scene);

    this.lastRollbackStop = index;

    return {
      absPath: fileName,
      sceneKind: detectKind(fileName) ?? 'part',
      result,
      rollbackStop: index,
      ...(assembly ? { assembly } : {}),
    };
  }

  async importFile(workspacePath: string, fileName: string, data: string): Promise<void> {
    if (!this.sceneManager) {
      throw new Error('SceneManager not initialized');
    }

    const binaryData = Buffer.from(data, 'base64');
    await this.sceneManager.importFile(workspacePath, fileName, binaryData);
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
   * Export every solid of a hub session's latest render. The session-keyed twin
   * of `exportShapes` (which reads the desktop `currentFileName`): hub mode keys
   * each render's scene by `sessionId`, so exporting/downloading from a hub
   * session must look it up the same way — exactly why `hitTestForSession`
   * exists. Gathers all solids itself ("download the whole model"); returns null
   * when the session has no rendered scene or it holds no solids (the caller maps
   * that to a "nothing to export" response).
   */
  exportShapesForSession(
    sessionId: string,
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
    const scene = this.previousScenes.get(sessionId);
    if (!scene) {
      return null;
    }
    const shapeIds: string[] = [];
    for (const obj of scene.getAllSceneObjects()) {
      for (const shape of obj.getAddedShapes()) {
        if (shape.isSolid()) {
          shapeIds.push(shape.id);
        }
      }
    }
    if (shapeIds.length === 0) {
      return null;
    }
    return this.sceneManager.exportShapes(scene, shapeIds, options);
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

  getParamOverrides(sessionId: string): Record<string, any> {
    const map = this.paramOverrides.get(normalizePath(sessionId));
    if (!map) return {};
    return Object.fromEntries(map);
  }

  getCurrentFileName(): string {
    return this.currentFileName;
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
      objects,
      rollbackStop: this.lastRollbackStop,
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
    const overrides = this.paramOverrides.get(sessionId);
    const sortedEntries = overrides ? [...overrides.entries()].sort(([a], [b]) => a.localeCompare(b)) : [];
    const normalized = codeOrBundle.replace(/\r\n/g, '\n');
    return createHash('sha1')
      .update(normalized)
      .update('\0')
      .update(JSON.stringify(sortedEntries))
      .digest('hex');
  }
}

const MAX_PARAM_DEPTH = 6;

function sanitizeParams(value: unknown, depth = 0): any {
  if (value === null || value === undefined) {
    return value ?? null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (depth >= MAX_PARAM_DEPTH) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeParams(v, depth + 1));
  }
  if (typeof value === 'object') {
    // A scene-object reference. Render as { ref: id } so the agent can chase
    // it through other tools without us shipping the whole subtree.
    const maybeId = (value as any).id;
    const isSceneObjectRef =
      typeof maybeId === 'string' &&
      typeof (value as any).getType === 'function';
    if (isSceneObjectRef) {
      return { ref: maybeId };
    }
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'function') {
        continue;
      }
      out[k] = sanitizeParams(v, depth + 1);
    }
    return out;
  }
  return null;
}
