---
id: api/fillet
title: fillet(radius, ...edges?)
summary: Rounds 3D edges (or 2D corners). Defaults to the last selection if no edges are passed.
tags: [api, solid, edges, 3d]
symbols: [fillet]
seeAlso: [api/extrude, concepts/last-selection]
---

# fillet

Imported from `fluidcad/core`.

```ts
fillet(radius?: number)                   // uses last selection, default radius 1
fillet(radius, ...sceneObjects)

// 2D variants (targets may be geometries, edge accessors, or edge filters):
fillet(objects: (Geometry | EdgeFilter)[])
fillet(objects: (Geometry | EdgeFilter)[], radius)
fillet(radius, ...objects: (Geometry | EdgeFilter)[])
```

Returns a `SceneObject`. Operates on the **last selection** when no edges
are passed — pair with `select()` or a direct accessor like `e.endEdges()`.
This applies inside sketches too: a preceding sketch-scoped `select(...)`
is consumed by a bare `fillet(radius)`.

## 2D corner filleting

In a sketch, targets select the *edge group* whose shared corners get
rounded: pass the statements themselves or edge filters
(`edge().line()`). A selection with no shared corner is a no-op.

```fluid.js
import { extrude, fillet, line, sketch } from "fluidcad/core";

sketch("xy", () => {
  const b = line([-40, -30], [40, -30]);
  const r = line([40, -30], [40, 30]);
  const t = line([40, 30], [-40, 30]);
  const l = line([-40, 30], [-40, -30]);
  fillet(4, t, l);            // round just the top-left corner
});
extrude(10);
```

## Common patterns

```fluid.js
import { extrude, fillet, line, sketch } from "fluidcad/core";

sketch("xy", () => {
  line([-20, -20], [20, -20]);
  line([20, -20], [20, 20]);
  line([20, 20], [-20, 20]);
  line([-20, 20], [-20, -20]);
});
const e = extrude(30);
fillet(5, e.endEdges());                  // round top edges only
```

```js
fillet(3, e.endEdges(), e.startEdges());  // round top and bottom

select(edge().verticalTo("xy"));
fillet(2);                                // last-selection form
```

## When to reach for chamfer instead

For a manufacturing edge break, `chamfer` is usually faster computationally
and easier to spec from a drawing. Reach for `fillet` when the part is
visually styled or the round is structurally meaningful (stress relief).

See [[api/extrude]] for the geometry produced upstream, and
[[concepts/last-selection]] for the selection-driven calling convention.
