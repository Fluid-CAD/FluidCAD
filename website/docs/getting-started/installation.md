---
sidebar_position: 1
title: "Installation"
---

# Installation

FluidCAD is a JavaScript library for building parametric 3D models with code. You write `.fluid.js` files, and FluidCAD renders them in a live 3D viewport that updates as you type.

## Prerequisites

- [Node.js](https://nodejs.org/) version 24 or higher
- npm (comes with Node.js)

## Create a new project

```bash
npm create fluidcad-app@latest my-app
cd my-app
npm install
```

This creates a project with the following structure:

```
my-app/
├── package.json
├── jsconfig.json
└── test.fluid.js      ← your first model
```

:::note
FluidCAD files use the `.fluid.js` extension. The viewer only picks up files with this naming convention.
:::

## The starter file

Open `test.fluid.js` — this is the file that was generated for you:

```js
import { extrude, fillet, shell, sketch } from 'fluidcad/core';
import { circle } from 'fluidcad/core';

sketch("xy", () => {
    circle(50)
})

const e = extrude(50)

shell(-6, e.endFaces())

fillet(5, e.startEdges())
```

Here's what each line does:

1. **`sketch("xy", () => { ... })`** — Starts a 2D sketch on the XY plane (the horizontal plane). Everything inside the callback draws 2D shapes.
2. **`circle(50)`** — Draws a circle with a diameter of 50.
3. **`extrude(50)`** — Takes the sketch and pulls it up 50 units into a 3D solid. We store the result in `e` so we can reference its faces and edges later.
4. **`shell(-6, e.endFaces())`** — Hollows out the solid with a wall thickness of 6, removing the top face (`endFaces()`). The negative value means the shell goes inward.
5. **`fillet(5, e.startEdges())`** — Rounds the bottom edges with a radius of 5.

The result is a small cup-like shape. Next, let's set up your editor so you can see it in 3D.
