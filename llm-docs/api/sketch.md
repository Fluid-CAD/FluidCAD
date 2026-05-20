---
id: api/sketch
title: sketch(plane | face, sketcher)
summary: Opens a 2D sketching context on a plane or a face. The active sketch is the implicit input to extrude/cut/revolve/sweep/loft.
tags: [api, 2d, primitive]
symbols: [sketch]
seeAlso: [api/extrude, concepts/last-selection, concepts/scene-graph]
---

# sketch

```ts
sketch(plane: PlaneLike, sketcher: () => T): SceneObject
sketch(face: SceneObject, sketcher: () => T): SceneObject
sketch(plane: Plane, sketcher: () => T): SceneObject
```

Opens a sketch context. The callback draws 2D geometry; whatever the callback
returns is attached as `.regions` on the resulting `SceneObject`, so named
references can be carried out:

```fluid.js
const s = sketch("xy", () => {
    const outer = circle(60).reusable();
    const inner = circle(20);
    return { outer, inner };
});

// s.regions.outer  → reference to the outer circle
```

## Implicit consumption

The sketch becomes the **last sketch**. The next 3D feature (`extrude`,
`cut`, `revolve`, `sweep`, `loft`, `rib`) consumes it automatically:

```fluid.js
sketch("xy", () => rect(100, 50).centered());
extrude(20);  // consumes the sketch above
```

A consumed sketch is gone. To reuse a sketch across multiple operations,
mark it `.reusable()`:

```fluid.js
const profile = sketch("xy", () => circle(40)).reusable();
extrude(30, profile);
extrude(-10, profile);  // still available
```

## Sketching on a face

Passing a face selection orients the sketch onto that face's plane:

```fluid.js
const e = extrude(30);
sketch(e.endFaces(), () => circle(15));
cut(10);  // 10mm-deep pocket on the top face
```

See [[concepts/coordinate-system]] for how sketch axes are derived from the
chosen plane, and [[concepts/last-selection]] for how implicit consumption
chains operations.
