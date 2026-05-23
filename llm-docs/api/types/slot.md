---
id: api/types/slot
title: Slot
summary: "The Slot type. Extends ExtrudableGeometry; adds 2 methods."
tags: [api, type, interface]
symbols: [Slot, ISlot]
seeAlso: [api/slot, api/types/extrudable-geometry]
---
# Slot

```ts
interface Slot extends ExtrudableGeometry {
  centered(value?: boolean): this;
  rotate(angle: number): this;
}
```

Extends [[api/types/extrudable-geometry]].

## Methods

### `centered()`

Controls whether the slot is centered on the current position.
When `true`, the slot is offset backward by half its length.

| Parameter | Type | Description |
| --- | --- | --- |
| `value` | `boolean` | `true` to center, `false` (default) to start from the current position. *(optional)* |

### `rotate()`

Sets the rotation angle of the slot's primary axis.

| Parameter | Type | Description |
| --- | --- | --- |
| `angle` | `number` | Rotation in degrees. |

## Inherited

From [[api/types/geometry]]: `guide()`, `start()`, `end()`, `tangent()`

From [[api/types/scene-object]]: `name()`, `reusable()`
