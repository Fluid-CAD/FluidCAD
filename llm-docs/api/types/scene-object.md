---
id: api/types/scene-object
title: SceneObject
summary: "The SceneObject type. Defines 2 methods."
tags: [api, type, interface]
symbols: [SceneObject, ISceneObject]
seeAlso: [api/select, concepts/scene-graph]
---
# SceneObject

```ts
interface SceneObject {
  name(value: string): this;
  reusable(): this;
}
```

## Methods

### `name()`

Sets a custom display name for this object, overriding the default type-based name.

| Parameter | Type | Description |
| --- | --- | --- |
| `value` | `string` | The display name to assign. |

### `reusable()`

Keeps this object's shapes in the scene after a feature uses them. A
sketch never needs it to be used twice — a feature hides a sketch from
the screen without taking it away from later features — so on a sketch
it means "stay on screen" (a layout sketch). A selection or a sketch
geometry used by a feature is consumed for good unless marked reusable.
`remove(obj)` takes a reusable object out of the scene.
