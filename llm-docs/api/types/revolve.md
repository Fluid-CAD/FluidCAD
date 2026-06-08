---
id: api/types/revolve
title: Revolve
summary: "The Revolve type. Extends BooleanOperation; adds 7 methods."
tags: [api, type, interface]
symbols: [Revolve, IRevolve]
seeAlso: [api/revolve, api/types/boolean-operation]
---
# Revolve

```ts
interface Revolve extends BooleanOperation {
  symmetric(): this;
  pick(...points: Point2DLike[]): this;
  thin(offset: NumberParam): this;
  thin(offset1: NumberParam, offset2: NumberParam): this;
  internalFaces(...args: (number | FaceFilter)[]): SceneObject;
  internalEdges(...args: (number | EdgeFilter)[]): SceneObject;
  capFaces(...args: (number | FaceFilter)[]): SceneObject;
  capEdges(...args: (number | EdgeFilter)[]): SceneObject;
}
```

Extends [[api/types/boolean-operation]].

## Methods

### `symmetric()`

Enables symmetric mode — revolves equally in both directions from the sketch plane.

### `pick()`

Restricts the revolve to only the sketch regions containing the given points.

| Parameter | Type | Description |
| --- | --- | --- |
| `...points` | [[api/types/point2dlike]][] | 2D points in the sketch plane identifying regions to revolve. *(optional)* |

### `thin()`

```ts
thin(offset: NumberParam): this
thin(offset1: NumberParam, offset2: NumberParam): this
```

Enables thin revolve mode — offsets the profile edges to create a thin-walled
solid of revolution instead of revolving filled faces. Positive values offset
outward, negative values offset inward.

| Parameter | Type | Description |
| --- | --- | --- |
| `offset1` | `NumberParam` | The first wall offset distance. Positive = outward, negative = inward. |
| `offset2` | `NumberParam` | The second wall offset distance, in the opposite direction of offset1. |

### `internalFaces()`

Selects faces created inside the solid during revolution (e.g., the inner
wall of a thin-walled revolve from a closed profile).

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `FaceFilter`)[] | Numeric indices or FaceFilterBuilder instances to filter the selection. *(optional)* |

### `internalEdges()`

Selects edges bounding the internal geometry created during revolution.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Numeric indices or EdgeFilterBuilder instances to filter the selection. *(optional)* |

### `capFaces()`

Selects the cap faces at the open ends of a thin-walled revolve from an open profile.
These are the small faces connecting the inner and outer walls at the profile endpoints.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `FaceFilter`)[] | Numeric indices or FaceFilterBuilder instances to filter the selection. *(optional)* |

### `capEdges()`

Selects edges on the cap faces of a thin-walled revolve from an open profile.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Numeric indices or EdgeFilterBuilder instances to filter the selection. *(optional)* |

## Inherited

From [[api/types/boolean-operation]]: `add()`, `'new'()`, `remove()`, `scope()`

From [[api/types/scene-object]]: `name()`, `reusable()`
