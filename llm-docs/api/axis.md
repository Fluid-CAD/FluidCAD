---
id: api/axis
title: axis(reference, options?)
summary: Builds a reference axis from a world axis name, an edge, or the midaxis between two axes. Used by revolve, repeat, and 3D rotations.
tags: [api, reference, geometry]
symbols: [axis]
seeAlso: [api/plane, api/constraints, api/revolve, api/rotate]
---

# axis

Imported from `fluidcad/core`.

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
import { axis, line, revolve, sketch } from "fluidcad/core";
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
const raised = axis("z", { offsetX: 50 });           // Z axis shifted +50 along X
revolve(raised);
```

An axis is consumed for display only: the revolve (or repeat, rotation,
helix) hides its line from that feature on, and any later feature takes the
same axis again by variable — no `.reusable()`. `remove(raised)` drops it for
good.

See [[api/plane]] for planar references. Inside a sketch, the sketch's

own axes are the datums `xAxis()` / `yAxis()` ([[api/constraints]],
[[concepts/coordinate-system]]) — not `axis("x")`, which is world X.
