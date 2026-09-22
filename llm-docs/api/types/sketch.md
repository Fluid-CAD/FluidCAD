---
id: api/types/sketch
title: Sketch
summary: "The Sketch type. Extends SceneObject; adds 1 method."
tags: [api, type, interface]
symbols: [Sketch, ISketch]
seeAlso: [api/types/scene-object]
---
# Sketch

```ts
interface Sketch extends SceneObject {
  close(): this;
}
```

Extends [[api/types/scene-object]].

## Methods

### `close()`

Marks the sketch finished. The editor stays in sketch mode while the
timeline ends in an open sketch; a closed sketch ends that without a
consuming feature, so a profile can be left unconsumed and the model
still opens as a 3D scene. The Finish Sketch button adds this chain and
removes it again when the sketch is reopened for editing.

## Inherited

From [[api/types/scene-object]]: `name()`, `reusable()`
