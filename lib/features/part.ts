import { BuildSceneObjectContext, SceneObject } from "../common/scene-object.js";
import { BreakpointHit } from "../common/breakpoint-hit.js";
import { Connector } from "./connector.js";
import { Exposed } from "./exposed.js";
import { IPart } from "../core/interfaces.js";
import { serializableParamDefs } from "./param-overrides.js";
import { guardedRecord } from "./guarded-record.js";
import { propertyValues, serializedProperties } from "./part-property.js";
import type { PartProperty, PropertyValues } from "./part-property.js";
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
   * The values the body published with `property('name', value)`, in
   * statement order — this variant's scalar interface. Recorded as the
   * statements execute (a breakpoint pause keeps the ones before it), so
   * they are per-variant like `paramValues`.
   */
  private readonly _properties: PartProperty[] = [];

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

  /**
   * The material id the definition's `.material()` assigned, copied here by
   * `PartDefinition.buildVariant`; null when none. Kept as the raw id (the
   * server resolves it against the merged materials list — an unknown id
   * is a warning there, not a build error here).
   */
  private _material: string | null = null;

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

    // The material rides the serialized payload: a cached Part served for
    // a material-only edit would keep reporting the old id.
    if (this._material !== other._material) {
      return false;
    }

    return true;
  }

  getType(): string {
    return "part";
  }

  setMaterial(id: string | null): void {
    this._material = id;
  }

  /** The material id `.material()` assigned on the definition, or null. */
  getMaterial(): string | null {
    return this._material;
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

  /**
   * The connectors the part body declared with `connector('name', …)`, in
   * statement order — its direct children. Their copies live under the
   * `copy()` statements that made them.
   */
  getDeclaredConnectors(): Connector[] {
    return this.getChildren().filter(
      (c): c is Connector => c instanceof Connector && c.copySlot() === undefined,
    );
  }

  /**
   * Every connector frame the part carries: each declared connector followed
   * by its copies in slot order (`bolt`, `bolt.instance(1)`, …) — what the
   * render, the hosts and the mate solver see.
   */
  getConnectors(): Connector[] {
    const out: Connector[] = [];
    for (const connector of this.getDeclaredConnectors()) {
      out.push(connector);
      const family = connector.getFamily();
      if (family) {
        out.push(...family.getCopies());
      }
    }
    return out;
  }

  /**
   * The part's declared connectors keyed by the name each `connector('name',
   * …)` statement registered. Mates reference connectors through this map
   * (`instance.connectors.main`), so the binding is robust to source
   * reordering inside the part — adding or moving a `connector(...)` call
   * doesn't shuffle which name maps to which connector. Uniqueness is
   * enforced at creation time by `connector()`. A copy is reached through
   * its seed (`instance.connectors.bolt.instance(3)`), never by a name of
   * its own — see {@link resolveConnector}.
   */
  getNamedConnectors(): Record<string, Connector> {
    const out: Record<string, Connector> = {};
    for (const c of this.getDeclaredConnectors()) {
      out[c.connectorName] = c;
    }
    return out;
  }

  /**
   * The connector a `(name, slot)` address names — the declared connector,
   * or with a slot its copy there (the connector itself at the original's
   * slot) — or null when either is missing. How `replicate()` rebinds a
   * replica's own sides.
   */
  resolveConnector(name: string, slot?: number): Connector | null {
    const connector = this.getDeclaredConnectors().find(c => c.connectorName === name);
    if (!connector) {
      return null;
    }
    if (slot === undefined) {
      return connector;
    }
    return connector.getFamily()?.memberAt(slot) ?? null;
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
    return guardedRecord(this.getNamedExposures(), name => {
      this.rethrowIfPaused();
      throw new Error(this.missingExposureMessage(name));
    });
  }

  private missingExposureMessage(name: string): string {
    const declared = Object.keys(this.getNamedExposures());
    const listing = declared.length > 0
      ? `declared exposures: ${declared.join(", ")}`
      : "it declares none";
    return `part "${this.partName}" exposes no "${name}" — ${listing}. `
      + `Publish it inside the part body with expose('${name}', source).`;
  }

  /** Register a `property()` declaration of the running body — `property()` enforces name uniqueness. */
  addProperty(property: PartProperty): void {
    this._properties.push(property);
  }

  /** The body's `property()` declarations, in statement order. */
  getProperties(): PartProperty[] {
    return [...this._properties];
  }

  /**
   * name → value of every property, verbatim as the body published them.
   * An unguarded plain record — the wire and internal enumerators use
   * this; user reads go through `properties`.
   */
  getPropertyValues(): Record<string, ParamVal> {
    return propertyValues(this._properties);
  }

  /**
   * The part's value interface: `property()` values by name, as
   * `instance.properties.<name>` / `def.properties.<name>` serve them.
   * Guarded exactly like `features` — an undeclared name throws a pointed
   * error naming the declared properties, and a build paused before the
   * `property()` statement ran re-throws the breakpoint instead.
   */
  get properties(): PropertyValues {
    return guardedRecord(this.getPropertyValues(), name => {
      this.rethrowIfPaused();
      throw new Error(this.missingPropertyMessage(name));
    });
  }

  private missingPropertyMessage(name: string): string {
    const declared = this._properties.map(p => p.name);
    const listing = declared.length > 0
      ? `declared properties: ${declared.join(", ")}`
      : "it declares none";
    return `part "${this.partName}" has no property "${name}" — ${listing}. `
      + `Declare it inside the part body with property('${name}', value).`;
  }

  /**
   * A variant whose build paused at a breakpoint() before a publication
   * statement ran: the consumer pauses like everything else downstream of
   * the breakpoint (with the original hit's location) instead of failing
   * the whole render over a name that would have registered.
   */
  private rethrowIfPaused(): void {
    if (this.pausedBy) {
      throw new BreakpointHit(this.pausedBy.sourceLocation);
    }
  }

  serialize() {
    return {
      name: this.partName,
      /** The material id, absent when the definition assigned none. */
      material: this._material ?? undefined,
      paramValues: this.paramValues,
      // Control metadata for per-instance parameter editing (sourceLocation
      // stripped — that serves the panel's declaration edits, not the wire).
      params: this.params ? serializableParamDefs(this.params) : undefined,
      properties: serializedProperties(this),
    };
  }
}
