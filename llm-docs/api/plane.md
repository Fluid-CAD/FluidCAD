---
id: api/plane
title: plane(reference, options?)
summary: Builds a reference plane from a standard name, an existing plane, a face, or the midpoint between two planes. Optional offset/rotation parametrize it.
tags: [api, reference, geometry]
symbols: [plane]
seeAlso: [api/axis, api/sketch, concepts/coordinate-system]
---

# plane

Imported from `fluidcad/core`.

```ts
plane(plane: PlaneLike, options: PlaneTransformOptions)
plane(plane: PlaneLike, offset: number)
plane(selection: SceneObject)                       // from a face
plane(selection: SceneObject, options)
plane(selection: SceneObject, offset)
plane(plane: Plane, options)                        // transform an existing plane
plane(p1: PlaneLike, p2: PlaneLike, options?)       // midplane between two planes
plane(p1: Plane, p2: Plane, options?)
```

`PlaneTransformOptions`:

- `offset: number` — translate along the normal.
- `rotateX`, `rotateY`, `rotateZ` — degrees.

## Example

```fluid.js
import { circle, extrude, line, origin, plane, sketch, xAxis, yAxis } from "fluidcad/core";
import { coincident, diameter, distance, horizontal, symmetric, vertical } from "fluidcad/constraints";

sketch("xy", () => {
  const b = line([-50, -30], [50, -30]);
  const r = line([50, -30], [50, 30]);
  const t = line([50, 30], [-50, 30]);
  const l = line([-50, 30], [-50, -30]);
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(t);
  vertical(l);
  symmetric(b.start(), b.end(), yAxis());   // bottom side centred on Y (and horizontal)
  symmetric(r.start(), r.end(), xAxis());   // right side centred on X (and vertical)
  distance(b.start(), b.end(), 100);
  distance(r.start(), r.end(), 60);
});
extrude(20);

const top = plane("xy", 80);                        // XY shifted up 80
sketch(top, () => {
  const c = circle([0, 0], 20);
  coincident(c.center(), origin());
  diameter(c, 20);
});
extrude(10);
```

A plane is consumed for display only: the sketch drawn on it (or the mirror
across it, the mid plane built from it) hides its quad from that feature on,
and any later feature takes the same plane again by variable — two
`sketch(top, …)` calls need no `.reusable()`. `remove(top)` drops it for good.

See [[api/axis]] for the axis counterpart and

[[concepts/coordinate-system]] for the sketch's own axes (`xAxis()` /
`yAxis()`).
