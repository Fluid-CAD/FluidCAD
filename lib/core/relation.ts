import { captureSourceLocation } from "../index.js";
import { getCurrentScene } from "../scene-manager.js";
import { AssemblyScene, type RelationType } from "../rendering/assembly-scene.js";
import { MateBuilder } from "../features/mate.js";
import { RelationBuilder, RelationRules, makeAssemblyRelation } from "../features/relation.js";

/**
 * Couples the free motions of two mates, the way meshing gears do: turning
 * one turns the other by the ratio. The mates keep their own freedom —
 * dragging either part, or animating either mate, moves both.
 *
 * | type | A (the driver's measure) | B (follows) | ratio |
 * |------|--------------------------|-------------|-------|
 * | `'gear'` | revolute or cylindrical: rotation about its Z | revolute or cylindrical: rotation about its Z | turns of B per turn of A |
 * | `'rack-and-pinion'` | revolute or cylindrical: the pinion's rotation | slider or cylindrical: the rack's travel along its Z | travel of B per revolution of A, in the document unit |
 *
 * Each rotation is measured about its own mate's Z (the first connector's
 * normal), each travel along it; a positive ratio moves B in the same
 * sense as A. Chain `.reverse()` when the real parts run the other way —
 * two external spur gears whose axes point the same way counter-rotate.
 * The relation holds from wherever the parts stand when it is solved: the
 * file's poses set the mesh phase.
 *
 *     const pinion = mate('revolute', base.connectors.axle, small.connectors.bore);
 *     const wheel = mate('revolute', base.connectors.axle2, big.connectors.bore);
 *     relation('gear', pinion, wheel, 0.5).reverse();   // 2:1 reduction
 *
 *     const rack = mate('slider', base.connectors.rail, bar.connectors.slot);
 *     relation('rack-and-pinion', pinion, rack, 62.8);  // 20 mm pitch radius
 *
 * `.name('drive')` assigns a stable authored name, unique within the owning
 * assembly occurrence. Both mates must be declared in the same assembly
 * scope as the relation. Only allowed in `*.assembly.js` files.
 *
 * @param type - `'gear'` or `'rack-and-pinion'`.
 * @param a - The mate whose motion is measured (a `mate()` handle).
 * @param b - The mate that follows it.
 * @param ratio - Gear: turns of B per turn of A. Rack-and-pinion: B's travel per turn of A. Positive.
 */
function relation(type: RelationType, a: MateBuilder, b: MateBuilder, ratio: number): RelationBuilder {
  const scene = getCurrentScene();
  if (!(scene instanceof AssemblyScene)) {
    throw new Error("relation() can only be used in *.assembly.js files.");
  }
  if (!RelationRules.TYPES.includes(type)) {
    throw new Error(
      `relation(): unknown relation type "${type}". Expected one of: ${RelationRules.TYPES.join(", ")}.`,
    );
  }
  for (const [side, value] of [["first", a], ["second", b]] as const) {
    if (!(value instanceof MateBuilder)) {
      throw new Error(
        `relation('${type}'): the ${side} argument must be a mate — bind the mate() statement to a const (const pinion = mate('revolute', …)) and pass that.`,
      );
    }
  }
  const recordA = a.getRecord();
  const recordB = b.getRecord();
  if (recordA === recordB) {
    throw new Error(`relation('${type}'): a mate cannot be related to itself.`);
  }
  const owner = scene.currentScopePath();
  for (const record of [recordA, recordB]) {
    if (!scene.getMates().includes(record)) {
      throw new Error(`relation('${type}'): the mate "${record.mateId}" belongs to another assembly — relate mates of this file.`);
    }
    if (record.owner !== owner) {
      throw new Error(
        `relation('${type}'): the mate "${record.mateId}" is declared in a different assembly scope — write the relation next to its mates, in the same assembly() body.`,
      );
    }
  }
  const sideProblem = RelationRules.sideProblem(type, recordA.type, recordB.type);
  if (sideProblem) {
    throw new Error(sideProblem);
  }
  const ratioProblem = RelationRules.ratioProblem(type, ratio);
  if (ratioProblem) {
    throw new Error(ratioProblem);
  }
  const sourceLocation = captureSourceLocation();
  const record = makeAssemblyRelation(
    type, recordA, recordB, ratio, scene.nextRelationId(), owner, sourceLocation ?? undefined,
  );
  scene.addRelation(record);
  return new RelationBuilder(record, scene);
}

export default relation;
