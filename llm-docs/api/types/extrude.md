---
id: api/types/extrude
title: Extrude
summary: "The Extrude type. Extends BooleanOperation; adds 16 methods."
tags: [api, type, interface]
symbols: [Extrude, IExtrude]
seeAlso: [api/extrude, api/types/boolean-operation]
---
# Extrude

```ts
interface Extrude extends BooleanOperation {
  symmetric(): this;
  startFaces(...args: (number | FaceFilter)[]): SceneObject;
  endFaces(...args: (number | FaceFilter)[]): SceneObject;
  startEdges(...args: (number | EdgeFilter)[]): SceneObject;
  endEdges(...args: (number | EdgeFilter)[]): SceneObject;
  sideFaces(...args: (number | FaceFilter)[]): SceneObject;
  sideEdges(...args: (number | EdgeFilter)[]): SceneObject;
  internalFaces(...args: (number | FaceFilter)[]): SceneObject;
  internalEdges(...args: (number | EdgeFilter)[]): SceneObject;
  capFaces(...args: (number | FaceFilter)[]): SceneObject;
  capEdges(...args: (number | EdgeFilter)[]): SceneObject;
  draft(value: NumberParam | [NumberParam, NumberParam]): this;
  endOffset(value: NumberParam): this;
  drill(value?: boolean): this;
  pick(...points: Point2DLike[]): this;
  thin(offset: NumberParam): this;
  thin(offset1: NumberParam, offset2: NumberParam): this;
}
```

Extends [[api/types/boolean-operation]].

## Methods

### `symmetric()`

Enables symmetric mode — extrudes equally in both directions from the sketch plane.

### `startFaces()`

Selects faces at the start (base) of the extrusion.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `FaceFilter`)[] | Numeric indices or FaceFilterBuilder instances to filter the selection. *(optional)* |

### `endFaces()`

Selects faces at the end (cap) of the extrusion.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `FaceFilter`)[] | Numeric indices or FaceFilterBuilder instances to filter the selection. *(optional)* |

### `startEdges()`

Selects edges on the start (base) faces of the extrusion.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Numeric indices or EdgeFilterBuilder instances to filter the selection. *(optional)* |

### `endEdges()`

Selects edges on the end (cap) faces of the extrusion.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Numeric indices or EdgeFilterBuilder instances to filter the selection. *(optional)* |

### `sideFaces()`

Selects the lateral faces created by the extrusion.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `FaceFilter`)[] | Numeric indices or FaceFilterBuilder instances to filter the selection. *(optional)* |

### `sideEdges()`

Selects edges on the side faces, excluding edges shared with start/end faces.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Numeric indices or EdgeFilterBuilder instances to filter the selection. *(optional)* |

### `internalFaces()`

Selects faces created inside the solid during extrusion (e.g., from holes or intersections).

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `FaceFilter`)[] | Numeric indices or FaceFilterBuilder instances to filter the selection. *(optional)* |

### `internalEdges()`

Selects edges bounding the internal geometry created during extrusion.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Numeric indices or EdgeFilterBuilder instances to filter the selection. *(optional)* |

### `capFaces()`

Selects the cap faces at the open ends of a thin-walled extrusion from an open profile.
These are the small faces connecting the inner and outer walls at the profile endpoints.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `FaceFilter`)[] | Numeric indices or FaceFilterBuilder instances to filter the selection. *(optional)* |

### `capEdges()`

Selects edges on the cap faces of a thin-walled extrusion from an open profile.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Numeric indices or EdgeFilterBuilder instances to filter the selection. *(optional)* |

### `draft()`

Applies a draft (taper) angle to the extrusion walls.

| Parameter | Type | Description |
| --- | --- | --- |
| `value` | `NumberParam` \| `[NumberParam, NumberParam]` | A single angle for uniform draft, or a `[start, end]` tuple for asymmetric draft. |

### `endOffset()`

Offsets the end face by a specified distance along the extrusion direction.

| Parameter | Type | Description |
| --- | --- | --- |
| `value` | `NumberParam` | The offset distance. |

### `drill()`

Enables or disables drill mode, which partitions the sketch into face regions
before extruding.

| Parameter | Type | Description |
| --- | --- | --- |
| `value` | `boolean` | `true` to enable (default), `false` to disable. *(optional)* |

### `pick()`

Restricts extrusion to only the sketch regions containing the given points.

| Parameter | Type | Description |
| --- | --- | --- |
| `...points` | [[api/types/point2dlike]][] | 2D points in the sketch plane identifying regions to extrude. *(optional)* |

### `thin()`

```ts
thin(offset: NumberParam): this
thin(offset1: NumberParam, offset2: NumberParam): this
```

Enables thin extrude mode — offsets the profile edges to create a thin-walled solid
instead of extruding filled faces. Positive values offset outward, negative values offset inward.

| Parameter | Type | Description |
| --- | --- | --- |
| `offset1` | `NumberParam` | The first wall offset distance. Positive = outward, negative = inward. |
| `offset2` | `NumberParam` | The second wall offset distance, in the opposite direction of offset1. |

## Inherited

From [[api/types/boolean-operation]]: `add()`, `'new'()`, `remove()`, `scope()`

From [[api/types/scene-object]]: `name()`, `reusable()`
