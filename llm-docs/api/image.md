---
id: api/image
title: image(src, options)
summary: Places a reference picture (a drawing, photo or scan) on the sketch plane for tracing; an editor-only statement inside the sketch callback with its own timeline row and no geometry.
tags: [api, 2d, sketch, image]
symbols: [image]
seeAlso: [api/sketch, api/region]
---

# image

Imported from `fluidcad/core`. Written inside a sketch callback.

```ts
image(src: string, options: SketchImageOptions)
```

`image()` puts a picture on the sketch plane — something to trace. The
editor draws it faded, under the sketch's own lines, wherever the sketch
is shown, and hides it with the lines once a feature consumes the sketch.
It has no geometry: nothing profiles, solves or consumes it. It is a
statement of its own, so it has its own timeline row under the sketch;
double-clicking that row reopens the picture for editing. `src` is a path
relative to the model file (png, jpeg, webp, gif or bmp). The sketch
toolbar's Image tool copies the file to `images/` beside the model and
writes the statement first in the sketch body.

```fluid.js
import { circle, image, origin, sketch } from "fluidcad/core";
import { coincident, diameter } from "fluidcad/constraints";

sketch("xy", () => {
  image("images/side-view.png", { width: 120, at: [10, 0], angle: 0, opacity: 0.4 });
  const c = circle([0, 0], 40);
  coincident(c.center(), origin());
  diameter(c, 40);
});
```

| option    | meaning                                                                  | default |
|-----------|--------------------------------------------------------------------------|---------|
| `width`   | the picture's width on the plane, document units                         | —       |
| `height`  | its height; one of the two is enough (the other follows the pixel aspect), both stretch | from aspect |
| `at`      | sketch-plane position of the picture's centre                            | `[0, 0]` |
| `angle`   | rotation about the plane normal, degrees counter-clockwise               | `0`     |
| `opacity` | 0 (invisible) … 1 (solid)                                                | `0.5`   |

The size is how a known dimension scales the picture: give the real width
(or height) of what it shows. A sketch can hold several pictures (a front
and a side view, say). A missing size, a non-positive one, an opacity
outside 0…1, a malformed `at` or a call outside a sketch body is the
statement's own build error; the sketch around it still builds.
