---
id: api/types/point2dlike
title: Point2DLike
summary: "A 2D point accepted by sketching functions."
tags: [api, type, union]
symbols: [Point2DLike]
seeAlso: [api/line, api/rect, api/types/vertex]
---
# Point2DLike

```ts
type Point2DLike = | Point2D
  | [number, number]
  | number[]
  | { x: number; y: number }
  | LazyVertex;
```

A 2D point used by all sketching functions. Any of the following formats are accepted:

| Format | Example | Description |
| --- | --- | --- |
| `[number, number]` | `[10, 20]` | Tuple of x, y coordinates. |
| `number[]` | `[10, 20]` | Array of x, y coordinates. |
| `{ x, y }` | `{ x: 10, y: 20 }` | Object with x, y properties. |
| [[api/types/vertex]] | `line(...).end()` | A vertex returned by a geometry method. |
