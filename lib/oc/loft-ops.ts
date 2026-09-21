import { getOC } from "./init.js";
import { Explorer } from "./explorer.js";
import { Solid } from "../common/solid.js";
import { Wire } from "../common/wire.js";
import { ConstrainedLoft, LoftEndCondition, LoftConditionKind, ThinLoftWalls } from "./loft/constrained-loft.js";
import { GuidedLoft } from "./loft/guided-loft.js";
import { mmTol } from "../units/tolerance.js";
import { Point } from "../math/point.js";

export type { LoftEndCondition, LoftConditionKind, ThinLoftWalls };

export interface LoftOptions {
  /** Constrains how the surface leaves the first profile. */
  startCondition?: LoftEndCondition;
  /** Constrains how the surface arrives at the last profile. */
  endCondition?: LoftEndCondition;
  /** One or two side rails the loft surface must follow. */
  guides?: Wire[];
  /** Each connection joins one world-space profile vertex per section. */
  connections?: Point[][];
}

export class LoftOps {
  /**
   * Lofts through the section wires. Plain lofts run OCC's ThruSections;
   * guides dispatch to `GuidedLoft` (virtual sections carried onto the
   * rails), connections and start/end conditions to `ConstrainedLoft` (pinned
   * skinning) — both in-house skins, since OCC can neither constrain end
   * tangency nor follow rails without distorting sections. Conditions
   * compose with guides: the condition fades out around each guide contact
   * (the rails own their sides of the surface). Connections compose with
   * both: they pin the sections, and rail contacts align around the pins.
   */
  static makeLoft(wires: Wire[], options?: LoftOptions): Solid[] {
    const guides = options?.guides ?? [];
    if (guides.length > 0) {
      return GuidedLoft.build(wires, guides, options?.startCondition, options?.endCondition, options?.connections);
    }
    if (options?.connections?.length) {
      return ConstrainedLoft.build(wires, options.startCondition, options.endCondition, options.connections);
    }
    if (options?.startCondition || options?.endCondition) {
      return ConstrainedLoft.build(wires, options.startCondition, options.endCondition);
    }
    return LoftOps.makeThruSectionsLoft(wires);
  }

  /**
   * Thin-walled loft with start/end conditions or connections: both walls
   * are skinned with the same constraints and assembled directly with ring
   * caps — see `ConstrainedLoft.buildThin`. Connections are stated on the
   * profiles and carried onto each wall. (The unconstrained thin loft stays
   * on the legacy ThruSections + boolean path in the feature layer.)
   */
  static makeThinLoft(walls: ThinLoftWalls[], options: LoftOptions): Solid[] {
    return ConstrainedLoft.buildThin(walls, options.startCondition, options.endCondition, options.connections);
  }

  private static makeThruSectionsLoft(wires: Wire[]): Solid[] {
    const oc = getOC();

    const thruSections = new oc.BRepOffsetAPI_ThruSections(true, false, mmTol(1e-6));

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
