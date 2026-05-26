---
id: api/types/two-objects-tangent-line
title: TwoObjectsTangentLine
summary: "The TwoObjectsTangentLine type. Extends Geometry; adds 2 methods."
tags: [api, type, interface]
symbols: [TwoObjectsTangentLine, ITwoObjectsTangentLine]
seeAlso: [api/tline, api/types/geometry]
---
# TwoObjectsTangentLine

```ts
interface TwoObjectsTangentLine extends Geometry {
  start(index?: number): Vertex;
  end(index?: number): Vertex;
}
```

Extends [[api/types/geometry]].

## Methods

### `start()`

Returns the start vertex of the tangent line.

**Returns**: [[api/types/vertex]].

| Parameter | Type | Description |
| --- | --- | --- |
| `index` | `number` | Solution index when multiple tangent lines exist (defaults to 0). *(optional)* |

### `end()`

Returns the end vertex of the tangent line.

**Returns**: [[api/types/vertex]].

| Parameter | Type | Description |
| --- | --- | --- |
| `index` | `number` | Solution index when multiple tangent lines exist (defaults to 0). *(optional)* |

## Inherited

From [[api/types/geometry]]: `guide()`, `start()`, `end()`, `tangent()`

From [[api/types/scene-object]]: `name()`, `reusable()`
