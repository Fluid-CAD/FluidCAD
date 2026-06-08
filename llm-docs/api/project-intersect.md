---
id: api/project-intersect
title: project / intersect
summary: Reduce 3D geometry to 2D sketch wires. `project` flattens edges along the sketch normal; `intersect` cuts the sketch plane through 3D objects.
tags: [api, 2d, modifier, projection]
symbols: [project, intersect]
seeAlso: [api/sketch, api/offset]
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

Pair either with `extrude` / `cut` / `offset` to re-use 3D geometry as
the input to a new 2D operation.

## Example

```fluid.js
import { circle, extrude, intersect, sketch } from "fluidcad/core";

sketch("xz", () => circle(40));
const cyl = extrude(80).symmetric();

sketch("xy", () => {
  intersect(cyl);             // cross-section where xy slices the cylinder
});
extrude(3);
```

See [[api/offset]] for offsetting the resulting wire and [[api/sketch]]
for the sketch context.
