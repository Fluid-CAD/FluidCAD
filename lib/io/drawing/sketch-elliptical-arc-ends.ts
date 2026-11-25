import type { Vec2 } from "./drawing.js";
import type { SketchPrimitive } from "./sketch-import.js";
import { SketchEllipticalArcs } from "./sketch-elliptical-arc.js";
import { SketchEnds } from "./sketch-ends.js";
import type { SketchEnd } from "./sketch-ends.js";

/**
 * Where a plan's elliptical arcs end.
 *
 * Rounded on its own, every number of an `eArc` statement is the file's to
 * the plan's decimals: its centre, its semi-radii and its angle are round
 * where the file's are. Its ends are not on that ellipse, though — not to
 * the last digit — and the statement reads an end off its ellipse as the
 * point of the ellipse in its direction: drawn a rounding step from where
 * it is written, and from the end of the line written at the same point.
 * Without a join to hold the two together the outline is open there, and
 * an outline open by a millionth encloses nothing.
 *
 * So the ends move, not the ellipse: each is written, a few decimals finer,
 * at the point of the ellipse it names, and every end written at the same
 * point as it — of a line, an arc, a bezier, a point — is written there
 * too. They were one point of the file; they are one point still, on the
 * ellipse, and the arc is drawn where it is written.
 *
 * Two elliptical arcs that meet cannot both do that: the point is on two
 * ellipses, whose rounded numbers generally do not cross there — not at
 * all when the arcs run on smoothly. There both keep their written ends,
 * and each ellipse is made to pass through them instead
 * (`SketchEllipticalArcs.through`): two of its numbers are worked out from
 * the ends and written finer.
 */
export class EllipticalArcEnds {
  /**
   * Settles the ends of the elliptical arcs of `primitives`, in place.
   * `sources` are the primitives as they were before they were rounded,
   * one for each: an end is put at the point of the written ellipse the
   * file's own end names, not the rounded one, so it is no further from the
   * file's than the ellipse is. `fine` rounds what is written finer.
   */
  static settle(primitives: SketchPrimitive[], sources: readonly SketchPrimitive[], fine: (value: number) => number): void {
    const at = new Map<string, SketchEnd[]>();
    for (const end of SketchEnds.of(primitives)) {
      const key = EllipticalArcEnds.key(end.at);
      const group = at.get(key);
      if (group) {
        group.push(end);
      } else {
        at.set(key, [end]);
      }
    }
    const endsAt = (p: Vec2) => at.get(EllipticalArcEnds.key(p)) ?? [];

    primitives.forEach((arc, index) => {
      if (arc.kind !== 'eArc') {
        return;
      }
      const source = sources[index];
      if (source.kind !== 'eArc') {
        return;
      }
      const starts = endsAt(arc.start);
      const ends = endsAt(arc.end);
      const meetsArc = [...starts, ...ends].some((end) => end.primitive !== index && primitives[end.primitive].kind === 'eArc');
      const moved = {
        ...arc,
        start: SketchEllipticalArcs.onEllipse(arc, source.start, fine),
        end: SketchEllipticalArcs.onEllipse(arc, source.end, fine),
      };
      // (An arc whose ends are so near that moving them could carry one past the other is refitted too.)
      if (meetsArc || !SketchEllipticalArcs.sameWay(arc, moved)) {
        primitives[index] = SketchEllipticalArcs.through(arc, fine);
        return;
      }
      for (const end of starts) {
        primitives[end.primitive] = SketchEnds.moved(primitives[end.primitive], end.end, moved.start);
      }
      for (const end of ends) {
        primitives[end.primitive] = SketchEnds.moved(primitives[end.primitive], end.end, moved.end);
      }
    });
  }

  private static key(p: Vec2): string {
    return `${p.x},${p.y}`;
  }
}
