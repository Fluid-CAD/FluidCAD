import { SceneObject } from "../common/scene-object.js";
import { BoundConnector, Connector } from "./connector.js";
import { ConnectorCopyRules, ConnectorCopyScope } from "./connector-copy.js";
import { CopyBase } from "./copy-base.js";
import { CopyLayout, CopySlotLayout } from "./copy-layout.js";
import { MirrorFeature } from "./mirror-feature.js";
import { Part } from "./part.js";
import { RepeatBase } from "./repeat-base.js";
import { RepeatCircular } from "./repeat-circular.js";
import { RepeatLinear } from "./repeat-linear.js";

/**
 * `copy(pattern, ...connectors)` — connector copies that follow a linear or
 * circular `repeat()` instead of laying out a pattern of their own. Each copy
 * is its seed's frame moved the way the repeat moved that instance — the very
 * transform the repeat's clones carry — so `copy(holes, bolt)` puts
 * `bolt.instance(k)` on `holes.instance(k)`: the repeat's numbering, its
 * original slot and its skipped slots, a partial arc spaced the repeat's way
 * (`angle / (count − 1)`, where `copy('circular')` steps `angle / count`).
 * Edit the repeat and the copies follow.
 *
 * It copies connectors only, and only inside a part's body — the part that
 * declares both the repeat and the connectors. A mirror, rotate or matrix
 * repeat is never followed: a connector copy is its frame moved rigidly,
 * never reflected. Every rule refuses the statement on its own row
 * ({@link CopyPattern.statementRefusal}, then the connectors' own rules and
 * the repeat's state when the copies are made).
 */
export class CopyPattern extends CopyBase {
  constructor(
    /** The repeat to follow — null when the argument was no scene object, and the statement is refused. */
    public pattern: SceneObject | null,
    /** The connectors to copy, as written; anything else among them refuses the statement. */
    public targetObjects: SceneObject[],
  ) {
    super();
  }

  /** The followed repeat's slots — none for a pattern the statement refused. */
  slotLayout(): CopySlotLayout {
    if (!CopyPattern.isFollowable(this.pattern)) {
      return { originalSlot: 0, slotCount: 0, slots: [] };
    }
    return CopyLayout.follow(this.pattern);
  }

  protected override followedPattern(): SceneObject | null {
    return this.pattern;
  }

  /** The followed repeat's own state, once the statement's rules passed ({@link repeatStateRefusal}). */
  protected connectorOptionsRefusal(): string | null {
    return CopyPattern.isFollowable(this.pattern) ? CopyPattern.repeatStateRefusal(this.pattern) : null;
  }

  compareTo(other: CopyPattern): boolean {
    if (!(other instanceof CopyPattern)) {
      return false;
    }

    if (!super.compareTo(other)) {
      return false;
    }

    if (this.pattern === null || other.pattern === null) {
      if (this.pattern !== other.pattern) {
        return false;
      }
    } else if (!this.pattern.compareTo(other.pattern)) {
      return false;
    }

    if (this.targetObjects.length !== other.targetObjects.length) {
      return false;
    }

    for (let i = 0; i < this.targetObjects.length; i++) {
      if (!this.targetObjects[i].compareTo(other.targetObjects[i])) {
        return false;
      }
    }

    return true;
  }

  getType(): string {
    return "copy-pattern";
  }

  /**
   * The rules the statement itself must follow, checked when it runs: a part
   * body — neither an assembly's top level nor a sketch — a linear or
   * circular repeat to follow, connectors and nothing else to copy, and the
   * repeat in the very part the statement runs in. The connectors' own rules
   * ({@link ConnectorCopyRules.seedRefusal}) and the repeat's state
   * ({@link connectorOptionsRefusal}) follow once these pass.
   */
  static statementRefusal(
    pattern: unknown,
    targets: readonly unknown[],
    scope: ConnectorCopyScope,
    inSketch: boolean,
  ): string | null {
    if (scope.kind === "assembly") {
      return "copy(): copy(pattern, …) follows a repeat() inside a part's body — at an assembly's top level "
        + "copy a connector with copy('linear' | 'circular', axis, options, …)";
    }
    if (inSketch) {
      return ConnectorCopyRules.inSketch(targets)
        ?? "copy(): copy(pattern, …) copies connectors in a part's body, not inside a sketch";
    }
    return ConnectorCopyRules.boundTarget(targets)
      ?? CopyPattern.patternRefusal(pattern)
      ?? CopyPattern.targetRefusal(targets)
      ?? CopyPattern.placementRefusal(pattern as RepeatBase, scope);
  }

