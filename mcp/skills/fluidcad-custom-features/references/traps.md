# Custom feature traps

Read before writing a `*.feature.js` module. Each entry: the mistake, how it shows, and the fix. The messages are the engine's own.

## `instanceof` on your own class

- **Signature.** A check that works on the first render fails on the next, or a cached build is never matched. Nothing errors.
- **Why.** The module is evaluated anew on every render and by the editor's catalog scan; each evaluation makes a new class, so an instance of the last render's `Standoff` is not an instance of this one's.
- **Fix.** Never `x instanceof Standoff`. The engine compares features by `static id` and values. To tell a value's elements apart, use the readers (`isLocation()`, `facesOf()`); `instanceof Feature` (the engine's base) is fine.

## No buckets

- **Signature.** `fillet(0.5, post.endEdges())` fails its row with `fillet: the selection resolved to no edges — nothing was filleted.`; the dialog's picks on the feature are written as filters (`select(edge()…)`) instead of `post.endEdges()`.
- **Why.** A feature fills only the buckets `setBuckets()` names.
- **Fix.** Sort the faces on the XY plane, place the tool with `transformTracking(shape, frame, faces)`, and name `placed.images` (filtering out `null`). Name start, end, side and internal faces (edges are derived), and named buckets for what a user will fillet, chamfer or sketch on. For a cut, give `startPlane` (its normal the way the tool grows) so the rims are start and end edges, not all internal. Check each bucket's count with `resolve_selection`.

## A misspelt bucket, or a member of the wrong shape, is a build error

