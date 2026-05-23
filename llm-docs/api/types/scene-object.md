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

Marks this object as reusable. Reusable objects retain their shapes when
consumed by features (e.g., extrude, revolve), allowing multiple features
to reference the same source geometry. Use `remove(obj)` to force-remove
shapes from a reusable object.
