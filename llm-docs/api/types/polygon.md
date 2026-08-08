---
id: api/types/polygon
title: Polygon
summary: "The Polygon type. Extends ExtrudableGeometry; adds 2 methods."
tags: [api, type, interface]
symbols: [Polygon, IPolygon]
seeAlso: [api/polygon, api/types/extrudable-geometry]
---
# Polygon

```ts
interface Polygon extends ExtrudableGeometry {
  getEdge(index: number): ISelection;
  getVertex(index: number): Vertex;
}
```

Extends [[api/types/extrudable-geometry]].

## Methods

### `getEdge()`

Returns a specific edge of the polygon by index.

**Returns**: `ISelection`.

| Parameter | Type | Description |
| --- | --- | --- |
| `index` | `number` | Zero-based edge index. |

### `getVertex()`

Returns a lazy-evaluated vertex at a specific corner of the polygon.

**Returns**: [[api/types/vertex]].

| Parameter | Type | Description |
| --- | --- | --- |
| `index` | `number` | Zero-based vertex index. |

## Inherited

From [[api/types/geometry]]: `guide()`, `edge()`, `start()`, `end()`, `tangent()`

From [[api/types/scene-object]]: `name()`, `reusable()`
