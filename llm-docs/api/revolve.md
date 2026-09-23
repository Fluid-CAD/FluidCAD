---
id: api/revolve
title: revolve(axis, angle?)
summary: Sweeps the last sketch around an axis. Full 360 by default; supply an angle for partial revolutions. The sketch plane must contain the axis.
tags: [api, 3d, solid]
symbols: [revolve]
seeAlso: [api/sketch, api/sweep, api/extrude]
---

# revolve

Imported from `fluidcad/core`.

```ts
revolve(axis: AxisLike, target?: SceneObject)         // full 360
revolve(axis: AxisLike, angle: number, target?)       // partial revolution
```

Returns `Revolve` (extends `BooleanOperation`). Chain: `.symmetric()`,
`.thin()`, `.region()`, plus the standard boolean scope methods.
`.region()` keys come from the `regions` list the feature reports when
called with no keys — see [[api/extrude]].

The **sketch plane must contain the axis**: to revolve around `"z"`,
sketch on `"xz"` or `"yz"`.

## Example

```fluid.js
import { line, revolve, sketch } from "fluidcad/core";
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

sketch("xz", () => {
  const b = line([20, 0], [30, 0]);
  const r = line([30, 0], [30, 30]);
  const t = line([30, 30], [20, 30]);
  const l = line([20, 30], [20, 0]);
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(b);
  vertical(r);
  horizontal(t);
  vertical(l);
  fix(b.start(), [20, 0]);
  distance(b.start(), b.end(), 10);
  distance(r.start(), r.end(), 30);
});
revolve("z");                                          // ring
```

See [[api/sweep]] for path-driven solids and [[api/extrude]] for linear
extrusion.
