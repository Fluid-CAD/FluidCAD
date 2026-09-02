---
id: api/constraints
title: Constraints — coincident, tangent, distance, …
summary: The 16 constraint statements of a solved sketch. Geometry is drawn at guess positions; constraints state the relationships and the solver moves the geometry until every relationship holds exactly.
tags: [api, 2d, constraint, solver]
symbols: [coincident, horizontal, vertical, parallel, perpendicular, tangent, equal, concentric, collinear, midpoint, symmetric, distance, angle, radius, diameter, fix]
seeAlso: [api/sketch, api/line, api/arc, api/circle, api/project-intersect, concepts/coordinate-system]
---

# Constraints

Imported from `fluidcad/constraints`:

```js
import { coincident, horizontal, vertical, parallel, perpendicular,
         tangent, equal, concentric, collinear, midpoint, symmetric,
         distance, angle, radius, diameter, fix } from "fluidcad/constraints";
```

Constraint statements are written inside a `sketch(plane, cb)` body —
every sketch is a constraint sketch. Primitives (`line`, `arc`, `circle`, `point`)
are drawn at rough **guess** positions; constraints state the
relationships; the solver moves the geometry until every relationship
holds exactly. Under-constrained geometry simply stays at its guesses.

## Targets

A constraint argument can be:

- a **statement** itself — `horizontal(l)`, `tangent(l, a)`, `equal(c1, c2)`;
- a **point accessor** — `l.start()`, `l.end()`, `l.mid()`, `a.center()`,
  `c.center()`;
- a **point statement** — `const p = point([x, y])`;
- a **sketch datum** — `origin()`, `xAxis()`, `yAxis()` (from
  `fluidcad/core`) — implicit fixed entities every sketch carries;
- a **fixed reference** — geometry brought in by `project()` /
  `intersect()`. References never move; your sketch geometry solves
  against them (`tangent(bore, l)`, `coincident(p, outline.ref(2))`).
  See [[api/project-intersect]].

## Geometric constraints

```ts
coincident(a, b)      // two points coincide; or point-on-line/arc/circle.
                      // coincident(p, l.mid()) lowers to midpoint(p, l).
horizontal(l)         // line horizontal — or horizontal(p1, p2, ...): equal y
vertical(l)           // line vertical — or vertical(p1, p2, ...): equal x
parallel(a, b, ...more)
                      // two or more lines, all paralleled to the first
perpendicular(a, b)   // two lines
tangent(a, b)         // line/arc/circle tangent to another
equal(a, b, ...more)  // equal length (lines) or equal radius (arcs/circles);
                      // takes two or more entities, all equated to the first
concentric(a, b)      // arcs/circles share a center
collinear(a, b)       // line along another line — or along xAxis()/yAxis()
midpoint(p, l)        // point at the line's midpoint
midpoint(p, a, b)     // point halfway between two points a and b
symmetric(a, b, l)    // points a and b mirror across line (or axis) l
fix(p)                // pin a point at its current guess coordinates
fix(p, [x, y])        // pin a point at explicit coordinates
```

## Dimensional constraints

```ts
distance(a, b, value)         // point–point, point–line, point–circle,
                              // line–line, line–circle, circle–circle
distance(p1, p2, value, 'x')  // point–point measured along one axis ('x' | 'y')
angle(a, b, degrees)          // CCW angle from line a to line b, 0–360
radius(c, value)              // arc or circle radius
diameter(c, value)            // arc or circle diameter
```

Distances involving a circle or arc measure to the **near side of the
circumference** by default; chain `.max()` to dimension the far side
(`.min()` restates the default). For a center distance, dimension the
center accessor instead: `distance(l, a.center(), v)`.

`angle(a, b, deg)` orients each line toward its **end** unless you pass an
endpoint accessor — `angle(l1, l2.start(), 45)` points l2 at its start.
There are no negative angles: a clockwise angle is the counterclockwise
angle of the swapped pair.

## Guesses pick the branch

Many constraint systems have several valid answers — a circle tangent to
a line can rest on either side. **The guess coordinates choose the
branch**: the solver converges to the solution nearest your guesses.
Place guesses roughly on the side you mean; precision is the solver's job.

## Example — the canonical rectangle

Four sloppy lines, snapped into an exact 100 × 50 rectangle:

```fluid.js
import { sketch, line, extrude } from "fluidcad/core";
import { coincident, horizontal, vertical, fix, distance } from "fluidcad/constraints";

sketch("xy", () => {
  const b = line([1, -2], [99, 3]);
  const r = line([99, 3], [101, 52]);
  const t = line([101, 52], [-2, 48]);
  const l = line([-2, 48], [1, -2]);
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(b);
  vertical(r);
  horizontal(t);
  vertical(l);
  fix(b.start(), [0, 0]);
  distance(b.start(), b.end(), 100);
  distance(r.start(), r.end(), 50);
});
extrude(10);
```

## Example — datums and tangency

```fluid.js
import { sketch, line, circle, origin, extrude } from "fluidcad/core";
import { coincident, tangent, horizontal, fix, diameter, distance } from "fluidcad/constraints";

sketch("xy", () => {
  const l = line([0, 0], [120, 0]).guide();   // construction line — not part of the profile
  const c = circle([60, 22], 40);
  coincident(l.start(), origin());
  horizontal(l);
  distance(l.start(), l.end(), 120);
  tangent(l, c);              // guess above the line → circle rests on top
  diameter(c, 40);
  distance(l.start(), c.center(), 60, 'x');
});
extrude(6);
```

The solver's verdict (fully constrained / DOF count / conflicts /
redundant constraints) is reported per sketch and rendered in the
viewport: green = locked, red = conflicting.

See [[api/sketch]] for the constraint-mode flag and [[api/line]] /
[[api/arc]] / [[api/circle]] for the primitives constraints act on.
