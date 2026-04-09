---
sidebar_position: 7
title: "Fillet"
---

# Fillet

`fillet()` rounds edges with a given radius, creating smooth transitions between faces.

```js
const e = extrude(30)
fillet(5, e.endEdges())        // round the top edges, radius 5
fillet(3, e.startEdges())      // round the bottom edges, radius 3
```

## Targeting edges

Pass specific edges as the second argument:

```js
fillet(5, e.endEdges())        // top edges of the extrude
fillet(3, e.sideEdges())       // side edges
fillet(2, c.internalEdges())   // internal edges from a cut
```

## Using the last selection

If you don't specify edges, `fillet()` targets the last `select()` result:

```js
import { select } from 'fluidcad/core';
import { edge } from 'fluidcad/filters';

select(edge().verticalTo("xy"))
fillet(5)                      // fillets the selected vertical edges
```

## 2D fillet

`fillet()` also works inside sketches to round corners between lines:

```js
sketch("xy", () => {
    polygon(5, 100)
    fillet(10)                 // round all corners of the polygon
})
```
