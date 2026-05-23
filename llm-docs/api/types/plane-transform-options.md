---
id: api/types/plane-transform-options
title: PlaneTransformOptions
summary: "Options accepted by `plane()` for offsetting and rotating a plane in its own frame."
tags: [api, type, options]
symbols: [PlaneTransformOptions, PlaneRenderableOptions]
seeAlso: [api/plane]
---
# PlaneTransformOptions

```ts
type PlaneTransformOptions = {
  offset?: number;
  rotateX?: number;
  rotateY?: number;
  rotateZ?: number;
};
```

Options accepted by `plane()` to offset and rotate a plane relative to its own axes. Rotations are composed together and applied around the plane's origin (after the offset is applied), so the plane tilts in place rather than orbiting the world origin.

## Properties

| Property | Type | Description |
| --- | --- | --- |
| `offset` | `number` | Distance to translate the plane along its normal *(optional)* |
| `rotateX` | `number` | Rotation around the plane's X axis (in degrees) *(optional)* |
| `rotateY` | `number` | Rotation around the plane's Y axis (in degrees) *(optional)* |
| `rotateZ` | `number` | Rotation around the plane's Z axis / normal (in degrees) *(optional)* |
