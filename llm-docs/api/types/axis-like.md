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
type AxisLike = StandardAxis | Axis | IAxis | AxisObjectBase;
```

An axis reference used by `revolve()` and other axis-based operations. Any of the following formats are accepted:

| Format | Example | Description |
| --- | --- | --- |
| Standard axis string | `"x"`, `"y"`, `"z"` | The three principal axes. |
| [[api/types/axis]] | `axis("x", [0, 10])` | An axis object created with `axis()`. |

## Example

```fluid.js
import { sketch, rect, move, revolve, axis } from "fluidcad/core";

sketch("xz", () => {
  move([20, 0]);
  rect(10, 30);
});
revolve("z", 360);             // string form

sketch("xz", () => {
  move([30, 0]);
  rect(5, 5);
});
revolve(axis("z"), 180);       // Axis form
```
