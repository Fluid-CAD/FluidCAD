---
id: api/types/solved-arc
title: SolvedArc
summary: "A solved (constraint-sketch) arc statement."
tags: [api, type, interface]
symbols: [SolvedArc, ISolvedArc]
seeAlso: [api/arc, api/types/geometry]
---
# SolvedArc

```ts
interface SolvedArc extends Geometry {
  cw(): this;
  ccw(): this;
  center(): Vertex;
}
```

A solved (constraint-sketch) arc statement.

Extends [[api/types/geometry]].

## Methods

### `cw()`

Sweeps the arc clockwise from start to end (display/topology only — the
solver has no sweep parameter).

### `ccw()`

Sweeps the arc counter-clockwise from start to end (the default).

### `center()`

Returns a lazy-evaluated vertex at the arc's center.

**Returns**: [[api/types/vertex]].

## Inherited

From [[api/types/geometry]]: `guide()`, `edge()`, `start()`, `end()`, `tangent()`

From [[api/types/scene-object]]: `name()`, `reusable()`
