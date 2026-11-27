---
id: api/types/surface-result
title: SurfaceResult
summary: "What every tool that leaves a surface answers: its faces, and the edges of its open rim."
tags: [api, type, interface]
symbols: [SurfaceResult, ISurfaceResult]
seeAlso: [api/types/scene-object]
---
# SurfaceResult

```ts
interface SurfaceResult extends SceneObject {
  faces(...args: (number | FaceFilter)[]): ISelection;
  boundaryEdges(...args: (number | EdgeFilter)[]): ISelection;
}
```

What every tool that leaves a surface answers: its faces, and the edges
of its open rim.

Extends [[api/types/scene-object]].

## Methods

### `faces()`

The faces of the surface. With no argument, all of them.

**Returns**: `ISelection`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `FaceFilter`)[] | Face indices, or face filters to narrow the faces by. *(optional)* |

### `boundaryEdges()`

The edges of the surface's open rim: those that bound one face only.
With no argument, all of them.

**Returns**: `ISelection`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Edge indices, or edge filters to narrow the edges by. *(optional)* |

## Inherited

From [[api/types/scene-object]]: `name()`
