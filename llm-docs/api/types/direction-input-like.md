---
id: api/types/direction-input-like
title: DirectionInputLike
summary: "A direction, given as an axis or as a plane's normal — what a projected curve's .direction() takes."
tags: [api, type, union]
symbols: [DirectionInputLike]
seeAlso: [api/projected-curve, api/types/projected-curve, api/types/axis-like, api/types/plane-like]
---
# DirectionInputLike

```ts
type DirectionInputLike = AxisLike | PlaneLike | IConnector | ISceneObject;
```

A direction, as `.direction()` of a projected curve takes it: an axis gives its own direction, a plane its normal. It is a line, not an arrow — what uses it decides which way along it matters. Any of the following formats are accepted:

| Format | Example | Description |
| --- | --- | --- |
| Standard axis string | `"x"`, `"y"`, `"z"` | The three principal axes. |
| [[api/types/axis]] | `axis("z", { offsetX: 50 })` | An axis object created with `axis()`. |
| Straight edge | `select(edge().line().first())` | Along the line of a straight edge; a curved edge is refused when the feature builds. |
| [[api/types/connector]] | `connector("pin", …)` | The connector's Z axis. |
| Standard plane string | `"xy"`, `"xz"`, `"yz"` | The normal of a principal plane. |
| [[api/types/plane]] | `plane("xy", { rotateX: 30 })` | The normal of a plane object created with `plane()`. |
| Planar face | `select(face().planar().first())` | The normal of a planar face; a curved face is refused when the feature builds. |

## Example

```fluid.js
import { sketch, circle, extrude, plane, project } from "fluidcad/core";

sketch("xy", () => {
  circle([0, 0], 80);
});
const disc = extrude(10);

const tilted = sketch(plane("xy", { offset: 40, rotateX: 30 }), () => {
  circle([0, 0], 30);
});

// Along the world Z axis, not the tilted plane's normal.
project(tilted, disc.endFaces()).direction("z");
```
