import { SceneObject } from "../common/scene-object.js";
import { LazyMatrix } from "../math/lazy-matrix.js";
import { Plane } from "../math/plane.js";
import { BoundConnector, Connector } from "./connector.js";
import { Part } from "./part.js";

/**
 * One copy of a connector, made by a `copy('linear' | 'circular', …)`
 * statement that lists the connector among its targets: the seed's frame
 * moved rigidly by one slot of the pattern, `frame = M_slot · frame_seed`.
 *
 * A copy is not re-derived from geometry at its new place — a `select()`
 * re-evaluated there falls back to the seed's own match when nothing matches,
 * and an assembly connector has no geometry at all — so it lands where the
 * pattern puts it, whatever is there. To keep copies on holes, pattern the
 * holes with the same pattern.
 *
 * Everything that takes a connector takes a copy unchanged, since it is one:
 * mates hold it, replicate compares it by identity, and the render stamps it
 * with its seed's host, so hiding that body hides the copies too. It is
 * read-only — it has no statement of its own, so `.rotate()` and `.offset()`
 * throw: adjust the seed and every copy follows. Copies live under their copy
 * statement, which folds them away in the timeline, never directly in the
 * part; the part reaches them through the seed's {@link ConnectorFamily}.
 */
export class ConnectorCopy extends Connector {
  constructor(
    readonly seed: Connector,
    readonly slot: number,
    readonly matrix: LazyMatrix,
  ) {
    super(seed.connectorName, seed.sourceShape, seed.options, seed.owner);
    this.name(this.label());
  }

  override build(): void {
    let seedFrame: Plane;
    try {
      seedFrame = this.seed.getFrame();
    } catch {
      throw new Error(`${this.label()} copies ${this.seed.label()}, which did not build`);
    }
    // The move is resolved only now: an axis object the pattern follows is
    // built by this point, not at parse time.
    this.setFrame(seedFrame.applyMatrix(this.matrix.resolve()));
    this.setHostShape(this.seed.getHostShape());
  }

  override rotate(): this {
    throw new Error(`${this.label()} is a copy — rotate ${this.seed.label()} itself and its copies follow`);
  }

  override offset(): this {
    throw new Error(`${this.label()} is a copy — offset ${this.seed.label()} itself and its copies follow`);
  }

  override instance(slot: number): Connector {
    throw new Error(
      `${this.label()} is a copy — address copies on the connector itself: ${this.seed.label()}.instance(${slot})`,
    );
  }

  override label(): string {
    return `${this.seed.label()}.instance(${this.slot})`;
  }

  override copySlot(): number {
    return this.slot;
  }

  override getDependencies(): SceneObject[] {
    return [this.seed];
  }

  override createCopy(remap: Map<SceneObject, SceneObject>): SceneObject {
    const seed = remap.get(this.seed);
    return new ConnectorCopy(seed instanceof Connector ? seed : this.seed, this.slot, this.matrix);
  }

  override compareTo(other: Connector): boolean {
    if (!(other instanceof ConnectorCopy) || !super.compareTo(other)) {
      return false;
    }
    return this.seed.compareTo(other.seed) && this.matrix.equals(other.matrix);
  }

  override serialize() {
    return { ...super.serialize(), copy: { slot: this.slot, seedId: this.seed.id } };
  }
}

/**
 * The copies one `copy()` statement made of one connector — what
 * `seed.instance(k)` reads. Slots are the statement's own numbering
 * (`CopyLayout`): the seed holds the original's slot, each placed slot holds
 * its copy, and the rest of `[0, slotCount)` are slots `skip` left out.
 */
export class ConnectorFamily {
  private readonly copies = new Map<number, ConnectorCopy>();

  constructor(
    readonly seed: Connector,
    /** The `copy()` statement — the errors name it. */
    readonly statement: SceneObject,
    readonly originalSlot: number,
    readonly slotCount: number,
  ) {}

  /** Record a copy at its slot (parse time). */
  add(copy: ConnectorCopy): void {
    this.copies.set(copy.slot, copy);
  }

  /** The copies in slot order, the seed left out. */
  getCopies(): ConnectorCopy[] {
    return [...this.copies.values()].sort((a, b) => a.slot - b.slot);
  }

