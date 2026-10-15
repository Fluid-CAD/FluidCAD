---
id: api/rotate
title: rotate(axis, angle, ...targets?)
summary: Rotates one or more solids around an axis. 3D-only — inside a sketch it throws; orient sketch geometry with angle()/horizontal()/vertical() constraints instead. Degrees, not radians.
tags: [api, 3d, transform]
symbols: [rotate]
seeAlso: [api/translate, api/mirror]
---

# rotate

Imported from `fluidcad/core`.

```ts
// around a world or custom axis, or a connector's Z axis
rotate(axis: AxisLike | Connector, angle, ...targets)
rotate(axis, angle, copy: boolean, ...targets)
```

Angles are degrees. The axis is a world axis name, `"x"` / `"y"` /
`"z"`, or an `axis()` datum for any other line ([[api/axis]]: from an
edge, or a world axis offset and tilted); a direction vector is refused.
`copy: true` clones the source rather than rotating it in place. A named
target stands for the body it built wherever later features left it — a
filleted or moved body turns as it is now (see [[concepts/scene-graph]]).

`rotate()` is 3D-only — inside a sketch it throws (the 2D rotate was
removed). Sketch geometry is oriented by constraints: `angle(xAxis(), l,
30)` sets a line's direction, `horizontal(l)` / `vertical(l)` pin it, and
the solver turns the connected profile with it. For rotated copies of
sketch geometry use `copy("circular", …)`.

## Example

```fluid.js
import { cylinder, rotate } from "fluidcad/core";

const c = cylinder(8, 40);
rotate("x", 90, c);                              // lay the cylinder on its side
```

See [[api/translate]] for moves and [[api/mirror]] for reflections.
