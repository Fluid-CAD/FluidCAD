# FluidCAD traps

Read before a fillet, chamfer, shell, cut, repeat, `plane()` offset, a sketch on a face, or a breakpoint. Each entry: the operation, the silent failure signature, the evidence, the fix. Evidence marked "observed in sessions" comes from agent sessions rather than the docs or the code.

## `cut` and `extrude` have opposite sign conventions

- **Signature.** A pocket that should go down comes out as a boss going up, or a `cut(10)` on a top face removes nothing visible and the volume does not change. The source reads as a correct transcription of the depth.
- **Evidence.** `api/cut`: positive distance cuts opposite the sketch normal (into the solid the sketch sits on); negative cuts along it; `cut()` with no argument is through-all, again opposite the normal. `extrude` positive goes along the normal.
- **Fix.** Transcribe a depth callout into `cut(depth)` on the face it is cut from, and `extrude(height)` for material added. When the sketch sits on a plane rather than a face, decide which side is "into the material" before writing the sign, then screenshot the first cut on every new plane.

## A filter that matches nothing, or too much

- **Signature, under-match.** `render.state` is `build-error` and `objectErrors` carries `fillet: the selection resolved to no edges — nothing was filleted.` (chamfer and shell have the same shape of message, "no faces" for shell). The rest of the model renders, so the picture looks fine at a glance.
- **Signature, over-match.** No error at all: the fillet also rounded the edges of a hole or a far-side face, and only a close look at the screenshot shows it. A `cut` aimed with an over-matching face reference cuts from the wrong face.
- **Evidence.** `lib/features/fillet.ts`, `chamfer.ts`, `shell.ts` set those errors on an empty resolution; the over-match case is observed in sessions.
- **Fix.** `resolve_selection` the expression at the scope and boundary (`before`) the statement runs in and read `count` before writing anything. Narrow with a second predicate (`edge().circle(5).onPlane("xy", 10)`, `face().planar().above("xy", 20)`) until the count is right, then write `synthesized.source` — usually the feature's own accessor (`e.endEdges()`), which cannot over-match. Re-run the resolution after any edit upstream of the feature.

## `plane()` offsets duplicate a dimension

- **Signature.** Change the base extrude from 40 to 45 and the boss sketched on `plane("xy", 40)` now floats inside the part, or the pocket on it vanishes. No error is reported.
- **Evidence.** The rule in the core skill ("sketch on face references, not transformed planes"); the failure is observed in sessions.
- **Fix.** `sketch(e.endFaces(), ...)`. Use `plane()` for datums that are not a face of anything: a mid-plane, a tilted section plane, an offset that is itself a design dimension.

## The face plane's origin is not the face centroid

- **Signature.** A circle drawn at `[0, 0]` in a sketch on `e.endFaces()` lands off-center of the face, or off the face entirely.
- **Evidence.** `api/sketch` and `api/cut`: "The face plane's origin is not guaranteed to be the face centroid; anchor geometry to a projected reference instead of raw coordinates."
- **Fix.** `const outline = project(e.endFaces()).guide();` then constrain to it (`offset(-10, outline)`, `concentric`, `coincident` against `outline.center()` or `outline.ref(i)`), or sketch on the datum plane at the face's height when the face is a full planar slab.

## Repeat direction and options

- **Signature.** A linear pattern marches off the part instead of across it; a circular pattern starts on the wrong side. The source looks right. Passing `count` alone fails the feature: the runtime needs spacing or span.
- **Evidence.** `api/repeat`: `linear` needs `count` plus exactly one of `offset` or `length`; `circular` needs `count` plus one of `offset` (degrees) or `angle`. The direction sign is observed in sessions.
- **Fix.** Prefer `length` (total span) when the drawing gives an overall; the sign of `offset` or `length` sets the direction. Repeat the feature (`repeat("linear", "x", { count: 4, offset: 30 }, hole)`), not the sketch. Gate every repeat on a screenshot, and `measure` the first and last instance centers.

## Shell offsets every face that exists when it runs

