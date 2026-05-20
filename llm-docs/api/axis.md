---
id: api/axis
title: axis(reference, options?)
summary: Builds a reference axis from a world axis name, an edge, or the midaxis between two axes. Used by revolve, repeat, and 3D rotations.
tags: [api, reference, geometry]
symbols: [axis]
seeAlso: [api/plane, api/local, api/revolve, api/rotate]
---

# axis

```ts
axis(axis: AxisLike)
axis(axis: AxisLike, options: AxisTransformOptions)
axis(source: SceneObject)                           // from an edge
axis(source: SceneObject, options)
axis(axis: Axis, options)
axis(a1: AxisLike, a2: AxisLike, options?)          // midaxis
axis(a1: Axis, a2: Axis, options?)
```

`AxisLike` is `"x"` / `"y"` / `"z"`, a direction vector, or an
`{ point?, direction }` record. `AxisTransformOptions` includes
`offsetX`, `offsetY`, `offsetZ`, `flip`, etc.

## Example

```fluid.js
sketch("xz", () => {
  move([20, 0]);
  rect(10, 30);
});
const raised = axis("z", { offsetX: 50 });           // Z axis shifted +50 along X
revolve(raised);
```

See [[api/plane]] for planar references and [[api/local]] for sketch-
local axes.