  /** The member at `slot` — the seed at the original's — or null for a skipped or out-of-range slot. */
  memberAt(slot: number): Connector | null {
    if (slot === this.originalSlot) {
      return this.seed;
    }
    return this.copies.get(slot) ?? null;
  }

  /** The member at `slot`; throws for a slot out of range or one `skip` left out. */
  member(slot: number): Connector {
    const name = this.seed.label();
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.slotCount) {
      const range = this.slotCount === 1 ? "only instance 0" : `instances 0–${this.slotCount - 1}`;
      throw new Error(`${name}.instance(${slot}) is out of range — ${this.statementLabel()} makes ${range}`);
    }
    const member = this.memberAt(slot);
    if (!member) {
      throw new Error(`${name}.instance(${slot}) was skipped by ${this.statementLabel()}`);
    }
    return member;
  }

  /** `the copy at flange.part.js:14` — the statement as messages name it. */
  statementLabel(): string {
    const location = this.statement.getSourceLocation();
    if (!location) {
      return "the copy statement";
    }
    const file = location.filePath.split("/").pop() ?? location.filePath;
    return `the copy at ${file}:${location.line}`;
  }
}

/**
 * Where a `copy()` statement runs: inside a part body — the part and the
 * innermost container around the call — or at an assembly file's top level,
 * under the assembly scope path it ran in ("" for the root assembly, an
 * occurrence path inside an inserted `assembly()` body).
 */
export type ConnectorCopyScope =
  | { kind: "part"; part: Part | null; container: SceneObject | null }
  | { kind: "assembly"; scopePath: string };

/**
 * The rules a `copy()` statement's connector targets must follow, checked
 * when the statement runs. Each answers with the reason to refuse the whole
 * statement — it then copies nothing, and its row reports why — or null.
 *
 * - A part's connectors are copied inside that part's own body, directly in
 *   it, and never inside a sketch.
 * - An assembly's connectors (`connector('bay', [x, y, z])`) are copied at
 *   the assembly's top level, root scope only — like the connectors
 *   themselves — and a top-level copy() copies nothing else.
 * - One copy statement per connector, and a copy is never copied again — a
 *   grid is one two-axis linear copy.
 * - An inserted instance's connector (`f.connectors.bolt`) is the
 *   assembly's handle on a part connector, never a copy() target or axis.
 *
 * A `copy()` without targets never copies connectors: inside a part it
 * copies the shapes already there, and a connector owns none.
 */
export class ConnectorCopyRules {
  /** A `copy()` inside a sketch handed a connector — a 2D copy stamps sketch geometry only. */
  static inSketch(targets: readonly unknown[]): string | null {
    const connector = targets.find((t): t is Connector => t instanceof Connector);
    if (!connector) {
      return null;
    }
    return `copy(): connectors aren't copied inside a sketch — copy ${connector.label()} in the part body, outside sketch()`;
  }

  /** An inserted instance's connector handed to `copy()`. */
  static boundTarget(targets: readonly unknown[]): string | null {
    const bound = targets.find((t): t is BoundConnector => t instanceof BoundConnector);
    if (!bound) {
      return null;
    }
    const name = bound.label();
    return `copy(): instance.connectors.${name} belongs to an inserted instance — copy ${name} inside its part's body`;
  }

  /**
   * An inserted instance's connector handed to `copy()` as its axis — its
   * pose is the assembly solver's, which the kernel never sees.
   */
  static boundAxis(axes: readonly unknown[]): string | null {
    const bound = axes.find((a): a is BoundConnector => a instanceof BoundConnector);
    if (!bound) {
      return null;
    }
    return `copy(): instance.connectors.${bound.label()} belongs to an inserted instance — its pose is the `
      + `assembly solver's, so it can't be a copy axis`;
  }

