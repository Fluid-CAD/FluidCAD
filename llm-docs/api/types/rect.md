---
id: api/types/rect
title: Rect
summary: "The Rect type. Extends ExtrudableGeometry; adds 14 methods."
tags: [api, type, interface]
symbols: [Rect, IRect]
seeAlso: [api/rect, api/types/extrudable-geometry]
---
# Rect

```ts
interface Rect extends ExtrudableGeometry {
  radius(...r: number[]): this;
  centered(value?: boolean | "horizontal" | "vertical"): this;
  topEdge(): SceneObject;
  bottomEdge(): SceneObject;
  leftEdge(): SceneObject;
  rightEdge(): SceneObject;
  topLeftArcEdge(): SceneObject;
  topRightArcEdge(): SceneObject;
  bottomLeftArcEdge(): SceneObject;
  bottomRightArcEdge(): SceneObject;
  topLeft(): Vertex;
  topRight(): Vertex;
  bottomLeft(): Vertex;
  bottomRight(): Vertex;
}
```

Extends [[api/types/extrudable-geometry]].

## Methods

### `radius()`

Sets corner radii for a rounded rectangle. Accepts 1–4 values
in order: `[bottomLeft, bottomRight, topRight, topLeft]`.
A single value applies to all corners.

| Parameter | Type | Description |
| --- | --- | --- |
| `...r` | `number`[] | One or more radius values. *(optional)* |

### `centered()`

Controls how the rectangle is positioned relative to the current point.

| Parameter | Type | Description |
| --- | --- | --- |
| `value` | `boolean` \| `"horizontal"` \| `"vertical"` | `true` centers on both axes, `'horizontal'` or `'vertical'` centers on one axis, `false` (default) keeps the current point as the origin corner. *(optional)* |

### `topEdge()`

Returns the top straight edge of the rectangle.

**Returns**: [[api/types/scene-object]].

### `bottomEdge()`

Returns the bottom straight edge of the rectangle.

**Returns**: [[api/types/scene-object]].

### `leftEdge()`

Returns the left straight edge of the rectangle.

**Returns**: [[api/types/scene-object]].

### `rightEdge()`

Returns the right straight edge of the rectangle.

**Returns**: [[api/types/scene-object]].

### `topLeftArcEdge()`

Returns the arc edge at the top-left corner. Only present when a radius is applied.

**Returns**: [[api/types/scene-object]].

### `topRightArcEdge()`

Returns the arc edge at the top-right corner. Only present when a radius is applied.

**Returns**: [[api/types/scene-object]].

### `bottomLeftArcEdge()`

Returns the arc edge at the bottom-left corner. Only present when a radius is applied.

**Returns**: [[api/types/scene-object]].

### `bottomRightArcEdge()`

Returns the arc edge at the bottom-right corner. Only present when a radius is applied.

**Returns**: [[api/types/scene-object]].

### `topLeft()`

Returns a lazy-evaluated vertex at the top-left corner.

**Returns**: [[api/types/vertex]].

### `topRight()`

Returns a lazy-evaluated vertex at the top-right corner.

**Returns**: [[api/types/vertex]].

### `bottomLeft()`

Returns a lazy-evaluated vertex at the bottom-left corner.

**Returns**: [[api/types/vertex]].

### `bottomRight()`

Returns a lazy-evaluated vertex at the bottom-right corner.

**Returns**: [[api/types/vertex]].

## Inherited

From [[api/types/geometry]]: `guide()`, `start()`, `end()`, `tangent()`

From [[api/types/scene-object]]: `name()`, `reusable()`
