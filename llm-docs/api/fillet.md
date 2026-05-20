---
id: api/fillet
title: fillet(radius, ...edges?)
summary: Rounds 3D edges (or 2D corners). Defaults to the last selection if no edges are passed.
tags: [api, solid, edges, 3d]
symbols: [fillet]
seeAlso: [api/extrude, concepts/last-selection]
---

# fillet

```ts
fillet(radius?: number)                   // uses last selection, default radius 1
fillet(radius, ...sceneObjects)

// 2D variants:
fillet(objects: Geometry[])
fillet(objects: Geometry[], radius)
fillet(radius, ...objects: Geometry[])
```

Returns a `SceneObject`. Operates on the **last selection** when no edges
are passed — pair with `select()` or a direct accessor like `e.endEdges()`.

## Common patterns

```fluid.js
const e = extrude(30);
fillet(5, e.endEdges());                  // round top edges only

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
