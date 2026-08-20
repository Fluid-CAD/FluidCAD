// The implicit sketch datums — origin point + x/y axis lines — as the
// handles origin()/xAxis()/yAxis() hand to constraint statements. Not
// SceneObjects: datums have no statement, no timeline row, and nothing
// to delete; they resolve to the fixed reference entities every solved
// sketch's solver system registers up front (SketchSystem.ensureDatums).

import { Sketch } from "../sketch.js";
import { DATUM_ENTITY_IDS } from "../../../sketch-solver/index.js";
import type { DatumName, SolverRef } from "../../../sketch-solver/index.js";

export class SketchDatum {
  constructor(
    /** The sketch that was active at the accessor call — null outside a
     * sketch; validated (solved mode, same sketch) at constraint
     * registration, where errors stash instead of throwing. */
    readonly sketch: Sketch | null,
    readonly datum: DatumName,
  ) {}

  get entityId(): number {
    return DATUM_ENTITY_IDS[this.datum];
  }

  ref(): SolverRef {
    return { entity: this.entityId };
  }

  /** True for the axis lines — infinite carriers in every constraint
   * that accepts a line, but with no meaningful length or midpoint. */
  get isAxis(): boolean {
    return this.datum !== 'origin';
  }

  /** The accessor spelling, for error messages. */
  get commandName(): string {
    return this.datum === 'origin' ? 'origin()' : this.datum === 'x-axis' ? 'xAxis()' : 'yAxis()';
  }
}
