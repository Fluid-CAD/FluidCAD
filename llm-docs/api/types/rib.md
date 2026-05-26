---
id: api/types/rib
title: Rib
summary: "The Rib type. Extends BooleanOperation; adds 11 methods."
tags: [api, type, interface]
symbols: [Rib, IRib]
seeAlso: [api/rib, api/types/boolean-operation]
---
# Rib

```ts
interface Rib extends BooleanOperation {
  startFaces(...args: (number | FaceFilter)[]): SceneObject;
  endFaces(...args: (number | FaceFilter)[]): SceneObject;
  sideFaces(...args: (number | FaceFilter)[]): SceneObject;
  capFaces(...args: (number | FaceFilter)[]): SceneObject;
  startEdges(...args: (number | EdgeFilter)[]): SceneObject;
  endEdges(...args: (number | EdgeFilter)[]): SceneObject;
  sideEdges(...args: (number | EdgeFilter)[]): SceneObject;
  capEdges(...args: (number | EdgeFilter)[]): SceneObject;
  draft(value: number | [number, number]): this;
  parallel(): this;
  extend(): this;
}
```

Extends [[api/types/boolean-operation]].

## Methods

### `startFaces()`

Selects faces at the start (base) of the rib — the profile face at the sketch plane.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `FaceFilter`)[] | Numeric indices or FaceFilterBuilder instances to filter the selection. *(optional)* |

### `endFaces()`

Selects faces at the end (top) of the rib — where the rib meets the boundary.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `FaceFilter`)[] | Numeric indices or FaceFilterBuilder instances to filter the selection. *(optional)* |

### `sideFaces()`

Selects the lateral wall faces of the rib.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `FaceFilter`)[] | Numeric indices or FaceFilterBuilder instances to filter the selection. *(optional)* |

### `capFaces()`

Selects the small cap faces at the spine endpoints.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `FaceFilter`)[] | Numeric indices or FaceFilterBuilder instances to filter the selection. *(optional)* |

### `startEdges()`

Selects edges on the start faces.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Numeric indices or EdgeFilterBuilder instances to filter the selection. *(optional)* |

### `endEdges()`

Selects edges on the end faces.

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

### `capEdges()`

Selects edges on the cap faces.

**Returns**: [[api/types/scene-object]].

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Numeric indices or EdgeFilterBuilder instances to filter the selection. *(optional)* |

### `draft()`

Applies a draft (taper) angle to the rib walls.

| Parameter | Type | Description |
| --- | --- | --- |
| `value` | `number` \| `[number, number]` | A single angle for uniform draft, or a `[start, end]` tuple for asymmetric draft. |

### `parallel()`

Switches the extrusion direction to parallel to the sketch plane
(perpendicular to the spine within the plane) instead of normal to it.

### `extend()`

Extends the rib's side faces at the spine endpoints outward to blend
with the target solids' walls.

## Inherited

From [[api/types/boolean-operation]]: `add()`, `'new'()`, `remove()`, `scope()`

From [[api/types/scene-object]]: `name()`, `reusable()`
