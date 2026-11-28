---
id: api/bridge
title: bridge(from, to)
summary: A smooth curve between two curve ends — closing the gap between two guide curves so a loft or a sweep has a continuous rail, a transition that leaves one edge and arrives at another, the fourth side of a boundary. Matches position, tangent (default) or curvature at each end; continuity and the two magnitudes are chained methods.
tags: [api, 3d, curve, wire]
symbols: [bridge]
seeAlso: [api/projected-curve, api/intersection-curve, api/helix, api/sweep, api/loft, api/select, api/types/bridge]
---

# bridge

Imported from `fluidcad/core`. Written outside a sketch (inside one, draw
the curve with `bezier()`).

```ts
bridge(from: CurveEnd | Point, to: CurveEnd | Point): IBridge
  .continuity('g0' | 'g1' | 'g2')   // default 'g1'
  .startMagnitude(n)                 // default 1, > 0
  .endMagnitude(n)                   // default 1, > 0
```

## The ends

| Argument | Accepts |
|---|---|
| `from`, `to` | A **curve end**: `.start()` or `.end()` of an edge selection (`body.sideEdges(2).end()`, `select(edge()…).start()`), of a curve object (`c.end()`), of one edge of a curve (`c.edges(0).start()`), or of a sketch entity seen from outside its sketch (`sk.geometries.l.end()` on a line or an arc, `bz.point(0)` on a bezier). Or a **point**: a sketch point (`sk.geometries.p`, or its `.start()`), a centre (`sk.geometries.c.center()`), any other vertex — that end then matches position only. |

- `c.start()` / `c.end()` of a curve object are where the curve's walk
  starts and ends (the first curve's, when the result is several separate
  curves), whichever way its edges' own curves run.
- `.start()` / `.end()` of an edge are the edge's own two ends (a straight
  edge's start is its end towards −X, then −Y, then −Z). Which one is
  called start does not change how the bridge leaves it: at the end of an
  edge the bridge always continues the edge, out of it.
- A **corner of a solid** has no point-only form: written as the end of an
  edge through it (`e.endEdges(0).start()`), it is that edge's end, and the
  bridge continues that edge. To leave a corner in a direction of your
  choosing, take the end of the edge that runs the way you want.
- `.center()`, `.offset(…)` and an anchor on a face are refused.

**The bridge continues each curve.** It leaves `from` in the direction that
curve was heading and arrives at `to` heading into that curve. There is
nothing to flip: the order of `from` and `to` only sets the direction of the
result (`bridge(b.start(), a.end())` is `bridge(a.end(), b.start())` run the
other way).

## Options (chained methods, in any order)

| Method | Meaning |
|---|---|
| `.continuity('g0')` | Position only: a straight line between the two points. |
| `.continuity('g1')` | The default: tangent — the bridge leaves and arrives along the curves. |
| `.continuity('g2')` | Curvature too — the bridge bends as the curve bends where they meet (a straight end has zero curvature, and that is matched). |
| `.startMagnitude(n)` | How far the bridge keeps going straight before it turns, at `from`. 1 by default; larger is fuller, smaller is tighter. A number or a parameter, greater than zero. |
| `.endMagnitude(n)` | The same at `to`. |

The continuity applies at both ends; an end that is a plain point only
ever matches position.

**Magnitude.** At each end the bridge leaves along the curve's direction
at a speed — the length of its derivative there — of `magnitude ×` the
distance between the two ends. 1 gives a balanced curve; with 0.5 it turns
sooner, staying close to the straight line between the points; with 2 it
keeps on along the curve's direction longer and swings round in a fuller
arc. Because the speed is measured against the gap, the shape stays the
same when the whole layout is scaled. A tiny curvature radius against a
long gap, or a large magnitude, can make the bridge loop; lower the
magnitude at that end. The magnitudes do nothing with `'g0'`, but must
still be greater than zero.

**Shape.** One Bezier curve. Position at both ends is a line, tangent at
both a cubic, curvature at both a quintic; mixed ends (a curve end and a
point, `'g2'` at one end and a point at the other) something in between.

## Result

A curve object, like a `helix`: construction geometry, drawn as a line. It
holds **one wire with one edge**, running from `from` to `to`.

- `br.edges()`, `br.edges(0)` — its edge.
- `br.start()`, `br.end()` — its two ends (themselves curve ends for
  another bridge).

