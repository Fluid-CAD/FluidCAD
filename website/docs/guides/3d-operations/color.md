---
sidebar_position: 12
title: "Color"
---

# Color

`color()` applies a color to faces or entire solids:

```js
import { color, select } from 'fluidcad/core';
import { face } from 'fluidcad/filters';

// Color specific faces
select(face().circle())
color("red")

// Color faces from an operation
const e = extrude(30)
color("orange", e.endFaces())
```

`color()` accepts named CSS colors (`"red"`, `"steelblue"`, `"tomato"`) and hex values (`"#e74c3c"`, `"#2ecc71"`).

## Color with selection

```js
select(face().parallelTo("xy"))
color("#3498db")               // color all horizontal faces

select(face().cylinder())
color("silver")                // color cylindrical faces
```

:::warning[Color is fragile]
Any operation that modifies the shape after coloring will remove the color. This means `color()` should be the **last operation** you apply to a shape — after all fillets, chamfers, booleans, and other modifications are done.

```js
const e = extrude(30)
fillet(5, e.endEdges())        // modify first
color("blue", e.endFaces())   // color last ✅

// ❌ Don't do this — the fillet will remove the color:
// color("blue", e.endFaces())
// fillet(5, e.endEdges())
```

This behavior will be improved in future versions.
:::
