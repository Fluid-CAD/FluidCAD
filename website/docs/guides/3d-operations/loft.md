---
sidebar_position: 5
title: "Loft"
---

# Loft

`loft()` creates a smooth transition between two or more sketch profiles on different planes. It's useful for shapes that change cross-section along their length.

```js
import { plane } from 'fluidcad/core';

const s1 = sketch("xy", () => {
    circle(100)
})

const s2 = sketch(plane("xy", { offset: 100 }), () => {
    rect(80).center()
})

loft(s1, s2)                   // smooth shape from circle to square
```

## Multiple profiles

You can loft through more than two profiles:

```js
const s1 = sketch("xy", () => { circle(100) })
const s2 = sketch(plane("xy", { offset: 50 }), () => { rect(60).center() })
const s3 = sketch(plane("xy", { offset: 100 }), () => { circle(40) })

loft(s1, s2, s3)              // circle → square → circle
```

The profiles must be on different planes (typically parallel planes at different offsets).

## Accessing geometry

```js
const l = loft(s1, s2)

l.endFaces()       // face at the last profile
l.startFaces()     // face at the first profile
l.sideFaces()      // the transition surface(s)
l.endEdges()       // edges at the last profile
l.startEdges()     // edges at the first profile
l.sideEdges()      // edges along the sides
```

## Fusion scope

```js
loft(s1, s2).new()             // create a separate solid
loft(s1, s2).add()             // fuse with touching solids (default)
loft(s1, s2).remove(box)       // subtract the lofted shape from the box
```
