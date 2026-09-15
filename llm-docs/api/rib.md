---
id: api/rib
title: rib(thickness, spine?)
summary: Builds a rib from an open spine sketch. Extends in the sketch plane normal until it meets surrounding solids.
tags: [api, 3d, solid]
symbols: [rib]
seeAlso: [api/sketch, api/extrude]
---

# rib

Imported from `fluidcad/core`.

```ts
rib(thickness)                          // uses last sketch as spine
rib(thickness, spine: SceneObject)
```

Returns `Rib` (extends `BooleanOperation`). Sign of `thickness` chooses
direction: positive forward, negative backward. Chain methods:

- `.parallel()` — extrude parallel to the sketch plane instead of the
  normal direction.
- `.extend()` — extend the rib ends so they blend with surrounding walls.

Plus the standard face/edge accessors (`startFaces`, `endFaces`,
`sideFaces`, etc.).

## Example

```fluid.js
import { extrude, line, origin, rib, sketch, xAxis, yAxis } from "fluidcad/core";
import { coincident, distance, fix, horizontal, symmetric, vertical } from "fluidcad/constraints";

sketch("xy", () => {
  const b = line([-60, -40], [60, -40]);
  const r = line([60, -40], [60, 40]);
  const t = line([60, 40], [-60, 40]);
  const l = line([-60, 40], [-60, -40]);
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(t);
  vertical(l);
  symmetric(b.start(), b.end(), yAxis());   // bottom side centred on Y (and horizontal)
  symmetric(r.start(), r.end(), xAxis());   // right side centred on X (and vertical)
  distance(b.start(), b.end(), 120);
  distance(r.start(), r.end(), 80);
});
extrude(40);
sketch("xz", () => {
  const web = line([-40, 5], [40, 5]);
  horizontal(web);
  fix(web.start(), [-40, 5]);
  distance(web.start(), web.end(), 80);
});
rib(3).extend();
```

See [[api/extrude]] for the base solid the rib connects into.
