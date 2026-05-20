---
id: api/tcircle
title: tCircle — tangent circle
summary: Full circle of given diameter tangent to two objects (or threading two points). Use qualifiers to disambiguate among the up-to-8 valid solutions.
tags: [api, 2d, constrained, curve]
symbols: [tCircle]
seeAlso: [api/tline, api/tarc, api/circle]
---

# tCircle

```ts
tCircle(c1, c2, diameter, mustTouch?)
tCircle(c1: QualifiedGeometry, c2: QualifiedGeometry, diameter, mustTouch?)
tCircle(c1: Point2D, c2: Point2D, diameter, mustTouch?)
```

Returns a full circle (`ExtrudableGeometry`) of the given diameter
tangent to both targets. Up to 8 solutions exist for two circles —
narrow with `outside` / `enclosing` / `enclosed` qualifiers and/or
`mustTouch: true`.

## Example

```fluid.js
import { outside } from "fluidcad/constraints";

sketch("xy", () => {
  const c1 = circle([0, 0], 40).reusable();
  const c2 = circle([100, 0], 40).reusable();
  tCircle(outside(c1), outside(c2), 20);
});
extrude(2);
```

See [[api/tline]] and [[api/tarc]] for tangent lines and arcs.
