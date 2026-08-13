import { Part } from "./part.js";
import type { Connector } from "./connector.js";
import type { Scene } from "../rendering/scene.js";
import type { SourceLocation } from "../common/scene-object.js";
import { getCurrentScene } from "../scene-manager.js";
import { popParamScope, pushParamScope } from "../param-registry.js";
import type { ParamOverrides, ParamVal } from "../param-registry.js";
import { canonicalVariantKey, mergeOverrides, validateParamOverrides, warnUnknownOverrides } from "./param-overrides.js";

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
 */
export class PartDefinition<T = unknown> {
  /**
   * Built variants, per scene: canonical override key → template Part.
   * Lives on the ROOT definition so `.with()` derivatives share it; keyed
   * weakly so disposed scenes release their templates.
   */
  private readonly variantsByScene = new WeakMap<Scene, Map<string, Part>>();

  /** Display name new variants materialize with — `.name()` overrides partName. */
  private displayName: string;

  constructor(
    public readonly partName: string,
    private readonly callback: () => T,
    private sourceLocation: SourceLocation | null = null,
    private readonly boundOverrides: ReadonlyMap<string, ParamVal> = new Map(),
    private readonly rootDefinition: PartDefinition<T> | null = null,
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

  /**
   * A derived definition with `overrides` pre-bound (later `.with()` and
   * insert-time overrides win over earlier ones). Cheap — no build; variants
   * stay shared with the root definition's cache.
   */
  with(overrides: ParamOverrides): PartDefinition<T> {
    validateParamOverrides(`part '${this.partName}'.with()`, overrides);
    return new PartDefinition<T>(
      this.partName,
      this.callback,
      this.sourceLocation,
      mergeOverrides(this.boundOverrides, overrides),
      this.root(),
    );
  }

  private root(): PartDefinition<T> {
    return this.rootDefinition ?? this;
  }

  private variantsIn(scene: Scene): Map<string, Part> {
    const root = this.root();
    let variants = root.variantsByScene.get(scene);
    if (!variants) {
      variants = new Map();
      root.variantsByScene.set(scene, variants);
    }
    return variants;
  }

  /** Whether any variant of this definition was built into `scene`. */
  hasVariantIn(scene: Scene): boolean {
    return (this.root().variantsByScene.get(scene)?.size ?? 0) > 0;
  }

  /**
   * The insert path: always builds under a parameter scope (even with zero
   * overrides), so an inserted part's `param()` calls never reach the
   * consuming file's global registry / params panel.
   */
  materializeVariant(scene: Scene, extra?: ParamOverrides): Part {
    return this.buildVariant(scene, mergeOverrides(this.boundOverrides, extra), true);
  }

  /**
   * The entry-file path (standalone render of the defining file): a plain
   * definition builds through the GLOBAL registry so its params land in the
   * panel with override/baseline bookkeeping intact; a `.with()` derivative
   * builds scoped — its bound values are fixed, not panel state.
   */
  materializeInto(scene: Scene): Part {
    const overrides = new Map(this.boundOverrides);
    return this.buildVariant(scene, overrides, overrides.size > 0);
  }

  /** `materializeInto` the current scene — the host's export arm and the legacy-access hatch. */
  materialize(): Part {
    const scene = getCurrentScene();
    if (!scene) {
      throw new Error(`part '${this.partName}': no active scene to build into.`);
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
    } finally {
      if (scope) {
        popParamScope();
      }
    }

    if (extensions && typeof extensions === 'object') {
      partObj.features = extensions;
    }
    if (scope) {
      if (scope.collected.size > 0) {
        partObj.params = Array.from(scope.collected.values());
        const values: Record<string, ParamVal> = {};
        for (const [label, def] of scope.collected) {
          values[label] = def.currentValue;
        }
        partObj.paramValues = values;
      }
      warnUnknownOverrides('part', this.partName, scope);
    }

    variants.set(key, partObj);
    return partObj;
  }

  /**
   * Legacy-access hatches: the eager `part()` returned the built Part, so
   * old code reads `.features` / connectors straight off the return value.
   * First touch materializes the default variant into the current scene.
   */
  get features(): T {
    return this.materialize().features as T;
  }

  getConnectors(): Connector[] {
    return this.materialize().getConnectors();
  }

  getNamedConnectors(): Record<string, Connector> {
    return this.materialize().getNamedConnectors();
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
export function materializePartArgs(args: unknown[]): any[] {
  return args.map(a => (a instanceof PartDefinition ? a.materialize() : a));
}
