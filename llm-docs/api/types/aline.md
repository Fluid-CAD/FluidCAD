---
id: api/types/aline
title: ALine
summary: "The ALine type. Extends Geometry; adds 1 method."
tags: [api, type, interface]
symbols: [ALine, IALine]
seeAlso: [api/line, api/types/geometry]
---
# ALine

```ts
interface ALine extends Geometry {
  centered(value?: boolean): this;
}
```

Extends [[api/types/geometry]].

## Methods

### `centered()`

Controls whether the line is centered on the current position.
When `true`, the line is offset backward by half its length so that the
current position falls at its midpoint.

| Parameter | Type | Description |
| --- | --- | --- |
| `value` | `boolean` | `true` to center, `false` (default) to start from the current position. *(optional)* |

## Inherited

From [[api/types/geometry]]: `guide()`, `start()`, `end()`, `tangent()`

From [[api/types/scene-object]]: `name()`, `reusable()`
