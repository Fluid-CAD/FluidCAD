---
id: api/types/curve-result
title: CurveResult
summary: "What every tool that leaves a curve answers: its edges, and where it starts and ends."
tags: [api, type, interface]
symbols: [CurveResult, ICurveResult]
seeAlso: [api/types/scene-object]
---
# CurveResult

```ts
interface CurveResult extends SceneObject {
  edges(...args: (number | EdgeFilter)[]): ISelection;
  start(): Vertex;
  end(): Vertex;
}
```

What every tool that leaves a curve answers: its edges, and where it
starts and ends.

Extends [[api/types/scene-object]].

## Methods

### `edges()`

The edges of the curve, in the order the curve runs. With no argument,
all of them.

**Returns**: `ISelection`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Edge indices, or edge filters to narrow the edges by. *(optional)* |

### `start()`

The point the curve starts at. When the result is several separate
curves, the first one's.

**Returns**: [[api/types/vertex]].

### `end()`

The point the curve ends at. When the result is several separate
curves, the first one's.

**Returns**: [[api/types/vertex]].

## Inherited

From [[api/types/scene-object]]: `name()`
