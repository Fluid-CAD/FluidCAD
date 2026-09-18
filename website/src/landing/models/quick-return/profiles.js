import { arc, circle, line } from "fluidcad/core";
import { coincident, diameter, distance, fix, horizontal, radius, vertical } from "fluidcad/constraints";

// Every profile is fully constrained; coordinate literals alone are only solver guesses.
export function disk(x, y, d) {
  const c = circle([x, y], d);
  fix(c.center(), [x, y]);
  diameter(c, d);
  return c;
}
export function rectangle(x, y, w, h) {
  const b = line([x, y], [x + w, y]);
  const r = line([x + w, y], [x + w, y + h]);
  const t = line([x + w, y + h], [x, y + h]);
  const l = line([x, y + h], [x, y]);
  coincident(b.end(), r.start()); coincident(r.end(), t.start());
  coincident(t.end(), l.start()); coincident(l.end(), b.start());
  horizontal(b); vertical(r); horizontal(t); vertical(l);
  fix(b.start(), [x, y]);
  distance(b.start(), b.end(), w); distance(r.start(), r.end(), h);
}
export function capsule(start, end, y, r) {
  const bottom = line([start, y - r], [end, y - r]);
  const right = arc([end, y - r], [end, y + r], [end, y]);
  const top = line([end, y + r], [start, y + r]);
  const left = arc([start, y + r], [start, y - r], [start, y]);
  fix(bottom.start(), [start, y - r]); fix(bottom.end(), [end, y - r]);
  fix(top.start(), [end, y + r]); fix(top.end(), [start, y + r]);
  fix(right.center(), [end, y]); radius(right, r);
  vertical(right.start(), right.center()); vertical(right.end(), right.center());
  fix(left.center(), [start, y]); radius(left, r);
  vertical(left.start(), left.center()); vertical(left.end(), left.center());
}

export function capsuleY(x, start, end, r) {
  const right = line([x + r, start], [x + r, end]);
  const top = arc([x + r, end], [x - r, end], [x, end]);
  const left = line([x - r, end], [x - r, start]);
  const bottom = arc([x - r, start], [x + r, start], [x, start]);
  fix(right.start(), [x + r, start]); fix(right.end(), [x + r, end]);
  fix(left.start(), [x - r, end]); fix(left.end(), [x - r, start]);
  fix(top.center(), [x, end]); radius(top, r);
  horizontal(top.start(), top.center()); horizontal(top.end(), top.center());
  fix(bottom.center(), [x, start]); radius(bottom, r);
  horizontal(bottom.start(), bottom.center()); horizontal(bottom.end(), bottom.center());
}
