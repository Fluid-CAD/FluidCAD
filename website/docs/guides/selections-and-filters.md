---
sidebar_position: 3
title: "Selections and Filters"
---

# Selections and Filters

Fillet, chamfer, shell, and color all need you to tell them *which* edges or faces to target. FluidCAD gives you two ways to do that: direct selection from operations, and filter-based selection.

## Direct selection

When you call `extrude()`, `cut()`, or other operations, the returned object lets you pick specific faces and edges:

```js
const e = extrude(30)

fillet(5, e.endEdges())        // top edges
fillet(3, e.startEdges())      // bottom edges
shell(-4, e.endFaces())        // remove top face and hollow
color("blue", e.sideFaces())   // color the sides
```

You can also select by index when there are multiple faces or edges:

```js
e.sideFaces(0)                 // the first side face
e.sideFaces(2)                 // the third side face
```

## The select function

For more control, use `select()` with filters from `fluidcad/filters`:

```js
import { select } from 'fluidcad/core';
import { edge, face } from 'fluidcad/filters';

select(edge().verticalTo("xy"))
fillet(3)
```

`select()` finds all matching geometry in the scene. The next operation (fillet, chamfer, color, etc.) automatically uses that selection.

## Edge filters

Import `edge` from `fluidcad/filters` and chain filter methods:

```js
import { edge } from 'fluidcad/filters';
```

### By direction

```js
edge().verticalTo("xy")        // edges perpendicular to the XY plane
edge().parallelTo("xz")        // edges parallel to the XZ plane
```

### By position

```js
edge().onPlane("xy", 30)       // edges that lie on the XY plane at height 30
edge().onPlane("yz", 50, true) // edges on YZ plane at offset 50 (approximate match)
```

### By shape

```js
edge().circle()                // circular edges
edge().arc()                   // arc-shaped edges
edge().line()                  // straight edges
```

### Negation

```js
edge().notOnPlane("xy", 0)     // edges NOT on the ground plane
edge().notCircle()             // edges that aren't circular
```

## Face filters

Import `face` from `fluidcad/filters` and chain filter methods:

```js
import { face } from 'fluidcad/filters';
```

### By direction

```js
face().parallelTo("xy")        // faces parallel to the XY plane (top/bottom faces)
face().parallelTo("xz")        // faces parallel to the XZ plane (front/back faces)
```

### By position

```js
face().onPlane("xy", 30)       // faces on the XY plane at height 30
```

### By shape

```js
face().circle()                // circular (flat round) faces
face().cylinder()              // cylindrical faces
face().cone()                  // conical faces
```

### Negation

```js
face().notOnPlane("xy", 0)     // faces NOT on the ground plane
face().notCircle()             // non-circular faces
```

## Using selections

### With fillet and chamfer

```js
select(edge().onPlane("xy", 30))
fillet(5)                      // fillets the selected edges

select(edge().verticalTo("xy"))
chamfer(2)                     // chamfers vertical edges
```

### With shell

```js
select(face().onPlane("xy", 30))
shell(-3)                      // removes selected face and hollows the solid
```

### With color

```js
select(face().circle())
color("red")                   // colors all circular faces red

select(face().parallelTo("xy"))
color("#3498db")               // hex colors work too
```

### Passing directly

You can also pass filters directly to operations without calling `select()` first:

```js
fillet(5, e.endEdges())                    // direct from operation
fillet(5, e.sideFaces(face().cylinder()))   // filter within direct selection
```

## Example: selective filleting

Fillet only the vertical edges of a box, then color the top:

```js
import { sketch, extrude, fillet, select, color } from 'fluidcad/core';
import { rect } from 'fluidcad/core';
import { edge, face } from 'fluidcad/filters';

sketch("xy", () => {
    rect(80, 60).center()
})

const e = extrude(40)

// Round only the vertical edges
select(edge().verticalTo("xy"))
fillet(8)

// Color the top face
select(face().onPlane("xy", 40))
color("steelblue")
```
