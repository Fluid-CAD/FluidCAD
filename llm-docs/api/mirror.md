---
id: api/mirror
title: mirror(plane | axis | line, ...targets?)
summary: Reflects sketch geometry across a line/axis or 3D solids across a plane. World-axis strings stay world-axis even inside a sketch — use the datum `xAxis()` / `yAxis()` for the sketch's own axes.
tags: [api, 2d, 3d, transform]
symbols: [mirror]
seeAlso: [api/translate, api/rotate, concepts/coordinate-system]
---

# mirror

Imported from `fluidcad/core`.

```ts
// 2D (inside a sketch)
mirror(line: SceneObject)
mirror(axis: AxisLike)
mirror(line, ...geometries)
mirror(axis, ...geometries)

// 3D
mirror(plane: PlaneLike, ...objects)
```

Inside a sketch, reflects geometry across a line or axis. Outside a
sketch, reflects solids across a plane. The 3D form returns `Mirror`
(extends `BooleanOperation`) and supports `.exclude(...objects)` to
skip specific objects.

**`"x"` is the world X axis, even inside a sketch.** To mirror across
the sketch plane's own X, use the sketch datum: `mirror(xAxis(), g)`.
See [[concepts/coordinate-system]] for the full convention.

## Example

```fluid.js
import { extrude, line, origin, mirror, sketch, xAxis, yAxis } from "fluidcad/core";
import { coincident, distance, horizontal, symmetric, vertical } from "fluidcad/constraints";

sketch("xy", () => {
  const b = line([-20, -15], [20, -15]);
  const r = line([20, -15], [20, 15]);
  const t = line([20, 15], [-20, 15]);
  const l = line([-20, 15], [-20, -15]);
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(t);
  vertical(l);
  symmetric(b.start(), b.end(), yAxis());   // bottom side centred on Y (and horizontal)
  symmetric(r.start(), r.end(), xAxis());   // right side centred on X (and vertical)
  distance(b.start(), b.end(), 40);
  distance(r.start(), r.end(), 30);
});
const block = extrude(20).new();
mirror("yz", block);                             // mirror across the YZ plane
```

See [[api/translate]] / [[api/rotate]] for non-reflective transforms.
