---
id: api/sdk-kernel
title: "fluidcad/sdk/kernel — the geometry a custom feature builds with (unstable)"
summary: "The engine's own shape wrappers and operations, exported for custom features' buildTool(): Shape, Solid, Face, Edge, Wire, Vertex, ShapeFactory (raw OpenCascade shapes into wrappers), Primitives (makeCylinder, makeSphere), BooleanOps (cutShapes), ShapeOps (transform, transformTracking, bounding boxes). Unstable: names and signatures will change. Every shape they make is the caller's: what buildTool() returns belongs to the feature, every intermediate you build and drop is freed with dispose(), and a shape read from a reference is never disposed."
tags: [api, sdk, custom-feature, kernel, type]
symbols: [Primitives, BooleanOps, ShapeOps, ShapeFactory, Shape, Solid, Face, Edge, Wire]
seeAlso: [api/feature, api/sdk-occt, concepts/custom-features, concepts/coordinate-system]
---

# fluidcad/sdk/kernel

```ts
import { Primitives, BooleanOps, ShapeOps, ShapeFactory, Shape, Solid, Face, Edge, Wire, Vertex } from 'fluidcad/sdk/kernel';

Primitives.makeCylinder(radius: number, height: number): Solid    // standing on the XY plane, from z = 0 up
Primitives.makeSphere(radius: number, angle: number): Solid       // centred on the origin; angle in radians (2π: whole)
BooleanOps.cutShapes(shape: Shape, tool: Shape): Shape            // a new shape; both inputs stay yours
ShapeOps.transform(shape: Shape, matrix: Matrix4): Shape          // a moved copy
ShapeOps.transformTracking(shape: Shape, matrix: Matrix4, subShapes: T[]): { shape: Shape; images: (T | null)[] }
ShapeOps.getBoundingBox(shape) / ShapeOps.getExactBoundingBox(shape): BoundingBox   // minX … maxZ
ShapeFactory.fromShape(raw: TopoDS_Shape): Shape                  // a raw OpenCascade shape, wrapped by its type

shape.getSubShapes('face'): Face[]      shape.getSubShapes('edge'): Edge[]
shape.getShape(): TopoDS_Shape          // the raw handle (fluidcad/sdk/occt)
shape.dispose()
face.getPlane(): Plane    face.center(): Point    face.calculateNormal(): Vector3d
face.getBoundingBox(): BoundingBox      face.getOuterWire(): Wire | null    face.getHoleWires(): Wire[]
edge.getFirstVertex(): Vertex    edge.getLastVertex(): Vertex    vertex.toPoint(): Point
```

**Unstable.** These are the engine's own kernel classes, exported as they
are so custom features can be written at all. Their names and signatures will
change without notice while the SDK settles. Build on `fluidcad/sdk` and
`fluidcad/math` (`Matrix4`, `Plane`, `Point`, `Vector3d`, `Axis`) wherever
they reach. For anything the curated kernel can't build — a loft, a sweep,
a box, an offset — see raw OpenCascade in [[api/sdk-occt]].

## Building a tool

`buildTool()` (see [[api/feature]]) builds its solids standing on the XY
plane, where sorting their faces into buckets is easy (`z = 0` is the start,
`z = height` the end), then places them with `ShapeOps.transformTracking`
and a frame from `fluidcad/math`:

```js
const frame = Matrix4.fromBasis(plane.xDirection, plane.yDirection, plane.normal, origin);
const placed = ShapeOps.transformTracking(tube, frame, all);   // all = tube.getSubShapes('face')
tube.dispose();
const endFaces = end.map(f => placed.images[all.indexOf(f)]).filter(f => f !== null);
```

`images[i]` is where `subShapes[i]` went in the moved shape, or `null` for one
the shape doesn't hold. The buckets a tool names must be faces and edges of
the shapes it returns: name the images, not the faces of the unplaced shape.

## Who owns what

- **Every shape these functions make belongs to the caller.**
- **A shape `buildTool()` returns belongs to the feature** from then on:
  never dispose it.
- **Dispose every intermediate you build and drop** — the cylinders a cut
  consumed, the shape a transform moved:

  ```js
  const boss = Primitives.makeCylinder(outer / 2, height);
  const bore = Primitives.makeCylinder(hole / 2, height);
  const tube = BooleanOps.cutShapes(boss, bore);
  boss.dispose();
  bore.dispose();
  ```

  A feature builds on every render whose cache misses it, and in the
  dialog's preview on every change, so a leak grows the engine's heap for
  the whole session.
- **Never dispose a shape read from a reference** (`facesOf()`,
  `shapesOf()`, `edgesOf()`): the scene owns it, and the model reads it
  after the feature.
- **The preview** frees whatever `ghost()` returns once it is drawn (a shape
  the scene holds is spared), and the bucket members a preview build
  declared.

## Raw shapes

`shape.getShape()` is a wrapper's raw OpenCascade handle, and
`ShapeFactory.fromShape(raw)` wraps a raw shape by its type (a solid as a
`Solid`, a face as a `Face`, …), as do `Solid.fromTopoDSSolid`,
`Face.fromTopoDSFace`, `Edge.fromTopoDSEdge`, `Wire.fromTopoDSWire` and
`Vertex.fromTopoDSVertex`. Those are the shapes `buildTool()` returns and
`setBuckets()` names. See [[api/sdk-occt]].
