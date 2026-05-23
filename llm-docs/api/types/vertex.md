---
id: api/types/vertex
title: Vertex
summary: "A lazy-evaluated vertex representing a point on existing geometry."
tags: [api, type, union]
symbols: [Vertex, LazyVertex]
seeAlso: [api/types/point2dlike]
---
# Vertex

```ts
type Vertex = Vertex;
```

A lazy-evaluated vertex representing a point on geometry. Vertices are returned by methods like `start()`, `end()`, and `tangent()` on `Geometry` types.

Vertices can be passed as a [[api/types/point2dlike]] to any function that accepts a 2D point, allowing you to reference points on existing geometry.
