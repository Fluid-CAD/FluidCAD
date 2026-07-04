import { getOC } from "./init.js";
import { Explorer } from "./explorer.js";
import { Solid } from "../common/solid.js";
import { Wire } from "../common/wire.js";
import { ConstrainedLoft, LoftEndCondition, LoftConditionKind } from "./loft/constrained-loft.js";
import { GuidedLoft } from "./loft/guided-loft.js";

export type { LoftEndCondition, LoftConditionKind };

export interface LoftOptions {
  /** Constrains how the surface leaves the first profile. */
  startCondition?: LoftEndCondition;
  /** Constrains how the surface arrives at the last profile. */
  endCondition?: LoftEndCondition;
  /** One or two side rails the loft surface must follow. */
  guides?: Wire[];
}

export class LoftOps {
  /**
   * Lofts through the section wires. Plain lofts run OCC's ThruSections;
   * guides dispatch to `GuidedLoft` (virtual sections carried onto the
   * rails) and start/end conditions to `ConstrainedLoft` (derivative-pinned
   * skinning) — both in-house skins, since OCC can neither constrain end
   * tangency nor follow rails without distorting sections. Conditions
   * compose with guides: the condition fades out around each guide contact
   * (the rails own their sides of the surface).
   */
  static makeLoft(wires: Wire[], options?: LoftOptions): Solid[] {
    const guides = options?.guides ?? [];
    if (guides.length > 0) {
      return GuidedLoft.build(wires, guides, options?.startCondition, options?.endCondition);
    }
    if (options?.startCondition || options?.endCondition) {
      return ConstrainedLoft.build(wires, options.startCondition, options.endCondition);
    }
    return LoftOps.makeThruSectionsLoft(wires);
  }

  /**
   * Thin-walled loft with start/end conditions: both walls are skinned with
   * the same conditions and assembled directly with ring caps — see
   * `ConstrainedLoft.buildThin`. (The condition-less thin loft stays on the
   * legacy ThruSections + boolean path in the feature layer.)
   */
  static makeThinLoft(outerWires: Wire[], innerWires: Wire[], options: LoftOptions): Solid[] {
    return ConstrainedLoft.buildThin(outerWires, innerWires, options.startCondition, options.endCondition);
  }

  private static makeThruSectionsLoft(wires: Wire[]): Solid[] {
    const oc = getOC();

    const thruSections = new oc.BRepOffsetAPI_ThruSections(true, false, 1e-6);

    for (const wire of wires) {
      thruSections.AddWire(wire.getShape());
    }

    const progress = new oc.Message_ProgressRange();
    thruSections.Build(progress);
    progress.delete();

    if (!thruSections.IsDone()) {
      thruSections.delete();
      throw new Error("Loft operation failed.");
    }

    const result = thruSections.Shape();
    thruSections.delete();

    const solids = Explorer.findShapes(result, Explorer.getOcShapeType("solid"));

    if (solids.length === 0) {
      throw new Error("Loft produced no solids.");
    }

    return solids.map(s => Solid.fromTopoDSSolid(Explorer.toSolid(s)));
  }
}
