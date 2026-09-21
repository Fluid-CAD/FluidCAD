---
id: api/types/offset-edge
title: OffsetEdge
summary: "One edge of an offset result (`o.edge(i)`): a whole-edge operand like any `edge(i)` selection, and a point source for references from outside the sketch — loft connections, connectors — through `.start()`, `.end()` and, on an arc, `.center()`."
tags: [api, type, interface]
symbols: [OffsetEdge, IOffsetEdge]
seeAlso: [api/types/select]
---
# OffsetEdge

```ts
interface OffsetEdge extends Select {
  start(): Vertex;
  end(): Vertex;
  center(): Vertex;
}
```

One edge of an offset result (`o.edge(i)`): a whole-edge operand like any
`edge(i)` selection, and a point source for references from outside the
sketch — loft connections, connectors — through `.start()`, `.end()` and,
on an arc, `.center()`. Offset edges have no solver identity, so these
points are not constraint targets.

Extends [[api/types/select]].

## Methods

### `start()`

The edge's first point along the offset walk (see `IOffset.edge`).

**Returns**: [[api/types/vertex]].

### `end()`

The edge's last point along the offset walk — `o.edge(i).end()` is `o.edge(i + 1).start()`.

**Returns**: [[api/types/vertex]].

### `center()`

The center of an arc edge (an offset arc or a rounded outward corner); an error on a line.

**Returns**: [[api/types/vertex]].

## Inherited

From [[api/types/scene-object]]: `name()`, `reusable()`
