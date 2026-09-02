import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { BreakpointHit } from "../common/breakpoint-hit.js";
import { Connector } from "./connector.js";
import { Exposed } from "./exposed.js";
import { IPart } from "../core/interfaces.js";
import { serializableParamDefs } from "./param-overrides.js";
import type { ParamDefinition, ParamVal } from "../param-registry.js";
import { unitFactor } from "../units/units.js";
import type { LengthUnit } from "../units/units.js";

export class Part extends SceneObject implements IPart {
  /**
   * The definition's parameter interface, collected while this variant
   * materialized under a parameter scope (insert path). Entry-file root
   * builds register into the global registry instead and leave this unset.
   */
  params?: ParamDefinition[];
  /** Resolved parameter values of the variant build — rides SerializedInstance. */
  paramValues?: Record<string, ParamVal>;

  /**
   * The breakpoint() that cut this variant's build short, if any — stamped
   * by `PartDefinition.buildVariant` when it records a paused partial. Kept
   * so `features` reads of an exposure the pause prevented from registering
   * re-propagate the pause (with the original hit's source location)
   * instead of failing the render — see the `features` getter.
   */
  private pausedBy: BreakpointHit | null = null;

  /**
   * The unit this variant was materialized INTO — the active unit at the
   * consuming statement (an assembly's project unit, or the unit of the
   * part file reading `def.features`). When it differs from the defining
   * file's unit the render pass rescales the built geometry into it
   * (part-scale.ts); `null` until buildVariant stamps it.
   */
  private _targetUnit: LengthUnit | null = null;

  constructor(public partName: string) {
    super();
    this.name(partName);
    this.setAlwaysVisible();
  }

  isContainer(): boolean {
    return true;
  }

  build(_context?: BuildSceneObjectContext): void {
    // No-op — children produce geometry
  }

  compareTo(other: Part): boolean {
    if (!(other instanceof Part)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.partName !== other.partName) {
      return false;
    }

    // A unit change on either side (the defining file's unit(), or the
    // project unit the scene runs in) changes the scale factor baked into
    // the cached geometry — never serve it from cache.
    if (this.getDefinitionUnit() !== other.getDefinitionUnit()
        || this.getTargetUnit() !== other.getTargetUnit()) {
      return false;
    }

    return true;
  }

  getType(): string {
    return "part";
  }

  /** The unit the defining file's numbers are in. */
  getDefinitionUnit(): LengthUnit {
    return this.getAuthoredUnit();
  }

  setTargetUnit(unit: LengthUnit): void {
    this._targetUnit = unit;
  }

  /** The unit the variant is consumed in — the definition unit when unset. */
  getTargetUnit(): LengthUnit {
    return this._targetUnit ?? this.getDefinitionUnit();
  }

  /** Whether the built geometry has to be rescaled into the target unit. */
  isForeignUnit(): boolean {
    return this.getDefinitionUnit() !== this.getTargetUnit();
  }

  /** Multiplier taking definition-unit lengths into the target unit. */
  getUnitScaleFactor(): number {
    return unitFactor(this.getDefinitionUnit(), this.getTargetUnit());
  }

  getConnectors(): Connector[] {
    return this.getChildren().filter(c => c instanceof Connector) as Connector[];
  }

  /**
   * The part's connectors keyed by the name each `connector('name', …)`
   * statement registered. Mates reference connectors through this map
   * (`instance.connectors.main`), so the binding is robust to source
   * reordering inside the part — adding or moving a `connector(...)` call
   * doesn't shuffle which name maps to which connector. Uniqueness is
   * enforced at creation time by `connector()`.
   */
  getNamedConnectors(): Record<string, Connector> {
    const out: Record<string, Connector> = {};
    for (const c of this.getConnectors()) {
      out[c.connectorName] = c;
    }
    return out;
  }

  getExposed(): Exposed[] {
    return this.getChildren().filter(c => c instanceof Exposed) as Exposed[];
  }

  /**
   * The part's exposures keyed by the name each `expose('name', …)` statement
   * registered, serving the SOURCE rather than the `Exposed` wrapper —
   * a consumer's `extrude(15, def.features.profile)` must depend on the
   * donor-owned object so cross-part dependency resolution keeps working.
   */
  getNamedExposures(): Record<string, SceneObject> {
    const out: Record<string, SceneObject> = {};
    for (const e of this.getExposed()) {
      out[e.exposeName] = e.source;
    }
    return out;
  }

  /** Record the breakpoint() that cut this variant's build short. */
  markPaused(hit: BreakpointHit): void {
    this.pausedBy = hit;
  }

  isPaused(): boolean {
    return this.pausedBy !== null;
  }

  /**
   * The part's geometry interface: exposure sources by name
   * (`def.features.<name>`). Reads are guarded — an exposure name this part
   * does not carry never comes back `undefined` (which would surface later
   * as a baffling argument error in the consumer):
   *
   * - If this variant's build paused at a breakpoint() before the
   *   `expose()` statement ran, the read re-throws BreakpointHit with the
   *   original hit's location — the consumer pauses like everything else
   *   downstream of the breakpoint, instead of failing the whole render.
   * - Otherwise the name is genuinely undeclared (a typo, or the expose()
   *   was removed) and the read throws a pointed error naming the declared
   *   exposures.
   *
   * Only identifier-shaped string keys are guarded: symbol keys and
   * protocol probes (`then` from await coercion, JSON/console lookups)
   * fall through so the record still behaves like a plain object.
   * Internal callers that enumerate exposures use `getNamedExposures()`,
   * which stays an unguarded plain record.
   */
  get features(): Record<string, SceneObject> {
    const exposures = this.getNamedExposures();
    return new Proxy(exposures, {
      get: (target, prop, receiver) => {
        if (typeof prop === "string" && !(prop in target) && Part.isExposureLookup(prop)) {
          if (this.pausedBy) {
            throw new BreakpointHit(this.pausedBy.sourceLocation);
          }
          throw new Error(this.missingExposureMessage(prop));
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  /**
   * Names the runtime itself may probe on any object — never treated as a
   * missing exposure so the guarded `features` record still awaits,
   * stringifies, and logs like a plain object.
   */
  private static readonly PROTOCOL_PROPS = new Set([
    "then", "catch", "finally", "toJSON", "toString", "valueOf", "constructor", "inspect",
  ]);

  /** Whether a missing-property read looks like a real `def.features.<name>` lookup. */
  private static isExposureLookup(name: string): boolean {
    if (Part.PROTOCOL_PROPS.has(name)) {
      return false;
    }
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
  }

  private missingExposureMessage(name: string): string {
    const declared = Object.keys(this.getNamedExposures());
    const listing = declared.length > 0
      ? `declared exposures: ${declared.join(", ")}`
      : "it declares none";
    return `part "${this.partName}" exposes no "${name}" — ${listing}. `
      + `Publish it inside the part body with expose('${name}', source).`;
  }

  serialize() {
    return {
      name: this.partName,
      paramValues: this.paramValues,
      // Control metadata for per-instance parameter editing (sourceLocation
      // stripped — that serves the panel's declaration edits, not the wire).
      params: this.params ? serializableParamDefs(this.params) : undefined,
    };
  }
}
