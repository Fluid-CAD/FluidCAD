---
id: api/types/solved-line
title: SolvedLine
summary: "A solved (constraint-sketch) line statement."
tags: [api, type, interface]
symbols: [SolvedLine, ISolvedLine]
seeAlso: [api/line, api/types/geometry]
---
# SolvedLine

```ts
interface SolvedLine extends Geometry {
  mid(): Vertex;
}
```

A solved (constraint-sketch) line statement.

Extends [[api/types/geometry]].

## Methods

### `mid()`

Returns a lazy-evaluated vertex at the line's midpoint. In constraints
it is accepted by coincident(), which lowers it to the midpoint
constraint.

**Returns**: [[api/types/vertex]].

## Inherited

From [[api/types/geometry]]: `guide()`, `edge()`, `start()`, `end()`, `tangent()`

From [[api/types/scene-object]]: `name()`, `reusable()`
