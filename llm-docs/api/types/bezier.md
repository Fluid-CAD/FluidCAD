---
id: api/types/bezier
title: Bezier
summary: "A bezier statement."
tags: [api, type, interface]
symbols: [Bezier, IBezier]
seeAlso: [api/types/geometry]
---
# Bezier

```ts
interface Bezier extends Geometry {
  point(index: number): Vertex;
  start(): Vertex;
  end(): Vertex;
}
```

A bezier statement. Inside a sketch every control point given as a
literal is a solver point entity — constraints target `.point(i)`
(or `.start()`/`.end()`) and the solve reshapes the curve. A control
point given as another entity's accessor (e.g. `l.end()`) is that
entity's point; `.point(i)` returns the original reference.

Extends [[api/types/geometry]].

## Methods

### `point()`

Returns the i-th control point (0-based; 0 is the start, the last
index is the end) as a lazy vertex / constraint target.

**Returns**: [[api/types/vertex]].

| Parameter | Type | Description |
| --- | --- | --- |
| `index` | `number` |  |

### `start()`

Returns the curve's start point — `point(0)`.

**Returns**: [[api/types/vertex]].

### `end()`

Returns the curve's end point — `point(n - 1)`.

**Returns**: [[api/types/vertex]].

## Inherited

From [[api/types/geometry]]: `guide()`, `edge()`, `start()`, `end()`, `tangent()`

From [[api/types/scene-object]]: `name()`, `reusable()`
