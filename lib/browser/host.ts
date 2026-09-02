import { init, type FluidCADOptions } from "../index.js";
import { createParamRegistry, getParamRegistry } from "../param-registry.js";
import type { ParamRegistry, ParamVal } from "../param-registry.js";
import { createManager } from "../scene-manager.js";
import { setAssetProvider } from "../io/file-import.js";
import { BreakpointHit } from "../common/breakpoint-hit.js";
import { PartDefinition } from "../features/part-definition.js";
import { Scene } from "../rendering/scene.js";
import type { ExportOptions } from "../io/file-export.js";
import type { MeasureEntityRef } from "../oc/measure/measure-types.js";
import { installEngineNamespaces } from "./linking.js";
import {
  VIEWER_PROTOCOL_VERSION,
  type BrowserObjectBuildError,
  type BrowserRenderResult,
  type BrowserSceneKind,
  type EngineInfo,
} from "./types.js";

type SceneManagerInstance = ReturnType<typeof createManager>;

/** Mirrors the server's detectKind (file-kind.ts): the suffix names the scene kind. */
export function detectSceneKind(entryPath: string): BrowserSceneKind {
  return entryPath.endsWith(".assembly.js") ? "assembly" : "part";
}

/**
 * Evaluates the current model "module" and returns its namespace. In the
 * viewer this imports a freshly compiled Blob URL — a new URL per call is the
 * browser-native equivalent of the desktop host's invalidateModule(); the
 * host calls it once per render pass.
 */
export type ModuleEvaluator = () => Promise<Record<string, unknown>>;

/**
 * The browser-side counterpart of FluidCadServer for a read-only viewer: one
 * model, one implicit session. Owns the render loop the desktop server runs
 * (fluidcad-server.ts processFileInternal) — fresh scene + param registry per
 * pass, scene compare for incremental rebuilds, param-override settling — and
 * the read-only command surface (params, rollback, recompute, properties,
 * measure, export, hit-test). Module compilation is injected via
 * ModuleEvaluator: bundling strategy belongs to the viewer, execution
 * semantics belong here.
 */
export class BrowserEngineHost {
  private manager: SceneManagerInstance | null = null;
  private evaluator: ModuleEvaluator | null = null;
  private previousScene: Scene | null = null;
  private overrides = new Map<string, unknown>();
  private lastParamDefaults = new Map<string, ParamVal>();
  private lastBreakpointHit = false;
  private lastRollbackStop = -1;
  private entryPath = "/model.fluid.js";

  static engineInfo(): EngineInfo {
    const version = (globalThis as { __FLUIDCAD_VERSION__?: string }).__FLUIDCAD_VERSION__;
    return { protocolVersion: VIEWER_PROTOCOL_VERSION, engineVersion: version ?? "dev" };
  }

  /**
   * Boot the kernel (OCJS + fonts + scene manager) and expose the linking
   * namespaces. A hub host seeds `options.unit` from the package manifest's
   * `unit` (schemaVersion 3; absent on older packages → mm): the browser has
   * no `fluidcad.json` to read, so this is the only way the project unit
   * reaches the engine, and `BrowserRenderResult.unit` then reports what the
   * viewer should display in.
   */
  async init(options?: FluidCADOptions): Promise<EngineInfo> {
    installEngineNamespaces();
    this.manager = await init(options);
    return BrowserEngineHost.engineInfo();
  }

  /**
   * Install the model's workspace: asset bytes served through the existing
   * AssetProvider hook (imports, workspace fonts), and the entry path used
   * for setCurrentFile. Text values are encoded as UTF-8.
   */
  setWorkspace(files: Record<string, string | Uint8Array>, entryPath: string): void {
    this.entryPath = entryPath.startsWith("/") ? entryPath : "/" + entryPath;
    const encoder = new TextEncoder();
    const bytes = new Map<string, Uint8Array>();
    for (const [path, content] of Object.entries(files)) {
      const key = path.startsWith("/") ? path.slice(1) : path;
      bytes.set(key, typeof content === "string" ? encoder.encode(content) : content);
    }
    setAssetProvider((relPath) => bytes.get(relPath) ?? null);
  }

  /** Swap in a newly compiled model module. The next render() evaluates it. */
  setModuleEvaluator(evaluator: ModuleEvaluator): void {
    this.evaluator = evaluator;
  }

