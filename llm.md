# FluidCAD — LLM Reference

> Self-contained reference for LLM agents writing FluidCAD scripts (`.fluid.js`).
> Source of truth for signatures is `website/docs/api/`. When this doc and the codebase disagree, trust the codebase.

FluidCAD is a JavaScript CAD library built on OpenCascade (B-Rep modeling kernel, via opencascade.js WASM). Users write `.fluid.js` files that build precise 3D solids. The runtime watches files and re-runs them on save; you do **not** call any `init()` from script code — just write top-level statements.

---

## Table of Contents

1. [Mental Model](#1-mental-model)
2. [Imports & Modules](#2-imports--modules)
3. [Core Concepts](#3-core-concepts)
4. [Sketching (2D)](#4-sketching-2d)
5. [3D Operations](#5-3d-operations)
6. [Selections & Filters](#6-selections--filters)
7. [Transforms & Patterns](#7-transforms--patterns)
8. [Reference Geometry](#8-reference-geometry)
9. [Utilities](#9-utilities)
10. [Idiomatic Patterns (Cookbook)](#10-idiomatic-patterns-cookbook)
11. [Common Mistakes & Footguns](#11-common-mistakes--footguns)
12. [Quick API Cheatsheet](#12-quick-api-cheatsheet)

---

## 1. Mental Model

### The core workflow

```
sketch (2D)  →  3D operation  →  modify  →  pattern / transform
```

Every model starts with a flat sketch on a plane. A 3D op (extrude, cut, revolve, sweep, loft) turns the sketch into a solid. Modifiers (fillet, chamfer, shell, draft) refine it. Patterns/transforms (repeat, copy, translate, rotate, mirror) replicate or move things.

### File format

- Filename: `box.fluid.js` (any name, `.fluid.js` extension).
- The runtime evaluates the script top-to-bottom. There is no `main()` and no `init()`.
- Statements execute in order; later operations see the geometry produced by earlier ones.
- The viewport re-renders on save (or live in some editors).

### Units

- No unit declaration. Numbers are unitless; **convention is millimeters**.
- Angles are in **degrees** wherever the API takes an angle. (Exception: `Matrix4` raw rotations use radians, but you almost never reach for those.)

### Smart defaults

These three rules make scripts terse:

1. **Last sketch is auto-picked.** `extrude(30)` extrudes the most recent sketch with no target argument.
2. **Last selection is auto-picked.** `fillet(5)` fillets whatever `select(...)` (or a `.endEdges()` accessor) produced just before.
3. **Touching solids auto-fuse.** Two extrusions that overlap merge into one solid unless you chain `.new()`.

When you need to be explicit, every operation accepts the target as a trailing argument.

### Act like a CAD designer, not a calculator

This is the single most important principle when writing FluidCAD. A CAD designer expresses **design intent** — "tangent to this circle," "centered on this face," "midway between these two planes," "perpendicular to this edge" — and lets the kernel solve the geometry. Computing coordinates by hand is the wrong default: it's brittle, opaque, hard to reparametrize, and almost always reinvents something FluidCAD already does precisely.

**Do not perform geometric calculations yourself when an API call exists.** The OpenCascade kernel is a precision B-Rep engine: it computes tangencies, intersections, midpoints, draft surfaces, offsets, projections, and rotations to floating-point accuracy. Your JavaScript math, by contrast, accumulates error, hides intent, and breaks the moment a parameter changes.

This applies to:

- **Trigonometry** — `Math.cos`, `Math.sin`, `Math.atan2`, manual angle conversions
- **Position arithmetic** — adding offsets, computing midpoints, distributing items along a span
- **Geometric intersections** — finding where a line meets a circle, where two arcs cross
- **Tangent points & tangent angles** — between two circles, between a line and an arc
- **Mirror coordinates** — flipping signs to model the other half
- **Polygon vertex coordinates** — `[r*cos(θ), r*sin(θ)]` for n sides
- **Rotation matrices and quaternions** — composing arbitrary transforms by hand

Whenever you reach for a calculator, stop and look for the FluidCAD primitive that expresses what you actually mean.

### Let the API do the math

Concrete substitutions. The left column is the trap; the right column is the idiomatic CAD-designer move.

| Don't compute… | Use instead |
|---|---|
| `[r*Math.cos(a), r*Math.sin(a)]` for a point at angle/radius | `pMove(r, angle)` — polar move relative to the current tangent |
| Cursor position after a turn | `rMove(angle)` to rotate the tangent, then draw |
| Endpoint of a horizontal segment as `[x + d, y]` | `hLine(d)` (or `hLine(target)` to land on an existing geometry) |
| Endpoint of a vertical segment | `vLine(d)` / `vLine(target)` |
| Where a line at angle `θ` hits another geometry | `aLine(angle, target)` — solver finds the intersection |
| Cursor X to reach a target | `hMove(target)` (similarly `vMove(target)`, `pMove(target, angle)`) |
| Tangent line endpoints between two circles | `tLine(outside(c1), outside(c2))` — then read `.start()` / `.end()` |
| Tangent arc between objects, points, or after a line | `tArc(...)` — handles every "continue tangent" case |
| A circle tangent to two others / through two points | `tCircle(...)` with qualifiers (`outside` / `enclosing` / `enclosed`) |
| Where a fillet arc would sit between two lines | `tArc(line1, line2, r)` or 2D `fillet(geometries, r)` |
| Polygon corner coordinates | `polygon(n, diameter, mode)` — `'inscribed'` or `'circumscribed'` |
| Stadium-shape end-cap arcs | `slot(length, radius)` |
| Slot-end positions or rotation by hand | `slot(...).centered()` or `slot(...).rotate(angle)` |
| Ellipse parametric points | `ellipse(rx, ry)` |
| Offset wire of an outline | `offset(distance)` (chain `.close()` for open profiles) |
| Cross-section of a 3D shape with a plane | `intersect(...3dObjects)` inside `sketch(plane, () => ...)` |
| Projection of 3D edges onto a plane | `project(...3dObjects)` inside a sketch |
| Tapered extrusion side surfaces | `extrude(d).draft(angle)` (or `.draft([start, end])`) |
| Two-distance asymmetric extrude | `extrude(d1, d2)` (no manual translate of half-extrudes) |
| Mirror across a plane by negating coords | `mirror(plane, ...objs)` / `repeat("mirror", plane, feature)` / 2D `mirror("x")` |
| Both sides of a symmetric extrusion | `.symmetric()` on the extrude/cut/revolve |
| Coordinates for N items evenly spaced | `repeat("linear", axis, { count: N, length: span })` |
| Coordinates for N items around a circle | `repeat("circular", axis, { count: N, angle: 360 })` |
| Centering a pattern around the original | `{ count, offset, centered: true }` |
| The midplane between two planes | `plane(p1, p2)` |
| The midaxis between two axes | `axis(a1, a2)` |
| A plane offset along its normal | `plane(planeLike, offset)` |
| A plane offset *and* rotated | `plane(planeLike, { offset, rotateX, rotateY, rotateZ })` |
| An axis in a sketch's local frame | `local('x' \| 'y' \| 'z')` |
| Selecting "the cylindrical face of diameter D" | `select(face().cylinder(D))` |
| Selecting "edges on the top face" | `e.endEdges()` or `edge().onPlane("xy", h)` |
| Selecting "vertical edges of a box" | `edge().verticalTo("xy")` |
| Selecting faces above/below a cut plane | `face().above(plane)` / `face().below(plane)` |
| Inner wall faces of a shelled solid | `s.internalFaces()` |
| Inner edges of a cut pocket | `c.internalEdges()` |
| Coordinates of a rectangle's edges | `r.topEdge()`, `.bottomEdge()`, `.leftEdge()`, `.rightEdge()` |
| Coordinates of a polygon vertex/edge | `p.getVertex(i)`, `p.getEdge(i)` |
| A "thin-walled" extrude by subtracting two extrusions | `extrude(d).thin(-t)` (or `.thin(o1, o2)` for two-sided) |
| A hollow shell by subtracting an inset solid | `shell(thickness, faceToRemove)` |
| Manually loop to make N pockets / bosses | `repeat("linear" \| "circular" \| ..., ..., featureRef)` |

**Rule of thumb:** if you find yourself writing `Math.`, computing a `* 2` or `/ 2`, or constructing a coordinate that *describes a geometric relationship* (tangency, intersection, symmetry, midpoint, even distribution), stop and pick the API primitive that describes the relationship directly.

### CAD design best practices

A few habits that keep models robust and editable:

1. **Parametrize at the top.** Declare named constants (`const width = 100`, `const wallThickness = 2.5`) before the geometry. Reuse them everywhere — never sprinkle raw magic numbers.
2. **Model design intent, not coordinates.** A boss is "centered on this face," not "at (50, 30, 0)." Use `.centered()`, `sketch(face, ...)`, `select(face().planar().onPlane(...))`, and constrained geometry to encode that intent.
3. **Build incrementally.** Each statement should produce a recognizable feature. Save references with `const` so later operations can refer back via `.endFaces()`, `.startEdges()`, etc.
4. **Prefer filters and direct accessors over indices.** `select(face().cylinder(20))` survives geometry changes; `e.sideFaces(3)` may not.
5. **Express symmetry once.** Model one half, then `mirror` or `repeat("mirror", ...)`. Don't write two near-duplicate halves.
6. **Use `repeat()` for feature patterns and `copy()` for shape duplication.** Re-evaluating a feature at N positions is fundamentally different from cloning the finished shape; pick the one that matches your intent ([§7.4](#74-copy-vs-repeat--when-to-use-which)).
7. **Use `part()` for assemblies.** Stronger than `.new()` — it isolates an entire component so its internal modeling never leaks into neighbors.
8. **Name important features** with `.name("...")` so the history panel is readable when debugging.
9. **Capture references close to creation.** Edges and face geometry become stale after the next modifying op; capture and use them right away ([§3.7](#37-stale-references)).
10. **Reuse sketches with `.reusable()` + `remove()`** when one profile drives two features at different heights, rather than redrawing.
11. **Resist the urge to early-optimize.** A clear, sequential script that names its steps is easier to edit later than a clever one with computed offsets.

When a problem feels like it needs trigonometry, that's almost always a signal that you've missed an API primitive. Re-read [§4.4](#44-constrained--cursor-relative-geometry) (constrained geometry), [§6](#6-selections--filters) (filters), and [§8](#8-reference-geometry) (reference geometry) — the answer is usually there.

### Consumption

Most features **consume** their input objects: an `extrude()` removes the sketch from the scene afterward, a `shell()` consumes the face selection it used, and so on. Mark inputs `.reusable()` if you want them to survive for another feature.

### What a minimal script looks like

```js
import { sketch, extrude, fillet, shell } from 'fluidcad/core';
import { rect } from 'fluidcad/core';

sketch("xy", () => {
    rect(100, 60).centered().radius(8)
})

const box = extrude(30)

fillet(3, box.startEdges())
shell(-2, box.endFaces())
```

That builds a rounded open-top container. No `await`, no setup, no exports — just statements.

---

## 2. Imports & Modules

FluidCAD exposes three import paths:

```js
import { /* features */ } from 'fluidcad/core';
import { face, edge } from 'fluidcad/filters';
import { outside, enclosed, enclosing, unqualified } from 'fluidcad/constraints';
```

| Module | Contents |
|--------|----------|
| `fluidcad/core` | Every operation: 2D primitives, 3D ops, transforms, booleans, `select`, `color`, `remove`, `load`, `axis`, `plane`, `local`, `part`. Also `Matrix4` etc. |
| `fluidcad/filters` | `face()` and `edge()` filter builders for use with `select()` and direct accessors like `e.sideFaces(face().cylinder())`. |
| `fluidcad/constraints` | `outside()`, `enclosed()`, `enclosing()`, `unqualified()` qualifiers for `tLine`/`tArc`/`tCircle`. |

You can import everything you need on a single line per module. There is no global state to initialize.

---

## 3. Core Concepts

### 3.1 Sketches

A sketch is a 2D drawing on a plane. The callback runs in a special context where 2D primitive functions (`rect`, `circle`, `line`, ...) automatically register geometry on that plane.

```js
sketch("xy", () => {
    rect(100, 60).centered()
    circle([30, 0], 10)
})
```

**Sketch plane** can be:
- A standard-plane string: `"xy"`/`"top"`, `"xz"`/`"front"`, `"yz"`/`"right"`, plus `"-xy"`/`"bottom"`, `"-xz"`/`"back"`, `"-yz"`/`"left"`.
- A `Plane` object from `plane(...)` (custom offset/rotation).
- A face from a previous 3D op: `sketch(e.endFaces(), () => ...)`.

When you sketch on a face, the cursor starts at the **center of the face**. Use `move([0,0])` if you need the face's origin instead.

**Outside a sketch:** most 2D primitives accept the plane as the first argument, equivalent to wrapping them in `sketch(plane, () => ...)`:

```js
circle("xy", 50)
rect("front", 100, 60)
```

This is convenient for single-shape sketches.

### 3.2 The current position (cursor)

Inside a sketch, FluidCAD tracks a **current position** (orange dot in the viewport) and a **current tangent** (orange arrow). Drawing commands start from the cursor; movement commands reposition it without drawing.

- `move([x, y])` — absolute move
- `hMove(d)` / `vMove(d)` — relative horizontal/vertical move
- `rMove(angle)` — rotate the tangent direction
- `pMove(r, angle)` — polar move
- `center()` — move to plane origin

This makes long chains of connected geometry (lines, arcs) read naturally.

### 3.3 How sketch faces are built

When a sketch is consumed by extrude/cut/revolve/etc., its 2D geometry is converted into faces:

- **Overlapping closed shapes auto-fuse** into one combined face.
- **Closed shapes inside other closed shapes become holes** (rings, mounting holes, pockets).
- **Open or unclosed geometry is ignored** when building faces (still useful as `.guide()`).

To make an inner shape solid instead of a hole, chain `.drill(false)` on the operation.

### 3.4 Consumption & `.reusable()`

By default, the input to an operation is consumed:
- `extrude(sketch)` removes the sketch's geometry after extruding.
- `shell(thickness, faces)` consumes the face selection.

Mark an input as `.reusable()` to keep it alive for the next feature:

```js
const profile = sketch("xy", () => { circle(60) }).reusable();
extrude(20);                 // first extrude consumes nothing because sketch is reusable
extrude(50);                 // works again — sketch is still there
remove(profile);             // explicit cleanup when you're done
```

`.reusable()` is also useful on individual geometries inside a sketch (so one of several shapes survives), and on selections.

### 3.5 Auto-fusion & boolean scope

Additive ops (extrude with no `.new()`, revolve, loft, sweep) fuse with **every** touching solid by default. Subtractive ops (`cut`, `.remove()`) subtract from every intersecting solid.

Control with these chain methods on the operation result:

- `.add()` — fuse with all touching solids (default).
- `.new()` — keep as a separate, standalone solid.
- `.remove()` — subtract from all intersecting solids.
- `.scope(...objects)` — narrow `.add()` or `.remove()` to specific targets.

```js
const box = extrude(30)

sketch("xy", () => { circle(20) })
extrude(50).new()                  // standalone — doesn't merge with box

sketch("xy", () => { circle(10) })
cut().remove().scope(box)          // cut only from box, not from other solids
```

Use `part()` for stronger isolation (see [§9.1](#91-part)).

### 3.6 Selecting subgeometry

Two ways to pick faces/edges:

**Direct accessors on operation results** — quickest, most stable. Each 3D op exposes methods to grab named regions:

```js
const e = extrude(30)
e.startFaces()   // bottom face(s)
e.endFaces()     // top face(s)
e.sideFaces()    // lateral face(s)
e.startEdges()   // edges around the bottom
e.endEdges()     // edges around the top
e.sideEdges()    // edges on the side faces only
e.internalFaces()  // faces created inside the solid (e.g., from a hole)
e.internalEdges()
e.sideFaces(0)            // first side face by index
e.sideFaces(face().cylinder())  // filter within direct accessor
```

**Filter-based with `select()`** — for criteria the direct accessors don't cover:

```js
import { select } from 'fluidcad/core';
import { edge, face } from 'fluidcad/filters';

select(edge().verticalTo("xy"))
fillet(3)                          // uses the selection just made
```

`select()` puts a selection into the implicit context. The next op that takes a selection (`fillet`, `chamfer`, `shell`, `color`, `draft`) picks it up automatically.

### 3.7 Stale references

Once an edge or face is modified by a later operation, references to it become stale:

```js
const e = extrude(30)
fillet(5, e.endEdges())            // ✅ works
chamfer(2, e.endEdges())           // ❌ those edges are gone — replaced by the fillet
```

**Exception:** even after a face is destroyed, you can still use it as a **sketch plane** — FluidCAD remembers the plane's position and orientation:

```js
const e = extrude(30)
fillet(5, e.endEdges())
sketch(e.endFaces(), () => { circle(20) })  // ✅ still works as a plane reference
cut(10)
```

Rule of thumb: capture and use a reference close to where it was created.

### 3.8 Implicit context (last-X)

Many ops have a "default target" rule that points to the most recent compatible object:

| Op | Default target |
|----|----------------|
| `extrude` / `cut` / `revolve` / `sweep` | Last sketch |
| `loft` | All current sketches treated as profiles (or pass them explicitly) |
| `fillet` / `chamfer` / `shell` / `color` / `draft` | Last selection (or `select(...)` immediately before) |
| `repeat` (no last arg) | Last created operation |
| `copy` (no last arg) | Last object |
| `subtract` / `fuse` / `common` (with args) | The given objects |

When in doubt, store a reference and pass it explicitly.

### 3.9 Method chaining

Operations return objects that support fluent chaining. Common chain methods:

- On most 3D ops (`Extrude`, `Cut`, `Revolve`, `Sweep`, `Loft`): `.symmetric()`, `.thin(offset)`, `.draft(angle)`, `.endOffset(d)`, `.pick(point)`, `.drill(bool)`.
- On `BooleanOperation` (Extrude/Revolve/Loft/Sweep/Mirror/Rib): `.add()`, `.new()`, `.remove()`, `.scope(...)`.
- On `Transformable` (sphere/cylinder return this): `.translate(...)`, `.rotate(...)`, `.mirror(...)`, `.transform(matrix)`.
- On every `SceneObject`: `.name(str)`, `.reusable()`.

### 3.10 Coordinate systems

- World axes: `"x"`, `"y"`, `"z"`. Standard planes: `"xy"`, `"xz"`, `"yz"` (and aliases).
- `"x"`, `"y"`, `"z"` always refer to **world** axes — including inside a `sketch(...)` callback. Bare axis strings are not reinterpreted by the active sketch plane.
- For axes in the active sketch's local frame, use `local('x' | 'y' | 'z')`. This works inside or outside the sketch callback (outside, it resolves against the currently active sketch plane).

---

## 4. Sketching (2D)

All functions in this section are imported from `fluidcad/core` and called inside a `sketch(plane, () => ...)` callback. Most also work outside a sketch by passing the plane as the first argument.

### 4.1 sketch()

```ts
sketch(plane: PlaneLike, sketcher: () => T): SceneObject
sketch(face: SceneObject, sketcher: () => T): SceneObject
sketch(plane: Plane, sketcher: () => T): SceneObject
```

Opens a sketch context. Whatever the callback returns is attached as `.regions` on the result, so you can return references to specific shapes:

```js
const s = sketch("xy", () => {
    const outer = circle(60).reusable()
    const inner = circle(20)
    return { outer, inner }
})

// s.regions.outer  ← reference to the outer circle
```

The sketch is a `SceneObject` you can mark `.reusable()` or pass to `extrude(distance, sketch)` later.

### 4.2 Primitive shapes

The 2D primitives have moved to `llm-docs/api/`. Each one has its own
page with signatures, accessors, and a runnable example:

- [`rect`](llm-docs/api/rect.md)
- [`circle`](llm-docs/api/circle.md)
- [`ellipse`](llm-docs/api/ellipse.md)
- [`polygon`](llm-docs/api/polygon.md)
- [`slot`](llm-docs/api/slot.md)
- [`line`](llm-docs/api/line.md)

### 4.3 Free-form curves

- [`arc`](llm-docs/api/arc.md) — circular arcs (point or angle form)
- [`bezier`](llm-docs/api/bezier.md) — quadratic / cubic free curves

### 4.4 Constrained / cursor-relative geometry

These continue from the current cursor position and tangent. Useful for
building outlines incrementally. Each family now lives in `llm-docs/`:

- [`hLine` / `vLine` / `aLine`](llm-docs/api/cursor-lines.md) —
  axis-aligned and angle-relative drawing.
- [`move` / `hMove` / `vMove` / `rMove` / `pMove` / `center` / `back`](llm-docs/api/cursor-move.md) —
  cursor positioning without drawing.
- [`tLine`](llm-docs/api/tline.md) — tangent line between or to curves.
- [`tArc`](llm-docs/api/tarc.md) — tangent arc, the most flexible
  constrained primitive.
- [`tCircle`](llm-docs/api/tcircle.md) — full circle tangent to two
  objects.

#### Constraint qualifiers

From `fluidcad/constraints`:

- `outside(obj)` — solution is external to `obj` (no shared interior).
- `enclosing(obj)` — solution wraps around `obj`.
- `enclosed(obj)` — solution sits inside `obj`.
- `unqualified(obj)` — removes any prior qualification.

```js
import { outside, enclosing } from 'fluidcad/constraints';
tCircle(enclosing(c1), outside(c2), 30)
```

#### connect

See [`llm-docs/api/connect.md`](llm-docs/api/connect.md) for the full
docs — `connect()` stitches the current sketch's edges into a closed
wire.

### 4.5 2D modifiers

#### offset

```ts
offset(distance?, removeOriginal?)
offset(targetPlane, distance, removeOriginal, ...sourceGeometries)
```

Offsets the current sketch wire (default distance 1). Returns `Offset` with `.close()` for capping open offsets.

#### project

```ts
project(...sourceObjects: SceneObject[])     // project 3D edges onto current sketch plane
project(targetPlane, sourceObjects)
```

Projects 3D faces or edges onto the active sketch plane, producing flat 2D wires you can extrude/offset/etc.

#### intersect

```ts
intersect(...sourceObjects: SceneObject[])
intersect(targetPlane, sourceObjects)
```

Like `project()` but produces cross-section edges where 3D objects intersect the sketch plane.

#### trim

```ts
trim()                              // trim all segments at crossings
trim(...filters: EdgeFilter[])      // trim segments matching the filters
```

#### split

```ts
split()                             // split all intersecting geometries at crossings
split(...objects)
```

#### fillet (2D form)

```ts
fillet(objects: Geometry[])
fillet(objects: Geometry[], radius)
fillet(radius, ...objects: Geometry[])
```

Inside a sketch, `fillet()` rounds the corner between two geometries.

### 4.6 Booleans inside sketches

```ts
fuse()
fuse(...objects)
subtract(object1, object2)
common()
common(...objects)
```

Same names as 3D booleans — context determines whether they operate on 2D or 3D geometry. Inside a sketch they merge/cut sketch outlines:

```js
sketch("xy", () => {
    const outer = rect(100, 60)
    const inner = rect([10, 10], 80, 40)
    subtract(outer, inner)         // 2D difference → frame outline
})
```

### 4.7 Sketch-local transforms

Inside a sketch, `rotate`, `mirror`, and `copy` operate on 2D geometry:

```ts
rotate(angle, ...targets)
rotate(angle, copy: boolean, ...targets)

mirror(line: SceneObject)
mirror(axis: AxisLike)             // e.g. mirror("x") to mirror across sketch X
mirror(line, ...geometries)
mirror(axis, ...geometries)

copy("linear", axis, options, ...objects)
copy("linear", [axisA, axisB], options, ...objects)
copy("circular", center: Point2D, options, ...objects)   // 2D circular uses a point
```

```js
sketch("xy", () => {
    circle([50, 0], 20)
    copy("linear", "x", { count: 3, offset: 40 })     // 3 circles spaced 40 apart
    mirror("y")                                         // mirror all of them across Y axis
})
```

### 4.8 Geometry meta

On every `Geometry` (and `ExtrudableGeometry`):

- `.guide()` — mark as construction-only (excluded from extrude/revolve face building, but usable as a target for `tLine`/`tArc`/`hLine(target)` etc.).
- `.reusable()` — survive consumption by an operation.
- `.start()`, `.end()` — lazy vertices at the endpoints.
- `.tangent()` — lazy vertex representing the tangent direction at the end of this geometry.
- `.name(str)` — display name for the history panel.

---

## 5. 3D Operations

### 5.1 extrude()

```ts
extrude(target?: SceneObject)                 // default distance (25)
extrude(distance: number, target?)
extrude(distance1, distance2, target?)        // two distances → asymmetric extrude
extrude(face, target?)                        // extrude up to a face
extrude("first-face", ...filters, target?)    // up to nearest intersecting face
extrude("last-face", ...filters, target?)     // up to farthest intersecting face
```

Returns `Extrude` (extends `BooleanOperation`). Pulls the sketch along the plane normal.

**Chain methods** (most also apply to cut/revolve/sweep/loft):
- `.symmetric()` — extrude equally in both directions. `extrude(30).symmetric()` gives total span of 60.
- `.draft(angle | [start, end])` — taper. Positive expands outward, negative tapers inward.
- `.endOffset(d)` — shift the end face by `d` along the extrusion direction.
- `.thin(offset)` / `.thin(o1, o2)` — make a thin-walled solid by offsetting the profile edges. Positive = outward, negative = inward. Two values create two opposite-direction offsets.
- `.drill(bool)` — `true` (default) treats inner closed shapes as holes; `false` makes them solid regions.
- `.pick(...points)` — restrict to specific regions when the sketch has multiple closed regions.
- `.add()` / `.new()` / `.remove()` / `.scope(...)` — boolean scope.

**Direct accessors on the result:**

```js
const e = extrude(30)
e.startFaces(), e.endFaces(), e.sideFaces()
e.startEdges(), e.endEdges(), e.sideEdges()
e.internalFaces(), e.internalEdges()
e.capFaces(), e.capEdges()                    // for thin extrudes from open profiles
```

Each accessor accepts numeric indices and/or `FaceFilterBuilder`/`EdgeFilterBuilder` to filter within the direct selection:

```js
e.sideFaces(0)                                // first side face
e.sideFaces(face().cylinder())                // only cylindrical side faces
e.endEdges(0, 2)                              // edges by index
```

Examples:

```js
sketch("xy", () => rect(100, 60).centered())
extrude(30)                                    // simple box

sketch("xy", () => circle(50))
extrude(30).symmetric().draft(5)               // bidirectional tapered cylinder

extrude(30).thin(-2)                           // thin-walled (2mm inward)

const target = select(face().onPlane("xy", 100))
extrude(target)                                // extrude up to that face
```

### 5.2 cut()

See [`llm-docs/api/cut.md`](llm-docs/api/cut.md).

### 5.3 revolve()

See [`llm-docs/api/revolve.md`](llm-docs/api/revolve.md).

### 5.4 sweep()

See [`llm-docs/api/sweep.md`](llm-docs/api/sweep.md).

### 5.5 loft()

See [`llm-docs/api/loft.md`](llm-docs/api/loft.md).

### 5.6 sphere() / cylinder()

See [`llm-docs/api/primitive-solids.md`](llm-docs/api/primitive-solids.md).

### 5.7 fillet()

See [`llm-docs/api/fillet.md`](llm-docs/api/fillet.md).

### 5.8 chamfer()

See [`llm-docs/api/chamfer.md`](llm-docs/api/chamfer.md).

### 5.9 shell()

See [`llm-docs/api/shell.md`](llm-docs/api/shell.md).

### 5.10 draft()

See [`llm-docs/api/draft.md`](llm-docs/api/draft.md).

### 5.11 rib()

See [`llm-docs/api/rib.md`](llm-docs/api/rib.md).

### 5.12 Booleans (3D)

See [`llm-docs/api/booleans.md`](llm-docs/api/booleans.md) for explicit
`fuse` / `subtract` / `common` operations.

---

## 6. Selections & Filters

### 6.1 Direct selection from an operation result

Already covered in [§3.6](#36-selecting-subgeometry) and the per-op sections. Summary:

| On | Methods |
|----|---------|
| `Extrude`, `Loft`, `Sweep`, `Rib` | `startFaces`, `endFaces`, `sideFaces`, `startEdges`, `endEdges`, `sideEdges`, `internalFaces`, `internalEdges`, `capFaces`, `capEdges` |
| `Revolve` | `internalFaces`, `internalEdges`, `capFaces`, `capEdges` |
| `Cut` | `startEdges`, `endEdges`, `internalFaces`, `internalEdges` |
| `Shell` | `internalFaces`, `internalEdges` |
| `Rect` | `topEdge`, `bottomEdge`, `leftEdge`, `rightEdge`, corner arc edges and vertex methods |
| `Polygon` | `getEdge(i)`, `getVertex(i)` |

Each face/edge accessor takes `...(number | FilterBuilder)`. Indices and filters compose — both narrow the result.

### 6.2 select()

```ts
select(...filters: (FaceFilter | EdgeFilter)[])
```

Runs the filters over the entire scene and stores the result as the implicit selection. The next op that takes a selection uses it automatically.

You can combine multiple filters; results are the union of all of them.

```js
select(edge().line(), edge().circle(20))       // both criteria contribute matches
fillet(2)
```

### 6.3 face() filter

From `fluidcad/filters`. Chain methods narrow the candidate set (AND). Every method has a `not...` counterpart for negation.

**By shape:**
- `.planar()` / `.notPlanar()`
- `.cylinder(diameter?)` / `.notCylinder(...)`
- `.cylinderCurve(diameter?)` — faces bounded by cylindrical curves
- `.cone()` / `.notCone()`
- `.torus(majorRadius?, minorRadius?)`
- `.circle(diameter?)` — flat disc faces

**By orientation / position:**
- `.onPlane(plane, offset?)` / `.notOnPlane(...)`
- `.parallelTo(plane)` / `.notParallelTo(...)`
- `.above(plane, offset?)` — entirely above the plane
- `.below(plane, offset?)`
- `.intersectsWith(plane)` — faces that cross the plane

**By topology:**
- `.edgeCount(n)`
- `.hasEdge(...filtersOrObjects)`

**By source:**
- `.from(...sceneObjects)` — restrict to faces from those objects (recursive into containers).

```js
face().planar().onPlane("xy", 30)              // top face at z=30
face().cylinder(10)                            // cylindrical faces of diameter 10
face().intersectsWith("front").notOnPlane("xy")
face().from(myBox).parallelTo("xy")
```

### 6.4 edge() filter

**By shape:**
- `.line(length?)` / `.notLine(...)`
- `.circle(diameter?)` / `.notCircle(...)`
- `.arc(radius?)` / `.notArc(...)`

**By orientation:**
- `.parallelTo(plane)` / `.notParallelTo(...)`
- `.verticalTo(plane)` / `.notVerticalTo(...)` — perpendicular to the plane

**By position:**
- `.onPlane(plane, offset?)` — accepts `{ offset, bothDirections, partial }`
- `.above(plane, offset?)`
- `.below(plane, offset?)`
- `.intersectsWith(sceneObject)` — edges that cross another scene object's edges

**By parent:**
- `.belongsToFace(...filtersOrObjects)`
- `.from(...sceneObjects)`

```js
edge().verticalTo("xy")                        // edges perpendicular to ground plane
edge().line(10).onPlane("xy", 0)               // 10-long line edges on the ground
edge().belongsToFace(face().cylinder())        // edges on cylindrical faces
edge().from(myBox).circle()                    // circular edges of myBox only
```

### 6.5 Composing & negation

Filter chain is AND. `select()` of multiple filter builders is OR. Negate any criterion with the `.notX()` form. `from()` composes with the rest as AND, and selections survive being cloned by `repeat()` / `mirror()` (references are remapped).

---

## 7. Transforms & Patterns

### 7.1 Standalone transforms

#### translate

```ts
translate(x, ...targets)
translate(x, y, ...targets)
translate(x, y, z, ...targets)
translate(point: PointLike, ...targets)
translate(x, y, z, copy: boolean, ...targets)    // copy flag (works at any arity)
```

Defaults to last object if no targets passed. Returns `SceneObject`.

```js
const s = sphere(25)
translate(0, 0, 100, s)                        // move it 100 up
translate(50, 0, 0, true, s)                   // copy + move
```

#### rotate

```ts
// 2D (inside sketch) — angle around plane Z
rotate(angle, ...targets)
rotate(angle, copy: boolean, ...targets)

// 3D — around an axis
rotate(axis: AxisLike, angle, ...targets)
rotate(axis, angle, copy: boolean, ...targets)
```

```js
rotate("z", 45, s)                             // 45° around world Z
rotate({ point: [0,0,0], direction: "x" }, 90)
```

#### mirror

```ts
// 2D (inside sketch)
mirror(line: SceneObject)
mirror(axis: AxisLike)
mirror(line, ...geometries)
mirror(axis, ...geometries)

// 3D
mirror(plane: PlaneLike, ...objects)
```

Inside a sketch, mirrors across a line or axis. Bare strings are still world axes (e.g., `mirror("x")` mirrors across the world X axis); use `mirror(local("x"))` to mirror across the sketch plane's local X. Outside a sketch, mirrors solids across a plane.

`mirror` (3D) returns `Mirror` (extends `BooleanOperation`) with `.exclude(...objects)` to skip specific objects.

### 7.2 copy() — snapshot duplication

```ts
// Linear
copy("linear", axis: AxisLike, options, ...objects)
copy("linear", axes: AxisLike[], options, ...objects)

// Circular
copy("circular", axis: AxisLike, options, ...objects)        // 3D
copy("circular", center: Point2D, options, ...objects)       // inside sketch
```

**`LinearCopyOptions` / `LinearRepeatOptions`:**
- `count: number | number[]` — instances per axis (including original).
- `offset: number | number[]` — spacing between instances. Mutually exclusive with `length`.
- `length: number | number[]` — total span; instances are evenly distributed.
- `centered: boolean` — center pattern around original.
- `skip: number[][]` — indices to skip (per-axis tuples).

**`CircularCopyOptions` / `CircularRepeatOptions`:**
- `count`, `angle`, `offset` (mutually exclusive with `angle`), `centered`, `skip`.

```js
const pin = extrude(10).new()
copy("linear", "x", { count: 4, offset: 30 }, pin)
copy("linear", ["x", "y"], { count: [3, 2], offset: [20, 40] }, pin)
copy("circular", "z", { count: 6, angle: 360 }, pin)
```

`copy()` clones the finished shape — copies are independent of the original's modeling history.

### 7.3 repeat() — feature re-application

```ts
repeat("linear", axis | axes, options, ...objects)
repeat("circular", axis, options, ...objects)
repeat("mirror", plane, ...objects)
repeat("rotate", axis, angle?, ...objects)        // angle defaults to 90°
repeat(matrix: Matrix4, ...objects)
```

`repeat()` re-applies the modeling feature itself. Pass the result of an `extrude()`, `cut()`, `fillet()`, etc. as the last argument(s) — each repetition re-runs that operation at the new position.

```js
// Cut one pocket, then repeat the cut across a grid → one solid with N pockets
const pocket = cut(10)
repeat("linear", ["x", "y"], { count: [4, 2], offset: [30, 30] }, pocket)

// Mirror a feature across a plane
const boss = extrude(15)
repeat("mirror", "front", boss)
```

### 7.4 copy vs repeat — when to use which

| You want… | Use |
|-----------|-----|
| Clone the whole finished shape at new positions (each copy independent) | `copy()` |
| Re-run a feature so it cuts/extrudes into the same solid at each position | `repeat()` |
| One solid with multiple pockets/bosses | `repeat()` with the cut/extrude result |
| Many separate solids of the same shape | `copy()` with `.new()` on the original |
| Mirror a feature across a plane | `repeat("mirror", plane, feature)` |

### 7.5 Chained transforms on objects

`Transformable` objects (sphere/cylinder, results of `translate`/`rotate`/`mirror`, anything inheriting `ITransformable`) chain:

```js
sphere(20)
    .translate(50, 0, 0)
    .rotate("z", 30)

cylinder(10, 40)
    .transform(myMatrix4)
```

Matrix4 composition is left-to-right: `.translate(T).rotate(R)` applies translation first, then rotation.

---

## 8. Reference Geometry

### 8.1 plane()

```ts
plane(plane: PlaneLike, options: PlaneTransformOptions)
plane(plane: PlaneLike, offset: number)
plane(selection: SceneObject)                      // from a face
plane(selection: SceneObject, options)
plane(selection: SceneObject, offset)
plane(plane: Plane, options)                       // transform an existing plane
plane(p1: PlaneLike, p2: PlaneLike, options?)      // midplane between two planes
plane(p1: Plane, p2: Plane, options?)
```

`PlaneTransformOptions`:
- `offset: number` — translate along the normal.
- `rotateX: number`, `rotateY: number`, `rotateZ: number` — degrees.

```js
const p = plane("xy", 50)                          // XY shifted up 50
const p2 = plane("xz", { offset: 30, rotateZ: 45 })
const p3 = plane(face1, 10)                        // 10 above a face
const mid = plane("xy", plane("xy", 100))          // midplane
```

### 8.2 axis()

```ts
axis(axis: AxisLike)
axis(axis: AxisLike, options: AxisTransformOptions)
axis(source: SceneObject)                          // from an edge
axis(source: SceneObject, options)
axis(axis: Axis, options)
axis(a1: AxisLike, a2: AxisLike, options?)         // midaxis
axis(a1: Axis, a2: Axis, options?)
```

`AxisLike` can be `"x"`, `"y"`, `"z"`, a direction vector, or an object `{ point?, direction }`. `AxisTransformOptions` includes `offsetX`, `offsetY`, `offsetZ`, `flip`, etc.

```js
const a = axis("y", { offsetZ: 100 })              // Y axis raised by 100
const a2 = axis(edgeRef)                           // axis from a straight edge
```

### 8.3 local()

```ts
local('x' | 'y' | 'z')
```

Returns an axis interpreted **relative to the active sketch's plane**. Useful when you're inside a sketch on a tilted plane and want "this sketch's X axis," not world X.

```js
sketch(rotatedPlane, () => {
    // ...
    mirror(local("x"))                              // mirror across sketch-local X
})
```

---

## 9. Utilities

### 9.1 part()

```ts
part(name: string, callback: () => void)
```

Creates an **isolation boundary**. Shapes inside the callback only auto-fuse with each other, not with anything outside the part. Use for assemblies with multiple components.

```js
part("base", () => {
    sketch("xy", () => rect(200, 100).centered())
    extrude(20)
})

part("pillar", () => {
    cylinder(20, 50).translate(0, 0, 20)
})
```

Reusable parts: wrap `part(...)` in a function for parametric instances:

```js
function createPin(d = 10, h = 30) {
    return part("pin", () => {
        cylinder(d / 2, h)
    })
}

createPin(8, 25)
createPin(12, 40).translate(50, 0, 0)
```

### 9.2 color()

```ts
color(color: string)                               // CSS color, applies to last selection
color(color: string, selection: SceneObject)
```

Accepts named colors (`"red"`), hex (`"#3498db"`), `rgb(...)`, etc.

```js
select(face().planar().onPlane("xy", 30))
color("#3498db")

const e = extrude(30)
color("red", e.sideFaces())
```

### 9.3 remove()

```ts
remove(...objects: SceneObject[])
```

Deletes objects from the scene. Most commonly used after `.reusable()` when you're done with the reusable source:

```js
const profile = sketch("xy", () => circle(60)).reusable()
extrude(20)
extrude(50)
remove(profile)                                    // clean up
```

### 9.4 load()

```ts
load(fileName: string)
```

Imports a 3D model file (STEP, STL, etc.) by relative filename from the project folder. Returns an `ILoadFile` (extends `SceneObject`) with chainable filtering:

```js
load("bracket.step")                               // loads as a SceneObject
load("bracket.step").translate(0, 0, 50).rotate("z", 90)
```

`ILoadFile` may support `.noColors()`, `.include(...)`, `.exclude(...)` to control which sub-shapes are imported and whether to keep STEP colors — consult the codebase if you need these.

### 9.5 split / trim (top-level)

```ts
split(...objects)                                  // 2D split at crossings (inside sketch)
trim()                                             // 2D trim (inside sketch)
trim(...filters: EdgeFilter[])
```

---

## 10. Idiomatic Patterns (Cookbook)

Each recipe is a complete `.fluid.js` file you can paste in.

### 10.1 Rounded-corner open container

```js
import { sketch, rect, extrude, fillet, shell } from 'fluidcad/core';

sketch("xy", () => {
    rect(120, 80).centered().radius(10)
})

const box = extrude(40)

fillet(3, box.startEdges())
shell(-2, box.endFaces())
```

### 10.2 Plate with a grid of holes

```js
import { sketch, rect, circle, move, extrude, cut, repeat } from 'fluidcad/core';

sketch("xy", () => {
    rect(200, 120).centered()
})
const plate = extrude(8)

sketch(plate.endFaces(), () => {
    move([-75, -40])
    circle(8)
})
const hole = cut()                              // through-all

repeat("linear", ["x", "y"], {
    count: [6, 4],
    offset: [30, 25]
}, hole)
```

### 10.3 Revolved profile (cup-like)

```js
import { sketch, move, line, vLine, hLine, revolve } from 'fluidcad/core';

sketch("xz", () => {
    move([10, 0])
    hLine(30)               // bottom outer
    vLine(50)               // outer wall
    hLine(-25)              // top rim
    vLine(-45)              // inner wall down
    hLine(-5)               // inner bottom
    line([10, 0])           // close
})

revolve("z")
```

### 10.4 Counter-bore on existing top face

```js
import { sketch, rect, circle, extrude, cut } from 'fluidcad/core';

sketch("xy", () => rect(60, 60).centered())
const base = extrude(20)

sketch(base.endFaces(), () => circle(20))       // big circle for the counter-bore
cut(5)                                          // counter-bore: 5mm deep

sketch(base.endFaces(), () => circle(8))        // through-hole
cut()                                           // through-all
```

### 10.5 Symmetric part from one half

```js
import { sketch, rect, move, extrude, repeat } from 'fluidcad/core';

sketch("xy", () => {
    move([5, -20])
    rect(60, 40)                                // off-center half
})
const half = extrude(15)

repeat("mirror", "yz", half)                    // mirror across the YZ plane
```

### 10.6 Reusable sketch consumed twice

```js
import { sketch, circle, extrude, remove } from 'fluidcad/core';

const profile = sketch("xy", () => {
    circle(60)
}).reusable()

extrude(10)                                     // first use — base disc
extrude(50)                                     // reuses the same profile

remove(profile)                                 // clean up
```

### 10.7 Tangent-arc + tangent-line outline

```js
import { sketch, circle, hMove, tLine, tArc, mirror } from 'fluidcad/core';
import { outside } from 'fluidcad/constraints';

sketch("xy", () => {
    const c1 = circle(40).reusable()
    hMove(60)
    const c2 = circle(20).reusable()

    const t = tLine(outside(c1), outside(c2))   // external tangent line
    tArc(t.end())                                // tangent arc continuing from line end
    mirror("x", t)                               // mirror to build the other side
})

const e = extrude(8)
```

### 10.8 Loft between offset profiles

```js
import { sketch, circle, rect, plane, loft } from 'fluidcad/core';

const bottom = sketch("xy", () => circle(60))
const top = sketch(plane("xy", 80), () => rect(70, 70).centered().radius(8))

loft(bottom, top)
```

### 10.9 Sweep along a path

```js
import { sketch, line, arc, circle, sweep } from 'fluidcad/core';

const path = sketch("xy", () => {
    line([0, 0], [80, 0])
    arc([160, 60]).radius(80)
}).reusable()

sketch("yz", () => circle(6))
sweep(path)
```

### 10.10 Selective fillets via filter

```js
import { sketch, rect, extrude, select, fillet, color } from 'fluidcad/core';
import { edge, face } from 'fluidcad/filters';

sketch("xy", () => rect(100, 60).centered())
const box = extrude(30)

select(edge().verticalTo("xy"))                 // only vertical edges
fillet(5)

select(face().planar().onPlane("xy", 30))       // the top face
color("#3498db")
```

### 10.11 Assembly with two parts

```js
import { sketch, rect, extrude, cylinder, translate, part } from 'fluidcad/core';

part("base", () => {
    sketch("xy", () => rect(200, 100).centered())
    extrude(20)
})

part("pillar", () => {
    cylinder(15, 60).translate(0, 0, 20)
})
```

The pillar sits on the base but stays a separate solid.

### 10.12 Drafted pocket pattern

```js
import { sketch, rect, move, extrude, cut, fillet, repeat } from 'fluidcad/core';

sketch("xy", () => rect(300, 100).centered())
extrude(40)

sketch("xy", () => {
    move([-130, -30])
    rect(30, 40)
})
const pocket = cut(30).draft(-10)                // tapered inward 10°
fillet(3, pocket.internalEdges())

repeat("linear", ["x", "y"], {
    count: [7, 2],
    length: [260, 60]
}, pocket)
```

### 10.13 Shell + intersection grooves

```js
import { sketch, rect, extrude, shell, fillet, intersect, select, repeat } from 'fluidcad/core';
import { face } from 'fluidcad/filters';

sketch("xy", () => rect(170, 100).radius(18).centered())
const e = extrude(24)
const s = shell(-5, e.endFaces())
fillet(8, s.internalEdges())

// Grooves on the front face — intersect the box with the "front" plane to get a profile
const facesX = select(face().intersectsWith("front").notOnPlane("xy"))
const groove = sketch("front", () => { intersect(facesX) })

const grooveCut = extrude(3, groove).thin(-1).remove().symmetric()

repeat("linear", "y", { count: 3, offset: 25, centered: true }, grooveCut)
```

### 10.14 Hex lantern with windows

```js
import { polygon, plane, extrude, shell, select, sketch, project, offset, cut, repeat } from 'fluidcad/core';
import { face } from 'fluidcad/filters';

const sides = 6;
const h = 150;

sketch(plane("xy", 24), () => polygon(sides, 100))
const middle = extrude(h).draft(8).new()

select(face().onPlane("xy", h + 24), face().onPlane("xy", 24))
shell(-7)

// Window cuts on each side face
sketch(middle.sideFaces(0), () => {
    project(middle.sideFaces(0))
    offset(-6, true)                            // inset by 6, remove original
})
const window = cut(7)

repeat("circular", "z", {
    count: sides,
    offset: 360 / sides
})
```

### 10.15 Coloring by filter

```js
import { sketch, rect, extrude, color, select } from 'fluidcad/core';
import { face } from 'fluidcad/filters';

sketch("xy", () => rect(100, 60).centered())
const e = extrude(30)

color("red", e.endFaces())
color("blue", e.startFaces())
select(face().from(e).parallelTo("yz"))
color("#2ecc71")
```

---

## 11. Common Mistakes & Footguns

Each one shows ❌ wrong → ✅ right with a one-line **Why**.

### 11.1 Sketch consumed by extrude

```js
// ❌ second extrude has nothing to consume
sketch("xy", () => rect(100, 50))
extrude(30)
extrude(20)                                     // error: no active sketch

// ✅ mark reusable (or store + pass explicitly)
const s = sketch("xy", () => rect(100, 50)).reusable()
extrude(30)
extrude(20)
remove(s)
```

**Why:** by default a sketch is consumed by the first feature that uses it. `.reusable()` keeps it alive.

### 11.2 Accidental auto-fusion

```js
// ❌ two extrudes that touch — they silently merge
sketch("xy", () => rect(100, 50))
extrude(30)
sketch("xy", () => { move([25,0]); rect(100, 50) })
extrude(30)                                     // now one solid, probably not what you wanted

// ✅ use .new() to keep them separate
extrude(30).new()
```

**Why:** additive ops fuse with all touching solids by default. `.new()` opts out. `part()` is a stronger boundary.

### 11.3 Wrong sketch plane for revolve

```js
// ❌ profile on XY can't revolve around Z (axis is in the plane)
sketch("xy", () => { move([20, 0]); rect(10, 30) })
revolve("z")                                    // error or degenerate result

// ✅ sketch on a plane that contains the axis
sketch("xz", () => { move([20, 0]); rect(10, 30) })
revolve("z")
```

**Why:** the sketch plane must contain the revolve axis. Use `"xz"` or `"yz"` to revolve around `"z"`.

### 11.4 Shell thickness sign

```js
// ❌ positive thickness grows the solid outward
shell(2, e.endFaces())                          // outer dim now larger by 2

// ✅ negative thickness goes inward, outer dim preserved
shell(-2, e.endFaces())
```

**Why:** negative shells inward (typical), positive shells outward.

### 11.5 cut() with no distance is through-all

```js
// ❌ probably meant a pocket, got a through-hole
sketch(e.endFaces(), () => circle(20))
cut()                                           // cuts all the way through

// ✅ specify the depth
cut(10)
```

**Why:** zero-arg `cut()` is through-all by design. Always pass a distance for finite pockets.

### 11.6 .symmetric() doubles total span

```js
// ❌ thinking this is total 50
extrude(50).symmetric()                         // actually spans -50..+50 = 100 total

// ✅ halve the argument when you want a fixed total
extrude(25).symmetric()                         // total span 50
```

**Why:** symmetric extrudes by `distance` in each direction.

### 11.7 .draft() sign convention

```js
// Outward draft on an extrude expands the top face
extrude(30).draft(10)                           // top is bigger than bottom

// ❌ this makes a pocket cut with an outward-tapered cavity (unusual)
cut(20).draft(10)

// ✅ for a "narrower at bottom" pocket, use negative
cut(20).draft(-10)
```

**Why:** positive draft pushes material outward along the extrusion direction. For inward-tapered cuts (mold-friendly cavities), use negative.

### 11.8 chamfer vs fillet

```js
// Easy to mix up — opposite visual results:
fillet(5, e.endEdges())                         // curved (rounded)
chamfer(5, e.endEdges())                        // flat (beveled)
```

**Why:** both round/break corners, but fillet uses an arc and chamfer uses a flat facet. Choose by aesthetic and manufacturing intent.

### 11.9 copy() vs repeat() semantics

```js
// ❌ cut + copy → many independent solids each with one pocket
cut(15)
copy("linear", "x", { count: 4, offset: 40 })

// ✅ cut + repeat → one solid with four pockets
const c = cut(15)
repeat("linear", "x", { count: 4, offset: 40 }, c)
```

**Why:** `copy()` clones the finished shape. `repeat()` re-applies the feature so it interacts with the existing solid at each new location.

### 11.10 offset vs length in pattern options

```js
// ❌ ambiguous — picking one is required
copy("linear", "x", { count: 4, offset: 30, length: 90 })   // don't mix

// ✅ either spacing OR span
copy("linear", "x", { count: 4, offset: 30 })               // 30 between each
copy("linear", "x", { count: 4, length: 90 })               // evenly across 90
```

**Why:** `offset` and `length` are mutually exclusive. Same for `angle` vs `offset` in circular patterns.

### 11.11 Stale edge references after fillet/chamfer

```js
const e = extrude(30)

// ❌ edges are gone after the first fillet
fillet(5, e.endEdges())
chamfer(2, e.endEdges())                        // those edges don't exist anymore

// ✅ select fresh, or pick a different region
fillet(5, e.endEdges())
chamfer(2, e.startEdges())
```

**Why:** the original edges are replaced by the fillet surface. Faces (as planes) survive — but edges and face *geometry* don't.

### 11.12 Guide geometry doesn't build faces

```js
// ❌ the guide circle doesn't cut anything
sketch("xy", () => {
    rect(100, 60).centered()
    circle(20).guide()                          // construction only — ignored by extrude
})
extrude(20)                                     // solid box, no hole

// ✅ either drop .guide(), or model the hole as a separate op
sketch("xy", () => {
    rect(100, 60).centered()
    circle(20)
})
extrude(20)                                     // ring (inner circle becomes a hole)
```

**Why:** `.guide()` marks construction geometry. It's useful as a target for `tLine`/`tArc`/`hLine(target)` but does not produce faces.

### 11.13 Plane / axis names are string literals

```js
// ❌ a free string isn't a valid plane name
sketch("top-plane", () => { ... })              // error

// ✅ use the literal names: xy/xz/yz, or aliases top/front/right, optionally negated
sketch("xy", () => { ... })
sketch("top", () => { ... })                    // alias
sketch("-xy", () => { ... })                    // negated normal
```

**Why:** valid plane strings: `"xy"`/`"top"`, `"xz"`/`"front"`, `"yz"`/`"right"`, and their negative versions (`"-xy"`/`"bottom"`, etc.). Anything else must be a `Plane` object from `plane(...)` or a face.

### 11.14 Auto-fusion across operations vs across parts

```js
// ❌ two parts intended to be assembled but they fuse together
sketch("xy", () => rect(200, 100).centered()); extrude(20)
cylinder(15, 60).translate(0, 0, 20)            // fuses with the base — one solid now

// ✅ wrap each in part() for isolation
part("base", () => {
    sketch("xy", () => rect(200, 100).centered()); extrude(20)
})
part("pillar", () => {
    cylinder(15, 60).translate(0, 0, 20)
})
```

**Why:** `.new()` keeps a single operation separate. `part()` is a stronger boundary for whole assemblies.

### 11.15 Sketching on a face vs sketching on a plane

```js
// On a face — cursor starts at the face's center
sketch(e.endFaces(), () => {
    circle(20)                                  // centered on the face
})

// On a plane — cursor starts at the plane origin
sketch("xy", () => {
    circle(20)                                  // at world (0,0,0)
})
```

**Why:** the convenience default for `sketch(face, ...)` is the face center. Reset with `move([0,0])` if you need plane-origin behavior.

### 11.16 Storing extrudes you'll need later

```js
// ❌ no reference saved → can't use .endFaces() later
extrude(30)
sketch( /* what face? */ , () => circle(10))

// ✅ save the reference at creation
const e = extrude(30)
sketch(e.endFaces(), () => circle(10))
```

**Why:** the implicit "last sketch / last selection" defaults don't carry over to face accessors. Always store the result if you'll reference its faces/edges.

### 11.17 Tangent-arc / tCircle multiple-solution surprise

```js
// ❌ this returns ALL valid tangent circles — could be 8 of them
tCircle(c1, c2, 30)

// ✅ qualify the geometric relationship you want
tCircle(outside(c1), outside(c2), 30)           // external tangency
tCircle(enclosing(c1), enclosed(c2), 30)        // wraps c1, fits inside c2
// Also: pass mustTouch: true to filter out phantom solutions on infinite line extensions
tCircle(c1, c2, 30, true)
```

**Why:** the solver returns every valid solution by default. Use `outside`/`enclosed`/`enclosing` and/or `mustTouch` to narrow.

### 11.18 Computing what FluidCAD already computes

```js
// ❌ trigonometry to place six bolts around a hub
const r = 40
for (let i = 0; i < 6; i++) {
    const a = (i / 6) * 2 * Math.PI
    sketch(face, () => circle([r * Math.cos(a), r * Math.sin(a)], 6))
    cut(10)
}

// ✅ one cut, repeated around an axis — exact, parametric, one line
sketch(face, () => circle([40, 0], 6))
const hole = cut(10)
repeat("circular", "z", { count: 6, angle: 360 }, hole)
```

```js
// ❌ tangent point computed by hand
const dx = c2x - c1x, dy = c2y - c1y
const d = Math.hypot(dx, dy)
const ang = Math.atan2(dy, dx) + Math.acos((r1 - r2) / d)
const tx = c1x + r1 * Math.cos(ang)
const ty = c1y + r1 * Math.sin(ang)
line([tx, ty], [/* the other tangent point */])

// ✅ describe the relationship; let the solver find the line
tLine(outside(c1), outside(c2))
```

```js
// ❌ manually splitting an extrude into two halves so it's symmetric
extrude(50)
translate(0, 0, -50)                            // shift to "center" — fragile, dimensions baked in

// ✅ symmetric mode does this exactly
extrude(25).symmetric()                         // span -25..+25 = 50 total
```

**Why:** every line of geometric math is a place where intent is lost, error accumulates, and the model breaks on the next parameter tweak. Treat `Math.cos`/`Math.sin`/`Math.atan2`/`Math.hypot`/manual offsets as smells; the API almost certainly has a primitive that expresses the same idea exactly and parametrically. See [§1 "Let the API do the math"](#let-the-api-do-the-math).

### 11.19 Filters compose as AND inside one builder

```js
// AND within a builder: edges that are circles AND on the XY plane
edge().circle().onPlane("xy", 0)

// OR across builders inside select():
select(edge().circle(), edge().line(20))        // circles OR 20-long lines
```

**Why:** chained filter methods narrow. To union multiple criteria, pass multiple filter builders to `select()`.

---

## 12. Quick API Cheatsheet

Alphabetical. Signatures are shorthand — see prior sections for full overloads.

| Name | Purpose | Shorthand |
|------|---------|-----------|
| `aLine` | Line at given angle | `aLine(angle, length)` |
| `arc` | Arc between points or by angle | `arc(end)` / `arc(r, a0, a1)` |
| `axis` | Reference axis | `axis(axisLike, options?)` |
| `bezier` | Bezier curve | `bezier(...controlPoints, end)` |
| `center` | Move cursor to plane origin | `center()` |
| `chamfer` | Bevel edges | `chamfer(d, ...edges?)` |
| `circle` | Circle by diameter | `circle(d)` / `circle(center, d)` |
| `color` | Apply color | `color(css, selection?)` |
| `common` | Boolean intersection (2D or 3D) | `common()` / `common(...objs)` |
| `connect` | Close sketch path | `connect()` |
| `copy` | Clone shape linearly or circularly | `copy(type, axisOrCenter, opts, ...objs?)` |
| `cut` | Subtract sketch from solids | `cut(d?)` / `cut(d, target?)` |
| `cylinder` | 3D cylinder primitive | `cylinder(r, h)` |
| `draft` | Apply draft angle to faces | `draft(angle, ...faces?)` |
| `ellipse` | Ellipse by semi-radii | `ellipse(rx, ry)` |
| `extrude` | Pull sketch into solid | `extrude(d?, target?)` |
| `fillet` | Round edges | `fillet(r?, ...edges?)` |
| `fuse` | Boolean union (2D or 3D) | `fuse()` / `fuse(...objs)` |
| `hLine` | Horizontal line | `hLine(distance)` |
| `hMove` | Move cursor horizontally | `hMove(d)` / `hMove(target)` |
| `intersect` | 3D-on-sketch cross-section | `intersect(...objs)` |
| `line` | Straight line | `line(end)` / `line(start, end)` |
| `load` | Import 3D file | `load("file.step")` |
| `local` | Sketch-local standard axis | `local('x' \| 'y' \| 'z')` |
| `loft` | Smooth between profiles | `loft(...profiles)` |
| `mirror` | Mirror geometry (2D line/axis or 3D plane) | `mirror(planeOrAxisOrLine, ...objs?)` |
| `move` | Absolute cursor move | `move()` / `move([x,y])` |
| `offset` | Offset sketch wire | `offset(d?, removeOriginal?)` |
| `pMove` | Polar move | `pMove(r, angle)` |
| `part` | Isolation boundary | `part(name, () => {...})` |
| `plane` | Reference plane | `plane(planeLike, options?)` |
| `polygon` | Regular polygon | `polygon(n, d, mode?)` |
| `project` | Project 3D onto sketch plane | `project(...objs)` |
| `rect` | Rectangle | `rect(w, h?)` |
| `remove` | Delete from scene | `remove(...objs)` |
| `repeat` | Re-apply feature at new positions | `repeat(type, axis/plane, opts?, ...objs?)` |
| `revolve` | Sweep sketch around axis | `revolve(axis, angle?)` |
| `rib` | Spine-based rib feature | `rib(thickness)` |
| `rMove` | Rotate cursor tangent | `rMove(angle, pivot?)` |
| `rotate` | Rotate (2D in sketch, 3D otherwise) | `rotate(angle, ...)` / `rotate(axis, angle, ...)` |
| `select` | Filter-based selection | `select(...filters)` |
| `shell` | Hollow out a solid | `shell(thickness, ...facesToRemove?)` |
| `sketch` | Open a 2D sketch context | `sketch(plane, () => {...})` |
| `slot` | Stadium/slot shape | `slot(length, radius)` |
| `sphere` | 3D sphere primitive | `sphere(r)` |
| `split` | Split sketch at crossings | `split()` / `split(...objs)` |
| `subtract` | Boolean difference (2D or 3D) | `subtract(keep, remove)` |
| `sweep` | Sweep sketch along path | `sweep(path)` |
| `tArc` | Tangent arc | `tArc(target)` / `tArc(r, a)` / etc. |
| `tCircle` | Tangent circle | `tCircle(c1, c2, d, mustTouch?)` |
| `tLine` | Tangent line | `tLine(d)` / `tLine(c1, c2)` |
| `translate` | Translate objects | `translate(x, y?, z?, ...objs?)` |
| `trim` | Trim sketch segments | `trim()` / `trim(...filters)` |
| `vLine` | Vertical line | `vLine(distance)` |
| `vMove` | Move cursor vertically | `vMove(d)` / `vMove(target)` |

**Filter builders (`fluidcad/filters`):**

| Builder | Notable methods |
|---------|-----------------|
| `face()` | `.planar()`, `.cylinder(d?)`, `.cone()`, `.torus(R?, r?)`, `.circle(d?)`, `.cylinderCurve(d?)`, `.onPlane(p, off?)`, `.parallelTo(p)`, `.above/below(p, off?)`, `.intersectsWith(p)`, `.edgeCount(n)`, `.hasEdge(...)`, `.from(...objs)`, plus `not...` variants |
| `edge()` | `.line(L?)`, `.circle(d?)`, `.arc(r?)`, `.onPlane(p, off?)`, `.parallelTo(p)`, `.verticalTo(p)`, `.above/below(p, off?)`, `.intersectsWith(obj)`, `.belongsToFace(...)`, `.from(...objs)`, plus `not...` variants |

**Constraint qualifiers (`fluidcad/constraints`):**

| Function | Use with `tLine` / `tArc` / `tCircle` |
|----------|----------------------------------------|
| `outside(obj)` | Solution is external to `obj` |
| `enclosing(obj)` | Solution wraps around `obj` |
| `enclosed(obj)` | Solution sits inside `obj` |
| `unqualified(obj)` | Strip any prior qualification |

**Universal chain methods:**

| Method | On | Effect |
|--------|----|--------|
| `.name(str)` | Every `SceneObject` | Display name |
| `.reusable()` | Every `SceneObject` | Survive consumption |
| `.guide()` | `Geometry` (sketch) | Construction only |
| `.start()` / `.end()` / `.tangent()` | `Geometry` | Lazy vertex / direction |
| `.add()` / `.new()` / `.remove()` / `.scope(...)` | `BooleanOperation` (Extrude/Revolve/Loft/Sweep/Mirror/Rib) | Boolean scope |
| `.symmetric()` | Extrude/Revolve/Cut | Bidirectional |
| `.draft(angle)` | Extrude/Cut/Sweep/Rib | Taper |
| `.thin(o)` / `.thin(o1, o2)` | Extrude/Cut/Revolve/Loft/Sweep | Thin-wall mode |
| `.endOffset(d)` | Extrude/Cut/Sweep | Shift end face |
| `.pick(...pts)` | Extrude/Cut/Revolve/Sweep | Region picking |
| `.drill(bool)` | Extrude/Sweep | Treat inner closed shapes as holes |
| `.translate(...)` / `.rotate(...)` / `.mirror(...)` / `.transform(m)` | `Transformable` | Standalone transforms |

---

*End of llm.md.*
