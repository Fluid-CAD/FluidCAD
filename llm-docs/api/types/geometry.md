---
id: api/types/geometry
title: Geometry
summary: "The Geometry type. Extends SceneObject; adds 4 methods."
tags: [api, type, interface]
symbols: [Geometry, IGeometry]
seeAlso: [api/types/scene-object]
---
# Geometry

```ts
interface Geometry extends SceneObject {
  guide(): this;
  start(): Vertex;
  end(): Vertex;
  tangent(): Vertex;
}
```

Extends [[api/types/scene-object]].

## Methods

### `guide()`

Marks this sketch geometry as construction geometry. Guide geometries are
excluded from the final sketch output (e.g., extrude, revolve) unless
explicitly included.

### `start()`

Returns a lazy-evaluated vertex at the start point of this geometry element.

**Returns**: [[api/types/vertex]].

### `end()`

Returns a lazy-evaluated vertex at the end point of this geometry element.

**Returns**: [[api/types/vertex]].

### `tangent()`

Returns a lazy-evaluated vertex representing the tangent direction at the end
of this geometry. Used to determine the direction of subsequent geometry elements.

**Returns**: [[api/types/vertex]].

## Inherited

From [[api/types/scene-object]]: `name()`, `reusable()`
