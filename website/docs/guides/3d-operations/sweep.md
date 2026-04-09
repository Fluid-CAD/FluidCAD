---
sidebar_position: 6
title: "Sweep"
---

# Sweep

`sweep()` moves a profile along a path to create a solid. It's used for pipes, rails, and any shape that follows a curve.

```js
const profile = sketch("top", () => {
    circle(40)
    circle(20)
})

const spine = sketch("front", () => {
    vLine(100)
    tArc(50, 180)
    tArc(80, -270)
})

sweep(spine, profile)
```

The first argument is the path (spine), the second is the profile to sweep. The profile and path should be on different planes.

## Accessing geometry

```js
const s = sweep(spine, profile)

s.endFaces()       // face at the end of the path
s.startFaces()     // face at the start of the path
s.sideFaces()      // the swept surface(s)
s.endEdges()       // edges at the end
s.startEdges()     // edges at the start
s.sideEdges()      // edges along the sides
s.internalFaces()  // internal faces (if profile has holes)
s.internalEdges()  // internal edges
```

## Fusion scope

```js
sweep(spine, profile).new()    // create a separate solid
sweep(spine, profile).add()    // fuse with touching solids (default)
sweep(spine, profile).remove(box)  // subtract the swept shape from the box
```
