---
id: api/split
title: split(plane | edge, options?, ...targets?)
summary: Splits solids with a plane — an origin plane, a plane() statement, a planar face — or along a sketched edge, which is swept out of its sketch into the cutter (a line gives a plane, an arc, circle, ellipse or spline a curved sheet). Every body the cut crosses becomes the pieces on either side; keep one side or both.
tags: [api, 3d, modify]
symbols: [split]
seeAlso: [api/types/split, api/plane, api/mirror, api/remove, api/select]
---

# split

Imported from `fluidcad/core`.

```ts
split(plane: PlaneLike | SceneObject, ...targets?: SceneObject[])
split(plane: PlaneLike | SceneObject, options: { keep?: 'both' | 'front' | 'back' }, ...targets?: SceneObject[])
split(edge: Geometry, ...targets?: SceneObject[])
split(edge: Geometry, options: { keep? }, ...targets?: SceneObject[])
```

Cuts solids along an infinite plane, or along the sheet a sketched edge
sweeps out of its sketch. Each solid the cut crosses is replaced by the
pieces on either side, every piece a body of its own capped where the cut
went. The split statement then holds the pieces: a
later feature naming the split (`translate(v, s)`, `fillet(2, …)` on its
edges, `remove(s)`) reads all of them, and a `.scope()` follows them too.

- **`plane`**: an origin plane (`'xy'`, `'xz'`, `'yz'`), a `plane()`
  statement, or a planar face selection — read exactly as `mirror(plane, …)`
  reads one. The plane is consumed for display only: its quad leaves the
  screen from the split on, and a later feature may take it again.
- **`edge`**: an edge of a sketch — a `line()`, `arc()`, `circle()`,
  `ellipse()` or spline, usually a construction edge (`.guide()`). The cut
  is what the edge would sweep if it were extruded out of the sketch both
  ways: a straight line gives the infinite plane that contains it and
  stands normal to the sketch; any curve gives a curved sheet, bounded by
  the curve's ends, so a curve must run all the way across a body to split
  it (a curve that stops inside splits nothing). The sketch is consumed for
  display, as an extrude's profile is — its wires leave the screen from the
  split on and the timeline eye brings them back — while the edge stays
  readable by any later feature. `front` is to the right of the edge when
  you travel it from the sketch's front (edge tangent × sketch normal): for
  a circle or a closed loop drawn counter-clockwise, the outside. Reach the
  edge from outside the sketch with a hoisted `let`, or return it from the
  sketch callback (`s.geometries.seed`).
- **`targets`**: the solids to split. Without targets every solid in scope
  is a candidate; inside `part()`, this means that part’s preceding solids.
  A solid the cut misses, or only touches along a face or an edge, stays
  unchanged.
- **`keep`**: `'both'` (the default) keeps every piece; `'front'` keeps the
  pieces on the side the plane normal points to, `'back'` the other side.
  Only pieces of solids the plane actually crosses are removed; missed or
  tangent solids remain unchanged. For origin planes, front is +Z for XY,
  −Y for XZ, and +X for YZ.

There is no offset option: to cut away from a plane, offset the plane
itself — `split(plane('xy', 12))`, `split(plane(select(face()…), -8))`.

A split whose cut crosses none of the solids builds nothing and reports
`nothing was split` on its row; a split with no solid in scope is an error.

```js
split('xz');                                      // every body, at the XZ plane
split(p, boss);                                   // one body, at a plane() statement
split(plane(select(face().onPlane('yz', 20)), -8)); // 8 inside the +x face
split('yz', { keep: 'front' }, body);             // keep the +x half only
split(seed, { keep: 'back' }, body);              // along a sketched line, keep the left side
split(ring, { keep: 'front' });                   // outside a counter-clockwise circle — core it out
```

## Example

```fluid.js
import { extrude, line, split, sketch, translate, xAxis, yAxis } from "fluidcad/core";
import { coincident, distance, horizontal, symmetric, vertical, fix } from "fluidcad/constraints";

sketch("xy", () => {
  const b = line([-40, -30], [40, -30]);
  const r = line([40, -30], [40, 30]);
  const t = line([40, 30], [-40, 30]);
  const l = line([-40, 30], [-40, -30]);
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(t);
  vertical(l);
  symmetric(b.start(), b.end(), yAxis());
  symmetric(r.start(), r.end(), xAxis());
  distance(b.start(), b.end(), 80);
  distance(r.start(), r.end(), 60);
});
const block = extrude(20);

// Divide the block at the YZ plane. Both pieces stay in place.
const halves = split("yz", block);

// A diagonal construction line on the XY plane defines a second, slanted cut
// through both halves.
let seed;
sketch("xy", () => {
  seed = line([-20, -40], [20, 40]).guide();
  fix(seed.start(), [-20, -40]);
  fix(seed.end(), [20, 40]);
});
const quarters = split(seed, { keep: "back" }, halves);

// Move all retained pieces together 30 units along +Z.
translate([0, 0, 30], quarters);
```

`split()` returns a [[api/types/split]].