The ends are **read, not used up**: the curves and solids they lie on stay
on screen and in the model, ready for a loft or a sweep. A `select(…)` an
end is taken on only locates it: its highlight leaves the display, and what
it selects stays readable.

## Errors

| Situation | Message |
|---|---|
| The two ends are the same point | `bridge: the two ends are at the same point.` Hint: `A bridge joins two ends apart from each other: pick the end of another curve, or a point elsewhere.` |
| A magnitude is zero or negative (when the curve builds) | `bridge: a magnitude must be greater than zero.` Hint: `1 is the default: larger keeps the bridge going straight longer before it turns, smaller turns it sooner.` |
| An end is `.center()`, `.offset(…)`, an anchor on a face, or no point at all | `bridge: an end is the start or the end of an edge, or a point.` Hint: `Take .start() or .end() of an edge or a curve (c.end(), e.sideEdges(2).start()), or give a vertex or a sketch point.` |
| `.continuity(…)` outside its set (thrown where the statement is written) | `bridge: .continuity() takes 'g0', 'g1' or 'g2'.` |
| A magnitude that is not a number (thrown where the statement is written) | `bridge: .startMagnitude() takes a number.` (or `.endMagnitude()`) |
| An argument that is no end (a whole curve, a solid, a number) | `bridge: the from argument must be a curve end, the start() or end() of an edge or a curve, or a point; got a projected-curve.` (or `to`) |
| Fewer or more than two arguments | `bridge: give the two ends to join: bridge(from, to), each the start() or end() of an edge or a curve, or a point.` / `bridge: takes two arguments, the two ends, got 3.` |
| Inside a sketch | `bridge: is written outside a sketch; inside one, draw the curve with bezier().` |
| `'g2'` at an end with zero curvature | Not an error: the zero curvature is matched. |

## Example: join two rails on a ball smoothly

```fluid.js
import { sketch, line, sphere, plane, project, bridge } from "fluidcad/core";
import { fix } from "fluidcad/constraints";

const ball = sphere(30);

// Two short rails drawn above the ball, with a gap between them.
const left = sketch(plane("xy", 50), () => {
  const l = line([-20, -8], [-6, -8]);
  fix(l.start(), [-20, -8]);
  fix(l.end(), [-6, -8]);
});
const right = sketch(plane("xy", 50), () => {
  const l = line([6, 8], [20, 8]);
  fix(l.start(), [6, 8]);
  fix(l.end(), [20, 8]);
});

// Dropped onto the ball: two curves on its top.
const a = project(left, ball);
const b = project(right, ball);

// Leaves a the way a runs, arrives running along b, the curvature matched
// at both joints. Both rails stay.
const br = bridge(a.end(), b.start()).continuity("g2");
```

## Example: from an edge of a body to a point

```fluid.js
import { sketch, line, point, extrude, plane, bridge, origin } from "fluidcad/core";
import { coincident, distance, horizontal, vertical, fix } from "fluidcad/constraints";

sketch("xy", () => {
  const b = line([0, 0], [40, 0]);
  const r = line([40, 0], [40, 20]);
  const t = line([40, 20], [0, 20]);
  const l = line([0, 20], [0, 0]);
  coincident(b.start(), origin());
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(b);
  vertical(r);
  horizontal(t);
  vertical(l);
  distance(b.start(), b.end(), 40);
  distance(r.start(), r.end(), 20);
});
const body = extrude(10);

const marks = sketch(plane("xy", 30), () => {
  const p = point([70, 10]);
  fix(p, [70, 10]);
  return { p };
});

// Leaves the top of an upright edge going on upwards, and lands on the
// point, matching only its position there.
const tail = bridge(body.sideEdges(1).end(), marks.geometries.p);
```

## Example: tighter and fuller

```fluid.js
import { sketch, line, bridge } from "fluidcad/core";
import { fix } from "fluidcad/constraints";

const rails = sketch("xy", () => {
  const l = line([0, 0], [20, 0]);
  const m = line([40, 20], [60, 20]);
  fix(l.start(), [0, 0]);
  fix(l.end(), [20, 0]);
  fix(m.start(), [40, 20]);
  fix(m.end(), [60, 20]);
  return { l, m };
});
const { l, m } = rails.geometries;

// The same two ends: 0.5 turns soon, close to the straight line between
// the points; 2 runs on along each line and swings round in a fuller S.
const tight = bridge(l.end(), m.start()).startMagnitude(0.5).endMagnitude(0.5);
const full = bridge(l.end(), m.start()).startMagnitude(2).endMagnitude(2);
```
