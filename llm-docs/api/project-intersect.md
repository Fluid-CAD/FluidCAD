---
id: api/project-intersect
title: project / intersect
summary: Reduce 3D geometry to 2D sketch wires. `project` flattens edges along the sketch normal; `intersect` cuts the sketch plane through 3D objects.
tags: [api, 2d, modifier, projection]
symbols: [project, intersect]
seeAlso: [api/sketch, api/offset, api/constraints]
---

# project / intersect

Imported from `fluidcad/core`.

```ts
project(...sourceObjects: SceneObject[])
project(targetPlane, sourceObjects)

intersect(...sourceObjects: SceneObject[])
intersect(targetPlane, sourceObjects)
```

Both operate inside a sketch context and return `ExtrudableGeometry`.

- `project(obj)` projects the edges of 3D faces or edges down to the
  active sketch plane along the normal — the resulting 2D wire matches
  the silhouette of `obj`.
- `intersect(obj)` cuts the sketch plane through `obj` and returns the
  cross-section edges where they meet.

In a constraint sketch the result registers as a **fixed reference
entity**: the solver never moves it, and your sketch geometry can be
constrained against it — `tangent(bore, l)` when the reference is a
single edge, or `.ref(i)` / `.start()` / `.end()` / `.center()` to pick
one edge of a multi-edge reference. Chain `.guide()` to keep the
reference out of extruded profiles.

Pair either with `extrude` / `cut` / `offset` to re-use 3D geometry as
the input to a new 2D operation.

## Sources from another part

A projection may read geometry another `part()` publishes with
`expose()`: reference it as `<donor>.features.<name>`. The donor must be
declared before the consumer, and the exposure lives in the donor's body.

```js
const lid = part("Lid", () => {
  // ...
  const body = extrude(6);
  expose("rim", body.endFaces(0));
});

const gasket = part("Gasket", () => {
  sketch("xy", () => {
    project(lid.features.rim).guide();   // the lid's outline, fixed
    // ...
  });
});
```

In the viewport the Project tool does this for you: picking a face or an
edge of another part shows a notice naming that part; confirming it writes
the `expose()` into the donor (unless one already publishes the pick) and
projects the reference in your sketch.

## Example

```fluid.js
import { circle, extrude, intersect, origin, sketch } from "fluidcad/core";
import { coincident, diameter } from "fluidcad/constraints";

sketch("xz", () => {
  const c = circle([0, 0], 40);
  coincident(c.center(), origin());
  diameter(c, 40);
});
const cyl = extrude(80).symmetric();

sketch("xy", () => {
  intersect(cyl);             // cross-section where xy slices the cylinder
});
extrude(3);
```

See [[api/offset]] for offsetting the resulting wire and [[api/sketch]]
for the sketch context.
