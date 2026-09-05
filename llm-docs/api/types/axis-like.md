---
id: api/types/axis-like
title: AxisLike
summary: "An axis reference accepted by revolve(), repeat(), and other axis-based operations."
tags: [api, type, union]
symbols: [AxisLike, AxisObjectBase]
seeAlso: [api/revolve, api/axis, api/types/axis]
---
# AxisLike

```ts
type AxisLike = StandardAxis | Axis | IAxis | AxisObjectBase | SketchDatum;
```

An axis reference used by `revolve()` and other axis-based operations. Any of the following formats are accepted:

| Format | Example | Description |
| --- | --- | --- |
| Standard axis string | `"x"`, `"y"`, `"z"` | The three principal axes. |
| [[api/types/axis]] | `axis("x", [0, 10])` | An axis object created with `axis()`. |
| Sketch axis datum | `xAxis()`, `yAxis()` | The sketch's own X / Y axis (see `api/constraints`) — for `mirror()` and `copy("linear", …)` inside a sketch, where a bare string means the world axis. |

## Example

```fluid.js
import { sketch, circle, revolve, axis } from "fluidcad/core";

sketch("xz", () => circle([25, 0], 10));
revolve("z", 360);             // string form

sketch("xz", () => circle([45, 0], 6));
revolve(axis("z"), 180);       // Axis form
```
