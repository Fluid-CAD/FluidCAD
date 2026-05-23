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
import { sketch, rect, circle, extrude, plane } from "fluidcad/core";

sketch("xy", () => rect(100, 50).centered());            // string form
const e = extrude(20);
sketch(plane("xy", 30), () => rect(40, 40).centered());  // Plane form
sketch(e.endFaces(), () => circle(10));                  // face form
extrude(5);
```
