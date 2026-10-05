import { Solid } from "../common/solid.js";
import { Wire } from "../common/wire.js";
import { SkinnedLoft, LoftEndCondition, LoftConditionKind, ThinLoftWalls } from "./loft/skinned-loft.js";
import { GuidedLoft } from "./loft/guided-loft.js";
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
   * Lofts through the section wires on the in-house skin. Guides dispatch to
   * `GuidedLoft` (virtual sections carried onto the rails); everything else
   * — plain lofts, connections, start/end conditions — to `SkinnedLoft`.
   * OCC can neither constrain end tangency nor follow rails without
   * distorting sections, and running plain lofts on the same skin keeps a
   * loft's edges and faces stable when options are added or removed.
   * Conditions compose with guides: the condition fades out around each
   * guide contact (the rails own their sides of the surface). Connections
   * compose with both: they pin the sections, and rail contacts align
   * around the pins.
   */
  static makeLoft(wires: Wire[], options?: LoftOptions): Solid[] {
    const guides = options?.guides ?? [];
    if (guides.length > 0) {
      return GuidedLoft.build(wires, guides, options?.startCondition, options?.endCondition, options?.connections);
    }
    return SkinnedLoft.build(wires, options?.startCondition, options?.endCondition, options?.connections);
  }

  /**
   * Thin-walled loft: both walls are skinned with the same constraints and
   * assembled directly with ring caps — see `SkinnedLoft.buildThin`.
   * Connections are stated on the profiles and carried onto each wall.
   */
  static makeThinLoft(walls: ThinLoftWalls[], options?: LoftOptions): Solid[] {
    return SkinnedLoft.buildThin(walls, options?.startCondition, options?.endCondition, options?.connections);
  }
}
