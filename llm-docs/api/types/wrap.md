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
  startFaces(...args: (number | FaceFilter)[]): ISelection;
  endFaces(...args: (number | FaceFilter)[]): ISelection;
  startEdges(...args: (number | EdgeFilter)[]): ISelection;
  endEdges(...args: (number | EdgeFilter)[]): ISelection;
  sideFaces(...args: (number | FaceFilter)[]): ISelection;
  sideEdges(...args: (number | EdgeFilter)[]): ISelection;
  internalFaces(...args: (number | FaceFilter)[]): ISelection;
  internalEdges(...args: (number | EdgeFilter)[]): ISelection;
  drill(value?: boolean): this;
  region(...names: string[]): this;
}
```

Extends [[api/types/boolean-operation]].

## Methods

### `startFaces()`

Selects the faces lying on the target surface (the base of the wrap).

**Returns**: `ISelection`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `FaceFilter`)[] | Numeric indices or FaceFilterBuilder instances to filter the selection. *(optional)* |

### `endFaces()`

Selects the raised (or recessed) faces offset from the target surface by the wrap thickness.

**Returns**: `ISelection`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `FaceFilter`)[] | Numeric indices or FaceFilterBuilder instances to filter the selection. *(optional)* |

### `startEdges()`

Selects edges on the base faces of the wrap.

**Returns**: `ISelection`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Numeric indices or EdgeFilterBuilder instances to filter the selection. *(optional)* |

### `endEdges()`

Selects edges on the offset faces of the wrap.

**Returns**: `ISelection`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Numeric indices or EdgeFilterBuilder instances to filter the selection. *(optional)* |

### `sideFaces()`

Selects the wall faces created from the outer boundary of each wrapped region.

**Returns**: `ISelection`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `FaceFilter`)[] | Numeric indices or FaceFilterBuilder instances to filter the selection. *(optional)* |

### `sideEdges()`

Selects edges on the wall faces, excluding edges shared with base/offset faces.

**Returns**: `ISelection`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Numeric indices or EdgeFilterBuilder instances to filter the selection. *(optional)* |

### `internalFaces()`

Selects the wall faces created from holes inside a wrapped region.

**Returns**: `ISelection`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `FaceFilter`)[] | Numeric indices or FaceFilterBuilder instances to filter the selection. *(optional)* |

### `internalEdges()`

Selects edges bounding the hole walls of the wrap.

**Returns**: `ISelection`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...args` | (`number` \| `EdgeFilter`)[] | Numeric indices or EdgeFilterBuilder instances to filter the selection. *(optional)* |

### `drill()`

Enables or disables drill mode, which partitions the sketch into face regions
before wrapping.

| Parameter | Type | Description |
| --- | --- | --- |
| `value` | `boolean` | `true` to enable (default), `false` to disable. *(optional)* |

### `region()`

Restricts wrapping to particular regions of the sketch, by the names
their `region()` declarations gave them. See `IExtrude.region`.

| Parameter | Type | Description |
| --- | --- | --- |
| `...names` | `string`[] | Names of regions the sketch declares. *(optional)* |

## Inherited

From [[api/types/boolean-operation]]: `add()`, `'new'()`, `remove()`, `scope()`

From [[api/types/scene-object]]: `name()`, `reusable()`