  /**
   * Why the form can't follow `pattern` — what it is, or the state it is in
   * — or null. The statement and the copy ghost read the same rules, so the
   * dialog refuses what the row would.
   */
  static followRefusal(pattern: unknown): string | null {
    return CopyPattern.patternRefusal(pattern)
      ?? CopyPattern.repeatStateRefusal(pattern as RepeatLinear | RepeatCircular);
  }

  /** Whether `pattern` is a repeat the form can follow: a linear or circular one. */
  private static isFollowable(pattern: unknown): pattern is RepeatLinear | RepeatCircular {
    return pattern instanceof RepeatLinear || pattern instanceof RepeatCircular;
  }

  /**
   * What a linear or circular repeat's own state rules out: a refused repeat
   * has no instances to follow, a linear count of zero numbers no slot at all
   * — not even the original's — and a centered circular repeat lays an
   * instance on its original (B3), where a connector copy would land on its
   * seed.
   */
  private static repeatStateRefusal(pattern: RepeatLinear | RepeatCircular): string | null {
    if (pattern.getRefusal()) {
      return "copy(): the repeat this copy follows is refused, so it has no instances to follow — fix that repeat first";
    }
    if (pattern instanceof RepeatCircular && pattern.options.centered) {
      return "copy(): a connector can't follow a centered circular repeat yet — drop centered on the repeat; "
        + "its pattern then starts at the original";
    }
    if (pattern.getInstanceSlots().length === 0) {
      return "copy(): the repeat numbers no instances — a connector copy needs a count of at least 1";
    }
    return null;
  }

  /** A first argument that isn't a linear or circular repeat. */
  private static patternRefusal(pattern: unknown): string | null {
    if (CopyPattern.isFollowable(pattern)) {
      return null;
    }
    if (pattern instanceof MirrorFeature) {
      return "copy(): copy(pattern, …) follows a linear or circular repeat() — a mirror repeat reflects its "
        + "instance, and a copied connector is never reflected";
    }
    if (pattern instanceof RepeatBase) {
      return "copy(): copy(pattern, …) follows a linear or circular repeat() — not a rotate or matrix repeat; "
        + "turn a connector with copy('circular', axis, options, …)";
    }
    return `copy(): copy(pattern, …) follows a repeat() — got ${CopyPattern.describe(pattern)}; pass the `
      + `repeat() itself, e.g. copy(holes, bolt)`;
  }

  /** No connector to copy, or something that isn't one among them. */
  private static targetRefusal(targets: readonly unknown[]): string | null {
    if (targets.length === 0) {
      return "copy(): copy(pattern, …) needs the connectors to copy — e.g. copy(holes, bolt)";
    }
    const other = targets.find(target => !(target instanceof Connector));
    if (other !== undefined) {
      return `copy(): copy(pattern, …) copies connectors only — got ${CopyPattern.describe(other)}; copy solids `
        + `with copy('linear' | 'circular', axis, options, …)`;
    }
    return null;
  }

  /**
   * A repeat of another part — or of a file's top level — followed from this
   * one: the copies would land on instances the part doesn't have.
   */
  private static placementRefusal(pattern: RepeatBase, scope: Extract<ConnectorCopyScope, { kind: "part" }>): string | null {
    const owner = CopyPattern.enclosingPart(pattern);
    if (owner === scope.part) {
      return null;
    }
    const where = owner ? `part "${owner.partName}"` : "the file's top level";
    return `copy(): the repeat belongs to ${where} — a connector follows a repeat in its own part's body`;
  }

  /** The part whose body `object` was made in, or null at a file's top level. */
  private static enclosingPart(object: SceneObject): Part | null {
    let current = object.getParent();
    while (current) {
      if (current instanceof Part) {
        return current;
      }
      current = current.getParent();
    }
    return null;
  }

  /** How a refusal names a value that isn't what the rule wanted: `cut()`, `a number`. */
  private static describe(value: unknown): string {
    if (value instanceof SceneObject) {
      return `${value.getType()}()`;
    }
    if (value instanceof BoundConnector) {
      return `instance.connectors.${value.label()}`;
    }
    if (value === null || value === undefined) {
      return String(value);
    }
    return `a ${typeof value}`;
  }
}
