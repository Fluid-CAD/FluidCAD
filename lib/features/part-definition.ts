import { Part } from "./part.js";
import { registerPartDefinitionClass } from "./part-args.js";
import type { Connector } from "./connector.js";
import type { Exposed } from "./exposed.js";
import type { SceneObject } from "../common/scene-object.js";
import type { Scene } from "../rendering/scene.js";
import { AssemblyScene } from "../rendering/assembly-scene.js";
import type { SourceLocation } from "../common/scene-object.js";
import { BreakpointHit } from "../common/breakpoint-hit.js";
import { getCurrentScene } from "../scene-manager.js";
import { popParamScope, pushParamScope } from "../param-registry.js";
import type { ParamOverrides, ParamVal } from "../param-registry.js";
import { canonicalVariantKey, collectedParamValues, toOverrideMap, warnUnknownOverrides } from "./param-overrides.js";

/**
 * A lazy part definition created by `part(name, callback)`.
 *
 * Nothing builds at definition time — geometry materializes per VARIANT
 * (one distinct assignment of the definition's `param()` values), keyed by
 * the canonicalized override map and cached per scene, so
 * `insert(def, { Length: 380 })` twice builds one template shared by both
 * instances, exactly like the old `const base = factory(380)` sharing
 * pattern. Mirrors the lazy `Assembly` definition (13-sub-assemblies);
 * `part()`'s old eager build survives as the entry-file materialization
 * pass (every definition an open part file declares still renders).
 *
 * Detected across engine realms by duck-typed
 * `getType() === 'part-definition'`; the materialized scene object keeps
 * `getType() === 'part'`, so old-engine/new-server combinations stay
 * classifiable.
 *
 * The `T` parameter (the callback's return type) is deprecated: the return
 * value no longer feeds `def.features` — kept only so user code that passes
 * definitions around stays typed.
 */
export class PartDefinition<T = unknown> {
  /**
   * Built variants, per scene: canonical override key → template Part.
   * Keyed weakly so disposed scenes release their templates.
   */
  private readonly variantsByScene = new WeakMap<Scene, Map<string, Part>>();

  /** Display name new variants materialize with — `.name()` overrides partName. */
  private displayName: string;

  /** One warning per definition when a callback still returns a features object. */
  private warnedReturn = false;

  constructor(
    public readonly partName: string,
    private readonly callback: () => T,
    private sourceLocation: SourceLocation | null = null,
  ) {
    this.displayName = partName;
  }

  /** Re-stamp where the definition was authored — variants built after this call carry it. */
  setSourceLocation(location: SourceLocation): this {
    this.sourceLocation = location;
    return this;
  }

  getSourceLocation(): SourceLocation | null {
    return this.sourceLocation;
  }

  getType(): string {
    return "part-definition";
  }

  /** Rename: variants materialized after this call carry `value` as their part name. */
  name(value: string): this {
    this.displayName = value;
    return this;
  }

  /**
   * No-op — a definition isn't consumable geometry, so there is nothing to
   * keep alive. Present so definitions satisfy the `ISceneObject` structural
   * surface everywhere a built part used to flow.
   */
  reusable(): this {
    return this;
  }

  private variantsIn(scene: Scene): Map<string, Part> {
    let variants = this.variantsByScene.get(scene);
    if (!variants) {
      variants = new Map();
      this.variantsByScene.set(scene, variants);
    }
    return variants;
  }

  /** Whether any variant of this definition was built into `scene`. */
  hasVariantIn(scene: Scene): boolean {
    return (this.variantsByScene.get(scene)?.size ?? 0) > 0;
  }

  /**
   * The insert path: always builds under a parameter scope (even with zero
   * overrides), so an inserted part's `param()` calls never reach the
   * consuming file's global registry / params panel.
   */
  materializeVariant(scene: Scene, extra?: ParamOverrides): Part {
    return this.buildVariant(scene, toOverrideMap(extra), true);
  }

  /**
   * The entry-file path (standalone render of the defining file): builds
   * through the GLOBAL registry so the definition's params land in the
   * panel with override/baseline bookkeeping intact.
   */
  materializeInto(scene: Scene): Part {
    return this.buildVariant(scene, new Map(), false);
  }

