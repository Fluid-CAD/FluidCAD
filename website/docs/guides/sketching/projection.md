---
sidebar_position: 7
title: "Projection"
---

# Projection

`project()` takes 3D geometry (faces, edges) and projects it onto your current sketch plane. This is useful for creating features that follow the shape of existing geometry.

## Projecting a face

```js
const e = extrude(30)

sketch(e.endFaces(), () => {
    project(e.endFaces())      // project the face outline onto the sketch
    offset(-5, true)           // shrink it inward by 5
})

cut(10)                        // cut a pocket that follows the shape
```

This projects the outline of the top face onto the sketch. Combined with `offset()`, it's a common way to create shell-like features or inset pockets that match an existing profile.

## Projecting edges

You can also project specific edges:

```js
sketch(e.endFaces(), () => {
    project(e.endEdges())      // project just the edges
})
```

## Multiple sources

Pass multiple objects to project them all at once:

```js
sketch("xy", () => {
    project(face1, face2, edge1)
})
```