  /**
   * The statement-level rules at an assembly file's top level: root scope
   * only, like `connector()` there, and the targets are assembly connectors
   * — listed explicitly, since the top level has no solids to fall back on.
   * An inserted instance's connector among the targets is left to
   * {@link boundTarget}; the per-connector rules follow in
   * {@link seedRefusal}.
   */
  static assemblyStatement(targets: readonly unknown[], scopePath: string): string | null {
    if (scopePath !== "") {
      return "copy() inside an assembly() body — assembly connectors are root-scope only for now; "
        + "copy them at the top level of the file that declares them";
    }
    if (targets.length === 0) {
      return "copy(): at an assembly's top level copy() copies assembly connectors — list the ones to copy, "
        + "e.g. copy('linear', 'x', { count: 3, offset: 20 }, bay)";
    }
    const other = targets.find(t => !(t instanceof Connector) && !(t instanceof BoundConnector));
    if (other !== undefined) {
      return `copy(): at an assembly's top level copy() copies assembly connectors only — got `
        + `${ConnectorCopyRules.describe(other)}; solids are copied inside a part's body`;
    }
    return null;
  }

  /**
   * An axis a top-level assembly copy can't follow. There the axis is a
   * world axis or an assembly connector — its Z axis through its origin —
   * and never an inserted instance's connector ({@link boundAxis}) or
   * anything built inside a part.
   */
  static assemblyAxis(axes: readonly unknown[]): string | null {
    for (const axis of axes) {
      if (axis instanceof Connector && !axis.isAssemblyConnector()) {
        return `copy(): ${axis.label()} is a part connector — an assembly's copy axis is a world axis `
          + `('x', 'y', 'z') or an assembly connector`;
      }
      if (axis instanceof SceneObject && !(axis instanceof Connector)) {
        return `copy(): at an assembly's top level the copy axis is a world axis ('x', 'y', 'z') or an `
          + `assembly connector — got ${ConnectorCopyRules.describe(axis)}`;
      }
    }
    return null;
  }

  /** The per-connector rules, for a statement running in `scope`. */
  static seedRefusal(seeds: readonly Connector[], scope: ConnectorCopyScope): string | null {
    const seen = new Set<Connector>();
    for (const seed of seeds) {
      if (seen.has(seed)) {
        return `copy(): ${seed.label()} is listed twice — list each connector once`;
      }
      seen.add(seed);
      const refusal = ConnectorCopyRules.oneSeed(seed, scope);
      if (refusal) {
        return refusal;
      }
    }
    return null;
  }

  private static oneSeed(seed: Connector, scope: ConnectorCopyScope): string | null {
    if (seed instanceof ConnectorCopy) {
      return `copy(): ${seed.label()} is itself a copy and isn't copied again — copy ${seed.seed.label()} `
        + `instead (a grid is one two-axis linear copy)`;
    }
    const placement = scope.kind === "part"
      ? ConnectorCopyRules.partPlacement(seed, scope)
      : ConnectorCopyRules.assemblyPlacement(seed);
    if (placement) {
      return placement;
    }
    const family = seed.getFamily();
    if (family) {
      return `copy(): ${seed.label()} is already copied by ${family.statementLabel()} — one copy statement `
        + `per connector (a grid is one two-axis linear copy)`;
    }
    return null;
  }

  /** A part connector is copied directly in its own part's body. */
  private static partPlacement(
    seed: Connector,
    scope: Extract<ConnectorCopyScope, { kind: "part" }>,
  ): string | null {
    if (seed.isAssemblyConnector()) {
      return `copy(): ${seed.label()} is an assembly connector — it isn't copied inside a part`;
    }
    const owner = seed.getParent();
    if (!(owner instanceof Part) || owner !== scope.part) {
      const whose = owner instanceof Part ? ` belongs to part "${owner.partName}"` : " belongs to another part";
      return `copy(): ${seed.label()}${whose} — a part's connectors are copied inside that part's body`;
    }
    if (scope.container !== scope.part) {
      const where = scope.container ? `${scope.container.getType()}(...)` : "another callback";
      return `copy(): copy ${seed.label()} directly in the part() body — this call is nested inside ${where}`;
    }
    return null;
  }

  /** An assembly's top level copies its own connectors, never a part's. */
  private static assemblyPlacement(seed: Connector): string | null {
    if (!seed.isAssemblyConnector()) {
      return `copy(): ${seed.label()} is a part connector — copy it inside its part's body`;
    }
    return null;
  }

  /** How a refusal names a value that isn't what the rule wanted. */
  private static describe(value: unknown): string {
    if (value instanceof SceneObject) {
      return `a ${value.getType()}()`;
    }
    if (value !== null && typeof value === "object" && "connectors" in value) {
      return "an inserted instance";
    }
    return value === null ? "null" : `a ${typeof value}`;
  }
}