  /**
   * Materialize into the current scene — the host's export arm and the
   * legacy-access hatch (`def.features`, `.from(def)`, transform-argument
   * coercion). In an assembly scene the build is SCOPED like insert()'s:
   * a read and an insert() share the default-variant template instead of
   * racing for the cache slot with different scoping, and the definition's
   * param() calls never leak into the consuming assembly's global registry
   * (they are the part's insertion interface, not the assembly's panel).
   * Part-kind scenes keep panel semantics — the same unscoped build the
   * entry-file pass does.
   */
  materialize(): Part {
    const scene = getCurrentScene();
    if (!scene) {
      throw new Error(`part '${this.partName}': no active scene to build into.`);
    }
    if (scene instanceof AssemblyScene) {
      return this.materializeVariant(scene);
    }
    return this.materializeInto(scene);
  }

  private buildVariant(scene: Scene, overrides: Map<string, ParamVal>, scoped: boolean): Part {
    const variants = this.variantsIn(scene);
    const key = canonicalVariantKey(overrides);
    const cached = variants.get(key);
    if (cached) {
      return cached;
    }

    const partObj = new Part(this.displayName);
    if (this.sourceLocation) {
      partObj.setSourceLocation(this.sourceLocation);
    }

    const scope = scoped ? pushParamScope(overrides) : null;
    let extensions: T;
    try {
      // Templates are always top-level: a definition referenced mid-build of
      // another container (a filter's `.from(def)`, a nested reference) must
      // not become that container's child.
      extensions = scene.runTopLevel(() => {
        scene.startProgressiveContainer(partObj);
        try {
          return this.callback();
        } finally {
          scene.endProgressiveContainer();
        }
      });
    } catch (e) {
      if (e instanceof BreakpointHit) {
        // A paused build IS this variant's world: the partial Part is already
        // in the scene, so record it — otherwise a second materialization
        // pass (the host's export arm plus the leftover-definitions pass both
        // materialize entry-file definitions) re-runs the callback and lands
        // a DUPLICATE partial part in the same scene. The pause is stamped on
        // the partial so consumer reads of an exposure the breakpoint kept
        // from registering re-propagate the pause instead of failing the
        // render (Part.features).
        partObj.markPaused(e);
        variants.set(key, partObj);
      }
      throw e;
    } finally {
      if (scope) {
        popParamScope();
      }
    }

    if (extensions && typeof extensions === 'object' && !this.warnedReturn) {
      // Hard cutover: the callback's return value no longer feeds
      // `def.features` — publications are declared with expose().
      this.warnedReturn = true;
      console.warn(
        `part '${this.partName}': the callback's return value is ignored — `
        + `declare publications with expose('name', source); consumers keep reading def.features.<name>.`,
      );
    }
    if (scope) {
      if (scope.collected.size > 0) {
        partObj.params = Array.from(scope.collected.values());
        partObj.paramValues = collectedParamValues(scope);
      }
      warnUnknownOverrides('part', this.partName, scope);
    }

    variants.set(key, partObj);
    return partObj;
  }

  /**
   * The definition's geometry interface: exposure sources by name, as
   * registered by the part body's `expose('name', source)` statements.
   * First touch materializes the default variant into the current scene.
   *
   * Untyped by design (mirroring `InstanceConnectors`): the `T` inferred
   * from the callback no longer types this — the callback return value is
   * a deprecated contract and no longer feeds `features`.
   */
  get features(): Record<string, SceneObject> {
    return this.materialize().features;
  }

  getConnectors(): Connector[] {
    return this.materialize().getConnectors();
  }

  getNamedConnectors(): Record<string, Connector> {
    return this.materialize().getNamedConnectors();
  }

  getExposed(): Exposed[] {
    return this.materialize().getExposed();
  }

  getNamedExposures(): Record<string, SceneObject> {
    return this.materialize().getNamedExposures();
  }
}

/**
 * Coerce any part definitions among mixed user arguments to their built
 * default variant in the current scene — the runtime half of definitions
 * flowing where built parts used to (`translate(50, 0, 0, def)`,
 * `face().from(def)`, `remove(def)`). Coercion at argument-evaluation time
 * keeps build order: the donor's geometry enters the scene before the
 * consuming statement does.
 */
registerPartDefinitionClass(PartDefinition);
