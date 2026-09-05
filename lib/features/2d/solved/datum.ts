// The implicit sketch datums — origin point + x/y axis lines — as the
// handles origin()/xAxis()/yAxis() hand to constraint statements and, for
// the axes, to the in-sketch transforms (mirror, linear copy). Not
// SceneObjects: datums have no statement, no timeline row, and nothing
// to delete; they resolve to the fixed reference entities every solved
// sketch's solver system registers up front (SketchSystem.ensureDatums).
// A transform that needs a geometric axis promotes the datum on demand
// (toAxisObject) into an AxisFromSketch it adds to the scene itself.

import { Sketch } from "../sketch.js";
import { AxisFromSketch } from "../../axis-from-sketch.js";
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

  /** The sketch-plane direction an axis datum stands for; null for the origin. */
  get direction(): 'x' | 'y' | null {
    return this.datum === 'x-axis' ? 'x' : this.datum === 'y-axis' ? 'y' : null;
  }

  /** The accessor spelling, for error messages. */
  get commandName(): string {
    return this.datum === 'origin' ? 'origin()' : this.datum === 'x-axis' ? 'xAxis()' : 'yAxis()';
  }

  /**
   * The datum as a geometric axis for an in-sketch transform (mirror,
   * linear copy): an AxisFromSketch resolving the sketch plane's x/y
   * direction. The caller adds it to the scene. Statement-time errors
   * (the origin, a call outside any sketch, another sketch's datum) throw
   * in `what`'s voice.
   */
  toAxisObject(what: string, activeSketch: Sketch | null): AxisFromSketch {
    const direction = this.direction;
    if (direction === null) {
      throw new Error(`${what}: ${this.commandName} is a point, not an axis — use xAxis() or yAxis()`);
    }
    if (this.sketch === null) {
      throw new Error(`${what}: ${this.commandName} was called outside a sketch — call it inside the sketch callback`);
    }
    if (activeSketch !== null && this.sketch !== activeSketch) {
      throw new Error(`${what}: ${this.commandName} belongs to another sketch`);
    }
    return new AxisFromSketch(this.sketch, direction);
  }
}
