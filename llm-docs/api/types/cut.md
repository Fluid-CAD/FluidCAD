---
id: api/types/cut
title: Cut
summary: "The Cut type. Extends SceneObject; adds 10 methods."
tags: [api, type, interface]
symbols: [Cut, ICut]
seeAlso: [api/cut, api/types/scene-object]
---
# Cut

```ts
interface Cut extends SceneObject {
  symmetric(): this;
  scope(...objects: SceneObject[]): this;
  draft(value: NumberParam | [NumberParam, NumberParam]): this;
  endOffset(value: NumberParam): this;
  startEdges(...args: (number | EdgeFilter)[]): ISelection;
  endEdges(...args: (number | EdgeFilter)[]): ISelection;
  internalEdges(...args: (number | EdgeFilter)[]): ISelection;
  internalFaces(...args: (number | FaceFilter)[]): ISelection;
  pick(...points: Point2DLike[]): this;
  thin(offset: NumberParam): this;
  thin(offset1: NumberParam, offset2: NumberParam): this;
}
```

Extends [[api/types/scene-object]].

## Methods

### `symmetric()`

Enables symmetric mode — cuts equally in both directions from the sketch plane.

### `scope()`

Narrows the cut scope to specific target objects.
Must be chained after `.remove()`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...objects` | [[api/types/scene-object]][] | The target objects to cut from. *(optional)* |

### `draft()`

Applies a draft (taper) angle to the cut walls.

| Parameter | Type | Description |
| --- | --- | --- |
| `value` | `NumberParam` \| `[NumberParam, NumberParam]` | A single angle for uniform draft, or a `[start, end]` tuple for asymmetric draft. |

### `endOffset()`

Offsets the cut end face by a specified distance along the cut direction.

| Parameter | Type | Description |
| --- | --- | --- |
| `value` | `NumberParam` | The offset distance. |

### `startEdges()`

Selects the edges at the top of the cut: the rims where the tool entered the
material, on whatever face it entered through (a flat top or a curved wall).
A symmetric cut starts inside the material, so it only has start edges where
the sketch plane lies in a void and the tool meets material further out.

**Returns**: `ISelection`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Numeric indices or EdgeFilterBuilder instances to filter the selection. *(optional)* |

### `endEdges()`

Selects the edges at the bottom of the cut: every edge of a floor the tool
stopped at, and the rims where a through cut left the material.

**Returns**: `ISelection`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Numeric indices or EdgeFilterBuilder instances to filter the selection. *(optional)* |

### `internalEdges()`

Selects the edges created inside the solid: creases between the cut's own
walls, and rims along faces the cut runs parallel to.

**Returns**: `ISelection`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Numeric indices or EdgeFilterBuilder instances to filter the selection. *(optional)* |

### `internalFaces()`

Selects internal faces exposed by the cut — newly created surfaces not from the original stock.

**Returns**: `ISelection`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `FaceFilter`)[] | Numeric indices or FaceFilterBuilder instances to filter the selection. *(optional)* |

### `pick()`

Restricts the cut to only the sketch regions containing the given points.

| Parameter | Type | Description |
| --- | --- | --- |
| `...points` | [[api/types/point2dlike]][] | 2D points in the sketch plane identifying regions to cut. *(optional)* |

### `thin()`

```ts
thin(offset: NumberParam): this
thin(offset1: NumberParam, offset2: NumberParam): this
```

Enables thin cut mode — offsets the profile edges to cut a thin-walled shape
instead of cutting filled faces. Positive values offset outward, negative values offset inward.

| Parameter | Type | Description |
| --- | --- | --- |
| `offset1` | `NumberParam` | The first wall offset distance. Positive = outward, negative = inward. |
| `offset2` | `NumberParam` | The second wall offset distance, in the opposite direction of offset1. |

## Inherited

From [[api/types/scene-object]]: `name()`, `reusable()`