- **Signature.** The feature's row fails (`build-error`; the dialog's preview says the same) with one of:
  - `gear: setBuckets() 'tipFace' is not a bucket of gear — did you mean tipFaces?` (a standard name misspelt, `endFace`, too; with no close name it lists the feature's buckets);
  - `gear: setBuckets() tipFaces must be a list of faces, got a face`;
  - `gear: setBuckets() tipFaces[0] is an edge, not a face — tipFaces holds faces`;
  - `gear: setBuckets() boreFaces[1] is not a face of the solids buildTool() returned — name faces of the shapes you return`.
- **Why.** `setBuckets()` refuses what it would lose: a name the feature has no bucket for (it used to be dropped silently, leaving an empty bucket), a member of the wrong kind, and a member of a shape `buildTool()` doesn't return (most often a face of the shape before `ShapeOps.transformTracking` placed it).
- **Fix.** Use the declared name exactly (under checkJs a misspelt name in `setBuckets()`, and `g.tipEdge()` in a model, are editor errors before they are build errors); pass lists; put faces in `…Faces` buckets and edges in `…Edges` ones; name `placed.images`, not the unplaced shape's faces. Every `setBuckets()` refusal: `api/feature-buckets`.

## A description on a bucket

- **Signature.** The model importing the module fails to compile and the Custom cell greys: `Feature.with(): bucket 'tipFaces': leave 'description' out — describe what the feature's buckets hold in the package's docs/ pages`. Also refused: `kind` (`leave 'kind' out — the name's ending gives it`), any other field (`unknown field 'note' — a bucket declares only its label`), a name without the ending (`'teeth' needs to end in Faces or Edges (teethFaces?)`), and `buckets` in `defineFeature()`'s metadata (`leave 'buckets' out — declare buckets on the class: Feature.with(params, { buckets })`).
- **Why.** A bucket declaration is `{}` or `{ label }`. What a bucket holds is documented in the feature's `docs/` page, where other authors and the LLM read it, not in code.
- **Fix.** Keep `{ label }` or `{}`, a line comment beside it for the code's reader, and describe each bucket (what it holds, its order) in `docs/<feature>.md`. Every declaration refusal: `api/feature-buckets`.

## A face the feature grows from, in a bucket of your own

- **Signature.** After `.add()`, a named bucket that held the feature's bottom face (`baseFaces`) is empty, or misses the faces that merged into the plate: a sketch or fillet on it resolves to nothing.
- **Why.** Across a fusion a named bucket follows each member's history and keeps only what the final solid carries: a face the fusion merged away is dropped, never swapped for the stock face it merged into. Only `startFaces` (and `endFaces`) are re-homed that way.
- **Fix.** Name the face the feature grows from `startFaces`, its far end `endFaces`. Keep named buckets for faces that survive as themselves (tips, flanks, floors, bores). The same rule trims a named bucket to what is left when the stock swallows part of a face.

## Derived edges need the edge bucket declared

- **Signature.** `g.flankEdges is not a function` at run time, `Property 'flankEdges' does not exist on type 'Gear'` in the editor, though `flankFaces` is declared and filled.
- **Why.** An edge bucket exists only when declared; nothing makes `xEdges` from `xFaces` on its own.
- **Fix.** Declare `flankEdges: {}` beside `flankFaces` and leave it out of `setBuckets()`: it is then the distinct edges of `flankFaces`, taken after the fusion or the cut. Fill it explicitly when it should hold only some of those edges.

## Filleting a fused feature's whole derived edge bucket

- **Signature.** `fillet(0.3, g.tipEdges())` fails its row with `fillet: the kernel could not build a fillet of radius 0.3 on the N selected edge(s). The radius may be too large for the adjacent faces. The solid was left unfilleted.` on a gear added onto a face wider than its teeth (the plate itself), while the same fillet works on a `.new()` gear, or on one standing on a seat smaller than its root circle.
- **Why.** Derived edges are taken after the fusion, so they include the concave edges where each tip now meets the plate, and OpenCascade can't round those together with the convex tip edges at the same corner.
- **Fix.** Filter the bucket (`fillet(0.3, g.tipEdges(edge().convex()))`), or keep the feature apart (`.new()`).

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

## A size with no default

- **Signature.** A fresh dialog shows the row empty, no preview draws, and **Apply** says `Rows is required.`; a model call that leaves it out fails to compile with `ventGrid(): 'rows' is required`.
- **Why.** A `number`, `integer`, `length`, `angle` or `text` without a `default` has nothing to fall back on, so the dialog asks for it. (A `boolean` and a `select` always have one: off, and the first option; an `optional` select without one shows "—" and stays unset.)
- **Fix.** Give every size a `default` the feature builds well with; leave one out only for a value the user must decide each time, and say so in its `label` or `description`.

## A call the dialog can't edit

- **Signature.** The statement builds, but double-clicking its row says it is `… — not editable in the dialog; edit the statement in the source`.
- **Why.** The dialog reads and writes only the call shape's grammar: positional values, one object literal of options, a trailing rest, then the operation chains. Options held in a variable, a spread (`{ ...sizes }`), a computed key, or a string where a number goes can't be written back.
- **Fix.** In the test part, write calls the way the dialog would. In the design, keep the call to that grammar: picks positional, sizes in one object of options.

## A required pick skipped by going straight to the options

- **Signature.** `standoff({ height: 5 })` fails the model's compilation with `standoff(): 'face' is required — it comes before the options`; in the editor, the call is marked (`… does not exist in type 'ISelection'`).
- **Why.** An object of options where a positional value goes skips every positional value from there on. That is how a call leaves an optional pick out (`gear({ teeth: 24 })`), but a value with no default that isn't `optional` can't be skipped.
- **Fix.** Pass the pick first (`standoff(plate.endFaces(), { height: 5 })`), or declare it `optional: true` when the feature has a sensible placement without it. Never write `undefined` to hold its place: the short form is what the dialog writes.

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

## Dialog controls and layout

Each is refused where the module loads (the model fails to compile, the Custom cell is greyed with the message) unless it says otherwise.

- **`group` or `tab` beside a `layout`.** `param 'size': leave 'group' out — the layout places it`. Move the heading into a `{ section }` or `{ tabs }` item.
- **A value left out of the `layout`, or placed twice.** `the value 'depth' has no place in the layout`, `the value 'depth' is placed twice in the layout`. List every declared value exactly once, hidden ones included (`visibleWhen` hides the row where it sits).
- **A picked value inside a `row`.** `… names 'face' — a picked value takes a full row`. Put the picker on its own line; rows hold typed-in values, notes and images, 2 to 4 cells.
- **`columns` or `search` where they don't apply.** `param 'size': 'columns' is for display: 'grid' — leave it out` (`'cards'` on a radio); `search` on a radio is refused as an unknown field. `columns` is 2 to 6.
- **A slider without both ends.** `display: 'slider' needs both 'min' and 'max' — the track runs from one to the other`. A stepper on a `length` or an `angle`: `display: 'stepper' is for a number or an integer — a length takes 'slider', or leave it out`.
- **A default that `when` does not offer at rest.** `the default "m4" is not offered … — an untouched dialog would show one thing and the builder get another`: the default must be offered while every other value is at its own default. Leave `default` out (the first option offered there is taken) or pick one that is. `none of its options is offered … — leave the 'when' off one, or make the value 'optional'` is the same rule with no candidate.
- **Options that wait on each other.** `param 'size': the 'when' of its options comes back round to it (…) — options that wait on each other have no first one to offer`. Let one value lead and the other follow.
- **`when` is not a check.** `fastener(at, { standard: 'iso', size: 'n4' })` builds: a hand-written call may pass any declared option. Validate in `buildTool()` if a combination can't be built.
- **A multi-select written as a bare value.** `fastener(): 'finishes' must be a list of "deburr", "chamfer", "polish", got 'deburr'` — a compile error at the call. Always an array literal: `finishes: ['deburr']`, `[]` for none. `this.values.finishes` is never `undefined`.
- **A choice held in a variable.** `size: screw` or `finishes: [...common]` builds, but the row opens as `screwHole()'s 'size' is not a plain string or number — not editable in the dialog; edit the statement in the source`. Write select, radio, text and list arguments as plain literals; numbers alone take variables and expressions.
- **An image that is not a declared path beside the module.** `'image' must be a relative path inside the module's directory, such as './image.svg', got '../m3.svg'`. No `../`, no URL, no absolute path; `.svg`, `.png`, `.jpg` or `.webp`. Only declared images are served. They are drawn as pictures, so `currentColor` in an SVG is black on both themes: use a mid-tone stroke (`#8a94a6`).
- **`visibleWhen` (or `when`) naming the wrong kind of value.** A picked value in a `visibleWhen` takes a condition, not a value: `{ at: { picked: true } }`, `{ faces: { count: 3 } }`, `{ at: { surface: 'cylinder' } }`, `{ at: { not: { surface: 'cylinder' } } }` (`… 'at' is a picked value: give it a condition such as { picked: true } or { surface: 'cylinder' }`). An option's `when` names typed-in values only (`… names 'face', a picked value — it can only name a typed-in one`), and neither names a select with `multiple: true` (`… a select with 'multiple: true' — it can only name a value that holds one thing`): add a boolean or a radio for the dialog to switch on.

## Smaller ones

- **Picks are only checked in the dialog.** `surface: 'planar'` and `curve: 'circle'` limit what the dialog takes; a model's own call isn't checked: check in `buildTool()` when the geometry depends on it.
- **Units.** Lengths are plain numbers in the model file's unit; a default does not scale with `unit('in')`. Angles are degrees: convert with `* Math.PI / 180`.
- **A corner point faces along its edge.** A point picked at a solid's corner is the end of an edge (`e.endEdges(0).end()`), and `frameOf()` gives it that edge's tangent as Z, not a face normal.
- **Node built-ins are blocked** in feature modules as in models (fs, child_process, net, http, os and the like).
- **A helper method's parameters need JSDoc types.** `this.values` is typed by inference, but a method of your own (`sunk(cylinder, depth, frame)`) is not: under the workspace's `checkJs` it reports `Parameter 'depth' implicitly has an 'any' type`. Add `@param {number} depth`, `@param {import('fluidcad/sdk/kernel').Shape} cylinder`, `@param {import('fluidcad/math').Plane} frame`.
- **Ids are unique, plain, and not the engine's.** Two builders with one `static id` grey both cells (`the feature id 'ventGrid' is used by more than one builder …`), in one module or two. An id the engine uses for its own scene objects is refused where the module loads (`'extrude' is one of the engine's own types: give the feature another id`). An installed package's features never collide with these: the engine keys them by the package (`@acme/vent-hardware:ventGrid`).
- **Custom features run in parts only**, not at the top level of an `*.assembly.js` file.