  /**
   * One full render pass, ported from FluidCadServer.processFileInternal:
   * fresh scene and param registry (with the session's overrides against
   * their baselines), module eval + calling exported functions (LocalSceneHost
   * parity), settle param bookkeeping, compare against the previous scene for
   * incremental reuse, mesh, and collect per-object build errors. On an eval
   * error the previous scene keeps being served, exactly like the desktop's
   * compile-error path.
   */
  async render(): Promise<BrowserRenderResult> {
    if (!this.manager) {
      throw new Error("BrowserEngineHost.init() must be called before render()");
    }
    if (!this.evaluator) {
      throw new Error("No model loaded — call setModuleEvaluator() first");
    }

    const sceneKind = detectSceneKind(this.entryPath);
    let scene: Scene = sceneKind === "assembly" ? this.manager.startAssemblyScene() : this.manager.startScene();
    this.manager.setCurrentFile(this.entryPath);

    const registry = createParamRegistry();
    if (this.overrides.size > 0) {
      registry.setOverrides(new Map(this.overrides), new Map(this.lastParamDefaults));
    }

    let breakpointHit = false;
    try {
      const mod = await this.evaluator();
      for (const value of Object.values(mod)) {
        let result: unknown = value;
        if (typeof value === "function") {
          result = await (value as () => unknown)();
        }
        if (result instanceof PartDefinition) {
          result.materializeInto(scene);
        }
      }
      // part() is lazy — definitions nothing exported still render standalone
      // in a part scene; assembly scenes build strictly via insert().
      if (sceneKind !== "assembly") {
        scene.materializeLeftoverDefinitions();
      }
      // A bare `assembly('name', () => {...})` statement is a lazy definition
      // nothing runs — without this the render is a silently empty scene.
      const dangling = (scene as { getDanglingDefinitionNames?: () => string[] }).getDanglingDefinitionNames?.() ?? [];
      if (dangling.length > 0) {
        throw new Error(
          `assembly('${dangling[0]}') is defined but never rendered — export a function returning it `
          + `(export const myAssembly = () => assembly('${dangling[0]}', () => {...});) so this file `
          + `renders it standalone, or insert() it from another assembly.`,
        );
      }
    } catch (error) {
      if (error instanceof BreakpointHit) {
        breakpointHit = true;
      } else {
        // The half-built scene is dropped un-disposed, matching the server's
        // error path; previousScene (still what the UI shows) is untouched.
        const err = error as Error;
        return {
          result: this.previousScene ? this.previousScene.getRenderedObjects() : [],
          rollbackStop: this.lastRollbackStop,
          unit: scene.unit,
      declaredUnit: scene.declaredUnit,
      projectUnit: this.manager.projectUnit,
          breakpointHit: false,
          objectErrors: [],
          compileError: { message: err?.message ?? String(error), stack: err?.stack },
        };
      }
    }
    this.lastBreakpointHit = breakpointHit;

    const params = getParamRegistry().getDefinitions();
    this.settleParamOverrides(registry);

    if (this.previousScene) {
      scene = this.manager.compare(this.previousScene, scene);
    }
    this.previousScene = scene;

    this.manager.renderScene(scene);
    const result = scene.getRenderedObjects();
    this.lastRollbackStop = result.length - 1;
    const assembly = this.manager.getAssemblyData(scene);

    return {
      sceneKind,
      result,
      rollbackStop: this.lastRollbackStop,
      unit: scene.unit,
      declaredUnit: scene.declaredUnit,
      projectUnit: this.manager.projectUnit,
      breakpointHit,
      params,
      objectErrors: BrowserEngineHost.collectObjectErrors(result),
      compileError: null,
      ...(assembly ? { assembly } : {}),
    };
  }

  /**
   * Forget the current model (scene, incremental-compare baseline, param
   * overrides) ahead of loading a different entry from the same workspace —
   * the viewer's file tabs. The kernel stays booted; setWorkspace() +
   * setModuleEvaluator() then prime the next model.
   */
  unloadModel(): void {
    if (this.previousScene) {
      this.manager?.disposeScene(this.previousScene);
      this.previousScene = null;
    }
    this.overrides.clear();
    this.lastParamDefaults.clear();
    this.lastBreakpointHit = false;
    this.lastRollbackStop = -1;
    this.evaluator = null;
  }

  /** Value-flow only: override a param and re-render. Source is never touched. */
  async setParam(label: string, value: unknown): Promise<BrowserRenderResult> {
    this.overrides.set(label, value);
    return this.render();
  }

  async resetParams(): Promise<BrowserRenderResult> {
    this.overrides.clear();
    return this.render();
  }

