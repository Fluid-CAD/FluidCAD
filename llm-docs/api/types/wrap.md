---
id: api/types/wrap
title: Wrap
summary: "The Wrap type. Extends BooleanOperation; adds 10 methods."
tags: [api, type, interface]
symbols: [Wrap, IWrap]
seeAlso: [api/types/boolean-operation]
---
# Wrap

```ts
interface Wrap extends BooleanOperation {
  startFaces(...args: (number | FaceFilter)[]): SceneObject;
  endFaces(...args: (number | FaceFilter)[]): SceneObject;
  startEdges(...args: (number | EdgeFilter)[]): SceneObject;
  endEdges(...args: (number | EdgeFilter)[]): SceneObject;
  sideFaces(...args: (number | FaceFilter)[]): SceneObject;
  sideEdges(...args: (number | EdgeFilter)[]): SceneObject;
  internalFaces(...args: (number | FaceFilter)[]): SceneObject;
  internalEdges(...args: (number | EdgeFilter)[]): SceneObject;
  drill(value?: boolean): this;
  pick(...points: Point2DLike[]): this;
}
```

Extends [[api/types/boolean-operation]].

## Methods

### `startFaces()`

Selects the faces lying on the target surface (the base of the wrap).

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `FaceFilter`)[] | Numeric indices or FaceFilterBuilder instances to filter the selection. *(optional)* |

### `endFaces()`

Selects the raised (or recessed) faces offset from the target surface by the wrap thickness.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `FaceFilter`)[] | Numeric indices or FaceFilterBuilder instances to filter the selection. *(optional)* |

### `startEdges()`

Selects edges on the base faces of the wrap.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Numeric indices or EdgeFilterBuilder instances to filter the selection. *(optional)* |

### `endEdges()`

Selects edges on the offset faces of the wrap.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Numeric indices or EdgeFilterBuilder instances to filter the selection. *(optional)* |

### `sideFaces()`

Selects the wall faces created from the outer boundary of each wrapped region.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `FaceFilter`)[] | Numeric indices or FaceFilterBuilder instances to filter the selection. *(optional)* |

### `sideEdges()`

Selects edges on the wall faces, excluding edges shared with base/offset faces.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Numeric indices or EdgeFilterBuilder instances to filter the selection. *(optional)* |

### `internalFaces()`

Selects the wall faces created from holes inside a wrapped region.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `FaceFilter`)[] | Numeric indices or FaceFilterBuilder instances to filter the selection. *(optional)* |

### `internalEdges()`

Selects edges bounding the hole walls of the wrap.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Numeric indices or EdgeFilterBuilder instances to filter the selection. *(optional)* |

### `drill()`

Enables or disables drill mode, which partitions the sketch into face regions
before wrapping.

| Parameter | Type | Description |
| --- | --- | --- |
| `value` | `boolean` | `true` to enable (default), `false` to disable. *(optional)* |

### `pick()`

Restricts wrapping to only the sketch regions containing the given points.

| Parameter | Type | Description |
| --- | --- | --- |
| `...points` | [[api/types/point2dlike]][] | 2D points in the sketch plane identifying regions to wrap. *(optional)* |

## Inherited

From [[api/types/boolean-operation]]: `add()`, `'new'()`, `remove()`, `scope()`

From [[api/types/scene-object]]: `name()`, `reusable()`