- **Signature, order.** A boss added before the shell comes out as a thin-walled hollow bump; a boss added after the shell stays solid and does not open into the cavity. Neither reports an error.
- **Signature, failure.** `shell: could not hollow the solid — wall offset failed.` in `objectErrors`; the original solid is kept, so the part renders un-shelled.
- **Evidence.** `lib/features/shell.ts` sets that error and its hint (wall thicker than a nearby feature or radius, a groove opening onto a removed face); the order effect is observed in sessions.
- **Fix.** Decide per boss which you want, and order the shell accordingly. Shell before small cuts and grooves, with a wall thinner than the smallest adjacent radius, and as few open faces as the design allows. Negative thickness shells inward (`shell(-2, e.endFaces())`).

## Sketching on, or selecting, geometry a later feature consumes

- **Signature.** A fillet or chamfer that worked yesterday now fails with `... N selected edge(s) matched no solid in the scene and were skipped.`, or the sketch that sat on a face moves after a cut removed that face.
- **Evidence.** The hint text in `fillet.ts` / `shell.ts`: "a later operation may have consumed them; re-select on the final model."
- **Fix.** Reference the face or edge as it exists at the point in the tree where the referencing feature runs. Dress features come last and select from the finished body; a sketch that must survive a boolean sits on a datum plane or on a face the boolean does not touch.

## A selection is good for the very next statement only

- **Signature.** `select(edge().verticalTo("xy"))`, then a `color()` or another statement, then `fillet(3)`: the fillet reports `fillet: no edges selected — nothing was filleted.`, or rounds the wrong edges.
- **Evidence.** `concepts/last-selection`: "A selection is good for the very next op."
- **Fix.** Pass the target explicitly: `fillet(3, e.endEdges())` or `fillet(3, select(...))` captured in a variable. The same rule applies to sketches: a sketch is consumed once; `.reusable()` to extrude it twice.

## `"x"` inside a sketch is the world X axis

- **Signature.** On a tilted plane, `mirror("x", g)` reflects across a line that is not the sketch's horizontal; the mirrored half lands somewhere unrelated.
- **Evidence.** `concepts/coordinate-system` and `api/mirror`.
- **Fix.** `mirror(xAxis(), g)` and `copy("linear", yAxis(), ...)` for the sketch's own axes; `xAxis()` / `yAxis()` come from `fluidcad/core` and are called inside the callback.

## Feature defaults do not scale with the unit

- **Signature.** In an inch file, `fillet(e.endEdges())` produces a 1 inch fillet and `chamfer(e.endEdges())` a 1 inch chamfer; text comes out 10 inches tall.
- **Evidence.** `concepts/units`: defaults are plain numbers in document units.
- **Fix.** Always pass the size when the file is not in mm. Read `unit` from `get_scene_summary` before assuming.

## `circle()` takes a diameter

- **Signature.** Every hole is twice the intended size, or a boss is twice as wide as the drawing.
- **Evidence.** `api/circle`: "The argument is the diameter, not the radius."
- **Fix.** Write `circle(center, diameter)`; when the drawing gives `R`, double it or use `radius(c, value)` as the constraint.

## `revolve` needs the axis in the sketch plane

- **Signature.** A revolve around `"z"` from a sketch on `"xy"` fails or produces a disc-like body instead of the intended solid of revolution.
- **Evidence.** `api/revolve`: "The sketch plane must contain the axis: to revolve around `"z"`, sketch on `"xz"` or `"yz"`."
- **Fix.** Sketch the half-profile on a plane that contains the axis, with the profile entirely on one side of it.

## `color()` with no selection paints everything

- **Signature.** `color("red")` after a statement that left no selection turns the whole part red.
- **Evidence.** `api/color`: with no selection it paints every face in the current context.
- **Fix.** Always pass a target: `color("red", e.endFaces())`. For viewing a selection, do not edit the file at all: `screenshot` with `highlight`.

## Breakpoint line index mismatch

- **Signature.** The partial scene stops one line early or late; a feature you expected to see is missing, or the one you wanted excluded is present.
- **Evidence.** `add_breakpoint` documents `line` as zero-based; every `sourceLocation` the server returns is 1-based (the scene summary, `objectErrors`, `compileError`).
- **Fix.** Pass the line, then `read_file` and confirm where the `breakpoint()` statement landed before trusting the partial scene. Prefer `rollback_to`, which has no such ambiguity.
