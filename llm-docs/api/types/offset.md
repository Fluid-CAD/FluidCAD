---
id: api/types/offset
title: Offset
summary: "The Offset type. Extends ExtrudableGeometry; adds 1 method."
tags: [api, type, interface]
symbols: [Offset, IOffset]
seeAlso: [api/offset, api/types/extrudable-geometry]
---
# Offset

```ts
interface Offset extends ExtrudableGeometry {
  close(): this;
}
```

Extends [[api/types/extrudable-geometry]].

## Methods

### `close()`

Closes an open offset by joining it back to the source wire with
straight cap edges at each endpoint. Has no effect when the offset
is already closed. Cannot be combined with `removeOriginal=true`.

## Inherited

From [[api/types/geometry]]: `guide()`, `start()`, `end()`, `tangent()`

From [[api/types/scene-object]]: `name()`, `reusable()`
