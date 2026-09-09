# Sketching: guesses versus constrained geometry

Read before the first constrained sketch, or when a sketch solved somewhere you did not draw it.

## Two ways to write a sketch, both valid

- **Exact coordinates.** A loop of lines whose endpoints already touch forms a closed profile with no constraints at all. Use this for a profile whose numbers come straight from a datum at the origin and will not be driven by relationships later.
- **Constrained.** Primitives are drawn at rough guess positions; constraints state the relationships; the solver moves the geometry until every relationship holds exactly. Use this when the sketch should be driven by intent (a circle concentric with a bore, a tangent line between two arcs, a slot centered on a face) or when a face plane's origin cannot be trusted (see below).

Under-constrained geometry simply stays at its guesses. That is the trap: a `circle([20, 0], 8)` with no constraint on its center sits at exactly `[20, 0]`, which is fine when that coordinate is the design, and wrong when the design was "centered on the boss" and the boss later moves.

## The datums

Every sketch carries `origin()`, `xAxis()` and `yAxis()` (imported from `fluidcad/core`, called inside the callback). Constrain against them instead of fixing arbitrary points: `coincident(c.center(), origin())`, `collinear(xAxis(), l)`, `symmetric(a, b, yAxis())`. They are also the sketch's own directions for `mirror()` and `copy("linear", …)` inside the sketch; a bare `"x"` there is the world X axis.

## Fully constraining a profile

The canonical rectangle: four lines joined with `coincident` at the corners, `horizontal` / `vertical` on the sides, one `fix` to pin the sketch to the plane, two `distance` constraints for width and height.

```fluid.js
import { sketch, line, extrude } from "fluidcad/core";
import { coincident, horizontal, vertical, fix, distance } from "fluidcad/constraints";

const plateW = 80;
const plateH = 50;

sketch("xy", () => {
  const b = line([0, 0], [plateW, 0]);
  const r = line([plateW, 0], [plateW, plateH]);
  const t = line([plateW, plateH], [0, plateH]);
  const l = line([0, plateH], [0, 0]);
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(b);
  vertical(r);
  horizontal(t);
  vertical(l);
  fix(b.start(), [0, 0]);
  distance(b.start(), b.end(), plateW);
  distance(r.start(), r.end(), plateH);
});
extrude(6);
```

The solver's verdict (fully constrained, remaining degrees of freedom, conflicts, redundant constraints) is rendered in the viewport per sketch: green means locked, red means conflicting. A `screenshot` of the sketch state (roll back to the sketch's index; `showDimensions` and `showPositional` are on by default) shows it.

## What the solver does with a circle

- **Center.** Unconstrained, it stays at the guess. Pin it with `coincident(c.center(), origin())`, `concentric(c, bore)`, `distance(l.start(), c.center(), 60, 'x')`, or `horizontal(big.center(), small.center())` plus a center distance.
- **Size.** `circle(center, diameter)` takes a diameter. Dimension with `diameter(c, v)` or `radius(c, v)`; the literal alone is a guess the solver may keep or change.
- **Distances to a circle** measure to the near side of the circumference by default; chain `.max()` for the far side, or dimension `c.center()` for a center distance.

## Guesses pick the branch

A circle tangent to a line can rest on either side; an angle can open either way. The solver converges to the solution nearest the guesses, so draw the guess roughly on the side you mean. Precision is the solver's job; side is yours. `angle(a, b, deg)` is counterclockwise from `a` to `b` and orients each line toward its end unless you pass an endpoint accessor; there are no negative angles.

## Sketching on a face

The face plane's origin is not guaranteed to be the face centroid, and its in-plane axes come from the face normal alone (Y is world +Z projected onto the face; on a horizontal face, +Y). Bring the face in as a fixed reference and constrain against it:

```fluid.js
import { sketch, line, circle, extrude, cut, project } from "fluidcad/core";
import { coincident, horizontal, vertical, fix, distance, concentric } from "fluidcad/constraints";

sketch("xy", () => {
  const b = line([0, 0], [60, 0]);
  const r = line([60, 0], [60, 40]);
  const t = line([60, 40], [0, 40]);
  const l = line([0, 40], [0, 0]);
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(b);
  vertical(r);
  horizontal(t);
  vertical(l);
  fix(b.start(), [0, 0]);
  distance(b.start(), b.end(), 60);
  distance(r.start(), r.end(), 40);
  circle([30, 20], 12);
});
const block = extrude(15);

// Counterbore on the top face, concentric with the through-hole.
sketch(block.endFaces(), () => {
  const bore = project(block.endFaces()).guide();
  const cb = circle([0, 0], 20);
  concentric(cb, bore.ref(1));
});
cut(4);
```

`project(...)` registers as a fixed reference the solver never moves; `.ref(i)`, `.start()`, `.end()` and `.center()` pick one edge of it. Check which index is the hole by rolling back to the sketch and taking a screenshot, or by `resolve_selection` on `edge().circle(12)` at the face.

## Keep sketches small

One sketch per feature idea. A sketch holding the outline, the holes and the slots collapses them into geometry nothing downstream can select individually; separate sketches give separate features, each with its own faces and edges for filters. A sketch is consumed once; `.reusable()` when two features need it, and `remove()` it when they are done.
