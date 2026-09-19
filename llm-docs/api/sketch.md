---
id: api/sketch
title: sketch(plane | face, sketcher)
summary: Opens a 2D sketching context on a plane or a face. Geometry is drawn at guess positions and solved against constraints. The active sketch is the implicit input to extrude/cut/revolve/sweep/loft.
tags: [api, 2d, primitive]
symbols: [sketch, origin, xAxis, yAxis]
seeAlso: [api/extrude, api/constraints, concepts/last-selection, concepts/scene-graph]
---

# sketch

Imported from `fluidcad/core`.

```ts
sketch(plane: PlaneLike, sketcher: () => T): SceneObject
sketch(face: SceneObject, sketcher: () => T): SceneObject
```

Opens a sketch context; it takes exactly two arguments, the plane (or
face) and the sketcher callback. Every sketch is a solved sketch: the
callback draws 2D geometry at **guess** positions and states
[[api/constraints]]; the solver moves the geometry until every
relationship holds. **Always fully constrain the sketch.** A coordinate
literal is only a guess for the solver, never the design: pin every
entity to the datums (`origin()`, `xAxis()`, `yAxis()`), to a projected
reference, or to other entities, and dimension every size, until the
solver reports the sketch fully constrained. Whatever the callback
returns is attached as `.geometries` on the resulting `SceneObject`, so
named references can be carried out:

```fluid.js
import { circle, extrude, origin, sketch } from "fluidcad/core";
import { coincident, concentric, diameter } from "fluidcad/constraints";

const s = sketch("xy", () => {
    const outer = circle([0, 0], 60);
    const inner = circle([0, 0], 20);
    coincident(outer.center(), origin());
    concentric(inner, outer);
    diameter(outer, 60);
    diameter(inner, 20);
    return { outer, inner };
});
extrude(10);

// s.geometries.outer  → reference to the outer circle
```

Use `.geometries` for any named geometry, including lines and arcs. The older
`.regions` spelling remains a deprecated alias for the same object.
Point accessors such as `s.geometries.line.start()` stay local inside sketch
constraints. Outside the sketch, loft connections and connectors resolve them
through the sketch plane to world coordinates, including on offset or tilted planes.

## Sketch datums

Every sketch carries three implicit fixed entities — `origin()`,
`xAxis()`, and `yAxis()` (imported from `fluidcad/core`). They never
move; constrain against them instead of fixing arbitrary points:
`coincident(c.center(), origin())`, `collinear(xAxis(), l)`,
`symmetric(a, b, yAxis())`. The two axis datums are also the sketch's
own directions for `mirror()` and `copy("linear", …)` inside the sketch
— a bare `"x"` there is the WORLD axis (see [[concepts/coordinate-system]]).

## Implicit consumption

The sketch becomes the **last sketch**. The next 3D feature (`extrude`,
`cut`, `revolve`, `sweep`, `loft`, `rib`) consumes it automatically:

```fluid.js
import { circle, extrude, origin, sketch } from "fluidcad/core";
import { coincident, diameter } from "fluidcad/constraints";

sketch("xy", () => {
  const c = circle([0, 0], 50);
  coincident(c.center(), origin());
  diameter(c, 50);
});
extrude(20);  // consumes the sketch above
```

A consumed sketch is gone. To reuse a sketch across multiple operations,
mark it `.reusable()`:

```fluid.js
import { circle, extrude, origin, sketch } from "fluidcad/core";
import { coincident, diameter } from "fluidcad/constraints";

const profile = sketch("xy", () => {
  const c = circle([0, 0], 40);
  coincident(c.center(), origin());
  diameter(c, 40);
}).reusable();
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
import { circle, cut, extrude, offset, origin, project, sketch } from "fluidcad/core";
import { coincident, diameter } from "fluidcad/constraints";

sketch("xy", () => {
  const c = circle([0, 0], 80);
  coincident(c.center(), origin());
  diameter(c, 80);
});
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
