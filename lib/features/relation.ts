import type { AssemblyMate, AssemblyRelation, AssemblyScene, MateType, RelationType } from "../rendering/assembly-scene.js";
import type { SourceLocation } from "../common/scene-object.js";

/**
 * The per-type rules a `relation()` statement must satisfy — stated once
 * here and mirrored by the server writer's validation (assembly-relation-
 * edit.ts) and the dialog's slot eligibility, so every layer refuses the
 * same statements with the same reasons.
 */
export class RelationRules {
  /** Mates with a rotation to couple: the free rotZ of a revolute or cylindrical. */
  static readonly ROTATING: ReadonlyArray<MateType> = ["revolute", "cylindrical"];
  /** Mates with a slide to couple: the free slideZ of a slider or cylindrical. */
  static readonly SLIDING: ReadonlyArray<MateType> = ["slider", "cylindrical"];
  static readonly TYPES: ReadonlyArray<RelationType> = ["gear", "rack-and-pinion"];

  /** Which mate types side A accepts for the relation type. */
  static sideATypes(type: RelationType): ReadonlyArray<MateType> {
    return RelationRules.ROTATING;
  }

  /** Which mate types side B accepts for the relation type. */
  static sideBTypes(type: RelationType): ReadonlyArray<MateType> {
    return type === "gear" ? RelationRules.ROTATING : RelationRules.SLIDING;
  }

  /**
   * Why the pair of mate types can't be related as `type`, or null when it
   * can. Worded for the statement author: it names the side and what it
   * takes instead.
   */
  static sideProblem(type: RelationType, mateTypeA: MateType, mateTypeB: MateType): string | null {
    if (!RelationRules.sideATypes(type).includes(mateTypeA)) {
      return type === "gear"
        ? `relation('gear'): the first mate is '${mateTypeA}' — a gear couples the rotation of two revolute or cylindrical mates.`
        : `relation('rack-and-pinion'): the first mate is '${mateTypeA}' — the pinion side must be a revolute or cylindrical mate (the rotation).`;
    }
    if (!RelationRules.sideBTypes(type).includes(mateTypeB)) {
      return type === "gear"
        ? `relation('gear'): the second mate is '${mateTypeB}' — a gear couples the rotation of two revolute or cylindrical mates.`
        : `relation('rack-and-pinion'): the second mate is '${mateTypeB}' — the rack side must be a slider or cylindrical mate (the travel). A planar mate frees two directions and a spin, so there is no single travel to couple; put the rack on a slider.`;
    }
    return null;
  }

  /** Why `ratio` is not a usable relation ratio, or null. */
  static ratioProblem(type: RelationType, ratio: unknown): string | null {
    if (typeof ratio !== "number" || !Number.isFinite(ratio)) {
      return `relation('${type}'): the ratio must be a finite number.`;
    }
    if (ratio <= 0) {
      return type === "gear"
        ? `relation('gear', a, b, ${ratio}): the ratio must be positive — it is how many turns B makes per turn of A; chain .reverse() to turn B the other way.`
        : `relation('rack-and-pinion', a, b, ${ratio}): the travel per revolution must be positive; chain .reverse() to run the rack the other way.`;
    }
    return null;
  }
}

export class RelationBuilder {
  constructor(private readonly relation: AssemblyRelation, private readonly scene?: AssemblyScene) {}

  /** @internal */
  getRecord(): AssemblyRelation {
    return this.relation;
  }

  /** Stable authored name, unique among relations in this assembly occurrence. */
  name(name: string): this {
    if (typeof name !== "string" || !name.trim()) {
      throw new Error("relation().name(): expected a non-empty string.");
    }
    const value = name.trim();
    if (this.scene?.getRelations().some(r => r !== this.relation && r.owner === this.relation.owner && r.name === value)) {
      throw new Error(`relation().name(): duplicate name "${value}" in this assembly scope.`);
    }
    this.relation.name = value;
    return this;
  }

  /**
   * Run B against A's sense: a gear's B turns the other way about its own
   * Z, a rack travels the other way along its Z. Toggles, so the canonical
   * statement writes it at most once.
   */
  reverse(): this {
    this.relation.reverse = !this.relation.reverse;
    return this;
  }
}

export function makeAssemblyRelation(
  type: RelationType,
  mateA: AssemblyMate,
  mateB: AssemblyMate,
  ratio: number,
  relationId: string,
  owner: string,
  sourceLocation: SourceLocation | undefined,
): AssemblyRelation {
  return { relationId, owner, type, mateA, mateB, ratio, reverse: false, sourceLocation };
}
