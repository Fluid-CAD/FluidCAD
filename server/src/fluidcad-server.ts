import { createHash } from 'crypto';
import { join } from 'path';
import { existsSync } from 'fs';
import { ViteManager } from './vite-manager.ts';
import { normalizePath } from './normalize-path.ts';
import { BreakpointHit } from '../../lib/dist/common/breakpoint-hit.js';
import type { CompileError } from './ws-protocol.ts';

type SceneManager = {
  startScene(): any;
  renderScene(scene: any): any;
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
  result: any[];
  rollbackStop: number;
  breakpointHit?: boolean;
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

export class FluidCadServer {
  private viteManager = new ViteManager();
  private sceneManager: SceneManager | undefined;
  private previousScenes: Map<string, any> = new Map();
  private renderingCache = new Map<string, any[]>();
  // Per-file hash + full result of the most recent successful render. Any
  // incoming render request — IPC live-update from the extension, watcher-
  // driven live-update under `fluidcad serve`, or HTTP /api/render from the
  // MCP — short-circuits here when the new code hashes to the same value.
  // Avoids redundant OCC work when multiple producers see the same write.
  private lastRendered = new Map<string, { hash: string; data: SceneRenderedData }>();
  private currentFileName: string = '';
  private currentFilePath: string = '';
  private lastRollbackStop: number = -1;
  private compileError: CompileError | null = null;

  async init(workspacePath: string) {
    await this.viteManager.init(workspacePath);

    const initFilePath = normalizePath(join(workspacePath, 'init.js'));
    if (existsSync(initFilePath)) {
      const { default: _sceneManager } = await this.viteManager.loadModule(initFilePath);
      this.sceneManager = await _sceneManager;
    }
  }

  async processFile(filePath: string, ignoreCache = false): Promise<SceneRenderedData | null> {
    if (!this.sceneManager) {
      return null;
    }

    filePath = normalizePath(filePath);
    const normalizedFileName = filePath.replace('virtual:live-render:', '');
    this.currentFileName = normalizedFileName;
    this.currentFilePath = filePath;

    if (!ignoreCache) {
      const fromCache = this.renderingCache.get(normalizedFileName);
      if (fromCache) {
        this.lastRollbackStop = fromCache.length - 1;
        this.compileError = null;
        return {
          absPath: normalizedFileName,
          result: fromCache,
          rollbackStop: fromCache.length - 1,
        };
      }
    }

    try {
      let scene = this.sceneManager.startScene();
      this.sceneManager.setCurrentFile(normalizedFileName);
      this.viteManager.invalidateModule();
      let breakpointHit = false;
      try {
        await this.viteManager.loadModule(filePath);
      }
      catch (e) {
        if (e instanceof BreakpointHit) {
          breakpointHit = true;
        } else {
          throw e;
        }
      }

      if (this.previousScenes.has(normalizedFileName)) {
        const previousScene = this.previousScenes.get(normalizedFileName);
        scene = this.sceneManager.compare(previousScene, scene);
      }

      this.previousScenes.set(normalizedFileName, scene);

      this.sceneManager.renderScene(scene);
      const result = scene.getRenderedObjects();

      for (const obj of result) {
        if (obj.sourceLocation) {
          obj.sourceLocation.filePath = obj.sourceLocation.filePath.replace('virtual:live-render:', '');
        }
      }

      if (!filePath.startsWith('virtual:live-render')) {
        this.renderingCache.set(normalizedFileName, result);
      }

      this.lastRollbackStop = result.length - 1;
      this.compileError = null;

      return {
        absPath: normalizedFileName,
        result,
        rollbackStop: result.length - 1,
        breakpointHit,
      };
    }
    catch (error) {
      this.viteManager.invalidateModule();
      console.log('Error processing file:', error);
      throw error;
    }
  }

  async updateLiveCode(fileName: string, code: string): Promise<SceneRenderedData | null> {
    fileName = normalizePath(fileName);

    // Dedup against the last successful render of this file. Multiple
    // producers (editor live-update, save-triggered process-file, watcher,
    // MCP /api/render) commonly hand us identical content; without this
    // short-circuit each one would trigger a redundant OCC pass.
    const hash = hashCode(code);
    const cached = this.lastRendered.get(fileName);
    if (cached && cached.hash === hash) {
      this.compileError = null;
      this.currentFileName = fileName;
      this.currentFilePath = `virtual:live-render:${fileName}`;
      this.lastRollbackStop = cached.data.rollbackStop;
      return cached.data;
    }

    const id = `virtual:live-render:${fileName}`;
    this.viteManager.setBuffer(id, code);
    this.renderingCache.delete(fileName);
    const result = await this.processFile(id, true);
    if (result) {
      this.lastRendered.set(fileName, { hash, data: result });
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
    this.previousScenes.delete(this.currentFileName);
    this.renderingCache.delete(this.currentFileName);
    this.lastRendered.delete(this.currentFileName);
    return this.processFile(this.currentFilePath, true);
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

    this.lastRollbackStop = index;

    return {
      absPath: fileName,
      result,
      rollbackStop: index,
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

  setCompileError(err: CompileError | null): void {
    this.compileError = err;
  }

  getCompileError(): CompileError | null {
    return this.compileError;
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
}

/**
 * Hash a `.fluid.js` source for dedup. Newlines are normalised to LF so a
 * round-trip through an editor (CRLF) and a disk write (LF) hashes the
 * same. SHA1 is plenty here — we just need a stable equality check, not
 * collision resistance against an adversary.
 */
function hashCode(code: string): string {
  return createHash('sha1').update(code.replace(/\r\n/g, '\n')).digest('hex');
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
