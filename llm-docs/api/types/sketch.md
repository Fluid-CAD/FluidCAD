---
id: api/types/sketch
title: Sketch
summary: "The Sketch type. Extends SceneObject; adds 2 methods."
tags: [api, type, interface]
symbols: [Sketch, ISketch]
seeAlso: [api/types/scene-object]
---
# Sketch

```ts
interface Sketch extends SceneObject {
  close(): this;
  image(src: string, options: SketchImageOptions): this;
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

### `image()`

Attaches a reference picture the editor draws on the sketch plane, faded
and under the sketch's own lines, whenever this sketch is edited — a
drawing, photo or scan to trace. `src` is a path relative to the model
file; `options` size it on the plane in document units (`width` and/or
`height` — one is enough, the other follows the picture's aspect),
place its centre (`at`, default `[0, 0]`), turn it (`angle`, degrees,
default 0) and set how solid it draws (`opacity`, 0…1, default 0.5).
Editor metadata only: geometry, solving and consumption are untouched.
The sketch toolbar's Image tool writes and edits this chain.

| Parameter | Type | Description |
| --- | --- | --- |
| `src` | `string` | Image file path, relative to the model file (png, jpeg, webp, gif, bmp). |
| `options` | `SketchImageOptions` | Size, position, rotation and opacity on the plane. |

## Inherited

From [[api/types/scene-object]]: `name()`
