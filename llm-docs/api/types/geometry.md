---
id: api/types/geometry
title: Geometry
summary: "The Geometry type. Extends SceneObject; adds 5 methods."
tags: [api, type, interface]
symbols: [Geometry, IGeometry]
seeAlso: [api/types/scene-object]
---
# Geometry

```ts
interface Geometry extends SceneObject {
  guide(): this;
  edge(roleOrIndex: string | number, roleIndex?: number): ISelection;
  start(): Vertex;
  end(): Vertex;
  tangent(): Vertex;
}
```

Extends [[api/types/scene-object]].

## Methods

### `guide()`

Marks this sketch geometry as construction geometry. Guide geometries are
excluded from the final sketch output (e.g., extrude, revolve) unless
explicitly included.

### `edge()`

Uniform edge accessor. `edge('body')` selects this feature's edges by
role (optionally disambiguated by role index); `edge(1)` selects by
build-order index over the feature's real edges. Roles: solver lines and
arcs stamp `body`; circles and ellipses `perimeter`; derived-op outputs
carry provenance-specific roles (e.g. fillet arcs).

**Returns**: `ISelection`.

| Parameter | Type | Description |
| --- | --- | --- |
| `roleOrIndex` | `string` \| `number` | A role name, or a build-order edge index. |
| `roleIndex` | `number` | Disambiguates roles that repeat. *(optional)* |

### `start()`

Returns a lazy-evaluated vertex at the start point of this geometry element.

**Returns**: [[api/types/vertex]].

### `end()`

Returns a lazy-evaluated vertex at the end point of this geometry element.

**Returns**: [[api/types/vertex]].

### `tangent()`

Returns a lazy-evaluated vertex representing the tangent direction at the end
of this geometry. Used to determine the direction of subsequent geometry elements.

**Returns**: [[api/types/vertex]].

## Inherited

From [[api/types/scene-object]]: `name()`, `reusable()`
