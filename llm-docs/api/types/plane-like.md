---
id: api/types/plane-like
title: PlaneLike
summary: "A plane reference accepted by sketch(), filters, and other plane-aware operations."
tags: [api, type, union]
symbols: [PlaneLike, PlaneObjectBase]
seeAlso: [api/sketch, api/plane, api/types/plane, api/types/scene-object]
---
# PlaneLike

```ts
type PlaneLike = StandardPlane | Plane | IPlane | PlaneObjectBase;
```

A plane reference used by `sketch()`, filters, and other operations. Any of the following formats are accepted:

| Format | Example | Description |
| --- | --- | --- |
| Standard plane string | `"xy"`, `"xz"`, `"yz"` | The three principal planes. |
| Negative plane string | `"-xy"`, `"-xz"`, `"-yz"` | Principal planes with flipped normals. |
| Named plane string | `"top"`, `"bottom"`, `"front"`, `"back"`, `"left"`, `"right"` | Descriptive aliases for the principal planes. |
| [[api/types/plane]] | `plane("xy", 10)` | A plane object created with `plane()`. |
| [[api/types/scene-object]] | A face selection | A planar face to use as reference. |

## Example

```fluid.js
import { sketch, circle, extrude, plane, origin } from "fluidcad/core";
import { coincident, diameter } from "fluidcad/constraints";

sketch("xy", () => {                                // string form
  const base = circle([0, 0], 50);
  coincident(base.center(), origin());
  diameter(base, 50);
});
const e = extrude(20);
sketch(plane("xy", 30), () => {                     // Plane form
  const mid = circle([0, 0], 30);
  coincident(mid.center(), origin());
  diameter(mid, 30);
});
sketch(e.endFaces(), () => {                        // face form
  const top = circle([0, 0], 10);
  coincident(top.center(), origin());
  diameter(top, 10);
});
extrude(5);
```
