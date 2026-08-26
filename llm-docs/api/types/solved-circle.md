---
id: api/types/solved-circle
title: SolvedCircle
summary: "A solved (constraint-sketch) circle statement."
tags: [api, type, interface]
symbols: [SolvedCircle, ISolvedCircle]
seeAlso: [api/circle, api/types/extrudable-geometry]
---
# SolvedCircle

```ts
interface SolvedCircle extends ExtrudableGeometry {
  center(): Vertex;
}
```

A solved (constraint-sketch) circle statement.

Extends [[api/types/extrudable-geometry]].

## Methods

### `center()`

Returns a lazy-evaluated vertex at the circle's center.

**Returns**: [[api/types/vertex]].

## Inherited

From [[api/types/geometry]]: `guide()`, `edge()`, `start()`, `end()`, `tangent()`

From [[api/types/scene-object]]: `name()`, `reusable()`
