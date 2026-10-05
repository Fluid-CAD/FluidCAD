# Custom feature traps

Read before writing a `*.feature.js` module. Each entry: the mistake, how it shows, and the fix. The messages are the engine's own.

## `instanceof` on your own class

- **Signature.** A check that works on the first render fails on the next, or a cached build is never matched. Nothing errors.
- **Why.** The module is evaluated anew on every render and by the editor's catalog scan; each evaluation makes a new class, so an instance of the last render's `Standoff` is not an instance of this one's.
- **Fix.** Never `x instanceof Standoff`. The engine compares features by `static id` and values. To tell a value's elements apart, use the readers (`isLocation()`, `facesOf()`); `instanceof Feature` (the engine's base) is fine.

## No buckets, or buckets of the wrong shape

- **Signature.** `fillet(0.5, post.endEdges())` fails its row with `fillet: the selection resolved to no edges — nothing was filleted.`; the dialog's picks on the feature are written as filters (`select(edge()…)`) instead of `post.endEdges()`.
- **Why.** A feature fills only the buckets `setBuckets()` declares, and a tool's buckets must be faces and edges of the shapes `buildTool()` returns. Naming faces of the shape before `ShapeOps.transformTracking` placed it names shapes the result doesn't hold.
- **Fix.** Sort the faces on the XY plane, place the tool with `transformTracking(shape, frame, faces)`, and name `placed.images` (filtering out `null`). Declare start, end, side and internal faces; edges are derived. For a cut, give `startPlane` (its normal the way the tool grows) so the rims are start and end edges, not all internal. Check each bucket's count with `resolve_selection`.

## Leaking intermediates, or freeing what isn't yours

- **Signature, leak.** Nothing visible; the engine's heap grows on every render whose cache misses the feature and on every change in its dialog's preview, until the session slows or traps.
- **Signature, over-free.** `Cannot pass deleted object`, a broken later feature, or a kernel crash.
- **Fix.** `dispose()` every shape you build and drop: the cylinders a cut consumed, the shape a transform moved. Never dispose a shape `buildTool()` returns (the feature owns it) or one read through `facesOf()`/`shapesOf()`/`edgesOf()` (the scene owns it).

## Raw OpenCascade outside `this.occ()`

- **Signature.** A leak per build (objects made through `getOC()` are never freed), or a WebAssembly trap: the row fails with `<Name> crashed the OpenCascade kernel (memory access out of bounds). The engine's memory may be damaged: what it builds from now on is suspect until the engine restarts.`, and the page offers **Restart engine**.
- **Fix.** Construct only through the scope: `this.occ(({ oc, track }) => { … })`; `track()` every object a method or static returns (`maker.Shape()`, `oc.TopoDS.Wire(s)`); return wrappers (`ShapeFactory.fromShape(raw)`) or `keep()` what must outlive the scope. Never `delete()` an object by hand, never free a raw shape that came from a reference, never make the scope's function async. After a trap, every later build is suspect until the engine restarts: say so to the user.

## Fields refused by name

- **Signature.** The model that imports the module fails to compile, and the feature's Custom cell is greyed, with one of:
  - `feature metadata: leave 'illustration' out — illustrations aren't supported (custom controls are planned)` (and the same for `onChange`);
  - `feature metadata: leave 'id' out — the feature's id is its class's static id`;
  - `feature metadata: leave 'defaultOperation' out — a feature adds by default when it offers 'add', else it applies the first of its 'operations'`;
  - `defineFeature(VentGrid): leave 'kind' out — it is read from the class: …` (and `class`, `params`);
  - `param 'rims': leave 'tangents' out — tangent chains are for fillet and chamfer only`;
  - `param 'around': leave 'connector' out — an axis picker always takes connectors`;
  - `param 'face': a picker takes no default — its value is what the user picks`.
- **Fix.** Leave them out. Any other unknown field is refused as a typo (`unknown field 'defualt' for a length value — its fields are …`).

## A union whose kinds take the same click

- **Signature.** `param 'at': both 'face' and 'anchor' take a face click — a picker of several kinds routes each click to the one kind that takes it; leave one out, or declare two values`.
- **Why.** Each click must land in exactly one kind. `face` + `anchor`, `solid` + `feature` (both take a feature row), `edge` + `face` with `facesAsEdges`, and `axis` + `connector` (an axis already takes connectors) clash.
- **Fix.** Leave one kind out, or declare two values.

## A select or a toggle without a default

- **Signature.** The model's own calls work, but **Apply** in the dialog fails when the user leaves that row alone: the dialog shows the first option (or the toggle off) yet writes nothing, and the builder requires the value (`ventGrid(): 'pattern' is required`).
- **Fix.** Give every `select` and `boolean` a `default`, or make it `optional`.

## A call the dialog can't edit

- **Signature.** The statement builds, but double-clicking its row says it is `… — not editable in the dialog; edit the statement in the source`.
- **Why.** The dialog reads and writes only the call shape's grammar: positional values, one object literal of options, a trailing rest, then the operation chains. Options held in a variable, a spread (`{ ...sizes }`), a computed key, or a string where a number goes can't be written back.
- **Fix.** In the test part, write calls the way the dialog would. In the design, keep the call to that grammar: picks positional, sizes in one object of options.

## The default operation needs no chain

- **Signature.** `ventGrid(face).add()` on a `['remove']` feature fails its row: `ventGrid(): .add() is not an operation this feature offers — it offers 'remove'; 'remove' is its default and needs no chain`.
- **Fix.** Write no chain for the default (`ventGrid(face)` cuts). `.remove()` spelled out is accepted and kept by edits, but redundant.

## Errors in the wrong place

- **Signature.** A whole model fails to compile over one feature call, or one row fails while you expected a compile error.
- **Why.** The builder checks its call where the model runs: a wrong or missing value (`ventGrid(): 'rows' must be at least 1, got 0`, `ventGrid(): unknown option 'colums' — the options are …`) fails the model's compilation. What `buildTool()` throws fails only its row.
- **Fix.** Read `render.state` and `objectErrors` for the row errors, the compile error for the call errors. Throw from `buildTool()` for geometry that can't be built (a hole wider than its pitch), with a message that says what to change.

## Writing the module while another model is open

- **Signature.** The module's write reports on a model that doesn't use the feature (`render.openModel: true`, nothing about the feature), or `no-open-model`.
- **Why.** A module never renders itself; its write re-renders the open model.
- **Fix.** Write the test part right after the module's first version; it becomes the open model, and later module writes report on it.

## Smaller ones

- **Picks are only checked in the dialog.** `surface: 'planar'` and `curve: 'circle'` limit what the dialog takes; a model's own call isn't checked: check in `buildTool()` when the geometry depends on it.
- **Units.** Lengths are plain numbers in the model file's unit; a default does not scale with `unit('in')`. Angles are degrees: convert with `* Math.PI / 180`.
- **A corner point faces along its edge.** A point picked at a solid's corner is the end of an edge (`e.endEdges(0).end()`), and `frameOf()` gives it that edge's tangent as Z, not a face normal.
- **Node built-ins are blocked** in feature modules as in models (fs, child_process, net, http, os and the like).
- **Ids are unique.** Two builders with one `static id` grey both cells (`the feature id 'acme.ventGrid' is used by more than one builder …`), in one module or two.
- **Custom features run in parts only**, not at the top level of an `*.assembly.js` file.
