---
id: api/booleans
title: fuse / subtract / common
summary: Explicit 3D boolean operations. Most of the time auto-fusion does the right thing — reach for these when you need exact control.
tags: [api, 3d, boolean]
symbols: [fuse, subtract, common]
seeAlso: [api/extrude, api/cut, concepts/scene-graph]
---

# fuse / subtract / common

Imported from `fluidcad/core`.

```ts
fuse()
fuse(...objects)                       // union of objects
subtract(object1, object2)             // object1 − object2
common()
common(...objects)                     // intersection
```

The no-argument forms operate on the implicit last objects in scope; the
explicit forms operate on the arguments you pass. These are 3D-only —
inside a sketch they throw (the 2D booleans were removed).
Most modeling work can rely on auto-fusion (touching solids merge
automatically and `.remove()` chained on `extrude` already covers
subtraction). Reach for these when:

- You need to fuse non-touching solids deliberately.
- An op didn't auto-fuse the way you wanted and you want to be explicit.
- You want an explicit intersection rather than a per-feature `.scope()`.

## Example

```fluid.js
import { circle, extrude, line, origin, sketch, subtract, xAxis, yAxis } from "fluidcad/core";
import { coincident, diameter, distance, horizontal, symmetric, vertical } from "fluidcad/constraints";

sketch("xy", () => {
  const b = line([-30, -30], [30, -30]);
  const r = line([30, -30], [30, 30]);
  const t = line([30, 30], [-30, 30]);
  const l = line([-30, 30], [-30, -30]);
  coincident(b.end(), r.start());
  coincident(r.end(), t.start());
  coincident(t.end(), l.start());
  coincident(l.end(), b.start());
  horizontal(t);
  vertical(l);
  symmetric(b.start(), b.end(), yAxis());   // bottom side centred on Y (and horizontal)
  symmetric(r.start(), r.end(), xAxis());   // right side centred on X (and vertical)
  distance(b.start(), b.end(), 60);
  distance(r.start(), r.end(), 60);
});
const a = extrude(20).new();
sketch("xy", () => {
  const c = circle([0, 0], 35);
  coincident(c.center(), origin());
  diameter(c, 35);
});
const b = extrude(20).new();
subtract(a, b);
```

See [[api/extrude]] for chained boolean scope (`.add()`, `.remove()`,
`.new()`, `.scope()`) and [[api/cut]] for the subtractive extrude.
