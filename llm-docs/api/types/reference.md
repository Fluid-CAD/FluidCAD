---
id: api/types/reference
title: Reference
summary: "A `project()`/`intersect()` result inside a solved sketch: fixed reference geometry the constraints can target."
tags: [api, type, interface]
symbols: [Reference, IReference]
seeAlso: [api/project-intersect, api/types/extrudable-geometry]
---
# Reference

```ts
interface Reference extends ExtrudableGeometry {
  ref(index: number): ReferenceEntity;
  center(): Vertex;
}
```

A `project()`/`intersect()` result inside a solved sketch: fixed reference
geometry the constraints can target. Passing the reference itself (or its
`center()`) resolves when it produced exactly one constrainable edge;
`.ref(i)` addresses one of several.

Extends [[api/types/extrudable-geometry]].

## Methods

### `ref()`

Constraint target naming projected edge `i` (0-based emitted order).

**Returns**: [[api/types/reference-entity]].

| Parameter | Type | Description |
| --- | --- | --- |
| `index` | `number` |  |

### `center()`

The single projected circle/arc's center point.

**Returns**: [[api/types/vertex]].

## Inherited

From [[api/types/geometry]]: `guide()`, `edge()`, `start()`, `end()`, `tangent()`

From [[api/types/scene-object]]: `name()`, `reusable()`
