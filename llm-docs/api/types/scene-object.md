---
id: api/types/scene-object
title: SceneObject
summary: "The SceneObject type. Defines 1 method."
tags: [api, type, interface]
symbols: [SceneObject, ISceneObject]
seeAlso: [api/select, concepts/scene-graph]
---
# SceneObject

```ts
interface SceneObject {
  name(value: string): this;
}
```

## Methods

### `name()`

Sets a custom display name for this object, overriding the default type-based name.

| Parameter | Type | Description |
| --- | --- | --- |
| `value` | `string` | The display name to assign. |
