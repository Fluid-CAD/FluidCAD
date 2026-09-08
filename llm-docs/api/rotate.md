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
// around a world or custom axis
rotate(axis: AxisLike, angle, ...targets)
rotate(axis, angle, copy: boolean, ...targets)
```

Angles are degrees. `AxisLike` is `"x"` / `"y"` / `"z"`, a direction
vector, or an `{ point?, direction }` record. `copy: true` clones the
source rather than rotating it in place.

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
