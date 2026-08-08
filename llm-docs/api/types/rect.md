---
id: api/types/rect
title: Rect
summary: "The Rect type. Extends ExtrudableGeometry; adds 6 methods."
tags: [api, type, interface]
symbols: [Rect, IRect]
seeAlso: [api/rect, api/types/extrudable-geometry]
---
# Rect

```ts
interface Rect extends ExtrudableGeometry {
  radius(...r: number[]): this;
  centered(value?: boolean | "horizontal" | "vertical"): this;
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

From [[api/types/geometry]]: `guide()`, `edge()`, `start()`, `end()`, `tangent()`

From [[api/types/scene-object]]: `name()`, `reusable()`
