---
sidebar_position: 8
title: "Chamfer"
---

# Chamfer

`chamfer()` bevels edges with a flat cut, creating angled transitions between faces.

```js
const e = extrude(30)
chamfer(3, e.endEdges())       // 3-unit chamfer on top edges
```

## Asymmetric chamfer

Specify two distances for an uneven bevel:

```js
chamfer(3, 5, e.endEdges())    // 3 units on one side, 5 on the other
```

## Targeting edges

Works the same way as fillet — pass specific edges or use the last selection:

```js
// Direct
chamfer(2, e.sideEdges())

// With select
import { select } from 'fluidcad/core';
import { edge } from 'fluidcad/filters';

select(edge().onPlane("xy", 30))
chamfer(4)
```
