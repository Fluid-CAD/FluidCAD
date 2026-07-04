---
id: api/types/loft
title: Loft
summary: "The Loft type. Extends BooleanOperation; adds 14 methods."
tags: [api, type, interface]
symbols: [Loft, ILoft]
seeAlso: [api/loft, api/types/boolean-operation]
---
# Loft

```ts
interface Loft extends BooleanOperation {
  guides(...guides: SceneObject[]): this;
  startCondition(type: LoftConditionType, magnitude?: NumberParam): this;
  endCondition(type: LoftConditionType, magnitude?: NumberParam): this;
  startFaces(...args: (number | FaceFilter)[]): SceneObject;
  endFaces(...args: (number | FaceFilter)[]): SceneObject;
  sideFaces(...args: (number | FaceFilter)[]): SceneObject;
  startEdges(...args: (number | EdgeFilter)[]): SceneObject;
  endEdges(...args: (number | EdgeFilter)[]): SceneObject;
  sideEdges(...args: (number | EdgeFilter)[]): SceneObject;
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

### `guides()`

Adds side guide curves (rails) the loft surface must follow. Supports one
or two guides in total; a single argument may carry several separate
curves (e.g. a sketch holding a curve and its mirror) — each connected
chain counts as one guide. Every guide must pass through every profile.
Cannot be combined with start/end conditions or thin mode.

| Parameter | Type | Description |
| --- | --- | --- |
| `...guides` | [[api/types/scene-object]][] | Sketches or edges forming the guide curves. *(optional)* |

### `startCondition()`

Constrains how the surface leaves the first profile.

| Parameter | Type | Description |
| --- | --- | --- |
| `type` | `LoftConditionType` | `'none'`, `'normal'` or `'tangent'` — see LoftConditionType. |
| `magnitude` | `NumberParam` | Scales the takeoff strength; defaults to 1. Negative values flip the direction (e.g. inward instead of outward for `'tangent'`). *(optional)* |

### `endCondition()`

Constrains how the surface arrives at the last profile.

| Parameter | Type | Description |
| --- | --- | --- |
| `type` | `LoftConditionType` | `'none'`, `'normal'` or `'tangent'` — see LoftConditionType. |
| `magnitude` | `NumberParam` | Scales the arrival strength; defaults to 1. Negative values flip the direction (e.g. inward instead of outward for `'tangent'`). *(optional)* |

### `startFaces()`

Selects faces on the first profile plane of the loft.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `FaceFilter`)[] | Numeric indices or FaceFilterBuilder instances to filter the selection. *(optional)* |

### `endFaces()`

Selects faces on the last profile plane of the loft.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `FaceFilter`)[] | Numeric indices or FaceFilterBuilder instances to filter the selection. *(optional)* |

### `sideFaces()`

Selects the lateral faces generated between loft profiles.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `FaceFilter`)[] | Numeric indices or FaceFilterBuilder instances to filter the selection. *(optional)* |

### `startEdges()`

Selects edges on the first profile plane of the loft.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Numeric indices or EdgeFilterBuilder instances to filter the selection. *(optional)* |

### `endEdges()`

Selects edges on the last profile plane of the loft.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Numeric indices or EdgeFilterBuilder instances to filter the selection. *(optional)* |

### `sideEdges()`

Selects edges on the side faces, excluding edges shared with start/end faces.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Numeric indices or EdgeFilterBuilder instances to filter the selection. *(optional)* |

### `thin()`

```ts
thin(offset: NumberParam): this
thin(offset1: NumberParam, offset2: NumberParam): this
```

Enables thin loft mode — offsets the profile edges of each section to create a
thin-walled shell instead of lofting filled faces. All profiles must be sketches
and share the same topology. Positive values offset outward, negative offsets inward.

| Parameter | Type | Description |
| --- | --- | --- |
| `offset1` | `NumberParam` | The first wall offset distance. Positive = outward, negative = inward. |
| `offset2` | `NumberParam` | The second wall offset distance, in the opposite direction of offset1. |

### `internalFaces()`

Selects faces created inside the solid during loft (e.g., the inner
wall of a thin-walled loft from closed profiles).

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `FaceFilter`)[] | Numeric indices or FaceFilterBuilder instances to filter the selection. *(optional)* |

### `internalEdges()`

Selects edges bounding the internal geometry created during loft.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Numeric indices or EdgeFilterBuilder instances to filter the selection. *(optional)* |

### `capFaces()`

Selects the cap faces at the open ends of a thin-walled loft from open profiles.
These are the small faces connecting the inner and outer walls at the profile endpoints.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `FaceFilter`)[] | Numeric indices or FaceFilterBuilder instances to filter the selection. *(optional)* |

### `capEdges()`

Selects edges on the cap faces of a thin-walled loft from open profiles.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Numeric indices or EdgeFilterBuilder instances to filter the selection. *(optional)* |

## Inherited

From [[api/types/boolean-operation]]: `add()`, `'new'()`, `remove()`, `scope()`

From [[api/types/scene-object]]: `name()`, `reusable()`
