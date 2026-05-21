---
id: api/types/tangent-arc-two-objects
title: TangentArcTwoObjects
summary: "The TangentArcTwoObjects type. Extends Geometry; adds 2 methods."
tags: [api, type, interface]
symbols: [TangentArcTwoObjects, ITangentArcTwoObjects]
seeAlso: [api/tarc, api/types/geometry]
---
# TangentArcTwoObjects

```ts
interface TangentArcTwoObjects extends Geometry {
  start(index?: number): Vertex;
  end(index?: number): Vertex;
}
```

Extends [[api/types/geometry]].

## Methods

### `start()`

Returns the start vertex of the tangent arc.

**Returns**: [[api/types/vertex]].

| Parameter | Type | Description |
| --- | --- | --- |
| `index` | `number` | Solution index when multiple tangent arcs exist (defaults to 0). *(optional)* |

### `end()`

Returns the end vertex of the tangent arc.

**Returns**: [[api/types/vertex]].

| Parameter | Type | Description |
| --- | --- | --- |
| `index` | `number` | Solution index when multiple tangent arcs exist (defaults to 0). *(optional)* |

## Inherited

From [[api/types/geometry]]: `guide()`, `start()`, `end()`, `tangent()`

From [[api/types/scene-object]]: `name()`, `reusable()`
