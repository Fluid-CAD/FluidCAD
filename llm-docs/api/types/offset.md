---
id: api/types/offset
title: Offset
summary: "The Offset type. Extends ExtrudableGeometry; adds 2 methods."
tags: [api, type, interface]
symbols: [Offset, IOffset]
seeAlso: [api/offset, api/types/extrudable-geometry]
---
# Offset

```ts
interface Offset extends ExtrudableGeometry {
  close(): this;
  edge(index: number): OffsetEdge;
}
```

Extends [[api/types/extrudable-geometry]].

## Methods

### `close()`

Closes an open offset by joining it back to the source wire with
straight cap edges at each endpoint. Has no effect when the offset
is already closed.

### `edge()`

One edge of the result by index, with point accessors for references
from outside the sketch (`a.geometries.o.edge(2).start()` in a loft
connection). Indices walk the result: index 0 is the offset of the
first source edge in statement order (for an open offset, the offset of
the chain's first edge), the walk continues in that edge's own
direction, and the arcs an outward offset rounds corners with are
ordinary steps of it. Several separate sources offset to several wires,
numbered wire after wire in statement order; `.close()` appends the cap
at the walk's end, then the cap at its start. Because the indices are
positional, an edit that changes which corners are rounded — flipping
the sign, for one — shifts them, and a reference then resolves to a
different vertex, as any index-based reference does.

**Returns**: [[api/types/offset-edge]].

| Parameter | Type | Description |
| --- | --- | --- |
| `index` | `number` | The 0-based edge index along the offset walk. |

## Inherited

From [[api/types/geometry]]: `guide()`, `edge()`, `start()`, `end()`

From [[api/types/scene-object]]: `name()`
