---
id: api/sketch
title: sketch(plane | face, sketcher, true)
summary: Opens a 2D sketching context on a plane or a face. Geometry is drawn at guess positions and solved against constraints. The active sketch is the implicit input to extrude/cut/revolve/sweep/loft.
tags: [api, 2d, primitive]
symbols: [sketch, origin, xAxis, yAxis]
seeAlso: [api/extrude, api/constraints, concepts/last-selection, concepts/scene-graph]
---

# sketch

Imported from `fluidcad/core`.

```ts
sketch(plane: PlaneLike, sketcher: () => T, true): SceneObject
sketch(face: SceneObject, sketcher: () => T, true): SceneObject
```

Opens a sketch context. Write the trailing `true` — it marks the sketch
as a constraint (solved) sketch, which is the documented form (every
sketch is solved; the flag is kept for source compatibility). The
callback draws 2D geometry at **guess** positions and states
[[api/constraints]]; the solver moves the geometry until every
relationship holds. Whatever the callback returns is attached as
`.regions` on the resulting `SceneObject`, so named references can be
carried out:

```fluid.js
import { circle, extrude, sketch } from "fluidcad/core";

const s = sketch("xy", () => {
    const outer = circle([0, 0], 60);
    const inner = circle([0, 0], 20);
    return { outer, inner };
});
extrude(10);

// s.regions.outer  → reference to the outer circle
```

## Sketch datums

Every sketch carries three implicit fixed entities — `origin()`,
`xAxis()`, and `yAxis()` (imported from `fluidcad/core`). They never
move; constrain against them instead of fixing arbitrary points:
`coincident(c.center(), origin())`, `collinear(xAxis(), l)`,
`symmetric(a, b, yAxis())`.

## Implicit consumption

The sketch becomes the **last sketch**. The next 3D feature (`extrude`,
`cut`, `revolve`, `sweep`, `loft`, `rib`) consumes it automatically:

```fluid.js
import { circle, extrude, sketch } from "fluidcad/core";

sketch("xy", () => circle([0, 0], 50));
extrude(20);  // consumes the sketch above
```

A consumed sketch is gone. To reuse a sketch across multiple operations,
mark it `.reusable()`:

```fluid.js
import { circle, extrude, sketch } from "fluidcad/core";

const profile = sketch("xy", () => circle([0, 0], 40)).reusable();
extrude(30, profile);
extrude(-10, profile);  // still available
```

## Sketching on a face

Passing a face selection orients the sketch onto that face's plane. If the
selection resolves to multiple faces, only the **first** face is used as
the sketch plane. The face plane's origin is not guaranteed to be the
face centroid — anchor geometry to a projected reference instead of raw
coordinates:

```fluid.js
import { circle, cut, extrude, offset, project, sketch } from "fluidcad/core";

sketch("xy", () => circle([0, 0], 80));
const e = extrude(30);
sketch(e.endFaces(), () => {
  const outline = project(e.endFaces()).guide();  // fixed reference outline
  offset(-10, outline);                            // pocket profile, inset 10
});
cut(10);  // 10mm-deep pocket on the top face
```

See [[concepts/coordinate-system]] for how sketch axes are derived from
the chosen plane, [[api/constraints]] for the constraint catalog, and
[[concepts/last-selection]] for how implicit consumption chains
operations.
