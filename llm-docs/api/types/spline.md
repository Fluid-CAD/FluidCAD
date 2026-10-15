---
id: api/types/spline
title: Spline
summary: "A spline statement: a smooth curve through its points."
tags: [api, type, interface]
symbols: [Spline, ISpline]
seeAlso: [api/types/geometry]
---
# Spline

```ts
interface Spline extends Geometry {
  point(index: number): Vertex;
  start(): Vertex;
  end(): Vertex;
}
```

A spline statement: a smooth curve through its points. Inside a sketch
every point given as a literal is a solver point entity — constraints
target `.point(i)` (or `.start()`/`.end()`) and the solve reshapes the
curve. A point given as another entity's accessor (e.g. `l.end()`) is
that entity's point; `.point(i)` returns the original reference.

Extends [[api/types/geometry]].

## Methods

### `point()`

Returns the i-th fit point (0-based; 0 is the start, the last index
is the end) as a lazy vertex / constraint target.

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

From [[api/types/geometry]]: `guide()`, `edge()`, `start()`, `end()`

From [[api/types/scene-object]]: `name()`
