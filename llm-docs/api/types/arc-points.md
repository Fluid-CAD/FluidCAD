---
id: api/types/arc-points
title: ArcPoints
summary: "The ArcPoints type. Extends ExtrudableGeometry; adds 2 methods."
tags: [api, type, interface]
symbols: [ArcPoints, IArcPoints]
seeAlso: [api/arc, api/types/extrudable-geometry]
---
# ArcPoints

```ts
interface ArcPoints extends ExtrudableGeometry {
  radius(value: NumberParam): IArcRadius;
  center(value: Point2DLike): IArcCenter;
}
```

Extends [[api/types/extrudable-geometry]].

## Methods

### `radius()`

Sets the bulge radius for point-to-point arcs.
Positive = CCW, negative = CW.

**Returns**: `IArcRadius`.

| Parameter | Type | Description |
| --- | --- | --- |
| `value` | `NumberParam` | The bulge radius. |

### `center()`

Specifies the circle center point for the arc.
Mutually exclusive with `.radius()`.

**Returns**: `IArcCenter`.

| Parameter | Type | Description |
| --- | --- | --- |
| `value` | [[api/types/point2dlike]] | The center point of the arc's circle. |

## Inherited

From [[api/types/geometry]]: `guide()`, `start()`, `end()`, `tangent()`

From [[api/types/scene-object]]: `name()`, `reusable()`
