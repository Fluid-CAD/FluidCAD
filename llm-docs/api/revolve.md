---
id: api/revolve
title: revolve(axis, angle?)
summary: Sweeps the last sketch around an axis. Full 360 by default; supply an angle for partial revolutions. The sketch plane must contain the axis.
tags: [api, 3d, solid]
symbols: [revolve]
seeAlso: [api/sketch, api/sweep, api/extrude]
---

# revolve

```ts
revolve(axis: AxisLike, target?: SceneObject)         // full 360
revolve(axis: AxisLike, angle: number, target?)       // partial revolution
```

Returns `Revolve` (extends `BooleanOperation`). Chain: `.symmetric()`,
`.thin()`, `.pick()`, plus the standard boolean scope methods.

The **sketch plane must contain the axis**: to revolve around `"z"`,
sketch on `"xz"` or `"yz"`.

## Example

```fluid.js
sketch("xz", () => {
  move([20, 0]);
  rect(10, 30);
});
revolve("z");                                          // ring
```

See [[api/sweep]] for path-driven solids and [[api/extrude]] for linear
extrusion.
