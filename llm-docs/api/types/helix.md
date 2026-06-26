---
id: api/types/helix
title: Helix
summary: "A 3D helix wire — a single edge that traces a helix curve on a cylindrical or conical surface."
tags: [api, type, interface]
symbols: [Helix, IHelix]
seeAlso: [api/types/scene-object]
---
# Helix

```ts
interface Helix extends SceneObject {
  pitch(pitch: number): this;
  turns(turns: number): this;
  startOffset(offset: number): this;
  endOffset(offset: number): this;
  height(height: number): this;
  radius(radius: number): this;
  endRadius(radius: number): this;
}
```

A 3D helix wire — a single edge that traces a helix curve on a cylindrical or
conical surface. Used as a path for `sweep()` to produce springs, threads, and
coils.

Created from one of:
- An axis (`AxisLike`): user supplies geometry via chained config.
- A cylindrical or conical face: axis + radii + height derived from the face.
- A line edge: axis = the line, height = line length.
- A circular edge: axis = circle normal, radius = circle radius.

Extends [[api/types/scene-object]].

## Methods

### `pitch()`

Axial rise per turn (distance along the helix axis covered per full revolution).
If unset, derived from `height / turns`.

| Parameter | Type | Description |
| --- | --- | --- |
| `pitch` | `number` |  |

### `turns()`

Number of full turns. Fractional values are allowed. Default 1.

| Parameter | Type | Description |
| --- | --- | --- |
| `turns` | `number` |  |

### `startOffset()`

Shifts the start of the helix along its axis, in axial mm. Positive values
trim the start (move it toward the end); negative values extend it. Default 0.

| Parameter | Type | Description |
| --- | --- | --- |
| `offset` | `number` |  |

### `endOffset()`

Extends (positive) or trims (negative) the helix at its end, in axial mm.
Default 0.

| Parameter | Type | Description |
| --- | --- | --- |
| `offset` | `number` |  |

### `height()`

Total axial height. Overrides face/edge-derived height when set. For line-edge
input, defaults to the line length. For circular-edge / pure-axis input,
defaults to 50 if neither this nor `pitch * turns` determine it.

| Parameter | Type | Description |
| --- | --- | --- |
| `height` | `number` |  |

### `radius()`

Start radius. Defaults to 20 for axis/line-edge input. For a cylindrical
face input, defaults to the face's radius and may be overridden (useful for
sweep/fuse workflows where the helix tube must overlap the cylinder
volumetrically — offset by ~1mm to avoid pure tangency). Ignored on
conical face input (radius is derived from face geometry).

| Parameter | Type | Description |
| --- | --- | --- |
| `radius` | `number` |  |

### `endRadius()`

End radius — when different from `radius()`, produces a conical helix.
Defaults to `radius()`. Ignored on face/circle inputs.

| Parameter | Type | Description |
| --- | --- | --- |
| `radius` | `number` |  |

## Inherited

From [[api/types/scene-object]]: `name()`, `reusable()`