  /**
   * Explicit full rebuild: drop the incremental-compare baseline so every
   * object rebuilds from scratch (FluidCadServer.recompute's forceFullRebuild
   * branch — without this an unchanged model compares fully cached and the
   * action does no visible work).
   */
  async recompute(): Promise<BrowserRenderResult> {
    if (this.previousScene) {
      this.manager?.disposeScene(this.previousScene);
      this.previousScene = null;
    }
    return this.render();
  }

  /**
   * Timeline scrub: re-mesh the existing scene up to `index` without
   * re-running the module (FluidCadServer.rollback). `scope: 'part'`
   * truncates only the target's enclosing part and keeps the rest of the
   * scene fully rendered — the manager owns the clamp, the scope
   * derivation, and the echoed stop.
   */
  rollback(index: number, scope?: 'part'): BrowserRenderResult | null {
    if (!this.manager || !this.previousScene) {
      return null;
    }
    const scene = this.previousScene;
    const { stop, scopePartId } = this.manager.rollbackScene(scene, index, { partScoped: scope === 'part' });
    const result = scene.getRenderedObjects();
    this.lastRollbackStop = stop;
    return {
      result,
      rollbackStop: stop,
      unit: scene.unit,
      declaredUnit: scene.declaredUnit,
      projectUnit: this.manager.projectUnit,
      ...(scopePartId ? { rollbackScopePartId: scopePartId } : {}),
      // A rollback doesn't re-run the module — the paused state persists.
      breakpointHit: this.lastBreakpointHit,
      objectErrors: BrowserEngineHost.collectObjectErrors(result),
      compileError: null,
    };
  }

  getShapeProperties(shapeId: string) {
    return this.previousScene ? this.manager?.getShapeProperties(this.previousScene, shapeId) ?? null : null;
  }

  getFaceProperties(shapeId: string, faceIndex: number) {
    return this.previousScene ? this.manager?.getFaceProperties(this.previousScene, shapeId, faceIndex) ?? null : null;
  }

  getEdgeProperties(shapeId: string, edgeIndex: number) {
    return this.previousScene ? this.manager?.getEdgeProperties(this.previousScene, shapeId, edgeIndex) ?? null : null;
  }

  measure(refs: MeasureEntityRef[]) {
    return this.previousScene ? this.manager?.measure(this.previousScene, refs) ?? null : null;
  }

  hitTest(shapeId: string, rayOrigin: [number, number, number], rayDir: [number, number, number], edgeThreshold: number) {
    return this.previousScene ? this.manager?.hitTest(this.previousScene, shapeId, rayOrigin, rayDir, edgeThreshold) ?? null : null;
  }

  exportShapes(shapeIds: string[], options: ExportOptions) {
    if (!this.previousScene) {
      throw new Error("Nothing rendered yet");
    }
    return this.manager!.exportShapes(this.previousScene, shapeIds, options);
  }

  dispose(): void {
    if (this.previousScene) {
      this.manager?.disposeScene(this.previousScene);
      this.previousScene = null;
    }
    setAssetProvider(null);
  }

  /**
   * Ported from FluidCadServer.settleParamOverrides (single implicit
   * session): remember what each param() declared so the next render can tell
   * an edited default from an unchanged one, and forget the overrides this
   * render found stale. Baselines merge rather than replace — a param that
   * didn't run this pass keeps the default it last declared.
   */
  private settleParamOverrides(registry: ParamRegistry): void {
    for (const [label, authored] of registry.getAuthoredDefaults()) {
      this.lastParamDefaults.set(label, authored);
    }
    for (const label of registry.getDiscardedOverrides()) {
      this.overrides.delete(label);
    }
  }

  /** Ported from FluidCadServer.collectObjectErrors — see that doc comment. */
  private static collectObjectErrors(result: unknown[]): BrowserObjectBuildError[] {
    const errors: BrowserObjectBuildError[] = [];
    for (let index = 0; index < result.length; index++) {
      const obj = result[index] as {
        hasError?: boolean; id: string; name: string; uniqueType: string;
        errorMessage?: string; sourceLocation?: BrowserObjectBuildError["sourceLocation"];
      };
      if (!obj?.hasError) {
        continue;
      }
      errors.push({
        index,
        id: obj.id,
        name: obj.name,
        uniqueKind: obj.uniqueType,
        message: obj.errorMessage || "Build failed.",
        sourceLocation: obj.sourceLocation,
      });
    }
    return errors;
  }
}
